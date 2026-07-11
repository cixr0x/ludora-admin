# Ludora Admin Production Deployment Runbook

Last verified: 2026-07-11

Use this runbook to deploy or recover the Ludora admin application and its private Codex-compatible API on the dedicated Google Cloud VM.

## Production Target

| Setting | Value |
| --- | --- |
| GCP project | `ludora-501213` |
| Instance | `ludora-admin` |
| Zone | `us-central1-c` |
| SSH user | `robertorojas87` |
| External IP | `34.55.19.20` |
| Public URL | `https://admin.ludora.bobbycrimson.com` |
| Admin checkout | `/opt/ludora/ludora-admin` |
| Codex API checkout | `/opt/ludora/codexapi` |
| Admin service | `ludora-admin-service.service` on `127.0.0.1:4001` |
| Codex API service | `codexapi.service` on `127.0.0.1:3001` |
| nginx site | `/etc/nginx/sites-available/ludora-admin` |

Connect from a workstation with:

```powershell
gcloud compute ssh robertorojas87@ludora-admin --project ludora-501213 --zone us-central1-c
```

## Architecture

```text
Internet
  |
  | HTTPS 443
  v
nginx
  |-- /               -> /opt/ludora/ludora-admin/ludora-admin-ui/dist
  `-- /api/*          -> http://127.0.0.1:4001/*
                              |
                              | OpenAI-compatible requests
                              v
                         127.0.0.1:3001
                           codexapi
                              |
                              v
                     Codex CLI account login
```

`codexapi` is private infrastructure for admin-service. It must never be proxied by nginx, bound to `0.0.0.0`, or opened in a GCP firewall rule.

## Guardrails

- Never print, copy into logs, or commit secret values from `.env` files or `~/.codex/auth.json`.
- Preserve the existing VM `.env` files during pulls and builds.
- Do not run `npm audit fix` as part of a deployment.
- Do not apply `database/schema.sql` to an existing database.
- Before any DDL or DML, provide the exact focused incremental SQL patch and wait for explicit user approval.
- Read-only database verification is allowed. Do not use a mutating endpoint as a smoke test.
- Run services as `robertorojas87`, not `root` or `mcp13`.
- Keep the fixed ports: Codex API `3001`, admin service `4001`, HTTP `80`, and HTTPS `443`.
- If a required port is occupied by an unexpected process, report the owner before stopping anything.
- Preserve unrelated worktree changes. Stage and commit only deployment-related repository files.

## Required Configuration Files

The real files live only on the VM and must remain ignored by Git:

```text
/opt/ludora/ludora-admin/ludora-admin-service/.env
/opt/ludora/ludora-admin/ludora-discovery/.env
/opt/ludora/ludora-admin/ludora-admin-ui/.env.production
```

Set their permissions to owner-only:

```bash
chmod 600 \
  /opt/ludora/ludora-admin/ludora-admin-service/.env \
  /opt/ludora/ludora-admin/ludora-discovery/.env \
  /opt/ludora/ludora-admin/ludora-admin-ui/.env.production
```

The admin-service `.env` must contain the existing application credentials plus these production values:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4001
CORS_ORIGIN=https://admin.ludora.bobbycrimson.com
OPENAI_BASE_URL=http://127.0.0.1:3001/v1
LUDORA_DISCOVERY_RUNNER=local
LUDORA_DISCOVERY_PACKAGE_DIR=/opt/ludora/ludora-admin/ludora-discovery
LUDORA_DISCOVERY_PYTHON=/opt/ludora/ludora-admin/ludora-discovery/.venv/bin/python
LUDORA_DISCOVERY_ENV_FILE=/opt/ludora/ludora-admin/ludora-discovery/.env
```

The production UI file contains:

```dotenv
VITE_ADMIN_API_URL=https://admin.ludora.bobbycrimson.com/api
```

`codexapi` does not require a repository `.env` in production. Its non-secret runtime settings live in its systemd unit.

## Preflight

Before changing the VM:

1. Confirm intentional changes are committed and pushed.
2. Run the affected repository tests and builds locally.
3. Check both VM worktrees before pulling:

```bash
git -C /opt/ludora/ludora-admin status --short
git -C /opt/ludora/codexapi status --short
```

Do not pull over unexpected tracked changes.

Confirm the Codex CLI login for the service account without printing credentials:

```bash
sudo -u robertorojas87 env HOME=/home/robertorojas87 codex login status
```

For a new or expired login on the headless VM:

```bash
codex login --device-auth
```

Complete the displayed device flow in a local browser while logged in as `robertorojas87` on the VM shell. Do not run the login with `sudo`.

## Routine Admin Deployment

Use this when `ludora-admin` changes and the VM is already provisioned.

```bash
cd /opt/ludora/ludora-admin
git pull --ff-only

cd ludora-admin-service
npm ci
npm run build

cd ../ludora-admin-ui
npm ci
npm run build

sudo systemctl restart ludora-admin-service.service
sudo systemctl reload nginx
```

If `ludora-discovery/pyproject.toml` or its Python dependencies changed:

```bash
cd /opt/ludora/ludora-admin/ludora-discovery
.venv/bin/python -m pip install -e .
.venv/bin/python -m playwright install --with-deps chromium
```

Run discovery tests from its checkout when discovery code changes:

```bash
cd /opt/ludora/ludora-admin/ludora-discovery
.venv/bin/python -m unittest discover -s tests -v
```

## Routine Codex API Deployment

Use this when `codexapi` changes:

```bash
cd /opt/ludora/codexapi
git pull --ff-only
npm ci
npm test
npm run build
sudo systemctl restart codexapi.service
curl -fsS http://127.0.0.1:3001/health
```

Restarting `codexapi` causes a short interruption only for admin AI requests. The admin service itself does not need a restart unless its code or environment changed.

## Full VM Bootstrap

Use this section only when rebuilding a fresh VM.

### 1. Install system dependencies

```bash
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  git ca-certificates curl build-essential \
  nodejs npm \
  python3-venv python3-pip \
  nginx certbot python3-certbot-nginx

sudo npm install -g @openai/codex@latest
```

Node.js 20 or newer is required.

### 2. Create the deployment root and clone repositories

```bash
sudo install -d -o robertorojas87 -g robertorojas87 -m 0755 /opt/ludora
cd /opt/ludora
git clone --branch main --single-branch https://github.com/cixr0x/ludora-admin.git
git clone --branch main --single-branch https://github.com/cixr0x/codexapi.git
```

Copy the real environment files into the locations listed above, then apply mode `600`.

### 3. Create discovery virtual environment

```bash
cd /opt/ludora/ludora-admin/ludora-discovery
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e .
.venv/bin/python -m playwright install --with-deps chromium
.venv/bin/python -c 'import ludora, playwright, psycopg, boto3, numpy, cv2; print("discovery dependencies ok")'
```

### 4. Build all applications

```bash
cd /opt/ludora/codexapi
npm ci
npm test
npm run build

cd /opt/ludora/ludora-admin/ludora-admin-service
npm ci
npm test
npm run build

cd /opt/ludora/ludora-admin/ludora-admin-ui
npm ci
npm run build
```

The UI build must happen after `.env.production` is present.

### 5. Install systemd units

Create `/etc/systemd/system/codexapi.service`:

```ini
[Unit]
Description=Ludora local Codex-compatible API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=robertorojas87
Group=robertorojas87
WorkingDirectory=/opt/ludora/codexapi
Environment=HOME=/home/robertorojas87
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=HOST=127.0.0.1
Environment=PORT=3001
Environment=CODEX_WORKSPACE=/opt/ludora/codexapi
Environment=CODEX_BACKEND=exec
Environment=CODEX_CALL_LOGGING=false
ExecStart=/usr/bin/node /opt/ludora/codexapi/dist/src/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/ludora-admin-service.service`:

```ini
[Unit]
Description=Ludora admin service
After=network-online.target codexapi.service
Wants=network-online.target
Requires=codexapi.service

[Service]
Type=simple
User=robertorojas87
Group=robertorojas87
WorkingDirectory=/opt/ludora/ludora-admin/ludora-admin-service
Environment=HOME=/home/robertorojas87
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node /opt/ludora/ludora-admin/ludora-admin-service/dist/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
```

Enable the services:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codexapi.service
curl -fsS http://127.0.0.1:3001/health
sudo systemctl enable --now ludora-admin-service.service
curl -fsS http://127.0.0.1:4001/health
```

### 6. Configure nginx before TLS

Create `/etc/nginx/sites-available/ludora-admin`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name admin.ludora.bobbycrimson.com;

    root /opt/ludora/ludora-admin/ludora-admin-ui/dist;
    index index.html;
    client_max_body_size 10m;

    location = /api {
        return 308 /api/;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:4001/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Enable it:

```bash
sudo ln -sfn /etc/nginx/sites-available/ludora-admin /etc/nginx/sites-enabled/ludora-admin
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

Confirm the DNS `A` record resolves to `34.55.19.20`, then issue TLS:

```bash
sudo certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email \
  --redirect -d admin.ludora.bobbycrimson.com
sudo nginx -t
sudo systemctl reload nginx
```

Use `--email <address>` instead of `--register-unsafely-without-email` when a renewal-notification address is available.

## Verification Checklist

Run after every deployment, adjusting checks to the changed component.

### Services and ports on the VM

```bash
systemctl is-enabled codexapi.service ludora-admin-service.service nginx.service
systemctl is-active codexapi.service ludora-admin-service.service nginx.service
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:4001/health
sudo nginx -t
ss -ltnp | grep -E ':(80|443|3001|4001)\b'
```

Expected listeners:

```text
127.0.0.1:3001  codexapi
127.0.0.1:4001  admin service
0.0.0.0:80      nginx
0.0.0.0:443     nginx
```

Any `0.0.0.0:3001` or `0.0.0.0:4001` result is a deployment failure.

### Public checks from a workstation

```powershell
curl.exe -f -I https://admin.ludora.bobbycrimson.com/
curl.exe -f https://admin.ludora.bobbycrimson.com/api/health
curl.exe -I http://admin.ludora.bobbycrimson.com/
curl.exe -sS --connect-timeout 5 http://34.55.19.20:3001/health
curl.exe -sS --connect-timeout 5 http://34.55.19.20:4001/health
```

Expected results:

- HTTPS UI returns `200`.
- `/api/health` returns the admin-service health JSON.
- HTTP redirects to HTTPS.
- Direct external connections to `3001` and `4001` fail.

### Authentication and read-only API smoke test

Run from the admin-service directory. This loads credentials without printing them:

```bash
cd /opt/ludora/ludora-admin/ludora-admin-service
node --input-type=module <<'NODE'
import dotenv from 'dotenv';
dotenv.config({ path: '.env', quiet: true });

const base = 'https://admin.ludora.bobbycrimson.com/api';
const login = await fetch(`${base}/admin/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD
  })
});
const setCookie = login.headers.get('set-cookie') ?? '';
const cookie = setCookie.split(';', 1)[0];
console.log(`login=${login.status}`);
console.log(`secure_cookie=${/;\s*secure/i.test(setCookie) && /;\s*httponly/i.test(setCookie)}`);
if (!login.ok || !cookie) process.exit(1);

const stores = await fetch(`${base}/stores?page=1&page_size=1`, {
  headers: { cookie }
});
console.log(`stores=${stores.status}`);
if (!stores.ok) process.exit(1);
NODE
```

### Discovery integration

```bash
cd /opt/ludora/ludora-admin/ludora-discovery
.venv/bin/python -m ludora.operation_cli --help >/dev/null
```

Confirm the admin-service `.env` points `LUDORA_DISCOVERY_PYTHON` at this virtual environment. Do not launch a mutating discovery operation merely as a smoke test.

### Deployed revisions and logs

```bash
git -C /opt/ludora/ludora-admin rev-parse --short HEAD
git -C /opt/ludora/codexapi rev-parse --short HEAD
git -C /opt/ludora/ludora-admin status --short
git -C /opt/ludora/codexapi status --short
sudo journalctl -u ludora-admin-service.service -n 100 --no-pager
sudo journalctl -u codexapi.service -n 100 --no-pager
```

The deployed revisions must match the intended pushed commits and both worktrees should be clean. Logs must not be copied into tickets or chat without checking for sensitive request content.

### TLS renewal

```bash
systemctl is-enabled certbot.timer
systemctl is-active certbot.timer
sudo certbot renew --dry-run
```

## Failure Handling

### Service will not start

```bash
sudo systemctl status <unit> --no-pager
sudo journalctl -u <unit> -n 100 --no-pager
```

Common causes:

- Missing or unreadable `.env` file.
- Admin service built before the latest pull.
- Codex CLI login belongs to a different Linux user.
- Discovery virtual environment does not exist at the configured path.
- A fixed port is already owned by another process.

### UI loads but API calls fail

Check:

1. `VITE_ADMIN_API_URL` was present before the Vite build.
2. `/api/health` works through nginx.
3. `CORS_ORIGIN` matches the production origin exactly.
4. The session cookie is `Secure` and `HttpOnly`.
5. `ludora-admin-service.service` is active and bound to loopback.

### Codex API health works but AI calls fail

Check:

```bash
sudo -u robertorojas87 env HOME=/home/robertorojas87 codex login status
sudo journalctl -u codexapi.service -n 100 --no-pager
```

Do not expose `codexapi` publicly as a workaround.

### Rollback

Use Git history as the source of truth:

1. Revert the problematic commit in the affected local repository.
2. Run tests and build locally.
3. Push the revert to `main`.
4. Run the appropriate routine deployment section.
5. Verify the live revision, services, ports, and public endpoint again.

Do not use `git reset --hard` on the VM and do not overwrite `.env` files during rollback.
