# AGENTS.md

## Fixed Local Ports

Use the fixed Codex startup commands for local development:

- Admin service: from `ludora-admin-service/`, run `npm run dev:codex`
- Admin UI: from `ludora-admin-ui/`, run `npm run dev:codex`
- Discovery package: lives at `ludora-discovery/` and is invoked by `ludora-admin-service`; do not start a separate discovery API unless explicitly testing `LUDORA_DISCOVERY_RUNNER=http`.
- Admin service URL: `http://127.0.0.1:4001`
- Admin UI URL: `http://127.0.0.1:5173`

Do not choose another port automatically. If one of these ports is busy, report the owning process and ask before stopping it or using a different port.

## AI API Flow

Use `docs/ai-api-flow.md` for new AI requests. Admin-service owns prompts, routes, and OpenAI Responses clients through `ludora-admin-service/src/ai/openAiResponsesClient.ts`. Discovery code that needs a new AI task should call an admin-service endpoint and should reuse the existing admin `.env` values instead of creating a separate key flow.

Do not run DDL or DML SQL commands without user confirmation.
