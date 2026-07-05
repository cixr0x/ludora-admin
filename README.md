# Ludora Admin

Admin application for reviewing dirty discovery data and curating Ludora's canonical catalog.

## Projects

- `ludora-admin-service`: Node.js TypeScript Express service for admin APIs and Postgres access.
- `ludora-admin-ui`: React TypeScript Vite app using MUI.
- `ludora-discovery`: Python discovery package invoked by the admin service for operations.

## Service

```powershell
cd .\ludora-admin-service
copy .env.example .env
npm install
npm run dev:codex
```

Set `LUDORA_DATABASE_URL` in `.env` before running database-backed routes.

## Database Changes

Use incremental SQL patches in `database/patches/` for existing databases. `database/schema.sql` is the current schema snapshot for review/bootstrap reference and must not be replayed for routine updates.

When a task changes the database shape or requires data backfill:

- Add one focused patch file under `database/patches/`.
- Keep `database/schema.sql` aligned as the final snapshot.
- Apply only the relevant patch after explicit DDL/DML approval.

### Admin AI Flow

OpenAI-backed admin features use the shared OpenAI Responses client in `ludora-admin-service/src/ai/openAiResponsesClient.ts`. Current callers include translation, description generation, product detail extraction, and Amazon title extraction.

Configure those calls in `ludora-admin-service/.env`:

```text
OPENAI_API_KEY=your_openai_or_codexapi_key
OPENAI_TRANSLATION_MODEL=gpt-5.4-nano
OPENAI_BASE_URL=http://127.0.0.1:3001/v1
```

`OPENAI_API_KEY` enables the AI-backed services. `OPENAI_BASE_URL` is optional: leave it unset to use the official OpenAI API, or set it to a local Codex/OpenAI-compatible `/v1` endpoint. `OPENAI_TRANSLATION_MODEL` is currently the shared text model setting for the admin AI clients.

New AI requests should be implemented in admin-service with this same flow. Discovery package code should call admin-service endpoints for new AI tasks instead of adding separate API-key handling. More detail is in `docs/ai-api-flow.md`.

### Local Cover Workflow

The item details page can start a local cover workflow from the item image itself or from a linked store item row, and the store item details page can start the same flow directly. The admin service downloads the selected source image, opens it in GIMP, and waits for either `<normalized-name>.en.webp` or `<normalized-name>.es.webp` in the work directory. The `.en.webp` file updates `items.image_url`; the `.es.webp` file updates `items.image_url_es`.

Defaults:

```text
LUDORA_COVER_WORK_DIR=C:\Users\mcp13\OneDrive\Documentos\boardgame
LUDORA_COVER_S3_BUCKET=ludora
LUDORA_COVER_S3_PREFIX=boardgame
LUDORA_COVER_S3_REGION=us-east-2
LUDORA_COVER_PUBLIC_BASE_URL=https://ludora.s3.us-east-2.amazonaws.com
LUDORA_COVER_GIMP_PATH=gimp-3.exe
```

AWS credentials are read through the AWS SDK standard environment/profile chain.

## UI

```powershell
cd .\ludora-admin-ui
copy .env.example .env
npm install
npm run dev:codex
```

The UI expects the service at `VITE_ADMIN_API_URL`, defaulting to `http://localhost:4001`.

## Operations

The Operations page runs discovery through `ludora-admin-service`. The Python discovery package lives at `ludora-discovery/` inside this admin repo and is started by the service as a local child process when an operation begins.

Install discovery dependencies when setting up admin operations:

```powershell
cd .\ludora-discovery
python -m pip install -e .
```

Then start `ludora-admin-service` and `ludora-admin-ui` normally. The admin service reads discovery credentials from its own `.env` by default through `LUDORA_DISCOVERY_ENV_FILE`.

Set `LUDORA_DISCOVERY_RUNNER=http` only when intentionally testing against a separately started discovery API.

## Verification

```powershell
cd .\ludora-admin-service
npm test
npm run build

cd ..\ludora-admin-ui
npm test
npm run build
```
