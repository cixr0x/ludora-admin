# Ludora Admin Production Deployment Runbook

Last verified: 2026-07-14

Use this runbook to deploy or recover the Ludora admin application and its private Codex-compatible API on the dedicated Google Cloud VM.

## Production Target

| Setting | Value |
| --- | --- |
| GCP project | `ludora-501213` |
| Instance | `ludora-admin-img-20260714-105613` |
| Zone | `us-central1-a` |
| Machine type | `e2-small` |
| Boot disk | 30 GB |
| Source machine image | `ludora-admin-img` |
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
gcloud compute ssh robertorojas87@ludora-admin-img-20260714-105613 --project ludora-501213 --zone us-central1-a
```

The active instance was restored on 2026-07-14 from machine image `ludora-admin-img`, whose source was the previous `ludora-admin` instance in `us-central1-c`. The previous instance is terminated and must not be used as a deployment target.

The public IP was reused by the replacement VM, so SSH clients may report a changed host key. The ED25519 fingerprint verified for the active instance on 2026-07-14 is:

```text
SHA256:sXB+umktCqke3Zb2t45KZbGONE2YbTi+Rhm+KQuMy8o
```

Confirm that exact fingerprint before accepting or refreshing a cached host key. Re-check it from a trusted Google Cloud path after any future VM replacement.

The external IP is not currently reserved as a static Compute Engine address. After any VM stop/start, verify the live IP and DNS before deploying or troubleshooting HTTPS:

```powershell
gcloud compute instances describe ludora-admin-img-20260714-105613 --project ludora-501213 --zone us-central1-a --format="value(networkInterfaces[0].accessConfigs[0].natIP)"
Resolve-DnsName admin.ludora.bobbycrimson.com -Type A
```

Both results must match. If the VM IP changes, report it and update DNS or reserve a static address with user approval before continuing.

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
- Run `ludora-admin-service.service` as `robertorojas87` and
  `codexapi.service` as its dedicated `codexapi` system account. Do not run
  either application service as `root` or `mcp13`.
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

The admin-service `.env` must contain the existing application credentials plus these production values. All non-embedding AI calls use the private loopback CodexAPI service; do not configure an official OpenAI Responses or Chat Completions fallback:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4001
CORS_ORIGIN=https://admin.ludora.bobbycrimson.com
CODEX_API_BASE_URL=http://127.0.0.1:3001/v1
CODEX_AI_MODEL=gpt-5.6-terra
LUDORA_DISCOVERY_RUNNER=local
LUDORA_DISCOVERY_PACKAGE_DIR=/opt/ludora/ludora-admin/ludora-discovery
LUDORA_DISCOVERY_PYTHON=/opt/ludora/ludora-admin/ludora-discovery/.venv/bin/python
LUDORA_DISCOVERY_ENV_FILE=/opt/ludora/ludora-admin/ludora-discovery/.env
LUDORA_DAILY_ITEM_DISCOVERY_ENABLED=true
LUDORA_CONTINUOUS_ITEM_UPDATE_ENABLED=true
LUDORA_CONTINUOUS_ITEM_UPDATE_POLL_SECONDS=5
LUDORA_CONTINUOUS_ITEM_UPDATE_LEASE_SECONDS=300
LUDORA_COVER_FLATTENING_WORK_DIR=/tmp/ludora-cover-flattening
LUDORA_WEB_BOT_AUTH_ENABLED=true
LUDORA_WEB_BOT_AUTH_IDENTITY_ORIGIN=https://admin.ludora.bobbycrimson.com
LUDORA_WEB_BOT_AUTH_CONTACT_EMAIL=robertorojasmo@gmail.com
LUDORA_WEB_BOT_AUTH_PRIVATE_JWK_PATH=/etc/ludora/web-bot-auth/private-key.jwk
```

The discovery `.env` uses the same `CODEX_API_BASE_URL` and configures its intentional direct CodexAPI classifier with `CODEX_CLASSIFIER_MODEL=gpt-5.4-mini`. Configure official OpenAI only for embeddings: `OPENAI_API_KEY=<embeddings only>` and `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`. `OPENAI_BASE_URL` and `OPENAI_TRANSLATION_MODEL` are compatibility aliases for the loopback CodexAPI URL and shared Codex model; they never select official OpenAI for generative calls.

