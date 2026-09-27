// ═══════════════════════════════════════════════════════════════════════════════
// server.js — BillHive Express API Server
// ═══════════════════════════════════════════════════════════════════════════════
//
// This is the main backend for BillHive, a self-hosted household bill-splitting
// app. It provides a REST API for managing bill state, monthly numeric data, and
// email configuration, plus a Server-Sent Events (SSE) endpoint for real-time
// multi-device sync.
//
// Architecture overview:
//   - Express 4.x with better-sqlite3 (synchronous — no async for DB ops)
//   - Multi-user via reverse-proxy auth headers (Authelia, Authentik, etc.)
//   - Falls back to user "local" when no proxy header is present
//   - SSE broadcasts a `data-changed` event to all of a user's open tabs on write
//   - Email relay supports SMTP, Mailgun, SendGrid, and Resend via nodemailer
//   - Runs in Docker on node:24-alpine; data stored at /data/billhive.db
//
// Data model:
//   user_state   — key/value JSON blobs per user (settings, people, bills, checklist)
//   monthly_data — per-month numeric snapshots keyed "YYYY-MM" per user
//   email_config — provider credentials per user (secrets stored server-side only)
//
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const Database = require('better-sqlite3');   // Sync SQLite — never use async/await for DB calls
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { sendEmail, maskConfig } = require('./email.js');
const { buildEmailHtml } = require('./emailTemplate.js');

const Data = require('./public/data-contract.js');
const { SyncStore, SyncError } = require('./sync-store');
const { GuestTripSync } = require('./guest-sync-store');
const { CheckShareSync } = require('./check-share-store');
const { AttachmentStore } = require('./attachment-store');
const app = express();
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_ADMIN_USERS = new Set((process.env.AUTH_ADMIN_USERS ?? 'local').split(',').map(value => value.trim()).filter(Boolean));
const INDEX_PATH = fs.existsSync(path.join(__dirname, 'index.html')) ? path.join(__dirname, 'index.html') : path.join(__dirname, 'public', 'index.html');
const DB_PATH = process.env.DB_PATH || '/data/billhive.db';  // Docker volume mount point

// TRUST_PROXY tells Express how many reverse-proxy hops to trust for X-Forwarded-*.
// Default 1 = trust the immediate proxy (Authelia/Authentik/Traefik). Set to 0 to
// disable, or a higher number if you have multiple proxies in front. Required for
// express-rate-limit to key off the real client IP.
const TRUST_PROXY = process.env.TRUST_PROXY ?? '1';
app.set('trust proxy', isNaN(Number(TRUST_PROXY)) ? TRUST_PROXY : Number(TRUST_PROXY));
app.disable('x-powered-by');

