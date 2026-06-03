# Clean Stores Item Discovery Design

## Goal

Add an admin workflow for approved stores. Admins can browse and edit rows from the clean `stores` table, open a store form, and start item discovery for that specific store.

## Scope

In scope:

- Add a `Stores` admin section backed by the clean `stores` table.
- Keep `Store Candidates` focused on dirty discovery review.
- Add table sorting/filtering and double-click form navigation for clean stores.
- Allow editing clean store fields.
- Add a `Run Item Discovery` button in the clean store form.
- Proxy the button through `ludora-admin-service` to `ludora-discovery`.

Out of scope:

- Creating clean stores manually.
- Running item discovery from pending/rejected store candidates.
- Polling item discovery progress in the Stores form.
- Store-specific crawler adapters.

## Data Flow

1. Admin opens `Stores`.
2. UI loads `GET /stores` from `ludora-admin-service`.
3. Admin double-clicks a row and opens form view.
4. Admin may save changes through `PATCH /stores/:id`.
5. Admin clicks `Run Item Discovery`.
6. Admin service loads the clean store by id and sends `store_id` plus `website_url` to discovery API.
7. Discovery API starts a background run that calls `collect_store_inventory(website_url, store_id, repository)`.
8. Crawler writes dirty item rows to `store_items`.

## API Shape

Admin service:

- `GET /stores`
- `PATCH /stores/:id`
- `POST /admin/operations/stores/:storeId/item-discovery-runs`

Discovery service:

- `POST /operations/stores/:storeId/item-discovery-runs`

The discovery API request body contains:

```json
{
  "website_url": "https://example.mx/"
}
```

The run response uses the existing run shape with `type = "item_discovery"` and a result containing `store_id`, `website_url`, and `item_candidates`.

## UX

Navigation will show both `Store Candidates` and `Stores`.

The Stores table uses clean store labels:

- Name
- Domain
- Website
- Instagram
- Facebook
- City
- State
- Country
- Logo
- Status
- Updated

The form displays editable fields and a separate `Run Item Discovery` action. The action button is disabled while a run request is being submitted and displays a success or error alert after the request completes.

## Testing

Discovery tests cover route parsing and item discovery run execution.

Admin service tests cover clean stores listing/updating and proxying the item discovery operation.

Admin UI tests cover navigation, Stores table rendering, form editing, and the item discovery button request.
