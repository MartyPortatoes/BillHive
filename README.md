# BillHive 🏠

Household bill management app — per-bill splitting, Verizon line tracking,
Zelle/Venmo deep links, trend charts, and server-side SQLite persistence.

Single Docker image: Node.js serves both the frontend and the REST API.

---

## Quick Start

```bash
# Pull and run (once image is published)
docker compose up -d

# Or build locally from source
docker compose up -d --build
```

Open **http://localhost:8080**

---

## Project Structure

```
billhive/
├── server.js          # Express — serves frontend + REST API
├── package.json
├── Dockerfile
├── docker-compose.yml
├── public/
│   └── index.html     # Frontend (vanilla JS, no build step)
└── .github/
    └── workflows/
        └── docker-publish.yml
```

---

## Docker Compose

```yaml
services:
  billhive:
    image: ghcr.io/martyportatoes/billhive:latest
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

Point your proxy at port `8080` (or whatever `BILLHIVE_PORT` is set to).

### Authelia
Automatically injects `Remote-User` header — no BillHive config needed.

```yaml
# Authelia access_control example
rules:
  - domain: bills.yourdomain.com
    policy: one_factor
```

### Authentik
Automatically injects `X-Authentik-Username` — ensure "Pass User Headers" is
enabled in your proxy provider (it is by default).

### Traefik labels (add to the billhive service)

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.billhive.rule=Host(`bills.yourdomain.com`)"
  - "traefik.http.routers.billhive.entrypoints=websecure"
  - "traefik.http.routers.billhive.tls.certresolver=letsencrypt"
  - "traefik.http.routers.billhive.middlewares=authelia@docker"
  - "traefik.http.services.billhive.loadbalancer.server.port=8080"
```

Without a proxy, all data is stored under the user ID `local` (single-user mode).

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
| GET | `/api/months` | All monthly data |
| GET | `/api/months/:key` | Single month (`YYYY-MM`) |
| PUT | `/api/months/:key` | Save month |
| GET | `/api/export` | Download JSON backup |
| POST | `/api/import` | Restore from JSON backup |

---

## Updating

```bash
docker compose pull && docker compose up -d
```

Data in the volume is preserved across updates.