The continuous updater is a supervised Python child of admin-service. It claims
one due item at a time, uses a five-minute expiring lease, and schedules a
successful item 21–23 hours into the future. The worker uses a PostgreSQL
advisory lock, so a manual batch update cannot run concurrently and double the
store request rate. HTTP 429 responses trigger independent platform-wide
cooldowns for Shopify and WooCommerce, allowing the worker to continue with
other platforms while the blocked platform recovers. Its heartbeat, leases,
attempts, platform cooldowns, pause/resume controls, and hourly staleness
distribution are available under **Operations > Update Monitor**. Pausing lets
the in-flight item finish, stops the automatic worker, and releases the
coordinator lock for manual updates. The pause is process-local, so restarting
admin-service starts the automatic worker again when it is enabled by
configuration.

The continuous worker recycles its complete Playwright browser and Node driver
after 250 browser fallback fetches or six hours, whichever occurs first. The
recycle happens between item fetches and preserves the worker session, database
connection, coordinator lock, and current job. Review
`browser_fetch.recycle.started`, `browser_fetch.recycle.completed`, and
`browser_fetch.recycle.failed` entries in the item-update trace when validating
the lifecycle in production.

### Daily item-discovery schedule

With `LUDORA_DAILY_ITEM_DISCOVERY_ENABLED=true`, admin-service automatically
launches an all-store item-discovery run at 05:00
`America/Mexico_City`. It does not catch up after a missed 05:00 start, and a
conflict or launch failure has no same-day automatic retry. An operator may
still start a manual retry.

Scheduled and manual all-store runs select active stores only. Explicit store
IDs remain targetable, including inactive stores. A second product-discovery job
is rejected while one is already running across batch and single-store entry
points. The product-discovery lock is independent from the continuous
item-update lock, so the continuous item-update worker remains active during
discovery.

Review schedule events with:

```bash
sudo journalctl -u ludora-admin-service.service -n 100 --no-pager
```

The production UI file contains:

```dotenv
VITE_ADMIN_API_URL=https://admin.ludora.bobbycrimson.com/api
```

The discovery `.env` must enable the installed Playwright fallback so protected
or incomplete product responses are retried with a rendered browser page:

```dotenv
LUDORA_BROWSER_FETCH_ENABLED=true
```

### Product-detail pacing and Shopify discovery

Product-detail requests are globally start-paced at three seconds across a discovery process. The throttle spans every store in a batch and also applies to retry attempts.

Shopify discovery enumerates product URLs from the sitemap and fetches each product detail through signed Storefront GraphQL only. It has no HTML fallback and does not use GraphQL for product enumeration. A null Shopify product is skipped and logged. A failed store does not stop the remaining stores in the batch, but any store failure causes the parent batch to fail after all stores have run.

Deployment smoke tests must not start a real discovery run, because a run
persists candidates and job/trace data.

### Web Bot Auth identity and signing key

Shopify storefront requests are signed with the public bot identity
`https://admin.ludora.bobbycrimson.com`. The public key directory and crawler
information page are served by admin-service through exact nginx routes. The
private Ed25519 JWK lives only on the VM and must never be copied into the
repository or printed in deployment output.

Create the key once on the VM without replacing an existing key:

```bash
sudo install -d -o robertorojas87 -g robertorojas87 -m 0700 /etc/ludora/web-bot-auth
sudo -u robertorojas87 node --input-type=module <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const keyPath = '/etc/ludora/web-bot-auth/private-key.jwk';
const { privateKey } = generateKeyPairSync('ed25519');
writeFileSync(keyPath, `${JSON.stringify(privateKey.export({ format: 'jwk' }))}\n`, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600
});
NODE
```

Install the repository-owned nginx locations inside the HTTPS server block:

```nginx
include /etc/nginx/snippets/ludora-admin-web-bot-auth.conf;
```

The source snippet is `ops/nginx/ludora-admin-web-bot-auth.conf`. Install it as
`/etc/nginx/snippets/ludora-admin-web-bot-auth.conf`, validate with
`sudo nginx -t`, and reload nginx. The exact public paths are:

```text
https://admin.ludora.bobbycrimson.com/.well-known/http-message-signatures-directory
https://admin.ludora.bobbycrimson.com/crawler
```

`codexapi` does not require a repository `.env` in production. The checked-in
`deploy/codexapi.service` fixes `HOME=/var/lib/codexapi`,
`CODEX_HOME=/var/lib/codexapi/home`,
`CODEX_WORKSPACE=/var/lib/codexapi/workspace`, `HOST=127.0.0.1`, and
`PORT=3001`.