// ── Ensure data directory exists ──────────────────────────────────────────────
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ── Database setup ────────────────────────────────────────────────────────────
// WAL mode allows concurrent reads while a write is in progress, which improves
// performance when multiple SSE clients are polling alongside state saves.
// Foreign keys are enabled for future schema extensions but not currently used.
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema: three tables, all keyed by user_id for multi-tenant isolation.
//
// user_state:   Generic key/value store for app config blobs.
//               Keys include: "settings", "people", "bills", "checklist".
//               Each value is a JSON string. The frontend sends all four keys
//               in a single PUT /api/state on every debounced save.
//
// email_config: Stores email provider credentials (SMTP, Mailgun, etc.) per user.
//               Secrets are stored in plaintext server-side but NEVER returned to
//               the browser — GET /api/email/config returns a masked copy.
//
// monthly_data: Per-month numeric snapshots keyed "YYYY-MM". Stores bill totals,
//               per-line amounts, computed owes, etc. Used for trend charts and
//               the history log. Written by the frontend via PUT /api/months/:key.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_state (
    user_id    TEXT    NOT NULL,
    key        TEXT    NOT NULL,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS email_config (
    user_id    TEXT    NOT NULL PRIMARY KEY,
    config     TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS monthly_data (
    user_id    TEXT    NOT NULL,
    month_key  TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, month_key)
  );

  -- Per-device API keys for iOS clients (M1/M3 hardening).
  -- Keys are hashed with SHA-256 before storage so a DB leak doesn't
  -- expose usable tokens. The plaintext key is shown to the user EXACTLY
  -- ONCE at generation time and never persisted in plaintext.
  CREATE TABLE IF NOT EXISTS api_keys (
    id           TEXT    PRIMARY KEY,
    user_id      TEXT    NOT NULL,
    name         TEXT    NOT NULL,
    key_hash     TEXT    NOT NULL,
    key_prefix   TEXT    NOT NULL,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    last_used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
  CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

  -- Server-wide settings (HMAC secret, "require device keys" toggle).
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- No-account share links for restaurant checks. Each row binds a random
  -- URL-safe token to a check inside a host's user_state JSON blob. Anyone
  -- with the token can read the check (stripped of host-only fields) and
  -- POST claims (a name + item IDs). Claims are stored as a JSON array
  -- in this row, separate from the host's state so they ride their own
  -- write path and don't get clobbered by the host's debounced save().
  CREATE TABLE IF NOT EXISTS share_checks (
    token       TEXT    PRIMARY KEY,
    user_id     TEXT    NOT NULL,
    check_id    TEXT    NOT NULL,
    claims      TEXT    NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    revoked_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_share_checks_user ON share_checks(user_id);
  CREATE INDEX IF NOT EXISTS idx_share_checks_check ON share_checks(user_id, check_id);

  -- Per-member invite links for trip sharing. Each row binds a token to a
  -- specific member within a trip in the host's user_state. The invitee's
  -- device presents the token on every read/write request, so revoking
  -- immediately cuts access with no separate session invalidation needed.
  CREATE TABLE IF NOT EXISTS trip_invites (
    token           TEXT    PRIMARY KEY,
    owner_user_id   TEXT    NOT NULL,
    trip_id         TEXT    NOT NULL,
    member_id       TEXT    NOT NULL,
    joined_at       INTEGER,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    revoked_at      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_trip_invites_owner ON trip_invites(owner_user_id, trip_id);
  CREATE INDEX IF NOT EXISTS idx_trip_invites_member ON trip_invites(owner_user_id, trip_id, member_id);

  -- Per-person invite links for household bills sharing. The token grants a
  -- read-only view of one person's bill summary, computed from the owner's
  -- current state each time the guest fetches it.
  CREATE TABLE IF NOT EXISTS bills_invites (
    token           TEXT    PRIMARY KEY,
    owner_user_id   TEXT    NOT NULL,
    person_id       TEXT    NOT NULL,
    joined_at       INTEGER,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    revoked_at      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_bills_invites_owner ON bills_invites(owner_user_id);
  CREATE INDEX IF NOT EXISTS idx_bills_invites_person ON bills_invites(owner_user_id, person_id);
`);

const sync = new SyncStore(db, {requirePreconditions: process.env.SYNC_REQUIRE_PRECONDITIONS === '1'});
const guestSync = new GuestTripSync(db, sync, publicTripShape);
const checkSync = new CheckShareSync(db, sync, publicCheckShape);
const attachments = new AttachmentStore(db, sync);
sync.validateReferences = userId => attachments.validateReferences(userId);

// Prepared statements — better-sqlite3 compiles these once at startup for
// significantly faster repeated execution. All are synchronous (.get / .run / .all).
const stmts = {
  getState:     db.prepare('SELECT value FROM user_state WHERE user_id = ? AND key = ?'),
  setState:     db.prepare('INSERT OR REPLACE INTO user_state (user_id, key, value, updated_at) VALUES (?, ?, ?, unixepoch())'),
  getAllState:   db.prepare('SELECT key, value FROM user_state WHERE user_id = ?'),
  getMonth:     db.prepare('SELECT data FROM monthly_data WHERE user_id = ? AND month_key = ?'),
  setMonth:     db.prepare('INSERT OR REPLACE INTO monthly_data (user_id, month_key, data, updated_at) VALUES (?, ?, ?, unixepoch())'),
  getAllMonths:  db.prepare('SELECT month_key, data FROM monthly_data WHERE user_id = ? ORDER BY month_key ASC'),
  deleteMonth:  db.prepare('DELETE FROM monthly_data WHERE user_id = ? AND month_key = ?'),
  getEmailCfg:  db.prepare('SELECT config FROM email_config WHERE user_id = ?'),
  setEmailCfg:  db.prepare('INSERT OR REPLACE INTO email_config (user_id, config, updated_at) VALUES (?, ?, unixepoch())'),

  // API keys
  findApiKeyByHash:    db.prepare('SELECT id, user_id FROM api_keys WHERE key_hash = ?'),
  listApiKeysForUser:  db.prepare('SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'),
  insertApiKey:        db.prepare('INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?)'),
  deleteApiKey:        db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?'),
  touchApiKey:         db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?'),
  countApiKeysForUser: db.prepare('SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ?'),

  // App settings
  getSetting: db.prepare('SELECT value FROM app_settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)'),

  // Trip invites
  findTripInviteByToken:      db.prepare('SELECT * FROM trip_invites WHERE token = ?'),
  findActiveInviteForMember:  db.prepare('SELECT * FROM trip_invites WHERE owner_user_id = ? AND trip_id = ? AND member_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1'),
  listInvitesForTrip:         db.prepare('SELECT * FROM trip_invites WHERE owner_user_id = ? AND trip_id = ? AND revoked_at IS NULL ORDER BY created_at DESC'),
  insertTripInvite:           db.prepare('INSERT INTO trip_invites (token, owner_user_id, trip_id, member_id) VALUES (?, ?, ?, ?)'),
  markTripInviteJoined:       db.prepare('UPDATE trip_invites SET joined_at = unixepoch() WHERE token = ? AND revoked_at IS NULL'),
  revokeTripInvite:           db.prepare('UPDATE trip_invites SET revoked_at = unixepoch() WHERE owner_user_id = ? AND trip_id = ? AND member_id = ? AND revoked_at IS NULL'),
  revokeAllTripInvites:       db.prepare('UPDATE trip_invites SET revoked_at = unixepoch() WHERE owner_user_id = ? AND trip_id = ? AND revoked_at IS NULL'),

  // Bills invites
  findBillsInviteByToken:      db.prepare('SELECT * FROM bills_invites WHERE token = ?'),
  findActiveBillsInviteForPerson: db.prepare('SELECT * FROM bills_invites WHERE owner_user_id = ? AND person_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1'),
  listBillsInvitesForOwner:    db.prepare('SELECT * FROM bills_invites WHERE owner_user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC'),
  insertBillsInvite:           db.prepare('INSERT INTO bills_invites (token, owner_user_id, person_id) VALUES (?, ?, ?)'),
  markBillsInviteJoined:       db.prepare('UPDATE bills_invites SET joined_at = unixepoch() WHERE token = ? AND revoked_at IS NULL'),
  revokeBillsInvite:           db.prepare('UPDATE bills_invites SET revoked_at = unixepoch() WHERE owner_user_id = ? AND person_id = ? AND revoked_at IS NULL'),
};

// ── Crypto helpers ────────────────────────────────────────────────────────────
function hashApiKey(key) {
  const salt = getServerSecret();
  return crypto.scryptSync(key, salt, 32).toString('hex');
}

function generateApiKey() {
  // 32 random bytes → 43-char URL-safe base64. Plus the "bh_live_" prefix
  // so leaked tokens are recognizable in logs and code-search dumps.
  return 'bh_live_' + crypto.randomBytes(32).toString('base64url');
}

function generateApiKeyId() {
  return 'ak_' + crypto.randomBytes(4).toString('hex');
}

// ── Server secret (used for cookie HMAC) ──────────────────────────────────────
// Generated on first startup and persisted; the same value is reused across
// restarts so existing browser sessions stay valid. Rotate by deleting the
// row from app_settings — all bh_session cookies become invalid.
function getServerSecret() {
  const row = stmts.getSetting.get('server_secret');
  if (row) return row.value;
  const secret = crypto.randomBytes(32).toString('hex');
  stmts.setSetting.run('server_secret', secret);
  return secret;
}
const SERVER_SECRET = getServerSecret();

// ── "Require device keys" toggle ──────────────────────────────────────────────
// When true, any /api/* request that didn't successfully authenticate via
// Bearer key, browser session cookie, or reverse-proxy header is rejected
// with 401. Off by default — enabling is a deliberate user action via the
// web UI.
function getRequireDeviceKeys() {
  return stmts.getSetting.get('require_device_keys')?.value === 'true';
}
function setRequireDeviceKeys(v) {
  stmts.setSetting.run('require_device_keys', v ? 'true' : 'false');
}

// ── Cookie helpers (HMAC-signed, stateless) ───────────────────────────────────
// bh_session cookie format: <base64url(payload)>.<hex(hmac)>
// Payload: { uid: "<userId>", iat: <unix>, exp: <unix> }
// Signed with SERVER_SECRET. Verified on every request via constant-time
// compare. 30-day lifetime; refreshes whenever the SPA reloads.
function signCookie(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SERVER_SECRET).update(body).digest('hex');
  return body + '.' + sig;
}

function verifyCookie(token) {
  if (!token) return null;
  try {
    const idx = token.indexOf('.');
    if (idx < 1) return null;
    const body = token.slice(0, idx);
    const sig  = token.slice(idx + 1);
    if (!/^[0-9a-f]+$/i.test(sig)) return null; // sig must be hex
    const expected = crypto.createHmac('sha256', SERVER_SECRET).update(body).digest('hex');
    if (sig.length !== expected.length) return null;
    // timingSafeEqual requires equal-length buffers
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.v !== 2 || typeof payload.uid !== 'string' || !/^[A-Za-z0-9._@-]{1,128}$/.test(payload.uid) || /^\.+$/.test(payload.uid)) return null;
    if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (payload.source === 'key' && !db.prepare('SELECT id FROM api_keys WHERE id = ? AND user_id = ?').get(payload.keyId, payload.uid)) return null;
    if (getRequireDeviceKeys() && payload.source === 'local') return null;
    return payload;
  } catch { return null; }
}

function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
function setSessionCookie(req, res, userId, source = req.authMethod === 'fallback' ? 'local' : req.authMethod, keyId = req.apiKeyId) {
  const now = Math.floor(Date.now() / 1000);
  const token = signCookie({ v: 2, uid: userId, source, keyId, iat: now, exp: now + COOKIE_MAX_AGE_SECONDS });
  const secure = req.secure;
  res.setHeader('Set-Cookie',
    `bh_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}` +
    (secure ? '; Secure' : '')
  );
}

// ── SSE client tracking ───────────────────────────────────────────────────────
// Maps each userId to a Set of open SSE response objects. When any write endpoint
// (state, months, import) completes, broadcastChange() pushes a lightweight
// `data-changed` event to every open tab for that user. The frontend then
// reloads state from the API — keeping multiple devices/tabs in sync.
//
// Cleanup: when a client disconnects, its res is removed from the Set. If the
// Set is empty, the Map entry is deleted to prevent memory buildup over time.
const sseClients = new Map();

function broadcastChange(userId) {
  const clients = sseClients.get(userId);
  if (!clients) return;
  for (const res of clients) {
    res.write('event: data-changed\ndata: {}\n\n');
  }
}

// ── Security headers (helmet) ────────────────────────────────────────────────
// CSP is tuned to what index.html actually loads:
//   - Chart.js from cdnjs.cloudflare.com (loaded with SRI integrity)
//   - Exact SHA-256 hashes authorize the shipped inline scripts.
//   - Inline styles remain supported for the existing data-driven templates.
//   - data: URIs for SVG background patterns in CSS
// connect-src includes 'self' for fetch + EventSource (SSE).
// frame-ancestors 'none' replaces X-Frame-Options to prevent clickjacking.
const scriptHashes = [INDEX_PATH, path.join(__dirname, 'public', 'share.html')].flatMap(file => {
  const html = fs.readFileSync(file, 'utf8');
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .filter(match => match[1].trim()).map(match => "'sha256-" + crypto.createHash('sha256').update(match[1]).digest('base64') + "'");
});
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src':     ["'self'"],
      'script-src':      ["'self'", ...scriptHashes, 'https://cdnjs.cloudflare.com'],
      'style-src':       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src':        ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src':         ["'self'", 'data:'],
      'connect-src':     ["'self'"],
      'frame-ancestors': ["'none'"],
      'base-uri':        ["'self'"],
      'form-action':     ["'self'"],
      'object-src':      ["'none'"],
      'upgrade-insecure-requests': null,   // self-hosted users may run on http://
    },
  },
  // HSTS only meaningful over HTTPS; harmless otherwise. 1 year.
  strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginEmbedderPolicy: false,        // Public share pages use remote fonts
  crossOriginResourcePolicy: { policy: 'same-site' },
}));

// ── Rate limiting ────────────────────────────────────────────────────────────
// Global limiter: 300 req / 15 min per IP. Generous enough for SSE reconnects
// and aggressive saves while still capping a single bad actor.
// Email limiter: tighter, applied only to /api/email/test and /api/email/send to
// prevent outbound mail abuse (quota burn, spam reputation damage).
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const emailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Email rate limit exceeded. Try again in a minute.' },
});
// Public limiter for /public/share/* and /share/:token. Tighter than the
// global limit so an attacker can't brute-force tokens by enumeration,
// loose enough that legitimate visitors loading a claim page and posting
// a few claim updates stay under the cap.
const publicLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});
app.use(limiter);

// ── Middleware ────────────────────────────────────────────────────────────────
// 2 MB limit is generous enough for large bill configs + monthly data imports
// while protecting against accidental mega-payloads.
// A portable restore allows 8 MiB of records plus the pinned commit envelope.
app.use(['/api/sync/commit', '/api/sync/restore/validate'], express.json({ limit: '10mb' }));
app.use(express.json({ limit: '2mb' }));

// ── Auth resolution ──────────────────────────────────────────────────────────
// Three trusted identity signals, in order of preference:
//   1. Authorization: Bearer <key>  — iOS device key (per-key user mapping)
//   2. bh_session cookie            — issued by the SPA on load (browser users)
//   3. Reverse-proxy header         — Authelia / Authentik / forward-auth
// Falls back to "local" so single-user setups keep working with no auth at all.
//
// Security boundary: proxy headers are TRUSTED. The proxy MUST strip them from
// incoming client requests before forwarding. If you expose this container
// directly without a proxy, anyone can spoof Remote-User and impersonate any
// user. Set TRUSTED_AUTH_HEADERS to restrict which header(s) are honored —
// e.g. TRUSTED_AUTH_HEADERS=remote-user for Authelia-only.
const TRUSTED_AUTH_HEADERS = (process.env.TRUSTED_AUTH_HEADERS ??
  'remote-user,x-authentik-username,x-forwarded-user,x-remote-user'
).toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

function pickAuthHeader(headers) {
  for (const name of TRUSTED_AUTH_HEADERS) {
    let v = headers[name];
    // Node represents repeat headers as arrays — take the first to avoid
    // arrays leaking into SQL bind parameters.
    if (Array.isArray(v)) v = v[0];
    if (typeof v !== 'string') continue;
    v = v.trim();
    // Whitelist: alphanum, dot, dash, underscore, @ — covers usernames and emails.
    // Rejects newlines, control chars, spaces, NULs, quotes — anything that
    // could break log lines or SQL. Also reject all-dot values ('.', '..', …):
    // userId is a directory tier in the attachment paths, so '..' would escape
    // the per-user receipts dir. No legitimate username/email is all dots.
    if (v && /^[A-Za-z0-9._@-]{1,128}$/.test(v) && !/^\.+$/.test(v)) return v;
  }
  return null;
}

// Resolves req.userId + req.authMethod from any of the trusted signals.
// Never rejects on its own — that's requireAuth's job. Two exceptions:
//   - An invalid Bearer token gets rejected immediately (a revoked key
//     should fail loudly, not silently downgrade to 'local')
function resolveAuth(req, res, next) {
  // 1. Bearer key — strongest signal
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && /^Bearer /i.test(authHeader)) {
    const key = authHeader.replace(/^Bearer /i, '').trim();
    if (key) {
      const row = stmts.findApiKeyByHash.get(hashApiKey(key));
      if (row) {
        req.userId = row.user_id;
        req.authMethod = 'bearer';
        req.apiKeyId = row.id;
        try { stmts.touchApiKey.run(Date.now(), row.id); } catch {}
        return next();
      }
      // Bearer was provided but didn't match any stored key.
      return res.status(401).json({ error: 'Invalid API key' });
    }
    return res.status(401).json({ error: 'Invalid API key' });
  }

  // Current proxy identity wins over a cookie left by a different account.
  const currentProxyUser = pickAuthHeader(req.headers);
  if (currentProxyUser) { req.userId = currentProxyUser; req.authMethod = 'proxy'; return next(); }

  // 2. Session cookie — for browser sessions
  const cookieToken = parseCookie(req.headers.cookie, 'bh_session');
  if (cookieToken) {
    const payload = verifyCookie(cookieToken);
    if (payload && payload.uid && payload.source !== 'proxy') {
      req.userId = payload.uid;
      req.authMethod = 'cookie';
      req.sessionPayload = payload;
      return next();
    }
    // Invalid/expired cookie — fall through, let other signals try.
  }

  // 3. Reverse-proxy header
  const proxyUser = pickAuthHeader(req.headers);
  if (proxyUser) {
    req.userId = proxyUser;
    req.authMethod = 'proxy';
    return next();
  }

  // 4. No auth identified
  req.userId = 'local';
  req.authMethod = 'fallback';
  next();
}

// Enforces authentication on /api/* routes. Only kicks in when the
// require-device-keys toggle is on; rejects requests whose only "auth"
// was the 'local' fallback.
function requireAuth(req, res, next) {
  if (!getRequireDeviceKeys()) return next();
  if (req.authMethod === 'fallback') {
    return res.status(401).json({
      error: 'Authentication required',
      hint: 'Generate an API key in the BillHive web UI under Settings → Devices, then add it to your iOS app.',
    });
  }
  next();
}

app.use(resolveAuth);

// Never cache private data or issue a host session to a public-link visitor.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/public/') || req.path.startsWith('/share/') || req.path === '/' || req.path === '/index.html') {
    res.setHeader('Cache-Control', 'no-store');
    res.vary('Cookie');
  }
  next();
});
// Browser write requests must originate from this origin. Native clients have
// no Origin/Fetch Metadata headers and continue to use bearer authentication.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const site = req.get('Sec-Fetch-Site');
  if (site && !['same-origin', 'none'].includes(site)) return res.status(403).json({ error: 'Cross-origin request rejected' });
  const expectedUser = req.get('X-BillHive-User');
  if (expectedUser && expectedUser !== req.userId) return res.status(409).json({ error: 'The signed-in account changed. Reload before saving.' });
  const origin = req.get('Origin');
  if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Cross-origin request rejected' });
  next();
});
// Exchange a device key for an HttpOnly browser session. The key stays out of
// browser storage; revoking the device key also invalidates its browser session.
app.post('/api/session', (req, res) => {
  if (req.authMethod !== 'bearer') return res.status(401).json({ error: 'A valid device key is required' });
  setSessionCookie(req, res, req.userId, 'key');
  res.json({ ok: true });
});

// Request logger (skip noisy static asset requests)
app.use((req, _res, next) => {
  if (req.path.startsWith('/api')) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} user=${req.userId}`);
  }
  next();
});

