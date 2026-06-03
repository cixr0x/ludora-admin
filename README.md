# Ludora Admin

Admin application for reviewing dirty discovery data and curating Ludora's canonical catalog.

## Projects

- `ludora-admin-service`: Node.js TypeScript Express service for admin APIs and Postgres access.
- `ludora-admin-ui`: React TypeScript Vite app using MUI.

## Service

```powershell
cd .\ludora-admin-service
copy .env.example .env
npm install
npm run dev
```

Set `LUDORA_DATABASE_URL` in `.env` before running database-backed routes.
Set `LUDORA_DISCOVERY_API_URL` when using the Operations page. For local development it defaults to `http://localhost:8001`.

## UI

```powershell
cd .\ludora-admin-ui
copy .env.example .env
npm install
npm run dev
```

The UI expects the service at `VITE_ADMIN_API_URL`, defaulting to `http://localhost:4001`.

## Operations

The Operations page can start store discovery through `ludora-discovery`.

Start the discovery API first:

```powershell
cd ..\ludora-discovery
$env:PYTHONPATH='src'
python -m ludora.api --host 127.0.0.1 --port 8001
```

Then start `ludora-admin-service` and `ludora-admin-ui` normally.

## Verification

```powershell
cd .\ludora-admin-service
npm test
npm run build

cd ..\ludora-admin-ui
npm test
npm run build
```