## Preflight

Before changing the VM:

1. Confirm intentional changes are committed and pushed.
2. Run the affected repository builds locally. Run test suites only when explicitly requested.
3. Check both VM worktrees before pulling:

```bash
git -C /opt/ludora/ludora-admin status --short
git -C /opt/ludora/codexapi status --short
```

Do not pull over unexpected tracked changes.

Confirm the Codex CLI login for the dedicated service account without printing
credentials:

```bash
sudo -u codexapi env \
  HOME=/var/lib/codexapi \
  CODEX_HOME=/var/lib/codexapi/home \
  /opt/ludora/codexapi/node_modules/.bin/codex login status
```

For a new or expired login on the headless VM:

```bash
sudo -u codexapi env \
  HOME=/var/lib/codexapi \
  CODEX_HOME=/var/lib/codexapi/home \
  /opt/ludora/codexapi/node_modules/.bin/codex login --device-auth
```

Complete the displayed device flow in a local browser. Run only the pinned
package-local CLI as `codexapi`; never copy another user's `auth.json` or expose
credential contents while provisioning the account.

## Automated Routine Admin Deployment

Run routine `ludora-admin` deployments from a Windows workstation with Google Cloud CLI access. Commit and push the intended change first, then pass the exact full commit SHA:

```powershell
Set-Location C:\PROJECTS\ludora\ludora-admin
$expectedCommit = (git rev-parse HEAD).Trim()

# Preview the pinned target and operation without contacting or changing the VM.
.\ops\Deploy-LudoraAdmin.ps1 -ExpectedCommit $expectedCommit -Component Auto -WhatIf

# Build and deploy the exact origin/main commit without test suites, then run production verification.
.\ops\Deploy-LudoraAdmin.ps1 -ExpectedCommit $expectedCommit -Component Auto

# Add test suites only when they were explicitly requested.
.\ops\Deploy-LudoraAdmin.ps1 -ExpectedCommit $expectedCommit -Component Auto -RunTests
```

`Auto` compares the last successfully verified deployment with the expected commit and selects `Ui`, `Service`, `Discovery`, `Full`, or verification-only behavior. By default, the selected path installs required dependencies, builds and activates the application, restarts or reloads affected services, and performs production verification without running test suites. Pass `-RunTests` only when tests were explicitly requested; it runs the selected component's test suite before its build or restart. The success stamp lives under the remote checkout's `.git` directory and is updated only after every smoke check passes, so retrying a failed deployment reruns the affected work even when the checkout already reached the expected SHA. To require a particular scope, pass `-Component Ui`, `Service`, `Discovery`, or `Full`; the script refuses an explicitly narrower scope when another runtime component also changed. Unclassified production paths conservatively select `Full`. For a visible UI change, add `-AssetMarker '<literal built text>'` so both the activated local bundle and a JavaScript asset fetched over HTTPS must contain that exact marker.

The first automated deployment on an existing VM has no trustworthy success stamp and therefore stops without changing the checkout. After confirming the currently deployed revision, services, schema state, and live smoke checks against this runbook, initialize the baseline once with:

```powershell
.\ops\Deploy-LudoraAdmin.ps1 `
  -ExpectedCommit $expectedCommit `
  -Component Auto `
  -InitializeDeploymentBaseline