// ── Static frontend ───────────────────────────────────────────────────────────
// Serves index.html (and any future assets) from the /public directory
app.get(['/', '/index.html'], serveShell);
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '1h',
  index: false,
  setHeaders(res, file) { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); },
}));

// ── Health check ──────────────────────────────────────────────────────────────
// Public: never gated by requireAuth. The iOS app uses this during onboarding
// to test whether a server is reachable AND whether a Bearer key is required,
// before asking the user to paste a key.
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    user: req.userId,
    authMethod: req.authMethod,
    requireDeviceKeys: getRequireDeviceKeys(),
    capabilities: {syncProtocol: 1, guestSyncProtocol: 1, checkShareProtocol: 1, checkShareGuardProtocol: 1, attachmentProtocol: 1, backupRestoreProtocol: 1, revisionPreconditionsRequired: sync.requirePreconditions},
    ts: Date.now(),
  });
});

// ── No-account check share — PUBLIC endpoints ────────────────────────────────
// Anonymous read + claim flow for restaurant check splits. Hosts generate a
// link via POST /api/share/check/:checkId (auth required, see authed section
// below). Visitors with the link can fetch the check + post claims without an
// account. publicLimiter protects against token brute-force enumeration.

// Pull the check object out of the host's user_state JSON blob. Returns
// null if the user has no state, has no checks, or the requested check
// doesn't exist. Used by the public read endpoint and the authed share
// info endpoint.
// Public-safe shape: keep item names + prices + name + date, drop any
// payment / email metadata the host might add later. Participants list is
// kept because the page shows who's already on the check, but their
// linkedPersonId is dropped (no need to expose internal IDs).
function publicCheckShape(check) {
  return {
    id: check.id,
    name: check.name,
    dateISO: check.dateISO,
    items: (check.items || []).map(i => ({
      id: i.id,
      name: i.name,
      price: i.price,
    })),
    participants: (check.participants || []).map(p => ({
      id: p.id,
      name: p.name,
    })),
    taxAmount: check.taxAmount || 0,
    discountAmount: check.discountAmount || 0,
    compAmount: check.compAmount || 0,
    serviceFeeAmount: check.serviceFeeAmount || 0,
    tipAmount: check.tipAmount || 0,
  };
}

// Public sharing never returns owner credentials or the private household document.
app.get('/public/share/check/:token/sync/snapshot', publicLimiter, (req, res) => {
  const snapshot = checkSync.publicSnapshot(req.params.token);
  res.setHeader('ETag', checkSync.etag(snapshot)); res.json(snapshot);
});
app.post('/public/share/check/:token/sync/claim', publicLimiter, (req, res) => {
  const result = checkSync.claimCommit(req.params.token, req.get('X-BillHive-Claimant-Key'), req.body,
    {requireProtection:req.get('X-BillHive-Require-Protection') === '1'});
  if (result.response.snapshot) res.setHeader('ETag', checkSync.etag(result.response.snapshot));
  res.json(result.response);
  if (!result.response.replayed) broadcastChange(result.userId);
});

// Legacy clients retain their response shape. Strict mode requires the sharing
// ETag for writes; these old commands have no durable request receipt.
app.get('/public/share/check/:token', publicLimiter, (req, res) => {
  const snapshot = checkSync.publicSnapshot(req.params.token);
  res.setHeader('ETag', checkSync.etag(snapshot));
  res.json({check:snapshot.check,claims:snapshot.claims,createdAt:snapshot.createdAt,currencyCode:snapshot.currencyCode});
});
app.post('/public/share/check/:token/claim', publicLimiter, (req, res) => {
  const result = checkSync.claimLegacy(req.params.token, req.body, req.get('If-Match'));
  res.setHeader('ETag', checkSync.etag(result.snapshot)); res.json({ok:true});
  broadcastChange(result.userId);
});

// ── Trip invite public routes ────────────────────────────────────────────────
// Public-facing endpoints for trip invites. The invite token acts as both
// identity (which member) and auth (right to read/write the trip). Rate-
// limited via publicLimiter to prevent brute-force token scanning.

/// Extracts a trip from the owner's user_state by id. Returns null if
/// the owner or trip doesn't exist.
function getTripFromState(ownerUserId, tripId) {
  const row = stmts.getState.get(ownerUserId, 'trips');
  if (!row) return null;
  try {
    const tripsState = JSON.parse(row.value);
    const trips = tripsState.trips || [];
    return trips.find(t => t.id === tripId) || null;
  } catch { return null; }
}

/// Strips a trip down to the fields safe for public sharing.
function publicTripShape(trip) {
  return {
    id: trip.id,
    name: trip.name || '',
    startDateISO: trip.startDateISO || '',
    endDateISO: trip.endDateISO || '',
    currency: trip.currency || '',
    members: (trip.members || []).map(m => ({
      id: m.id,
      name: m.name || '',
    })),
    expenses: (trip.expenses || []).map(e => ({
      id: e.id,
      name: e.name || '',
      amount: e.amount || 0,
      paidByAmounts: e.paidByAmounts || {},
      splitBetweenIds: e.splitBetweenIds || [],
      dateISO: e.dateISO || '',
      category: e.category || 'other',
      customCategoryName: e.customCategoryName || '',
      customCategoryIconName: e.customCategoryIconName || '',
      sourceAmount: e.sourceAmount || 0,
      sourceCurrency: e.sourceCurrency || '',
      exchangeRate: e.exchangeRate || 1,
      exchangeRateTargetCurrency: e.exchangeRateTargetCurrency || '',
      exchangeRateIsLocked: e.exchangeRateIsLocked || false,
      exchangeRateDateISO: e.exchangeRateDateISO || '',
      exchangeRateSource: e.exchangeRateSource || '',
      notes: e.notes || '',
    })),
    notes: trip.notes || '',
    isArchived: trip.isArchived || false,
    settlements: (trip.settlements || []).map(s => ({id:s.id, fromMemberId:s.fromMemberId,
      toMemberId:s.toMemberId, amount:s.amount, settledAtISO:s.settledAtISO || '', notes:s.notes || '',
      ...(s.sourceActionId ? {sourceActionId:s.sourceActionId} : {})})),
    checklistItems: (trip.checklistItems || []).map(item => ({id:item.id,label:item.label || '',
      isDone:!!item.isDone,createdAtISO:item.createdAtISO || ''})),
  };
}

