const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { sendEmail, maskConfig } = require('./email.js');
const { buildEmailHtml } = require('./emailTemplate.js');

const app = express();
const PORT = process.env.PORT || 8080;
const DB_PATH = process.env.DB_PATH || '/data/billflow.db';

// ── Ensure data directory exists ──────────────────────────────────────────────
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ── Database setup ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

// Prepared statements
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

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// Auth — reads user identity injected by reverse proxy (Authelia / Authentik).
// Falls back to "local" for single-user mode with no proxy.
app.use((req, res, next) => {
  req.userId =
    req.headers['remote-user']          ||   // Authelia
    req.headers['x-authentik-username'] ||   // Authentik
    req.headers['x-forwarded-user']     ||   // Generic
    req.headers['x-remote-user']        ||
    'local';
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
app.get('/api/state', (req, res) => {
  const rows = stmts.getAllState.all(req.userId);
  const state = {};
  rows.forEach(r => { try { state[r.key] = JSON.parse(r.value); } catch { state[r.key] = r.value; } });
  res.json(state);
});

app.put('/api/state', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid body' });
  const saveMany = db.transaction((userId, data) => {
    for (const [key, val] of Object.entries(data)) {
      stmts.setState.run(userId, key, JSON.stringify(val));
    }
  });
  saveMany(req.userId, body);
  res.json({ ok: true });
});

app.patch('/api/state/:key', (req, res) => {
  stmts.setState.run(req.userId, req.params.key, JSON.stringify(req.body));
  res.json({ ok: true });
});

// ── Monthly data API ──────────────────────────────────────────────────────────
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
  if (!/^\d{4}-\d{2}$/.test(key)) return res.status(400).json({ error: 'Invalid month key (expected YYYY-MM)' });
  stmts.setMonth.run(req.userId, key, JSON.stringify(req.body));
  res.json({ ok: true });
});

app.delete('/api/months/:key', (req, res) => {
  stmts.deleteMonth.run(req.userId, req.params.key);
  res.json({ ok: true });
});

// ── Export / Import ───────────────────────────────────────────────────────────
app.get('/api/export', (req, res) => {
  const state = {};
  stmts.getAllState.all(req.userId).forEach(r => { try { state[r.key] = JSON.parse(r.value); } catch {} });
  const monthly = {};
  stmts.getAllMonths.all(req.userId).forEach(r => { try { monthly[r.month_key] = JSON.parse(r.data); } catch {} });
  res.setHeader('Content-Disposition', `attachment; filename="billflow-backup-${req.userId}-${Date.now()}.json"`);
  res.json({ user: req.userId, exportedAt: new Date().toISOString(), state, monthly });
});

app.post('/api/import', (req, res) => {
  const { state, monthly } = req.body;
  const importAll = db.transaction((userId, s, m) => {
    if (s) for (const [k, v] of Object.entries(s)) stmts.setState.run(userId, k, JSON.stringify(v));
    if (m) for (const [k, v] of Object.entries(m)) stmts.setMonth.run(userId, k, JSON.stringify(v));
  });
  importAll(req.userId, state, monthly);
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

// PUT /api/email/config — save full config including secrets
app.put('/api/email/config', (req, res) => {
  const body = req.body;
  if (!body || !body.provider) return res.status(400).json({ error: 'provider required' });
  // Merge with existing to allow partial updates (so masked fields aren't overwritten with masked values)
  let existing = {};
  const row = stmts.getEmailCfg.get(req.userId);
  if (row) { try { existing = JSON.parse(row.config); } catch {} }
  // Only update secret fields if they don't look like masked values
  const secretFields = ['mailgunApiKey','sendgridApiKey','resendApiKey','smtpPass'];
  const merged = { ...existing, ...body };
  secretFields.forEach(f => {
    if (body[f] && body[f].includes('••••')) {
      merged[f] = existing[f]; // keep original if user didn't change it
    }
  });
  stmts.setEmailCfg.run(req.userId, JSON.stringify(merged));
  res.json({ ok: true });
});

// POST /api/email/test — send a test email to the configured from address
app.post('/api/email/test', async (req, res) => {
  const row = stmts.getEmailCfg.get(req.userId);
  if (!row) return res.status(400).json({ error: 'No email config saved' });
  let cfg;
  try { cfg = JSON.parse(row.config); } catch { return res.status(400).json({ error: 'Invalid config' }); }
  const { html, text } = buildEmailHtml({
    greeting: 'Hey there,',
    personName: 'You',
    accentColor: '#a8e063',
    monthLabel: 'Test Email',
    bills: [{ name: 'Electric', amount: 85.00 }, { name: 'Internet', amount: 59.99 }],
    total: 144.99,
    payMethod: 'none',
    fromName: cfg.fromName || 'BillFlow',
  });
  try {
    await sendEmail(cfg, cfg.fromEmail, 'BillFlow — Test Email', html, text);
    res.json({ ok: true, message: `Test email sent to ${cfg.fromEmail}` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/send — send bill summary to a person
app.post('/api/email/send', async (req, res) => {
  const { to, greeting, personName, accentColor, monthLabel, bills, total, payMethod, payId, zelleUrl } = req.body;
  if (!to) return res.status(400).json({ error: 'recipient (to) required' });

  const row = stmts.getEmailCfg.get(req.userId);
  if (!row) return res.status(400).json({ error: 'No email provider configured. Set it up in Settings → Email.' });
  let cfg;
  try { cfg = JSON.parse(row.config); } catch { return res.status(400).json({ error: 'Invalid email config' }); }

  const { html, text } = buildEmailHtml({
    greeting, personName, accentColor,
    monthLabel, bills, total, payMethod, payId, zelleUrl,
    fromName: cfg.fromName || 'BillFlow',
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

// ── SPA fallback — serve index.html for any non-API route ────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`BillFlow running on :${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Auth: Remote-User / X-Authentik-Username / X-Forwarded-User (fallback: "local")`);
});
