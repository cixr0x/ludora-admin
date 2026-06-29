# Discovery Operations API Design

## Goal

Expose the existing store discovery process as a small local API so admin tooling can trigger it without shell access.

## Scope

The API serves operational discovery commands only. It is not a public platform API and does not expose curated catalog data.

## Endpoints

- `GET /health` returns service health.
- `POST /operations/store-discovery-runs` starts one store discovery run in the background.
- `GET /operations/store-discovery-runs/{run_id}` returns status for a known run.
- `GET /operations/store-discovery-runs/latest` returns the latest known run, or `null`.

## Runtime Behavior

Only one store discovery run may be active at a time. A second start request while a run is `running` returns HTTP `409`.

The run uses the existing discovery defaults and persists to `discovery_store_candidates` through the existing repository. It resolves `BRAVE_SEARCH_API_KEY` and `LUDORA_DATABASE_URL` from environment variables or `.env`.

## Run Status Shape

Each response returns a `data` object:

```json
{
  "id": "uuid",
  "type": "store_discovery",
  "status": "running",
  "started_at": "2026-05-25T20:00:00Z",
  "completed_at": null,
  "result": null,
  "error": null
}
```

Completed runs include `searched_queries`, `candidate_domains`, and `accepted_stores`.

## Error Handling

Configuration and runtime failures mark the run as `failed` and expose a concise error message in the run status. API-level errors return JSON `{ "error": { "message": "..." } }`.

## Testing

Tests cover the runner's use of existing discovery functions and the API routing/status behavior without calling Brave or a real database.