// ── Bills invite helpers ────────────────────────────────────────────────────
// SelfHive keeps the canonical bills state on this server, so invite links can
// compute the guest's current read-only snapshot instead of storing a stale copy.

function parseJSONValue(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function getStateJSON(userId, key, fallback) {
  const row = stmts.getState.get(userId, key);
  return row ? parseJSONValue(row.value, fallback) : fallback;
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getMonthJSON(userId, key) {
  const row = stmts.getMonth.get(userId, key);
  return row ? parseJSONValue(row.data, { totals: {}, amounts: {} }) : { totals: {}, amounts: {} };
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function billLines(bill) {
  return Array.isArray(bill?.lines) ? bill.lines : [];
}

function evenCentAmounts(lines, totalCents) {
  if (!lines.length) return {};
  const baseCents = Math.floor(totalCents / lines.length);
  const remainder = totalCents % lines.length;
  const extraStart = lines.length - remainder;
  const amounts = {};
  lines.forEach((line, index) => {
    const cents = baseCents + (index >= extraStart ? 1 : 0);
    amounts[line.id] = cents / 100;
  });
  return amounts;
}

function isAutoEvenPctDistribution(lines) {
  const count = lines.length;
  if (!count) return false;
  const exactShare = 100 / count;
  if (lines.every(line => Math.abs(finiteNumber(line.value) - exactShare) < 0.000001)) {
    return true;
  }
  const roundedShare = Math.round(exactShare * 100) / 100;
  const lastShare = 100 - (roundedShare * (count - 1));
  return lines.every((line, index) => {
    const expected = index === count - 1 ? lastShare : roundedShare;
    return Math.abs(finiteNumber(line.value) - expected) < 0.005001;
  });
}

function pctLineAmounts(bill, total) {
  const lines = billLines(bill);
  const totalCents = Math.max(0, Math.round(finiteNumber(total) * 100));
  if (!lines.length) return {};
  if (isAutoEvenPctDistribution(lines)) return evenCentAmounts(lines, totalCents);

  const amounts = {};
  let allocatedCents = 0;
  lines.slice(0, -1).forEach(line => {
    const cents = Math.max(0, Math.round(totalCents * finiteNumber(line.value) / 100));
    amounts[line.id] = cents / 100;
    allocatedCents += cents;
  });
  const last = lines[lines.length - 1];
  amounts[last.id] = Math.max(0, totalCents - allocatedCents) / 100;
  return amounts;
}

function billLineShares(bill, monthData) {
  const lines = billLines(bill);
  const amountMap = monthData?.amounts?.[bill.id] || {};
  const nonRemainderTotal = lines.reduce((total, line) => (
    line.id === bill.remainderLineId ? total : total + finiteNumber(amountMap[line.id])
  ), 0);
  const totals = monthData?.totals || {};
  const hasTotal = Object.prototype.hasOwnProperty.call(totals, bill.id);
  const billTotal = hasTotal ? finiteNumber(totals[bill.id]) : nonRemainderTotal;
  const pctAmounts = bill.splitType === 'pct' ? pctLineAmounts(bill, billTotal) : {};

  return lines.map(line => {
    let amount = 0;
    if (bill.splitType === 'pct') {
      amount = pctAmounts[line.id] || 0;
    } else if (line.id === bill.remainderLineId) {
      amount = Math.max(0, billTotal - nonRemainderTotal);
    } else {
      amount = finiteNumber(amountMap[line.id]);
    }
    return {
      line,
      payerId: line.coveredById || line.personId,
      amount,
    };
  });
}

function computeBillsPersonOwes(people, bills, monthData) {
  const byPerson = {};
  for (const bill of Array.isArray(bills) ? bills : []) {
    const billPayer = bill.paidById || 'me';
    for (const share of billLineShares(bill, monthData)) {
      const { line, payerId, amount } = share;
      if (amount <= 0) continue;

      if (billPayer === 'me') {
        if (payerId === 'me') continue;
        if (!byPerson[payerId]) byPerson[payerId] = { total: 0, bills: [] };
        let billName = bill.name || '';
        if (line.coveredById && line.coveredById !== line.personId) {
          const covered = people.find(person => person.id === line.personId);
          if (covered) billName += ` (covers ${covered.name})`;
        }
        byPerson[payerId].total += amount;
        byPerson[payerId].bills.push({ billId: bill.id, billName, amount });
      } else if (payerId === 'me') {
        if (!byPerson[billPayer]) byPerson[billPayer] = { total: 0, bills: [] };
        byPerson[billPayer].total -= amount;
        byPerson[billPayer].bills.push({ billId: bill.id, billName: bill.name || '', amount: -amount });
      }
    }
  }

  Object.values(byPerson).forEach(entry => {
    const consolidated = new Map();
    entry.bills.forEach(item => {
      const existing = consolidated.get(item.billId);
      if (existing) {
        existing.amount += item.amount;
      } else {
        consolidated.set(item.billId, { ...item });
      }
    });
    entry.bills = Array.from(consolidated.values()).sort((a, b) => a.billName.localeCompare(b.billName));
  });
  return byPerson;
}

function buildBillsInvitePayload(ownerUserId, personId) {
  const rawPeople = getStateJSON(ownerUserId, 'people', []);
  const people = Array.isArray(rawPeople) ? rawPeople : [];
  const bills = getStateJSON(ownerUserId, 'bills', []);
  const person = people.find(p => p.id === personId);
  if (!person) return null;

  const monthKey = currentMonthKey();
  const monthData = getMonthJSON(ownerUserId, monthKey);
  const ownerName = (people.find(p => p.id === 'me') || {}).name || 'Host';
  const owes = computeBillsPersonOwes(people, bills, monthData);
  const personOwes = owes[personId] || { total: 0, bills: [] };

  return {
    ownerName,
    personId,
    personName: person.name || '',
    monthKey,
    totalOwed: finiteNumber(personOwes.total),
    bills: personOwes.bills.map(item => ({
      name: item.billName,
      amount: finiteNumber(item.amount),
    })),
    payMethod: person.payMethod || 'none',
    payId: person.payId || '',
    zelleUrl: person.zelleUrl || null,
  };
}

function billsInviteInfoResponse(invite) {
  return {
    token: invite.token,
    personId: invite.person_id,
    joined: !!invite.joined_at,
    createdAt: invite.created_at,
  };
}

function billsInvitePreviewResponse(invite, payload) {
  return {
    ownerName: payload.ownerName,
    personId: payload.personId,
    personName: payload.personName,
    joined: !!invite.joined_at,
    createdAt: invite.created_at,
    monthSummary: {
      monthKey: payload.monthKey,
      totalOwed: payload.totalOwed,
      bills: payload.bills,
    },
  };
}

function sharedBillsDataResponse(payload) {
  return {
    ownerName: payload.ownerName,
    personName: payload.personName,
    monthKey: payload.monthKey,
    totalOwed: payload.totalOwed,
    bills: payload.bills,
    payMethod: payload.payMethod,
    payId: payload.payId,
    zelleUrl: payload.zelleUrl,
  };
}

// GET /public/trip/invite/:token — preview the trip before joining.
// Returns the trip data (stripped of host-only info) + invite metadata.
function readPublicTrip(req, {requireJoined = false, join = false} = {}) {
  return db.transaction(() => {
    const invite = stmts.findTripInviteByToken.get(req.params.token);
    if (!invite) throw new SyncError(404, 'INVITE_NOT_FOUND', 'Invite not found');
    if (invite.revoked_at) throw new SyncError(410, 'INVITE_REVOKED', 'This invite has been revoked');
    if (requireJoined && !invite.joined_at) throw new SyncError(403, 'INVITE_NOT_JOINED', 'Invite not yet accepted');
    const trip = getTripFromState(invite.owner_user_id, invite.trip_id);
    if (!trip) throw new SyncError(404, 'TRIP_NOT_FOUND', 'Trip not found');
    const member = (trip.members || []).find(item => item.id === invite.member_id);
    if (!member) throw new SyncError(410, 'MEMBER_REMOVED', 'This trip member was removed');
    if (join && !invite.joined_at) stmts.markTripInviteJoined.run(req.params.token);
    return {metadata:sync.metadata(invite.owner_user_id), payload:{
      trip:publicTripShape(trip), memberId:invite.member_id, memberName:member.name || '',
      joined:join || !!invite.joined_at, createdAt:invite.created_at,
    }};
  }).immediate();
}
app.get('/public/trip/invite/:token', publicLimiter, (req, res) => {
  const result = readPublicTrip(req);
  res.setHeader('ETag', sync.etag(result.metadata));res.json(result.payload);
});
app.post('/public/trip/invite/:token/join', publicLimiter, (req, res) => {
  const result = readPublicTrip(req, {join:true});
  res.setHeader('ETag', sync.etag(result.metadata));res.json({ok:true,...result.payload});
});
app.get('/public/trip/invite/:token/trip', publicLimiter, (req, res) => {
  const result = readPublicTrip(req, {requireJoined:true});
  res.setHeader('ETag', sync.etag(result.metadata));res.json({trip:result.payload.trip});
});

app.get('/public/trip/invite/:token/sync/snapshot', publicLimiter, (req, res) => {
  const snapshot = guestSync.snapshot(req.params.token);
  res.setHeader('ETag', sync.etag(snapshot));
  res.json(snapshot);
});
app.post('/public/trip/invite/:token/sync/commit', publicLimiter, (req, res) => {
  const result = guestSync.commit(req.params.token, req.body, {requireProtection:req.get('X-BillHive-Require-Protection') === '1'});
  if (result.response.snapshot) res.setHeader('ETag', sync.etag(result.response.snapshot));
  res.json(result.response);
  if (!result.response.replayed) broadcastChange(result.userId);
});

// POST /public/trip/invite/:token/expense — add or update an expense on
// the shared trip. Body: a full Expense object. If an expense with the
// same id already exists, it's replaced (update); otherwise it's appended.
function guestTripWrite(req, res, update) {
  const invite = stmts.findTripInviteByToken.get(req.params.token);
  if (!invite) return res.status(404).json({error:'Invite not found'});
  legacyWrite(req, res, () => {
    // Recheck authorization inside the same transaction as the owner's revision and mutation.
    const current = stmts.findTripInviteByToken.get(req.params.token);
    if (!current || current.revoked_at) throw new SyncError(410, 'INVITE_REVOKED', 'This invite has been revoked');
    if (!current.joined_at) throw new SyncError(403, 'INVITE_NOT_JOINED', 'Invite not yet accepted');
    const row = stmts.getState.get(current.owner_user_id, 'trips');
    if (!row) throw new SyncError(404, 'TRIP_NOT_FOUND', 'Trip not found');
    const tripsState = JSON.parse(row.value);
    const trip = (tripsState.trips || []).find(item => item.id === current.trip_id);
    if (!trip) throw new SyncError(404, 'TRIP_NOT_FOUND', 'Trip not found');
    if (trip.isArchived) throw new SyncError(409, 'TRIP_ARCHIVED', 'This trip is archived');
    if (!(trip.members || []).some(member => member.id === current.member_id)) throw new SyncError(410, 'MEMBER_REMOVED', 'This trip member was removed');
    update(trip);
    Data.state({trips:tripsState});
    stmts.setState.run(current.owner_user_id, 'trips', JSON.stringify(tripsState));
  }, invite.owner_user_id);
}

app.post('/public/trip/invite/:token/expense', publicLimiter, (req, res) => {
  try { Data.tree(req.body); } catch (_) { return res.status(400).json({error:'Invalid expense payload'}); }
  const expense = req.body;
  if (!expense || !expense.id || typeof expense.name !== 'string') return res.status(400).json({error:'Invalid expense payload'});
  guestTripWrite(req, res, trip => {
    const expenses = trip.expenses || [];
    const index = expenses.findIndex(item => item.id === expense.id);
    if (index >= 0) expenses[index] = expense; else expenses.unshift(expense);
    trip.expenses = expenses;
  });
});

app.delete('/public/trip/invite/:token/expense/:expenseId', publicLimiter, (req, res) => {
  guestTripWrite(req, res, trip => { trip.expenses = (trip.expenses || []).filter(item => item.id !== req.params.expenseId); });
});

app.post('/public/trip/invite/:token/settlement', publicLimiter, (req, res) => {
  try { Data.tree(req.body); } catch (_) { return res.status(400).json({error:'Invalid settlement payload'}); }
  const settlement = req.body;
  if (!settlement || !settlement.id) return res.status(400).json({error:'Invalid settlement payload'});
  guestTripWrite(req, res, trip => {
    const settlements = trip.settlements || [];
    const existing = settlements.find(item => item.id === settlement.id);
    if (existing && !require('node:util').isDeepStrictEqual(existing, settlement)) throw new SyncError(409, 'SETTLEMENT_ID_REUSED', 'This settlement ID already exists');
    if (!existing) settlements.push(settlement);
    trip.settlements = settlements;
  });
});

// ── Bills invite public routes ───────────────────────────────────────────────
// Public-facing endpoints for household bills invites. The token identifies
// one invited person and authorizes read-only access to that person's snapshot.

// GET /public/bills/invite/:token — preview the invite before joining.
app.get('/public/bills/invite/:token', publicLimiter, (req, res) => {
  const invite = stmts.findBillsInviteByToken.get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.revoked_at) return res.status(410).json({ error: 'This invite has been revoked' });

  const payload = buildBillsInvitePayload(invite.owner_user_id, invite.person_id);
  if (!payload) return res.status(404).json({ error: 'Person not found' });
  res.json(billsInvitePreviewResponse(invite, payload));
});

// POST /public/bills/invite/:token/join — claim the invite. Idempotent.
app.post('/public/bills/invite/:token/join', publicLimiter, (req, res) => {
  const invite = stmts.findBillsInviteByToken.get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.revoked_at) return res.status(410).json({ error: 'This invite has been revoked' });

  if (!invite.joined_at) {
    stmts.markBillsInviteJoined.run(req.params.token);
  }

  const updatedInvite = stmts.findBillsInviteByToken.get(req.params.token) || invite;
  const payload = buildBillsInvitePayload(updatedInvite.owner_user_id, updatedInvite.person_id);
  if (!payload) return res.status(404).json({ error: 'Person not found' });
  broadcastChange(updatedInvite.owner_user_id);
  res.json({
    ok: true,
    personId: payload.personId,
    personName: payload.personName,
    ownerName: payload.ownerName,
  });
});

// GET /public/bills/invite/:token/data — read the joined person's bill snapshot.
app.get('/public/bills/invite/:token/data', publicLimiter, (req, res) => {
  const invite = stmts.findBillsInviteByToken.get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.revoked_at) return res.status(410).json({ error: 'This invite has been revoked' });

  const payload = buildBillsInvitePayload(invite.owner_user_id, invite.person_id);
  if (!payload) return res.status(404).json({ error: 'Person not found' });
  res.json(sharedBillsDataResponse(payload));
});