```

Baseline initialization always runs a full deployment and refreshes discovery dependencies. Do not use it to bypass an unexplained, missing, stale, or inconsistent deployment stamp.

The script fails closed unless all of these conditions hold:

- The local checkout is clean, on `main`, and at the supplied full 40-character SHA.
- The supplied SHA is exactly the current `origin/main` revision.
- The configured instance is running in the pinned project and zone with the expected machine type, IP, and DNS record.
- The remote checkout is on `main`, has the pinned origin, has no tracked changes, and can fast-forward to the exact SHA.
- No other deployment holds the remote lock.
- Required production configuration files are regular ignored/untracked files, owned by `robertorojas87`, and mode `600`. Their values are never printed.

If SQL files under `database/` changed between the deployed and expected revisions, the script stops before fast-forwarding the checkout or changing the running application and lists the files. It never executes SQL. Only after the exact SQL has been shown and the required DDL/DML approval and execution workflow has been completed may an operator rerun with `-AllowDatabasePatchPresence`; that switch only acknowledges the files and does not apply them.

After a successful fast-forward, the script runs component-specific installs, builds, activation, and restarts, plus opt-in tests when `-RunTests` is present. It then verifies the exact remote HEAD, clean tracked state, active services, the effective nginx static root and API upstream, the required CodexAPI loopback health check, admin-service loopback health, listener bindings, HTTPS, HTTP redirect, authenticated read-only stores access, and optional UI marker. UI builds use a staging directory and activate only after the Vite build succeeds, so a failed build does not empty nginx's live `dist`. The script also confirms from the workstation that ports `3001` and `4001` are not externally reachable.

The script does not stage, commit, push, reset, clean, bootstrap the VM, deploy `codexapi`, or automatically roll back. Preserve its structured `DEPLOY_STEP`, `DEPLOY_STATUS`, and `DEPLOY_RESULT` output when diagnosing a failure. Use the manual commands below only for focused recovery or when the script itself is unavailable.

## Manual Routine Admin Deployment

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

Run discovery tests from its checkout only when they were explicitly requested:

```bash
cd /opt/ludora/ludora-admin/ludora-discovery
.venv/bin/python -m unittest discover -s tests -v
```

## Routine Codex API Deployment

Use this when `codexapi` changes. Start with the exact full commit SHA that was
reviewed and approved. The checkout must be clean, and the approved commit must
be the fetched `origin/main` revision. Record the current full SHA as the
previous known commit before making any change.

```bash
set -euo pipefail
cd /opt/ludora/codexapi

CODEXAPI_COMMIT='<approved full 40-character commit SHA>'
git status --short
test -z "$(git status --porcelain)"
git fetch origin main
test "$(git rev-parse origin/main)" = "$CODEXAPI_COMMIT"
PREVIOUS_CODEXAPI_COMMIT="$(git rev-parse HEAD)"
printf 'Previous CodexAPI commit: %s\n' "$PREVIOUS_CODEXAPI_COMMIT"

# Keep the service stopped if checkout, install, test, or build fails.
sudo systemctl stop codexapi.service
git checkout main
git merge --ff-only "$CODEXAPI_COMMIT"
test "$(git rev-parse HEAD)" = "$CODEXAPI_COMMIT"
test -z "$(git status --porcelain)"
npm ci
npm test
npm run build
test -z "$(git status --porcelain)"

sudo install -o root -g root -m 0644 \
  deploy/codexapi.service /etc/systemd/system/codexapi.service
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/codexapi.service

verify_codexapi_startup() {
  sudo systemctl is-active --quiet codexapi.service &&
    curl -fsS http://127.0.0.1:3001/health |
      node -e 'let b=""; process.stdin.on("data", c => b += c).on("end", () => { try { const h = JSON.parse(b); if (h.status !== "ok" || h.capabilityPolicy !== "codexapi-capable-isolated-v2" || !h.codexCli || h.codexCli.version !== "0.147.0" || h.codexCli.checked !== true) process.exit(1); } catch { process.exit(1); } });' &&
    test "$(ss -H -ltn 'sport = :3001' | wc -l)" -eq 1 &&
    ss -H -ltn 'sport = :3001' | grep -Eq '127[.]0[.]0[.]1:3001([[:space:]]|$)'
}

verify_codexapi_boundary() {
  local unit
  unit="$(sudo systemctl show codexapi.service \
    --property=User --property=Group --property=ProtectSystem --property=ProtectHome \
    --property=CapabilityBoundingSet --property=ReadWritePaths --property=InaccessiblePaths)" &&
    grep -Fx 'User=codexapi' <<<"$unit" &&
    grep -Fx 'Group=codexapi' <<<"$unit" &&
    grep -Fx 'ProtectSystem=strict' <<<"$unit" &&
    grep -Fx 'ProtectHome=true' <<<"$unit" &&
    grep -Fx 'ReadWritePaths=/var/lib/codexapi' <<<"$unit" &&
    grep -Fx 'InaccessiblePaths=/opt/ludora/ludora-admin /home /root' <<<"$unit" &&
    cmp -s deploy/codexapi-runtime.config.toml /var/lib/codexapi/home/codexapi-runtime.config.toml &&
    test "$(stat -c '%a' /var/lib/codexapi/home/codexapi-runtime.config.toml)" = 400
}

sudo systemctl start codexapi.service
if ! verify_codexapi_startup; then
  sudo systemctl stop codexapi.service
  exit 1
