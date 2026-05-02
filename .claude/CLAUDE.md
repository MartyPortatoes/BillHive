# BillHive Web App — Architecture Reference

> Detailed reference for the web application. For project overview and
> critical rules, see the root `../../CLAUDE.md`.

---

## Backend — server.js

### Environment Variables
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `DB_PATH` | `/data/billhive.db` | SQLite database path |
| `BILLHIVE_PORT` | `8080` | Host port mapping in docker-compose |
| `TRUST_PROXY` | `1` | Express trust-proxy hop count (set to `0` to disable, higher for chained proxies) |
| `TRUSTED_AUTH_HEADERS` | `remote-user,x-authentik-username,x-forwarded-user,x-remote-user` | Comma-separated list of headers to honor for proxy-auth. Restrict to lock down spoofing. |

### Auth
Three trusted identity signals, in order of preference:
1. `Authorization: Bearer <key>` — iOS device key (per-key user mapping)
2. `bh_session` cookie — issued by the SPA on HTML load (browser users)
3. Reverse-proxy header (`Remote-User` etc.) — Authelia / Authentik / forward-auth

Falls back to `"local"` so single-user setups keep working with no auth at all.

The `bh_session` cookie is HMAC-signed (server secret persisted in `app_settings`),
30-day lifetime, refreshed on every HTML page load. HttpOnly + SameSite=Lax.

If the **Connected Devices → Require API key** toggle is on (`require_device_keys`
in `app_settings`), `/api/*` requests must successfully authenticate via one of
the three signals above. `/api/health` is always public so the iOS app can probe
reachability and detect whether keys are required before asking the user to paste one.

All API data is scoped per `userId`.

### Database Tables
```sql
user_state    (user_id, key, value, updated_at)        -- settings/people/bills/checklist
monthly_data  (user_id, month_key, data, updated_at)   -- per-month amounts (YYYY-MM)
email_config  (user_id, config, updated_at)            -- email provider credentials
api_keys      (id, user_id, name, key_hash, key_prefix,
               created_at, last_used_at)               -- iOS device keys (SHA-256 hashed)
app_settings  (key, value)                             -- server_secret, require_device_keys
```

### API Endpoints
```
GET    /api/health              → { ok, user, authMethod, requireDeviceKeys, ts }   PUBLIC
GET    /api/state               → full config object
PUT    /api/state               → save full config (settings + people + bills + checklist)
PATCH  /api/state/:key          → save single key
GET    /api/months              → all monthly data as { 'YYYY-MM': data }
GET    /api/months/:key         → single month
PUT    /api/months/:key         → save month data (validates YYYY-MM format)
DELETE /api/months/:key         → delete month
GET    /api/export              → JSON backup download
POST   /api/import              → restore from JSON backup { state, monthly }
GET    /api/email/config        → masked email config (secrets redacted)
PUT    /api/email/config        → save/merge email config (skips masked fields)
POST   /api/email/test          → send test email
POST   /api/email/send          → send bill summary email to a person
GET    /api/keys                → list current user's device keys (no plaintext)
POST   /api/keys                → generate new key, returns plaintext ONCE
DELETE /api/keys/:id            → revoke a key
GET    /api/auth/settings       → { requireDeviceKeys, deviceKeyCount }
PUT    /api/auth/settings       → toggle require-device-keys mode
```

---

## Frontend — index.html

Single-file SPA. All CSS, HTML, and JS in one file. No imports, no modules.
State lives in a global `S` object. Chart.js loaded from cdnjs for Trends tab.

### Global State Keys
`S.settings` — user config (myEmail, etc.)
`S.people[]` — person objects (id, name, color, payMethod, payId, zelleUrl, email, greeting)
`S.bills[]` — bill objects (id, name, icon, color, splitType, remainderLineId, payUrl, preserve, lines[])
`S.monthly{}` — keyed by `'YYYY-MM'`, contains totals, amounts, cached _myTotal and _owes
`S.checklist{}` — keyed by `'YYYY-MM'`, boolean map of checklist item completion

### Key Business Logic

**`computeBillSplit(bill)`** → `{ [personId]: amount }`
Routes each line's amount to `coveredById` if set, otherwise `personId`.

**`computePersonOwes()`** → `{ [personId]: { total, bills[] } }`
Aggregates what each non-"me" person owes. Drives Summary, Receive cards, and emails.

**`autoFillPreservedBills()`**
On month change, copies previous month's amounts for `preserve: true` bills.
Only when target month has no existing data.

**`updateBillComputedDisplays(billId)`** — SURGICAL (use during typing)
Updates computed values only. Never touches `<input>` elements.

**`refreshBillBody(billId)`** — FULL RE-RENDER (use for structural changes)
Destroys and rebuilds the bill body. Use for add/remove lines, split type changes, etc.

### Tabs
| Tab | Render function | Notes |
|---|---|---|
| Bills | `renderBills()` | Expandable cards, line grids, preserve toggle |
| Summary | `renderSummary()` | Per-person cards + my outlay + breakdown |
| Send & Receive | `renderSendPay()` | Receive/Send cards + Checklist |
| Trends | `renderTrends()` | Chart.js, person/bill toggle via `setTrendsView()` |
| Settings | `renderSettings()` | People, email relay, greetings, bill config |

### Trends Tab
Two views toggled by `trendsView`: `'person'` (default) and `'bill'`.
Always call `.destroy()` on chart instances before re-creating on the same canvas.

### CSS Design System
Dark theme with CSS custom properties. Key tokens: `--bg`, `--surface`, `--surface2`,
`--surface3`, `--border`, `--text`, `--muted`. Person colors: `--green` (me),
`--blue` (wife), `--orange` (dad), `--purple` (mom). Fonts: Cabinet Grotesk (display),
DM Mono (data).

---

## Email System

### email.js — Four Providers
Mailgun, SendGrid, Resend (native `fetch()`), and SMTP (`nodemailer`).
SMTP uses `tls.rejectUnauthorized: false` for self-signed certs.

### emailTemplate.js
`buildEmailHtml(opts)` → `{ html, text }`. Dark-themed, mobile-responsive,
inline-styled HTML tables. Always returns both HTML and plain text.

---

## Docker

Single-stage Alpine build. `index.html` copied from repo root to `/app/public/`.
`better-sqlite3` native compile requires `python3 make g++` via `apk`.
`npm install --omit=dev`. No `.npmrc` needed.

GitHub Actions (`docker-publish.yml` in repo root) pushes to
`ghcr.io/martyportatoes/billflow` with tags: latest, semver, short SHA.
