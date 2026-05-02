<p align="center">
  <img src="screenshots/logo.png" width="100" alt="BillHive" />
</p>

<h1 align="center">BillHive</h1>

<p align="center">Self-hosted household bill management. One person fronts every bill — BillHive tracks the splits, generates Zelle/Venmo/Cash App payment links, and sends HTML email summaries to everyone who owes money.</p>

<p align="center">Runs as a <strong>single Docker container</strong> with a SQLite database. No cloud, no subscription, no external services required.</p>

---

## Screenshots

<p align="center">
  <img src="screenshots/bills.png" width="32%" alt="Bills tab" />
  &nbsp;
  <img src="screenshots/send-receive.png" width="32%" alt="Send & Receive tab" />
  &nbsp;
  <img src="screenshots/trends.png" width="32%" alt="Trends tab" />
</p>

---

## Features

**Bill splitting**
- Split bills by **percentage** or **fixed dollar amounts** per line
- Assign each line to a household member
- "Covered by" relationships — Dad can pay on Mom's behalf while Mom shows $0 owed
- Set a **remainder line** to absorb rounding on fixed-split bills
- **Auto-carry forward** amounts month-to-month for bills that don't change

**Payment collection**
- **Zelle, Venmo, and Cash App** deep-links auto-generated with the exact amount pre-filled
- Custom Zelle URLs supported for banks with their own enrollment flows
- One-click **HTML email summaries** sent to each person with their itemized bill breakdown
- Supports **Mailgun, SendGrid, Resend, and SMTP** — API keys stored server-side, never exposed to the browser

**Tracking & history**
- Summary tab shows each person's total owed with a full bill-by-bill breakdown
- **Trend charts** — per-person and per-bill views with line charts, donut breakdowns, and stacked bar charts powered by Chart.js
- **Monthly checklist** auto-generated from your people and bills — tracks what's been emailed, paid, and collected

**Infrastructure**
- Single Docker container — Node.js serves both the frontend and REST API
- SQLite database in a named Docker volume — no external database required
- **Multi-user safe** — deploy behind Authelia or Authentik; BillHive reads the `Remote-User` / `X-Authentik-Username` header and scopes all data per user
- Full JSON **export/import** backup via the Settings tab

---

## Quick Start

```bash
docker run -d \
  --name billhive \
  -p 8080:8080 \
  -v billhive-data:/data \
  ghcr.io/martyportatoes/billflow:latest
```

Open **http://localhost:8080**

---

## Docker Compose

```yaml
services:
  billhive:
    image: ghcr.io/martyportatoes/billflow:latest
    container_name: billhive
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - billhive-data:/data

volumes:
  billhive-data:
```

---

## Reverse Proxy Setup

Point your proxy at port `8080`. BillHive reads the following headers for user identity (first match wins):

| Header | Set by |
|---|---|
| `Remote-User` | Authelia |
| `X-Authentik-Username` | Authentik |
| `X-Forwarded-User` | Generic proxies |
| `X-Remote-User` | Generic proxies |

Without a proxy, all data is stored under user ID `local` (single-user mode).

### Traefik labels

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.billhive.rule=Host(`bills.yourdomain.com`)"
  - "traefik.http.routers.billhive.entrypoints=websecure"
  - "traefik.http.routers.billhive.tls.certresolver=letsencrypt"
  - "traefik.http.routers.billhive.middlewares=authelia@docker"
  - "traefik.http.services.billhive.loadbalancer.server.port=8080"
```

---

## Data Persistence

SQLite lives in a named Docker volume at `/data/billhive.db`.

**Host-mounted path** (easier backups):
```yaml
volumes:
  billhive-data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /your/host/path/billhive-data
```

**Backup via UI:** Settings → Export Backup → downloads full JSON

**Backup via CLI:**
```bash
docker exec billhive sqlite3 /data/billhive.db .dump > backup.sql
```

**Restore:** Settings → Import Backup → select `.json` file

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Port the server listens on |
| `DB_PATH` | `/data/billhive.db` | SQLite database path |

---

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health check + current user |
| GET | `/api/state` | Load config (settings, people, bills) |
| PUT | `/api/state` | Save config |
| PATCH | `/api/state/:key` | Save a single config key |
| GET | `/api/months` | All monthly data |
| GET | `/api/months/:key` | Single month (`YYYY-MM`) |
| PUT | `/api/months/:key` | Save month data |
| DELETE | `/api/months/:key` | Delete a month |
| GET | `/api/export` | Download full JSON backup |
| POST | `/api/import` | Restore from JSON backup |
| GET | `/api/email/config` | Get email config (secrets masked) |
| PUT | `/api/email/config` | Save email config |
| POST | `/api/email/test` | Send a test email |
| POST | `/api/email/send` | Send bill summary to a person |

---

## Updating

```bash
docker compose pull && docker compose up -d
```

Data in the volume is preserved across updates.

---

## iOS Companion App

A native iOS app called **SelfHive** is available on the App Store: [SelfHive — Bill Splitting](https://apps.apple.com/us/app/selfhive-bill-splitting/id6760245713). It connects directly to your self-hosted BillHive server. Source code: [github.com/martyportatoes/billhive-ios](https://github.com/martyportatoes/billhive-ios).

A standalone version of the app, simply called "BillHive", will also be available for anyone not interested in self-hosting.

### Securing iOS connections (optional)

If your server is reachable on a network where you don't fully trust every device — or you just want defense-in-depth — you can require iOS apps to authenticate with a per-device API key.

In the BillHive web app, go to **Settings → Connected Devices**:

1. Click **+ Generate Device Key**, name the device (e.g. "Marty's iPhone")
2. The key is shown **once** in plaintext — copy it now (we hash before storing)
3. In SelfHive, go to **Settings → Server → API Key** and paste it
4. Optionally flip **Require API key for iOS apps** to ON — any iOS app without a valid key will be rejected

To revoke: open **Connected Devices**, click **Revoke** next to the device. The key stops working immediately.

The web app keeps working with no key — browser sessions authenticate via a signed cookie issued on page load.

---

<p align="center">
  <a href="https://www.buymeacoffee.com/mportelos">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Beer" height="60" />
  </a>
</p>
