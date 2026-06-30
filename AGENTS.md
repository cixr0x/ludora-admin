# AGENTS.md

## Fixed Local Ports

Use the fixed Codex startup commands for local development:

- Admin service: from `ludora-admin-service/`, run `npm run dev:codex`
- Admin UI: from `ludora-admin-ui/`, run `npm run dev:codex`
- Discovery package: lives at `ludora-discovery/` and is invoked by `ludora-admin-service`; do not start a separate discovery API unless explicitly testing `LUDORA_DISCOVERY_RUNNER=http`.
- Admin service URL: `http://127.0.0.1:4001`
- Admin UI URL: `http://127.0.0.1:5173`

Do not choose another port automatically. If one of these ports is busy, report the owning process and ask before stopping it or using a different port.

Do not run DDL or DML SQL commands without user confirmation.
