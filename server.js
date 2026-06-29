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
//   - Runs in Docker on node:20-alpine; data stored at /data/billhive.db
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

const app = express();
const PORT = process.env.PORT || 8080;
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

  // Check share links
  findShareByToken:           db.prepare('SELECT * FROM share_checks WHERE token = ?'),
  findActiveShareForCheck:    db.prepare('SELECT * FROM share_checks WHERE user_id = ? AND check_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1'),
  insertShare:                db.prepare('INSERT INTO share_checks (token, user_id, check_id, claims) VALUES (?, ?, ?, ?)'),
  setShareClaims:             db.prepare('UPDATE share_checks SET claims = ? WHERE token = ? AND revoked_at IS NULL'),
  revokeSharesForCheck:       db.prepare('UPDATE share_checks SET revoked_at = unixepoch() WHERE user_id = ? AND check_id = ? AND revoked_at IS NULL'),

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
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
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
function setSessionCookie(req, res, userId) {
  const now = Math.floor(Date.now() / 1000);
  const token = signCookie({ uid: userId, iat: now, exp: now + COOKIE_MAX_AGE_SECONDS });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
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
//   - Google Fonts (CSS at fonts.googleapis.com, font files at fonts.gstatic.com)
//   - Chart.js from cdnjs.cloudflare.com (loaded with SRI integrity)
//   - Inline <script> and inline style="..." (the entire SPA is one inline script,
//     and email-style inline CSS is everywhere). 'unsafe-inline' is required.
//   - data: URIs for SVG background patterns in CSS
// connect-src includes 'self' for fetch + EventSource (SSE).
// frame-ancestors 'none' replaces X-Frame-Options to prevent clickjacking.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src':     ["'self'"],
      'script-src':      ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
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
  crossOriginEmbedderPolicy: false,        // Google Fonts doesn't send CORP headers
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
const TRUSTED_AUTH_HEADERS = (process.env.TRUSTED_AUTH_HEADERS ||
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
        try { stmts.touchApiKey.run(Date.now(), row.id); } catch {}
        return next();
      }
      // Bearer was provided but didn't match any stored key.
      return res.status(401).json({ error: 'Invalid API key' });
    }
  }

  // 2. Session cookie — for browser sessions
  const cookieToken = parseCookie(req.headers.cookie, 'bh_session');
  if (cookieToken) {
    const payload = verifyCookie(cookieToken);
    if (payload && payload.uid) {
      req.userId = payload.uid;
      req.authMethod = 'cookie';
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

// Attach a fresh bh_session cookie to any GET that wants HTML — i.e. browser
// SPA loads. API calls (Accept: application/json) and asset fetches don't
// trigger it. Each visit refreshes the 30-day expiry.
app.use((req, res, next) => {
  if (req.method === 'GET' && typeof req.headers.accept === 'string' && req.headers.accept.includes('text/html')) {
    setSessionCookie(req, res, req.userId);
  }
  next();
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
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '1h',
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
function getCheckFromState(userId, checkId) {
  const row = stmts.getState.get(userId, 'checks');
  if (!row) return null;
  let checksState;
  try { checksState = JSON.parse(row.value); } catch { return null; }
  const list = (checksState && checksState.checks) || [];
  return list.find(c => c.id === checkId) || null;
}

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

// GET /public/share/check/:token — anonymous read of a shared check.
app.get('/public/share/check/:token', publicLimiter, (req, res) => {
  const share = stmts.findShareByToken.get(req.params.token);
  if (!share) return res.status(404).json({ error: 'Share not found' });
  if (share.revoked_at) return res.status(410).json({ error: 'This share link has been revoked' });

  const check = getCheckFromState(share.user_id, share.check_id);
  if (!check) return res.status(404).json({ error: 'Check not found' });

  let claims = [];
  try { claims = JSON.parse(share.claims); } catch {}

  res.json({
    check: publicCheckShape(check),
    claims,
    createdAt: share.created_at,
  });
});

// POST /public/share/check/:token/claim — anonymous claim of items.
// Body: { claimerName: String, itemIds: [String] }. Appends a new claim
// to the share's claims array. We don't deduplicate (a claimer can return
// multiple times to adjust); the iOS app reconciles claims on read.
app.post('/public/share/check/:token/claim', publicLimiter, (req, res) => {
  const share = stmts.findShareByToken.get(req.params.token);
  if (!share) return res.status(404).json({ error: 'Share not found' });
  if (share.revoked_at) return res.status(410).json({ error: 'This share link has been revoked' });

  const body = req.body || {};
  const claimerName = typeof body.claimerName === 'string' ? body.claimerName.trim() : '';
  const itemIds = Array.isArray(body.itemIds)
    ? body.itemIds.filter(x => typeof x === 'string').slice(0, 200)
    : [];
  if (!claimerName || claimerName.length > 80) {
    return res.status(400).json({ error: 'claimerName is required (1–80 chars)' });
  }

  let claims = [];
  try { claims = JSON.parse(share.claims); } catch {}

  claims.push({
    claimerName,
    itemIds,
    claimedAt: new Date().toISOString(),
  });

  // Cap total claims per share to prevent unbounded growth from abuse.
  if (claims.length > 500) claims = claims.slice(-500);

  stmts.setShareClaims.run(JSON.stringify(claims), req.params.token);

  // Tell the host's open SSE clients to refresh — they'll re-fetch
  // /api/share/check/:checkId and see the new claim. C.1 leaves the
  // iOS app at "manual refresh"; C.2 will hook this up.
  broadcastChange(share.user_id);

  res.json({ ok: true });
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
      sourceAmount: e.sourceAmount || 0,
      sourceCurrency: e.sourceCurrency || '',
      exchangeRate: e.exchangeRate || 1,
      notes: e.notes || '',
    })),
    notes: trip.notes || '',
    isArchived: trip.isArchived || false,
    settlements: trip.settlements || [],
    checklistItems: trip.checklistItems || [],
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
app.get('/public/trip/invite/:token', publicLimiter, (req, res) => {
  const invite = stmts.findTripInviteByToken.get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.revoked_at) return res.status(410).json({ error: 'This invite has been revoked' });

  const trip = getTripFromState(invite.owner_user_id, invite.trip_id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const member = (trip.members || []).find(m => m.id === invite.member_id);
  res.json({
    trip: publicTripShape(trip),
    memberId: invite.member_id,
    memberName: member ? member.name : '',
    joined: !!invite.joined_at,
    createdAt: invite.created_at,
  });
});

// POST /public/trip/invite/:token/join — claim the invite. Idempotent:
// calling twice on an already-joined invite is a no-op success.
app.post('/public/trip/invite/:token/join', publicLimiter, (req, res) => {
  const invite = stmts.findTripInviteByToken.get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.revoked_at) return res.status(410).json({ error: 'This invite has been revoked' });

  if (!invite.joined_at) {
    stmts.markTripInviteJoined.run(req.params.token);
  }

  const trip = getTripFromState(invite.owner_user_id, invite.trip_id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const member = (trip.members || []).find(m => m.id === invite.member_id);
  res.json({
    ok: true,
    trip: publicTripShape(trip),
    memberId: invite.member_id,
    memberName: member ? member.name : '',
  });
});

// GET /public/trip/invite/:token/trip — full trip data for a joined invite.
// The iOS app calls this to refresh the trip while the member has it open.
app.get('/public/trip/invite/:token/trip', publicLimiter, (req, res) => {
  const invite = stmts.findTripInviteByToken.get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.revoked_at) return res.status(410).json({ error: 'This invite has been revoked' });
  if (!invite.joined_at) return res.status(403).json({ error: 'Invite not yet accepted' });

  const trip = getTripFromState(invite.owner_user_id, invite.trip_id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  res.json({ trip: publicTripShape(trip) });
});

// POST /public/trip/invite/:token/expense — add or update an expense on
// the shared trip. Body: a full Expense object. If an expense with the
// same id already exists, it's replaced (update); otherwise it's appended.
app.post('/public/trip/invite/:token/expense', publicLimiter, (req, res) => {
  const invite = stmts.findTripInviteByToken.get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.revoked_at) return res.status(410).json({ error: 'This invite has been revoked' });
  if (!invite.joined_at) return res.status(403).json({ error: 'Invite not yet accepted' });

  const expense = req.body;
  if (!expense || !expense.id || typeof expense.name !== 'string') {
    return res.status(400).json({ error: 'Invalid expense payload' });
  }

  // Read the owner's state, find the trip, mutate, and write back.
  const stateRow = stmts.getState.get(invite.owner_user_id, 'trips');
  if (!stateRow) return res.status(404).json({ error: 'Trip not found' });

  let tripsState;
  try { tripsState = JSON.parse(stateRow.value); } catch {
    return res.status(500).json({ error: 'Corrupt trip state' });
  }

  const tripIdx = (tripsState.trips || []).findIndex(t => t.id === invite.trip_id);
  if (tripIdx === -1) return res.status(404).json({ error: 'Trip not found' });

  const trip = tripsState.trips[tripIdx];
  const expenses = trip.expenses || [];
  const existingIdx = expenses.findIndex(e => e.id === expense.id);
  if (existingIdx >= 0) {
    expenses[existingIdx] = expense;
  } else {
    expenses.unshift(expense);
  }
  trip.expenses = expenses;
  tripsState.trips[tripIdx] = trip;

  stmts.setState.run(invite.owner_user_id, 'trips', JSON.stringify(tripsState));
  broadcastChange(invite.owner_user_id);
  res.json({ ok: true });
});

// DELETE /public/trip/invite/:token/expense/:expenseId — delete a single
// expense from the shared trip.
app.delete('/public/trip/invite/:token/expense/:expenseId', publicLimiter, (req, res) => {
  const invite = stmts.findTripInviteByToken.get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.revoked_at) return res.status(410).json({ error: 'This invite has been revoked' });
  if (!invite.joined_at) return res.status(403).json({ error: 'Invite not yet accepted' });

  const stateRow = stmts.getState.get(invite.owner_user_id, 'trips');
  if (!stateRow) return res.status(404).json({ error: 'Trip not found' });

  let tripsState;
  try { tripsState = JSON.parse(stateRow.value); } catch {
    return res.status(500).json({ error: 'Corrupt trip state' });
  }

  const tripIdx = (tripsState.trips || []).findIndex(t => t.id === invite.trip_id);
  if (tripIdx === -1) return res.status(404).json({ error: 'Trip not found' });

  const trip = tripsState.trips[tripIdx];
  trip.expenses = (trip.expenses || []).filter(e => e.id !== req.params.expenseId);
  tripsState.trips[tripIdx] = trip;

  stmts.setState.run(invite.owner_user_id, 'trips', JSON.stringify(tripsState));
  broadcastChange(invite.owner_user_id);
  res.json({ ok: true });
});

// POST /public/trip/invite/:token/settlement — record a settlement on
// the shared trip. Body: a SettledTransfer object.
app.post('/public/trip/invite/:token/settlement', publicLimiter, (req, res) => {
  const invite = stmts.findTripInviteByToken.get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.revoked_at) return res.status(410).json({ error: 'This invite has been revoked' });
  if (!invite.joined_at) return res.status(403).json({ error: 'Invite not yet accepted' });

  const settlement = req.body;
  if (!settlement || !settlement.id) {
    return res.status(400).json({ error: 'Invalid settlement payload' });
  }

  const stateRow = stmts.getState.get(invite.owner_user_id, 'trips');
  if (!stateRow) return res.status(404).json({ error: 'Trip not found' });

  let tripsState;
  try { tripsState = JSON.parse(stateRow.value); } catch {
    return res.status(500).json({ error: 'Corrupt trip state' });
  }

  const tripIdx = (tripsState.trips || []).findIndex(t => t.id === invite.trip_id);
  if (tripIdx === -1) return res.status(404).json({ error: 'Trip not found' });

  const trip = tripsState.trips[tripIdx];
  if (!trip.settlements) trip.settlements = [];
  trip.settlements.push(settlement);
  tripsState.trips[tripIdx] = trip;

  stmts.setState.run(invite.owner_user_id, 'trips', JSON.stringify(tripsState));
  broadcastChange(invite.owner_user_id);
  res.json({ ok: true });
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
app.get('/api/state', (req, res) => {
  const rows = stmts.getAllState.all(req.userId);
  const state = {};
  rows.forEach(r => { try { state[r.key] = JSON.parse(r.value); } catch { state[r.key] = r.value; } });
  res.json(state);
});

app.put('/api/state', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid body' });

  // Wrap in a transaction so all keys are written atomically — prevents
  // partial state if the server crashes mid-write.
  const saveMany = db.transaction((userId, data) => {
    for (const [key, val] of Object.entries(data)) {
      stmts.setState.run(userId, key, JSON.stringify(val));
    }
  });
  saveMany(req.userId, body);
  res.json({ ok: true });

  // Notify other tabs/devices AFTER responding — keeps the save latency low.
  broadcastChange(req.userId);
});

app.patch('/api/state/:key', (req, res) => {
  stmts.setState.run(req.userId, req.params.key, JSON.stringify(req.body));
  res.json({ ok: true });
  broadcastChange(req.userId);
});

// ── Monthly data API ──────────────────────────────────────────────────────────
// GET  /api/months       — all months for trend charts and history log
// GET  /api/months/:key  — single month (YYYY-MM format)
// PUT  /api/months/:key  — upsert a month's data (totals, amounts, computed owes)
// DELETE /api/months/:key — remove a month's data entirely
app.get('/api/months', (req, res) => {
  const rows = stmts.getAllMonths.all(req.userId);
  const months = {};
  rows.forEach(r => { try { months[r.month_key] = JSON.parse(r.data); } catch {} });
  res.json(months);
});

app.get('/api/months/:key', (req, res) => {
  const row = stmts.getMonth.get(req.userId, req.params.key);
  if (!row) return res.json({});
  try { res.json(JSON.parse(row.data)); } catch { res.json({}); }
});

app.put('/api/months/:key', (req, res) => {
  const key = req.params.key;
  // Validate format to prevent arbitrary keys from polluting the table
  if (!/^\d{4}-\d{2}$/.test(key)) return res.status(400).json({ error: 'Invalid month key (expected YYYY-MM)' });
  stmts.setMonth.run(req.userId, key, JSON.stringify(req.body));
  res.json({ ok: true });
  broadcastChange(req.userId);
});

app.delete('/api/months/:key', (req, res) => {
  stmts.deleteMonth.run(req.userId, req.params.key);
  res.json({ ok: true });
  broadcastChange(req.userId);
});

// ── Export / Import ───────────────────────────────────────────────────────────
// GET  /api/export — download a full JSON backup of all state + monthly data.
//                    Scoped to the current user — won't leak other users' data.
// POST /api/import — restore from a backup file. Merges into existing data
//                    (upsert semantics) so it won't delete months/keys that
//                    aren't in the backup.
app.get('/api/export', (req, res) => {
  const state = {};
  stmts.getAllState.all(req.userId).forEach(r => { try { state[r.key] = JSON.parse(r.value); } catch {} });
  const monthly = {};
  stmts.getAllMonths.all(req.userId).forEach(r => { try { monthly[r.month_key] = JSON.parse(r.data); } catch {} });
  res.setHeader('Content-Disposition', `attachment; filename="billhive-backup-${req.userId}-${Date.now()}.json"`);
  res.json({ user: req.userId, exportedAt: new Date().toISOString(), state, monthly });
});

app.post('/api/import', (req, res) => {
  const { state, monthly } = req.body || {};
  // Whitelist state keys we manage; reject anything else so a crafted backup
  // can't pollute user_state with arbitrary rows.
  const ALLOWED_STATE_KEYS = new Set(['settings', 'people', 'bills', 'checklist', 'requestDates', 'checks', 'trips']);
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
  importAll(req.userId, state, monthly);
  res.json({ ok: true });
  broadcastChange(req.userId);
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
  let claims = [];
  try { claims = JSON.parse(share.claims); } catch {}
  return {
    token: share.token,
    url: `${publicBaseURL(req)}/share/${share.token}`,
    createdAt: share.created_at,
    claims,
  };
}

// POST /api/share/check/:checkId — create (or rotate) a share link.
// If a non-revoked share already exists for this check, returns it
// (idempotent for the simple case). Pass ?rotate=1 to force a new token
// and revoke the previous one (useful if the user accidentally posted
// the old link publicly).
app.post('/api/share/check/:checkId', (req, res) => {
  const checkId = req.params.checkId;
  if (!getCheckFromState(req.userId, checkId)) {
    return res.status(404).json({ error: 'Check not found' });
  }

  const rotate = req.query.rotate === '1' || req.query.rotate === 'true';
  if (!rotate) {
    const existing = stmts.findActiveShareForCheck.get(req.userId, checkId);
    if (existing) return res.json(shareInfoResponse(existing, req));
  } else {
    stmts.revokeSharesForCheck.run(req.userId, checkId);
  }

  const token = crypto.randomBytes(24).toString('base64url');
  stmts.insertShare.run(token, req.userId, checkId, '[]');
  const share = stmts.findShareByToken.get(token);
  res.json(shareInfoResponse(share, req));
});

// GET /api/share/check/:checkId — fetch the current active share + claims.
// 404 if there's no active share. Used by the iOS app to refresh claim
// counts after the host receives the SSE "data-changed" event (C.2)
// or via manual refresh (C.1).
app.get('/api/share/check/:checkId', (req, res) => {
  const share = stmts.findActiveShareForCheck.get(req.userId, req.params.checkId);
  if (!share) return res.status(404).json({ error: 'No active share' });
  res.json(shareInfoResponse(share, req));
});

// DELETE /api/share/check/:checkId — revoke any active share for this check.
// All future reads of the token return 410 Gone. Claims are kept in the row
// for audit but the link no longer works.
app.delete('/api/share/check/:checkId', (req, res) => {
  stmts.revokeSharesForCheck.run(req.userId, req.params.checkId);
  res.json({ ok: true });
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
    deviceKeyCount:    row ? row.c : 0,
  });
});