fi
if ! verify_codexapi_boundary; then
  sudo systemctl stop codexapi.service
  exit 1
fi
```

The verification function requires `status: "ok"`, capability policy
`codexapi-capable-isolated-v2`, Codex CLI version `0.147.0`, `checked: true`,
and exactly one `127.0.0.1:3001` listener. The boundary verification requires
the dedicated `codexapi` user/group, strict filesystem protections, the sole
persistent writable `/var/lib/codexapi` service path, inaccessible admin, home,
and root paths, and an exact mode-`0400` runtime profile matching the checked-in
`deploy/codexapi-runtime.config.toml`. Any failed post-start check stops the
service before the shell exits. Use the explicit previous-commit recovery
procedure under **Rollback**.

After CodexAPI verification succeeds, deploy the approved admin-service revision through the existing routine admin deployment procedure. Once that revision is active, run the database-free regression canary from the admin-service checkout:

```bash
cd /opt/ludora/ludora-admin/ludora-admin-service
sudo systemctl is-active --quiet ludora-admin-service.service
npm run verify:ai-bgg
```

The canary calls only the loopback AI BGG matcher with the fixed Bomberos En
Accion regression fixture. It does not import, cache, link, or write store
items, and it does not use database commands.

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
```

Node.js 20 or newer is required. Do not install a global Codex CLI; the
CodexAPI package lock supplies the pinned package-local executable.

### 2. Create the deployment root and clone repositories

```bash
sudo install -d -o robertorojas87 -g robertorojas87 -m 0755 /opt/ludora
cd /opt/ludora
git clone --branch main --single-branch https://github.com/cixr0x/ludora-admin.git
git clone --branch main --single-branch https://github.com/cixr0x/codexapi.git

sudo useradd --system --home-dir /var/lib/codexapi \
  --create-home --shell /usr/sbin/nologin codexapi
sudo install -d -o codexapi -g codexapi -m 0700 \
  /var/lib/codexapi \
  /var/lib/codexapi/home \
  /var/lib/codexapi/workspace
```

The deployment user owns the read-only CodexAPI checkout; the `codexapi`
service account owns only its runtime home and empty workspace under
`/var/lib/codexapi`. Copy the real Ludora environment files into the locations
listed above, then apply mode `600`.

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

### 5. Authenticate CodexAPI and install systemd units

Authenticate the dedicated identity with the pinned package-local executable.
Complete the displayed device flow manually; do not copy credentials from the
deployment user or another account:

```bash
sudo -u codexapi env \
  HOME=/var/lib/codexapi \
  CODEX_HOME=/var/lib/codexapi/home \
  /opt/ludora/codexapi/node_modules/.bin/codex login --device-auth
sudo -u codexapi env \
  HOME=/var/lib/codexapi \
  CODEX_HOME=/var/lib/codexapi/home \
  /opt/ludora/codexapi/node_modules/.bin/codex login status
```

Install the exact unit checked into the approved CodexAPI revision instead of
recreating it inline:

```bash
sudo install -o root -g root -m 0644 \
  /opt/ludora/codexapi/deploy/codexapi.service \
  /etc/systemd/system/codexapi.service
sudo systemd-analyze verify /etc/systemd/system/codexapi.service
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
sudo systemctl is-active codexapi.service
curl -fsS http://127.0.0.1:3001/health
sudo journalctl -u codexapi.service -n 30 --no-pager
sudo systemctl enable --now ludora-admin-service.service
curl -fsS http://127.0.0.1:4001/health
```

Before enabling admin-service, confirm the CodexAPI health response contains the
same startup-attestation fields required by the routine deployment and that
`ss -ltnp` shows CodexAPI only on `127.0.0.1:3001`.

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

Confirm the command is targeting the active replacement VM before checking the application:

```powershell
gcloud compute instances describe ludora-admin-img-20260714-105613 --project ludora-501213 --zone us-central1-a --format="table(name,zone.basename(),status,machineType.basename(),networkInterfaces[0].accessConfigs[0].natIP)"
```

Expected identity: instance `ludora-admin-img-20260714-105613`, zone `us-central1-a`, status `RUNNING`, machine type `e2-small`, and an external IP matching DNS.

### Services and ports on the VM

