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

## UI

```powershell
cd .\ludora-admin-ui
copy .env.example .env
npm install
npm run dev
```

The UI expects the service at `VITE_ADMIN_API_URL`, defaulting to `http://localhost:4001`.

## Verification

```powershell
cd .\ludora-admin-service
npm test
npm run build

cd ..\ludora-admin-ui
npm test
npm run build
```
