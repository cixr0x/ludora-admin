# AGENTS.md

## Fixed Local Ports

Use the fixed Codex startup commands for local development:

- Admin service: from `ludora-admin-service/`, run `npm run dev:codex`
- Admin UI: from `ludora-admin-ui/`, run `npm run dev:codex`
- Discovery package: lives at `ludora-discovery/` and is invoked by `ludora-admin-service`; do not start a separate discovery API unless explicitly testing `LUDORA_DISCOVERY_RUNNER=http`.
- Admin service URL: `http://127.0.0.1:4001`
- Admin UI URL: `http://127.0.0.1:5173`

Do not choose another port automatically. If one of these ports is busy, report the owning process and ask before stopping it or using a different port.

## Production VM

- Instance: `ludora-admin`
- GCP project: `ludora-501213`
- Zone: `us-central1-c`
- SSH user: `robertorojas87`
- Connect with `gcloud compute ssh robertorojas87@ludora-admin --project ludora-501213 --zone us-central1-c`
- Admin checkout: `/opt/ludora/ludora-admin`
- Codex API checkout: `/opt/ludora/codexapi`
- Run application services as `robertorojas87`.
- Do not use the automatically created `mcp13` account for deployment or service ownership.

## Completion

When a task changes files, commit and push the task changes in each affected Git repository before reporting completion. If unrelated pre-existing changes are present, leave them untouched and report them separately.

## Database Changes

Do not apply `database/schema.sql` to existing shared or live databases. It is a snapshot/reference only, not the routine update mechanism.

Every database change must have a focused incremental SQL patch in `database/patches/`. Apply only the specific patch required for the change, and only after explicit DDL/DML approval.

## AI API Flow

Use `docs/ai-api-flow.md` for new AI requests. Admin-service owns prompts, routes, and OpenAI Responses clients through `ludora-admin-service/src/ai/openAiResponsesClient.ts`. Discovery code that needs a new AI task should call an admin-service endpoint and should reuse the existing admin `.env` values instead of creating a separate key flow.

Do not run DDL or DML SQL commands without user confirmation.
