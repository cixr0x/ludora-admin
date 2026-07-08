# External Cover Image Optimization Admin UI Design

## Goal

Expose the existing external cover image optimizer from the Ludora admin UI as a single apply-only maintenance action.

## Context

The admin service already contains `optimizeExternalCoverImages`, which scans external `items.image_url` and `items.image_url_es` values, downloads oversized unmanaged images, converts them to WebP, uploads them to the configured S3 bucket, and updates the relevant item image URL column.

The user approved an Operations subpage with only the applying action. The UI must not add a SQL confirmation dialog. No database schema changes are required.

## Design

Add a new Operations child route named `operations-image-optimization`. The page will show one action, `Optimize External Cover Images`, and call a new authenticated admin-service endpoint. The endpoint will call the existing optimizer with `apply: true` and return the optimizer result in the existing `{ data }` envelope.

The admin service will receive the optimizer dependencies through `createApp` so tests can inject a deterministic optimizer and the production server can use `createNodeExternalCoverImageOptimizerDependencies(config.localCoverWorkflow)`.

## Data Flow

1. Admin user opens `#operations-image-optimization`.
2. UI renders the image optimization subpage.
3. User clicks `Optimize External Cover Images`.
4. UI sends `POST /admin/operations/external-cover-image-optimizations`.
5. Admin service runs `optimizeExternalCoverImages(database, dependencies, { apply: true })`.
6. Service returns summary counts, optimized rows, skipped rows, and failures.
7. UI displays summary counts and any failures.

## Error Handling

The route will reuse the app JSON error handler. The UI will display a concise error alert if the request fails. The button remains disabled while a request is in flight.

## Testing

Add service tests proving the endpoint invokes the optimizer with `apply: true` and returns the result. Add UI client tests proving the API method posts to the correct endpoint. Add Operations/App tests proving the navigation link, route, button, request, and returned summary render correctly.
