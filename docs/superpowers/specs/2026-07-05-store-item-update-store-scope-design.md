# Store Item Update Store Scope Design

## Goal

Store item update runs must be scoped from the Admin UI. An operator can select one or more stores from the curated `stores` table and run the update only for those stores, or use a separate "Run for all" action that runs the same process for every store without selecting all stores in the interface.

## Store Eligibility

All rows in the `stores` table are eligible. The current `stores.status` value is not used for filtering because existing stores are currently in `draft` status.

The item update still keeps the existing store item eligibility rules. It updates only store items that are listed, confirmed board-game rows with an item reference and source URL.

## Admin UI

The Store Item Update operation page displays a selectable store list:

- Each store row has a checkbox.
- The list shows enough identifying data to choose the store, such as name, canonical domain, website URL, and platform when available.
- "Run for selected stores" is enabled only when at least one store is selected.
- "Run for all" is always available when no update run is already being started.
- Store selection is local UI state and is not used by "Run for all".

The UI must not batch one request per store. It sends one request for the selected scope and lets the backend manage the multi-store operation.

## Backend API

The existing item update operation endpoint should accept a store scope in the request body:

```json
{
  "store_ids": [12, 34, 56]
}
```

For the all-stores action, the UI sends:

```json
{
  "all_stores": true
}
```

The endpoint rejects invalid selected-store requests, including empty `store_ids`, non-numeric IDs, duplicate IDs, or a body that combines `store_ids` with `all_stores`.

Existing no-body behavior should remain compatible and behave as an all-stores run.

## Discovery Flow

The admin service passes the selected store IDs to the discovery operation as one backend-managed run. The local discovery client forwards the scope through the operation CLI. The discovery operation then passes the scope to the item update process.

When store IDs are present, the repository query for confirmed board-game item candidates filters by `store_id`. When no store IDs are present, the query keeps the current all-stores behavior.

## Job Logging

The existing store item update job log continues to represent the full backend operation run. A selected-store run is one job, not one job per store. The current aggregate fields still apply:

- status
- started and completed timestamps
- error
- items scanned
- items updated

No schema change is required for this design unless later audit requirements need the exact selected store list persisted in the job log.

## Error Handling

If the store list cannot be loaded, the page shows an error and disables "Run for selected stores". "Run for all" remains available because it does not depend on loaded store selection.

If the backend rejects the scope or the operation fails to start, the UI shows the existing operation error state and keeps the selected stores intact.

## Testing

Implementation should cover:

- UI renders the store checkbox list and tracks selected IDs.
- "Run for selected stores" sends one request with `store_ids`.
- "Run for all" sends one request with `all_stores: true` and does not depend on selected checkboxes.
- Admin service validates request bodies and forwards the scope to the operations client.
- Local discovery client forwards selected store IDs to the CLI.
- Discovery CLI parses selected store IDs.
- Discovery operation passes selected store IDs to the update workflow.
- Repository query filters by selected store IDs while preserving existing item eligibility filters.