app.put('/api/auth/settings', (req, res) => {
  if (!req.body || typeof req.body.requireDeviceKeys !== 'boolean') {
    return res.status(400).json({ error: 'requireDeviceKeys (boolean) required' });
  }
  setRequireDeviceKeys(req.body.requireDeviceKeys);
  const row = stmts.countApiKeysForUser.get(req.userId);
  res.json({
    requireDeviceKeys: getRequireDeviceKeys(),
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
  const cleaned = name.replace(/[^A-Za-z0-9.\-]/g, '');
  // Must have content, must not be just dots, must end in a safe extension
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('.')) return null;
  if (cleaned.length > 255) return null;
  return cleaned;
}

// Sanitize path segments (tripId, expenseId) — same whitelist but no dots allowed.
function sanitizePathSegment(seg) {
  if (typeof seg !== 'string') return null;
  const cleaned = seg.replace(/[^A-Za-z0-9\-]/g, '');
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

    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'Empty body — expected image data' });
    }

    const filename = `${attachmentId}.jpg`;
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

  const filePath = path.join(dataDir, 'trip-receipts', req.userId, expenseId, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Attachment not found' });

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

    if (!req.body || !req.body.length) {
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

  const filePath = path.join(dataDir, 'trip-itinerary-attachments', req.userId, eventId, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Attachment not found' });

  res.sendFile(filePath);
});

// DELETE /api/trips/:tripId/itinerary/:eventId/attachments/:filename
app.delete('/api/trips/:tripId/itinerary/:eventId/attachments/:filename', (req, res) => {
  const eventId = sanitizePathSegment(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'Invalid eventId' });

  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: 'Invalid filename' });

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
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`BillHive running on :${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Auth: Remote-User / X-Authentik-Username / X-Forwarded-User (fallback: "local")`);
});
