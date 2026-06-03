# Admin Operations Page Design

## Goal

Add an admin UI page where an operator can run store discovery from the browser.

## Naming

The page is named `Operations`. This is more specific than `Actions` and leaves room for future operational jobs such as inventory discovery, BGG imports, and indexing.

## Architecture

The UI continues to call `ludora-admin-service` only. The admin service proxies operation requests to `ludora-discovery` through `LUDORA_DISCOVERY_API_URL`.

## Admin Service API

- `POST /admin/operations/store-discovery-runs` starts a discovery run through the discovery API.
- `GET /admin/operations/store-discovery-runs/latest` fetches the latest known discovery run.
- `GET /admin/operations/store-discovery-runs/:runId` fetches a specific run.

The proxy preserves `409` conflict responses when discovery is already running and returns JSON error bodies for other failures.

## UI Behavior

The sidebar gets an `Operations` item. The page shows a single operation row for `Store discovery`, a `Run Store Discovery` button, the latest status, timestamps, and summary counts when available. While a run is active, the button is disabled and the page polls the latest run.

## Testing

Admin-service tests use a fake discovery operations client. UI tests mock `fetch`, verify the nav item, click the run button, and verify status/count rendering.
