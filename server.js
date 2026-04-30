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
};

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
app.use(limiter);

// ── Middleware ────────────────────────────────────────────────────────────────
// 2 MB limit is generous enough for large bill configs + monthly data imports
// while protecting against accidental mega-payloads.
app.use(express.json({ limit: '2mb' }));

// Auth middleware — identifies the current user from reverse-proxy headers.
// Supported proxies: Authelia (Remote-User), Authentik (X-Authentik-Username),
// and generic forward-auth setups (X-Forwarded-User, X-Remote-User).
// When no proxy is present (e.g. local Docker Compose), defaults to "local"
// so the app works seamlessly in single-user mode.
//
// Security boundary: these headers are TRUSTED. The reverse proxy MUST strip
// them from incoming client requests before forwarding. If you expose this
// container directly without a proxy, anyone can spoof Remote-User and
// impersonate any user. Set TRUSTED_AUTH_HEADERS to restrict which header(s)
// are honored — e.g. TRUSTED_AUTH_HEADERS=remote-user for Authelia-only.
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
    // could break log lines or SQL.
    if (v && /^[A-Za-z0-9._@-]{1,128}$/.test(v)) return v;
  }
  return 'local';
}

app.use((req, res, next) => {
  req.userId = pickAuthHeader(req.headers);
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
app.get('/api/health', (req, res) => {
  res.json({ ok: true, user: req.userId, ts: Date.now() });
});

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
  const ALLOWED_STATE_KEYS = new Set(['settings', 'people', 'bills', 'checklist']);
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
  const { to, greeting, personName, accentColor, monthLabel, bills, total, payMethod, payId, zelleUrl } = req.body;
  if (!to) return res.status(400).json({ error: 'recipient (to) required' });

  const row = stmts.getEmailCfg.get(req.userId);
  if (!row) return res.status(400).json({ error: 'No email provider configured. Set it up in Settings → Email.' });
  let cfg;
  try { cfg = JSON.parse(row.config); } catch { return res.status(400).json({ error: 'Invalid email config' }); }

  const { html, text } = buildEmailHtml({
    greeting, personName, accentColor,
    monthLabel, bills, total, payMethod, payId, zelleUrl,
    fromName: cfg.fromName || 'BillHive',
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