// GET /share/:token — serves the static claim page. Has to be registered
// BEFORE the SPA fallback so /share/* doesn't fall through to index.html.
app.get('/share/:token', publicLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// ── Enforce auth on the rest of /api/* ────────────────────────────────────────
// Anything below this line requires authentication when the toggle is on.
app.use('/api', requireAuth);

// ── State API ─────────────────────────────────────────────────────────────────
// GET  /api/state       — returns all key/value pairs for the current user
// PUT  /api/state       — bulk upsert of multiple keys (used by the frontend's
//                         debounced save — sends settings, people, bills, checklist)
// PATCH /api/state/:key — upsert a single key (used for targeted updates)
//
// The frontend's save flow: user input → mutate S → debounced save() (600ms) →
// PUT /api/state → server broadcasts SSE → other tabs reload.
app.get('/api/sync/snapshot', (req, res) => {
  const snapshot = sync.snapshot(req.userId);
  res.setHeader('ETag', sync.etag(snapshot));
  res.json(snapshot);
});
app.post('/api/sync/commit', (req, res) => {
  if (req.get('X-BillHive-Require-Protection') === '1' && !sync.requirePreconditions) throw new SyncError(428, 'PROTECTION_DISABLED', 'Enable server revision protection before saving with this client.');
  const result = sync.commit(req.userId, req.body);
  res.setHeader('ETag', sync.etag(result));
  res.json(result);
  if (!result.replayed) broadcastChange(req.userId);
});
app.post('/api/sync/restore/validate', (req,res) => {
  res.json(sync.validateRestore(req.userId,req.body,state => attachments.missingForRestore(req.userId,state)));
});

function legacyWrite(req, res, operation, userId = req.userId) {
  const result = sync.write(userId, req.get('If-Match'), operation);
  res.setHeader('ETag', sync.etag(result.metadata));
  res.json(result.value ?? {ok:true});
  broadcastChange(userId);
}

app.get('/api/state', (req, res) => {
  const snapshot = sync.snapshot(req.userId);
  res.setHeader('ETag', sync.etag(snapshot));
  res.json(snapshot.state);
});

app.put('/api/state', (req, res) => {
  const body = req.body;
  try { Data.state(body); } catch (error) { return res.status(400).json({ error: error.message }); }

  legacyWrite(req, res, () => {
    for (const [key, val] of Object.entries(body)) stmts.setState.run(req.userId, key, JSON.stringify(val));
  });
});

app.patch('/api/state/:key', (req, res) => {
  try { Data.state({ [req.params.key]: req.body }); } catch (error) { return res.status(400).json({ error: error.message }); }
  legacyWrite(req, res, () => { stmts.setState.run(req.userId, req.params.key, JSON.stringify(req.body)); });
});

// ── Monthly data API ──────────────────────────────────────────────────────────
// GET  /api/months       — all months for trend charts and history log
// GET  /api/months/:key  — single month (YYYY-MM format)
// PUT  /api/months/:key  — upsert a month's data (totals, amounts, computed owes)
// DELETE /api/months/:key — remove a month's data entirely
app.get('/api/months', (req, res) => {
  const snapshot = sync.snapshot(req.userId);
  res.setHeader('ETag', sync.etag(snapshot));
  res.json(snapshot.monthly);
});

app.get('/api/months/:key', (req, res) => {
  const snapshot = sync.snapshot(req.userId);
  res.setHeader('ETag', sync.etag(snapshot));
  res.json(snapshot.monthly[req.params.key] || {});
});

app.put('/api/months/:key', (req, res) => {
  const key = req.params.key;
  // Validate format to prevent arbitrary keys from polluting the table
  if (!Data.monthKey(key)) return res.status(400).json({ error: 'Invalid month key (expected YYYY-MM)' });
  try { Data.month(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
  legacyWrite(req, res, () => { stmts.setMonth.run(req.userId, key, JSON.stringify(req.body)); });
});

app.delete('/api/months/:key', (req, res) => {
  if (!Data.monthKey(req.params.key)) return res.status(400).json({error:'Invalid month key'});
  legacyWrite(req, res, () => { stmts.deleteMonth.run(req.userId, req.params.key); });
});

// ── Export / Import ───────────────────────────────────────────────────────────
// GET  /api/export — download a full JSON backup of all state + monthly data.
//                    Scoped to the current user — won't leak other users' data.
// POST /api/import — restore from a backup file. Merges into existing data
//                    (upsert semantics) so it won't delete months/keys that
//                    aren't in the backup.
app.get('/api/export', (req, res) => {
  const snapshot = sync.snapshot(req.userId);
  res.setHeader('ETag', sync.etag(snapshot));
  res.setHeader('Content-Disposition', `attachment; filename="billhive-backup-${req.userId}-${Date.now()}.json"`);
  res.json({user:req.userId, exportedAt:new Date().toISOString(), state:snapshot.state, monthly:snapshot.monthly});
});

app.post('/api/import', (req, res) => {
  try { Data.backup(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
  const { state, monthly } = req.body;
  // Whitelist state keys we manage; reject anything else so a crafted backup
  // can't pollute user_state with arbitrary rows.
  const ALLOWED_STATE_KEYS = new Set(['settings', 'people', 'bills', 'checklist', 'requestDates', 'checks', 'trips', 'sharedBills', 'currentMode', 'hasSeenModeHint', 'webPreferences']);
  const importAll = db.transaction((userId, s, m) => {
    if (s && typeof s === 'object') {
      for (const [k, v] of Object.entries(s)) {
        if (!ALLOWED_STATE_KEYS.has(k)) continue;
        stmts.setState.run(userId, k, JSON.stringify(v));
      }
    }
    if (m && typeof m === 'object') {
      for (const [k, v] of Object.entries(m)) {
        if (!/^\d{4}-\d{2}$/.test(k)) continue;
        stmts.setMonth.run(userId, k, JSON.stringify(v));
      }
    }
  });
  legacyWrite(req, res, () => { importAll(req.userId, state, monthly); });
});

// Clear editable setup and revoke links together; history/files/relay settings
// deliberately remain. The web confirmation describes that exact scope.
app.post('/api/reset-setup', (req, res) => {
  legacyWrite(req, res, () => {
    db.prepare('DELETE FROM user_state WHERE user_id = ?').run(req.userId);
    stmts.setState.run(req.userId, 'people', '[]');
    stmts.setState.run(req.userId, 'bills', '[]');
    db.prepare('UPDATE share_checks SET revoked_at = unixepoch() WHERE user_id = ? AND revoked_at IS NULL').run(req.userId);
    db.prepare('UPDATE trip_invites SET revoked_at = unixepoch() WHERE owner_user_id = ? AND revoked_at IS NULL').run(req.userId);
    db.prepare('UPDATE bills_invites SET revoked_at = unixepoch() WHERE owner_user_id = ? AND revoked_at IS NULL').run(req.userId);
  });
});

// ── Check share links (AUTH) ─────────────────────────────────────────────────
// Host-side endpoints for managing no-account share links. The public-facing
// `/public/share/check/*` and `/share/:token` routes live above (before the
// requireAuth gate). The token + URL returned by POST is what the iOS app
// drops into the iOS share sheet.
//
// PUBLIC_BASE_URL env var lets self-hosters set the URL that gets embedded
// in share links (e.g. https://billhive.example.com). Falls back to deriving
// from the inbound request, which is correct when the user clicks Share from
// the same network they're hosting on but wrong behind a reverse proxy with
// a different external hostname — hence the env override.
function publicBaseURL(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function shareInfoResponse(share, req) {
  return {...share,url:`${publicBaseURL(req)}/share/${share.token}`};
}
function ownerShareResponse(snapshot, req) {
  // This is routing metadata, not part of the share revision: a self-hoster may
  // change PUBLIC_BASE_URL without changing the check, token or guest claims.
  return {...snapshot,shareUrl:snapshot.share ? shareInfoResponse(snapshot.share,req).url : null};
}

app.get('/api/share/check/:checkId/sync/snapshot', (req, res) => {
  const snapshot = checkSync.ownerSnapshot(req.userId, req.params.checkId);
  res.setHeader('ETag', checkSync.etag(snapshot)); res.json(ownerShareResponse(snapshot,req));
});
app.post('/api/share/check/:checkId/sync/commit', (req, res) => {
  const result = checkSync.ownerCommit(req.userId, req.params.checkId, req.body,
    {requireProtection:req.get('X-BillHive-Require-Protection') === '1'});
  res.setHeader('ETag', checkSync.etag(result.snapshot)); res.json({...result,snapshot:ownerShareResponse(result.snapshot,req)});
  if (!result.replayed) broadcastChange(req.userId);
});

app.post('/api/share/check/:checkId', (req, res) => {
  const kind = req.query.rotate === '1' || req.query.rotate === 'true' ? 'rotate' : 'create';
  const result = checkSync.ownerLegacy(req.userId, req.params.checkId, kind, req.get('If-Match'));
  res.setHeader('ETag', checkSync.etag(result.snapshot)); res.json(shareInfoResponse(result.snapshot.share, req));
  broadcastChange(req.userId);
});
app.get('/api/share/check/:checkId', (req, res) => {
  const snapshot = checkSync.ownerSnapshot(req.userId, req.params.checkId);
  res.setHeader('ETag', checkSync.etag(snapshot));
  if (!snapshot.share) return res.status(404).json({error:'No active share'});
  res.json(shareInfoResponse(snapshot.share, req));
});
app.delete('/api/share/check/:checkId', (req, res) => {
  const result = checkSync.ownerLegacy(req.userId, req.params.checkId, 'revoke', req.get('If-Match'));
  res.setHeader('ETag', checkSync.etag(result.snapshot)); res.json({ok:true});
  broadcastChange(req.userId);
});


// ── Trip invite links (AUTH) ─────────────────────────────────────────────────
// Host-side endpoints for managing per-member trip invites. Same pattern as
// check share links: POST creates, GET lists, DELETE revokes. The public-
// facing endpoints live above the auth gate.

// POST /api/trips/:tripId/invite — create a per-member invite link.
// Body: { memberId }. Idempotent if an active invite already exists for
// this member — returns the existing token. Pass ?rotate=1 to revoke any
// prior invite for that member and mint a fresh one.
app.post('/api/trips/:tripId/invite', (req, res) => {
  const { tripId } = req.params;
  const { memberId } = req.body || {};
  if (!memberId) return res.status(400).json({ error: 'memberId is required' });

  const trip = getTripFromState(req.userId, tripId);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!(trip.members || []).find(m => m.id === memberId)) {
    return res.status(404).json({ error: 'Member not found on this trip' });
  }

  const rotate = req.query.rotate === '1' || req.query.rotate === 'true';
  if (!rotate) {
    const existing = stmts.findActiveInviteForMember.get(req.userId, tripId, memberId);
    if (existing) {
      return res.json({
        token: existing.token,
        memberId: existing.member_id,
        joined: !!existing.joined_at,
        createdAt: existing.created_at,
      });
    }
  } else {
    stmts.revokeTripInvite.run(req.userId, tripId, memberId);
  }

  const token = crypto.randomBytes(24).toString('base64url');
  stmts.insertTripInvite.run(token, req.userId, tripId, memberId);
  const invite = stmts.findTripInviteByToken.get(token);
  res.json({
    token: invite.token,
    memberId: invite.member_id,
    joined: !!invite.joined_at,
    createdAt: invite.created_at,
  });
});

// GET /api/trips/:tripId/invites — list all active invites for a trip.
app.get('/api/trips/:tripId/invites', (req, res) => {
  const invites = stmts.listInvitesForTrip.all(req.userId, req.params.tripId);
  res.json(invites.map(inv => ({
    token: inv.token,
    memberId: inv.member_id,
    joined: !!inv.joined_at,
    createdAt: inv.created_at,
  })));
});

// DELETE /api/trips/:tripId/invite/:memberId — revoke an invite for a
// specific member. The member immediately loses access on their next request.
app.delete('/api/trips/:tripId/invite/:memberId', (req, res) => {
  stmts.revokeTripInvite.run(req.userId, req.params.tripId, req.params.memberId);
  res.json({ ok: true });
});

// DELETE /api/trips/:tripId/invites — revoke ALL invites for a trip.
app.delete('/api/trips/:tripId/invites', (req, res) => {
  stmts.revokeAllTripInvites.run(req.userId, req.params.tripId);
  res.json({ ok: true });
});


// ── Bills invite links (AUTH) ────────────────────────────────────────────────
// Host-side endpoints for managing per-person household bills invites.

// POST /api/bills/invite — create a per-person invite link.
// Body: { personId }. Idempotent if an active invite already exists for
// this person. Pass ?rotate=1 to revoke any prior invite and mint a fresh one.
app.post('/api/bills/invite', (req, res) => {
  const { personId } = req.body || {};
  if (!personId) return res.status(400).json({ error: 'personId is required' });

  const payload = buildBillsInvitePayload(req.userId, personId);
  if (!payload) return res.status(404).json({ error: 'Person not found' });

  const rotate = req.query.rotate === '1' || req.query.rotate === 'true';
  if (!rotate) {
    const existing = stmts.findActiveBillsInviteForPerson.get(req.userId, personId);
    if (existing) return res.json(billsInviteInfoResponse(existing));
  } else {
    stmts.revokeBillsInvite.run(req.userId, personId);
  }

  const token = crypto.randomBytes(24).toString('base64url');
  stmts.insertBillsInvite.run(token, req.userId, personId);
  const invite = stmts.findBillsInviteByToken.get(token);
  res.json(billsInviteInfoResponse(invite));
});

// GET /api/bills/invites — list all active household bills invites.
app.get('/api/bills/invites', (req, res) => {
  const invites = stmts.listBillsInvitesForOwner.all(req.userId);
  res.json(invites.map(billsInviteInfoResponse));
});

// DELETE /api/bills/invite/:personId — revoke an invite for one person.
app.delete('/api/bills/invite/:personId', (req, res) => {
  stmts.revokeBillsInvite.run(req.userId, req.params.personId);
  res.json({ ok: true });
});


// ── Email config API ──────────────────────────────────────────────────────────
// GET /api/email/config — returns masked config (never exposes secrets)
app.get('/api/email/config', (req, res) => {
  const row = stmts.getEmailCfg.get(req.userId);
  if (!row) return res.json(null);
  try {
    const cfg = JSON.parse(row.config);
    res.json(maskConfig(cfg));
  } catch { res.json(null); }
});

// PUT /api/email/config — save full config including secrets.
// Because the GET endpoint returns masked secrets (e.g. "SG.••••••••"), the
// frontend might send those masked values back unchanged. To avoid overwriting
// the real secret with dots, we detect masked values and keep the original.
app.put('/api/email/config', (req, res) => {
  const body = req.body;
  if (!body || !body.provider) return res.status(400).json({ error: 'provider required' });

  // Load existing config for merge — allows partial updates without losing fields
  let existing = {};
  const row = stmts.getEmailCfg.get(req.userId);
  if (row) { try { existing = JSON.parse(row.config); } catch {} }

  // Merge new values on top of existing, then fix up any masked secrets
  const secretFields = ['mailgunApiKey','sendgridApiKey','resendApiKey','smtpPass'];
  const merged = { ...existing, ...body };
  secretFields.forEach(f => {
    if (body[f] && body[f].includes('••••')) {
      merged[f] = existing[f]; // keep original — user didn't change this field
    }
  });

  stmts.setEmailCfg.run(req.userId, JSON.stringify(merged));
  res.json({ ok: true });
});

// POST /api/email/test — send a test email to the configured from address
app.post('/api/email/test', emailLimiter, async (req, res) => {
  const row = stmts.getEmailCfg.get(req.userId);
  if (!row) return res.status(400).json({ error: 'No email config saved' });
  let cfg;
  try { cfg = JSON.parse(row.config); } catch { return res.status(400).json({ error: 'Invalid config' }); }
  const { html, text } = buildEmailHtml({
    greeting: 'Hey there,',
    personName: 'You',
    accentColor: '#F5A800',
    monthLabel: 'Test Email',
    bills: [{ name: 'Electric', amount: 85.00 }, { name: 'Internet', amount: 59.99 }],
    total: 144.99,
    payMethod: 'none',
    fromName: cfg.fromName || 'BillHive',
  });
  try {
    await sendEmail(cfg, cfg.fromEmail, 'BillHive — Test Email', html, text);
    res.json({ ok: true, message: `Test email sent to ${cfg.fromEmail}` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/send — send bill summary to a person
app.post('/api/email/send', emailLimiter, async (req, res) => {
  const { to, greeting, personName, accentColor, monthLabel, bills, total, payMethod, payId, zelleUrl, currencyCode } = req.body;
  if (!to) return res.status(400).json({ error: 'recipient (to) required' });

  const row = stmts.getEmailCfg.get(req.userId);
  if (!row) return res.status(400).json({ error: 'No email provider configured. Set it up in Settings → Email.' });
  let cfg;
  try { cfg = JSON.parse(row.config); } catch { return res.status(400).json({ error: 'Invalid email config' }); }

  const { html, text } = buildEmailHtml({
    greeting, personName, accentColor,
    monthLabel, bills, total, payMethod, payId, zelleUrl,
    fromName: cfg.fromName || 'BillHive',
    currencyCode: currencyCode || 'USD',
  });

  const subject = `Bills for ${monthLabel}`;
  try {
    await sendEmail(cfg, to, subject, html, text);
    res.json({ ok: true });
  } catch(e) {
    console.error('Email send failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API keys (per-device tokens for iOS clients) ─────────────────────────────
// All endpoints scope by req.userId — a user can only manage their own keys.
// Plaintext keys are returned ONLY at creation time; everything else exposes
// only the prefix (first 12 chars) for identification in the UI.

app.get('/api/keys', (req, res) => {
  const rows = stmts.listApiKeysForUser.all(req.userId);
  res.json(rows.map(r => ({
    id:          r.id,
    name:        r.name,
    keyPrefix:   r.key_prefix,
    createdAt:   r.created_at,
    lastUsedAt:  r.last_used_at,
  })));
});

app.post('/api/keys', (req, res) => {
  const rawName = (req.body && typeof req.body.name === 'string') ? req.body.name.trim() : '';
  const name = rawName.slice(0, 64) || 'Unnamed device';
  const key = generateApiKey();
  const id = generateApiKeyId();
  const prefix = key.slice(0, 12); // "bh_live_xxxx"
  try {
    stmts.insertApiKey.run(id, req.userId, name, hashApiKey(key), prefix);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to create key' });
  }
  // Plaintext key is returned exactly once — the client must save it now.
  res.json({
    id,
    name,
    key,
    keyPrefix: prefix,
    createdAt: Math.floor(Date.now() / 1000),
  });
  broadcastChange(req.userId);
});

app.delete('/api/keys/:id', (req, res) => {
  const result = stmts.deleteApiKey.run(req.params.id, req.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Key not found' });
  res.json({ ok: true });
  broadcastChange(req.userId);
});

// ── Auth settings (server-wide toggle) ────────────────────────────────────────
app.get('/api/auth/settings', (req, res) => {
  const row = stmts.countApiKeysForUser.get(req.userId);
  res.json({
    requireDeviceKeys: getRequireDeviceKeys(),
    canManage: AUTH_ADMIN_USERS.has(req.userId) && req.authMethod !== 'bearer' && req.sessionPayload?.source !== 'key',
    deviceKeyCount:    row ? row.c : 0,
  });
});

app.put('/api/auth/settings', (req, res) => {
  if (!req.body || typeof req.body.requireDeviceKeys !== 'boolean') {
    return res.status(400).json({ error: 'requireDeviceKeys (boolean) required' });
  }
  if (!AUTH_ADMIN_USERS.has(req.userId) || req.authMethod === 'bearer' || req.sessionPayload?.source === 'key') return res.status(403).json({ error: 'Use a trusted browser administrator session to change authentication settings' });
  if (req.body.requireDeviceKeys && !stmts.countApiKeysForUser.get(req.userId).c) return res.status(400).json({ error: 'Create and save a device key before requiring authentication' });
  setRequireDeviceKeys(req.body.requireDeviceKeys);
  if (req.authMethod !== 'proxy') setSessionCookie(req, res, req.userId, 'setup');
  const row = stmts.countApiKeysForUser.get(req.userId);
  res.json({
    requireDeviceKeys: getRequireDeviceKeys(),
    canManage: AUTH_ADMIN_USERS.has(req.userId) && req.authMethod !== 'bearer' && req.sessionPayload?.source !== 'key',
    deviceKeyCount:    row ? row.c : 0,
  });
  broadcastChange(req.userId);
});

// ── SSE event stream ─────────────────────────────────────────────────────────
// The frontend opens a persistent EventSource connection to this endpoint.
// When any write occurs (state save, month update, import), broadcastChange()
// pushes a `data-changed` event. The client-side handler then reloads from
// the API — but only if no input is currently focused (to avoid disrupting typing).
//
// EventSource auto-reconnects on network errors, so no manual retry logic is
// needed server-side. The `connected` event is sent immediately so the client
// knows the connection is live.
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');

  // Register this response object for future broadcasts
  if (!sseClients.has(req.userId)) sseClients.set(req.userId, new Set());
  sseClients.get(req.userId).add(res);

  // Clean up on disconnect — remove from Set, and delete the Map entry if
  // this was the last client for this user (prevents memory leak).
  req.on('close', () => {
    const clients = sseClients.get(req.userId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(req.userId);
    }
  });
});

// ── Trip attachments ─────────────────────────────────────────────────────────
// Managed uploads stage immutable bytes. A later revision-checked household save
// publishes the descriptor; unreferenced uploads cannot be downloaded.
function attachmentIdentity(req) {
  return {userId:req.get('X-BillHive-User'),serverInstanceId:req.get('X-BillHive-Server'),householdId:req.get('X-BillHive-Household')};
}
function sendManagedAttachment(res, row) {
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
  res.attachment(row.filename); res.setHeader('Content-Type','application/octet-stream');
  res.setHeader('X-Attachment-SHA256',row.sha256); res.setHeader('ETag',`"sha256:${row.sha256}"`);
  res.send(row.bytes);
}
app.put('/api/sync/attachments/:kind/:tripId/:recordId/:filename', express.raw({type:'application/octet-stream',limit:'10mb'}), (req,res) => {
  const scope = attachments.scope(req.params.kind,req.params.tripId,req.params.recordId,req.params.filename);
  res.json(attachments.upload(req.userId,scope,attachmentIdentity(req),
    {id:req.get('X-Attachment-Id'),mimeType:req.get('X-Attachment-Type'),sha256:req.get('X-Attachment-SHA256')},req.body));
});
app.put('/api/sync/restore/attachments/:kind/:tripId/:recordId/:filename', express.raw({type:'application/octet-stream',limit:'10mb'}), (req,res) => {
  const revision = req.get('X-BillHive-Revision');
  if (!revision || !/^(0|[1-9][0-9]*)$/.test(revision)) throw new SyncError(400,'INVALID_RESTORE','A restore revision is required.');
  const scope = attachments.scope(req.params.kind,req.params.tripId,req.params.recordId,req.params.filename);
  res.json(attachments.upload(req.userId,scope,attachmentIdentity(req),
    {id:req.get('X-Attachment-Id'),mimeType:req.get('X-Attachment-Type'),sha256:req.get('X-Attachment-SHA256')},req.body,Number(revision)));
});
app.get('/api/sync/attachments/:kind/:tripId/:recordId/:filename', (req,res) => {
  const scope = attachments.scope(req.params.kind,req.params.tripId,req.params.recordId,req.params.filename);
  sendManagedAttachment(res,attachments.download(req.userId,scope,attachmentIdentity(req)));
});

// Per-expense receipt images and per-itinerary files, stored on disk alongside
// the SQLite database. The attachment *metadata* (id, filename, mimeType) lives
// inside the Trip JSON in user_state and syncs automatically. These endpoints
// sync the actual bytes so SelfHive users get attachments on every device.
//
// Storage layout: <DATA_DIR>/trip-receipts/<userId>/<expenseId>/<filename>.jpg
// The userId tier prevents users from reading each other's receipts.

// Sanitize filenames to alphanumeric + dash + dot only. Rejects path traversal
// sequences (../, /, backslash) and any characters outside the whitelist.
function sanitizeFilename(name) {
  if (typeof name !== 'string') return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9.\-]*$/.test(name)) return null;
  const cleaned = name;
  // Must have content, must not be just dots, must end in a safe extension
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('.')) return null;
  if (cleaned.length > 255) return null;
  return cleaned;
}

// Sanitize path segments (tripId, expenseId) — same whitelist but no dots allowed.
function sanitizePathSegment(seg) {
  if (typeof seg !== 'string') return null;
  if (!/^[A-Za-z0-9\-]+$/.test(seg)) return null;
  const cleaned = seg;
  if (!cleaned) return null;
  if (cleaned.length > 128) return null;
  return cleaned;
}

// Resolves the receipts directory for a given user + expense, creating it lazily.
function receiptsDir(userId, expenseId) {
  const dir = path.join(dataDir, 'trip-receipts', userId, expenseId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function itineraryAttachmentsDir(userId, eventId) {
  const dir = path.join(dataDir, 'trip-itinerary-attachments', userId, eventId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// POST /api/trips/:tripId/expenses/:expenseId/attachments
// Upload a JPEG receipt image. The attachmentId is passed via the
// X-Attachment-Id header (the iOS client generates the UUID). The raw
// image bytes are the request body (Content-Type: image/*).
app.post('/api/trips/:tripId/expenses/:expenseId/attachments',
  express.raw({ type: 'image/*', limit: '2mb' }),
  (req, res) => {
    const expenseId = sanitizePathSegment(req.params.expenseId);
    if (!expenseId) return res.status(400).json({ error: 'Invalid expenseId' });

    const attachmentId = sanitizePathSegment(req.headers['x-attachment-id']);
    if (!attachmentId) return res.status(400).json({ error: 'X-Attachment-Id header required' });

    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'Empty body — expected image data' });
    }

    const filename = `${attachmentId}.jpg`;
    if (attachments.isManagedLegacyPath(req.userId,'expenses',expenseId,filename)) throw new SyncError(409,'IMMUTABLE_ATTACHMENT','Managed attachment content cannot be overwritten.');
    const dir = receiptsDir(req.userId, expenseId);
    const filePath = path.join(dir, filename);

    try {
      fs.writeFileSync(filePath, req.body);
    } catch (e) {
      console.error('Attachment write failed:', e.message);
      return res.status(500).json({ error: 'Failed to save attachment' });
    }

    res.json({ ok: true, attachmentId, filename });
  }
);

// GET /api/trips/:tripId/expenses/:expenseId/attachments/:filename
// Serve a receipt image. Returns 404 if the file doesn't exist.
app.get('/api/trips/:tripId/expenses/:expenseId/attachments/:filename', (req, res) => {
  const expenseId = sanitizePathSegment(req.params.expenseId);
  if (!expenseId) return res.status(400).json({ error: 'Invalid expenseId' });

  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: 'Invalid filename' });

  if (attachments.isManagedLegacyPath(req.userId,'expenses',expenseId,filename)) {
    return sendManagedAttachment(res,attachments.download(req.userId,attachments.scope('expenses',req.params.tripId,expenseId,filename)));
  }

  const filePath = path.join(dataDir, 'trip-receipts', req.userId, expenseId, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Attachment not found' });

  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
  res.attachment(filename);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(filePath);
});

// DELETE /api/trips/:tripId/expenses/:expenseId/attachments/:filename
// Delete a receipt image from disk. Returns 200 even if the file was already
// gone (idempotent delete — the client may retry after a network hiccup).
app.delete('/api/trips/:tripId/expenses/:expenseId/attachments/:filename', (req, res) => {
  const expenseId = sanitizePathSegment(req.params.expenseId);
  if (!expenseId) return res.status(400).json({ error: 'Invalid expenseId' });

  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: 'Invalid filename' });
  if (attachments.isManagedLegacyPath(req.userId,'expenses',expenseId,filename)) throw new SyncError(409,'IMMUTABLE_ATTACHMENT','Remove the attachment reference with a revision-checked household save.');

  const filePath = path.join(dataDir, 'trip-receipts', req.userId, expenseId, filename);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('Attachment delete failed:', e.message);
    return res.status(500).json({ error: 'Failed to delete attachment' });
  }

  res.json({ ok: true });
});

// POST /api/trips/:tripId/itinerary/:eventId/attachments
// Upload an itinerary attachment. The iOS client generates both the UUID
// attachment id and safe storage filename; raw bytes are the request body.
app.post('/api/trips/:tripId/itinerary/:eventId/attachments',
  express.raw({ type: '*/*', limit: '10mb' }),
  (req, res) => {
    const eventId = sanitizePathSegment(req.params.eventId);
    if (!eventId) return res.status(400).json({ error: 'Invalid eventId' });

    const attachmentId = sanitizePathSegment(req.headers['x-attachment-id']);
    if (!attachmentId) return res.status(400).json({ error: 'X-Attachment-Id header required' });

    const filename = sanitizeFilename(req.headers['x-filename']);
    if (!filename) return res.status(400).json({ error: 'X-Filename header required' });
    if (attachments.isManagedLegacyPath(req.userId,'itinerary',eventId,filename)) throw new SyncError(409,'IMMUTABLE_ATTACHMENT','Managed attachment content cannot be overwritten.');

    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'Empty body — expected attachment data' });
    }

    const dir = itineraryAttachmentsDir(req.userId, eventId);
    const filePath = path.join(dir, filename);

    try {
      fs.writeFileSync(filePath, req.body);
    } catch (e) {
      console.error('Itinerary attachment write failed:', e.message);
      return res.status(500).json({ error: 'Failed to save attachment' });
    }

    res.json({ ok: true, attachmentId, filename });
  }
);

// GET /api/trips/:tripId/itinerary/:eventId/attachments/:filename
app.get('/api/trips/:tripId/itinerary/:eventId/attachments/:filename', (req, res) => {
  const eventId = sanitizePathSegment(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'Invalid eventId' });

  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: 'Invalid filename' });

  if (attachments.isManagedLegacyPath(req.userId,'itinerary',eventId,filename)) {
    return sendManagedAttachment(res,attachments.download(req.userId,attachments.scope('itinerary',req.params.tripId,eventId,filename)));
  }

  const filePath = path.join(dataDir, 'trip-itinerary-attachments', req.userId, eventId, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Attachment not found' });

  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
  res.attachment(filename);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(filePath);
});

// DELETE /api/trips/:tripId/itinerary/:eventId/attachments/:filename
app.delete('/api/trips/:tripId/itinerary/:eventId/attachments/:filename', (req, res) => {
  const eventId = sanitizePathSegment(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'Invalid eventId' });

  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: 'Invalid filename' });
  if (attachments.isManagedLegacyPath(req.userId,'itinerary',eventId,filename)) throw new SyncError(409,'IMMUTABLE_ATTACHMENT','Remove the attachment reference with a revision-checked household save.');

  const filePath = path.join(dataDir, 'trip-itinerary-attachments', req.userId, eventId, filename);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('Itinerary attachment delete failed:', e.message);
    return res.status(500).json({ error: 'Failed to delete attachment' });
  }

  res.json({ ok: true });
});


// ── SPA fallback — serve index.html for any non-API route ────────────────────
// BillHive is a single-page app — all client-side routing happens in the browser.
// Any path that isn't an /api/* route or a static file gets index.html so that
// deep links and browser refreshes work correctly.
app.use(['/api', '/public'], (_req, res) => res.status(404).json({ error: 'Not found' }));
function serveShell(req, res) {
  if (req.authMethod === 'proxy' || (!getRequireDeviceKeys() && req.authMethod === 'fallback')) setSessionCookie(req, res, req.userId);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(INDEX_PATH);
}
app.get('*', serveShell);
app.use((error, _req, res, _next) => {
  if (error instanceof SyncError) return res.status(error.status).json({error:error.message, code:error.code});
  const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
  res.status(status).json({ error: status === 500 ? 'Stored data could not be read or the operation failed. Existing data has been preserved.' : 'Invalid or oversized request body' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`BillHive running on :${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Auth: Remote-User / X-Authentik-Username / X-Forwarded-User (fallback: "local")`);
});
