# Platform Cooldown and Continuous Update Control Design

## Goal

Prevent a stream of HTTP 429 failures from one store platform from consuming the continuous update worker, and let an administrator stop and restart the automatic update worker from the existing Update Monitor page.

## Confirmed Behavior

- Rate-limit cooldowns are platform-wide, not store-specific.
- Shopify and WooCommerce have independent cooldown state.
- A WooCommerce 429 prevents claims for every WooCommerce store until its cooldown expires.
- Pausing stops only the continuous automatic update worker.
- The current item may finish before the worker exits and releases the coordinator lock.
- Once the worker has stopped, manual store-item update jobs may acquire the coordinator lock.
- Resuming starts a new continuous worker process.
- Pause state is process-local. Restarting the admin service or VM starts the automatic worker again when continuous updates are enabled by configuration.

## Root Cause

The worker already paces requests, but the durable 429 block is hard-coded to Shopify. When Chocita Juegos began returning HTTP 429, each failed item was individually rescheduled while the claim query immediately selected another due WooCommerce item. Production traces showed consecutive WooCommerce requests approximately every five seconds with `shopify_blocked_until` left null.

## Platform Cooldown State

Add a focused incremental database patch that creates `store_item_update_platform_cooldown` with one row per worker name and normalized platform:

- `worker_name text`
- `platform text`
- `blocked_until timestamptz`
- `consecutive_429s integer`
- `updated_at timestamptz`
- Primary key: `(worker_name, platform)`

The patch will copy any existing Shopify block and consecutive count from `store_item_update_worker_state` into the new table. The legacy Shopify columns will remain in place for backward compatibility but will no longer drive scheduling after this change.

The claim query will exclude stores whose normalized platform has an unexpired row in `store_item_update_platform_cooldown`. The existing Shopify raw-payload inference remains part of platform normalization.

For Shopify or WooCommerce HTTP 429 responses, the worker will:

1. Increment that platform's consecutive 429 count.
2. Calculate the existing progressive delay: 15 minutes, 60 minutes, 6 hours, then 24 hours.
3. Honor a longer server `Retry-After` value, capped at 24 hours.
4. Persist the platform block and reschedule the failed item no earlier than the block expiry.
5. Continue processing eligible items from other platforms.

A successful update for the affected platform clears its block and resets its consecutive count. Non-429 failures keep the normal item-level retry behavior and do not create a platform block.

## Worker Pause and Resume

Extend the existing `ContinuousItemUpdateWorkerManager` with process-local control state and three operations:

- `pause()` marks automatic restart as disabled and sends `SIGTERM` to the active Python worker.
- `resume()` clears the paused flag and launches a worker when none is active.
- `getStatus()` returns `running`, `stopping`, or `paused` for the monitor and API.

The Python worker's existing signal handler sets its stop event. It finishes the in-flight claim, marks the worker stopped, closes its database connection, and thereby releases the advisory coordinator lock. Pause will not use the shutdown force-kill timer because the approved behavior allows the current item to finish. Service shutdown retains its existing bounded termination behavior.

If Resume is requested while the process is still stopping, the manager records the desired running state and relaunches after the old child closes. Duplicate Pause and Resume requests are idempotent.

## Admin API

Pass the manager's control interface into the operations router and add authenticated endpoints:

- `POST /admin/operations/store-item-update-worker/pause`
- `POST /admin/operations/store-item-update-worker/resume`

Each endpoint returns the current control status. If the continuous worker is disabled or unavailable, the API returns a clear conflict response rather than pretending the action succeeded.

The existing store-item update monitor response will include the manager control status and the active platform cooldown rows. Database worker health remains available separately so the UI can distinguish a deliberate stop from a stale or failed worker.

## Admin UI

Add controls beside Refresh on **Operations > Update Monitor**:

- Show **Pause automatic updates** while running.
- Show **Stopping automatic updates** disabled while the worker is exiting.
- Show **Resume automatic updates** while paused.

After a control request, refresh the monitor immediately and continue the existing polling. Display cooldown chips for each currently blocked platform, including its expiry time. Keep the existing worker heartbeat and statistics visible.

## Error Handling

- A pause request succeeds when already paused or stopping.
- A resume request succeeds when already running.
- Spawn failures continue through the existing supervised restart path unless the manager is paused or shutting down.
- A platform cooldown write and the failed item update remain in the same database transaction.
- A missing or expired cooldown row never blocks claims.
- Manual updates remain blocked only until the automatic worker has actually exited and released the coordinator lock.

## Testing

Discovery tests will verify:

- A WooCommerce 429 starts the first platform-wide 15-minute block.
- A longer `Retry-After` value wins within the 24-hour cap.
- Repeated WooCommerce 429 responses advance the progressive backoff.
- WooCommerce claims are skipped during its block while Shopify and other platforms remain eligible.
- A successful WooCommerce update clears its platform cooldown.
- Existing Shopify behavior uses the same platform cooldown path.

Admin-service tests will verify manager pause, stopping, resume, idempotency, close/restart races, API responses, and monitor cooldown output. Admin-UI tests will verify the correct control button and blocked-platform chips, plus successful pause/resume API calls and refresh behavior.

## Deployment and Database Safety

The database change will be a new incremental patch under `database/patches/`; `database/schema.sql` will be updated only as the schema snapshot. Before the patch is executed against any shared or production database, its exact SQL must be shown and explicitly approved. Application deployment will occur only after the patch is approved and applied because the new claim query depends on the cooldown table.