```bash
systemctl is-enabled codexapi.service ludora-admin-service.service nginx.service
systemctl is-active codexapi.service ludora-admin-service.service nginx.service
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:4001/health
sudo nginx -t
ss -ltnp | grep -E ':(80|443|3001|4001)\b'
```

The CodexAPI health request is required for every production verification because every non-embedding AI path depends on the private loopback service.

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
sudo -u codexapi env \
  HOME=/var/lib/codexapi \
  CODEX_HOME=/var/lib/codexapi/home \
  /opt/ludora/codexapi/node_modules/.bin/codex login status
sudo journalctl -u codexapi.service -n 100 --no-pager
```

Do not expose `codexapi` publicly as a workaround.

### CodexAPI previous-commit recovery

If a CodexAPI deployment fails, keep the service stopped and explicitly rebuild
the full previous commit SHA printed before deployment. This is a manual,
operator-selected recovery; it is not an automatic rollback mechanism.

```bash
set -euo pipefail
cd /opt/ludora/codexapi

CODEXAPI_PREVIOUS_COMMIT='<previous full 40-character commit SHA>'
test -z "$(git status --porcelain)"
git fetch origin
git cat-file -e "${CODEXAPI_PREVIOUS_COMMIT}^{commit}"

sudo systemctl stop codexapi.service
git checkout --detach "$CODEXAPI_PREVIOUS_COMMIT"
test "$(git rev-parse HEAD)" = "$CODEXAPI_PREVIOUS_COMMIT"
npm ci
npm test
npm run build
test -z "$(git status --porcelain)"

sudo install -o root -g root -m 0644 \
  deploy/codexapi.service /etc/systemd/system/codexapi.service
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/codexapi.service

verify_codexapi_startup() {
  sudo systemctl is-active --quiet codexapi.service &&
    curl -fsS http://127.0.0.1:3001/health |
      node -e 'let b=""; process.stdin.on("data", c => b += c).on("end", () => { try { const h = JSON.parse(b); if (h.status !== "ok" || h.capabilityPolicy !== "codexapi-capable-isolated-v2" || !h.codexCli || h.codexCli.version !== "0.147.0" || h.codexCli.checked !== true) process.exit(1); } catch { process.exit(1); } });' &&
    test "$(ss -H -ltn 'sport = :3001' | wc -l)" -eq 1 &&
    ss -H -ltn 'sport = :3001' | grep -Eq '127[.]0[.]0[.]1:3001([[:space:]]|$)'
}

verify_codexapi_boundary() {
  local unit
  unit="$(sudo systemctl show codexapi.service \
    --property=User --property=Group --property=ProtectSystem --property=ProtectHome \
    --property=CapabilityBoundingSet --property=ReadWritePaths --property=InaccessiblePaths)" &&
    grep -Fx 'User=codexapi' <<<"$unit" &&
    grep -Fx 'Group=codexapi' <<<"$unit" &&
    grep -Fx 'ProtectSystem=strict' <<<"$unit" &&
    grep -Fx 'ProtectHome=true' <<<"$unit" &&
    grep -Fx 'ReadWritePaths=/var/lib/codexapi' <<<"$unit" &&
    grep -Fx 'InaccessiblePaths=/opt/ludora/ludora-admin /home /root' <<<"$unit" &&
    cmp -s deploy/codexapi-runtime.config.toml /var/lib/codexapi/home/codexapi-runtime.config.toml &&
    test "$(stat -c '%a' /var/lib/codexapi/home/codexapi-runtime.config.toml)" = 400
}

sudo systemctl start codexapi.service
if ! verify_codexapi_startup; then
  sudo systemctl stop codexapi.service
  exit 1
fi
if ! verify_codexapi_boundary; then
  sudo systemctl stop codexapi.service
  exit 1
fi
```

Verify the same startup-attestation fields, runtime-profile mode and contents,
filesystem boundary, and loopback-only listener required by a routine
deployment. A failed recovery verification also leaves the service stopped.
The checkout is intentionally detached at the recovered commit; the next
approved forward deployment checks out `main` and fast-forwards it to an exact
approved `origin/main` revision.

### Ludora admin rollback

Use Git history as the source of truth:

1. Revert the problematic commit in the affected local repository.
2. Run the build locally; run tests only when explicitly requested.
3. Push the revert to `main`.
4. Run the appropriate routine deployment section.
5. Verify the live revision, services, ports, and public endpoint again.

Do not use `git reset --hard` on the VM and do not overwrite `.env` files during rollback.
