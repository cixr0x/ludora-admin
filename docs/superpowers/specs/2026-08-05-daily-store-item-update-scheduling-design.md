# Daily Store Item Update Scheduling Design

## Goal

Distribute continuous store-item refreshes throughout each day so products from the same store are not refreshed in creation-date clusters. Preserve the five-second continuous worker cadence, item-level retry backoff, platform cooldowns, and the existing update-history behavior.

## Confirmed Behavior

- The admin service schedules eligible store items once daily at 3:00 AM in the `America/Mexico_City` time zone.
- Each run distributes updates over the following 20 hours. A normal automatic window therefore runs from 3:00 AM through 11:00 PM local time.
- Items are evenly spaced independently for each store. Their order and each store's starting offset are randomized on every run.
- The continuous worker keeps its existing five-second cadence and processes due items one at a time.
- A successful refresh removes that item from the due queue by setting `next_update_at` to null.
- A failed refresh remains in the queue and receives the existing item-level backoff. Platform-wide cooldown behavior remains unchanged.
- There is no per-item daily-cycle or generation state.
- The next automatic or manual scheduling run overwrites the current `next_update_at` value for every eligible item, including failed items awaiting a retry and items already refreshed that day.
- Store items discovered after a scheduling run start with no due time and wait for the following scheduling run.
- The Update Monitor provides a manual action that invokes the same scheduling operation used by the 3:00 AM trigger.

## Scheduling Architecture

Add a `StoreItemUpdateScheduleManager` to the admin service. The manager owns the automatic timer and calls one shared scheduling operation for both automatic and manual triggers.

The manager checks immediately on service startup and then at a short periodic interval. At or after 3:00 AM local time, it runs the automatic schedule when no successful automatic run exists for that local calendar date. This provides catch-up behavior if the service or VM was unavailable at 3:00 AM. A manual run does not count as the date's automatic run and does not suppress the 3:00 AM schedule.

The service uses a dedicated PostgreSQL advisory lock while scheduling. Only one service instance or API request may schedule at a time. A second manual request receives a conflict response, while an automatic tick exits cleanly and tries again later. The advisory lock is independent from the continuous worker coordinator lock, so scheduling does not require pausing updates.

Both trigger paths provide the execution time as `window_start`; `window_end` is exactly 20 hours later. A normal automatic run starts at 3:00 AM. A delayed catch-up or manual run starts at its actual execution time rather than placing due timestamps in the past.

## Per-Store Distribution

The scheduling transaction selects the same store items that the continuous worker is allowed to refresh:

- the owning store is active;
- the store item itself is active;
- the item is a confirmed board-game listing;
- it is linked to a catalog item;
- it has a usable source URL;
- its listing status is `LISTED`; and
- it is not currently protected by a live item-update lease.

Platform cooldowns do not exclude items from scheduling. They continue to defer claims at worker execution time.

Within each store partition, the scheduling query:

1. Shuffles eligible items with a new random order.
2. Counts the items in the store.
3. Generates one random fractional phase for the store.
4. Places each item using its zero-based shuffled rank `n`: `window_start + ((n + phase) / store_item_count) * 20 hours`.

This produces equal spacing for a store without aligning every store to the beginning of the window. It removes creation and refresh ordering from the schedule while avoiding the collisions produced by assigning every item an unrelated random timestamp.

The scheduling update changes only `next_update_at`. It does not clear leases, failure counters, cooldowns, product fields, or update history. If an update is already in flight when scheduling begins, that in-flight result wins: success clears the due time and failure assigns its backoff time. The current refresh counts as that item's update for the new day.

## Database State

Keep `20260804_004_randomize_listed_store_item_update_schedule.sql` unchanged and commit it as an immutable historical patch. Patch `004` has already been applied and must not be executed again. Add all new schema changes in the sequential `20260804_005_daily_store_item_update_scheduling.sql` patch.

Change `store_items.next_update_at` to be nullable and remove its `now()` default. Existing insertion paths will therefore create unscheduled store items unless they explicitly provide a due time. The continuous claim query already treats null as not due.

Add a `store_item_update_schedule_runs` table containing:

- a generated run identifier;
- trigger type: `AUTOMATIC` or `MANUAL`;
- the automatic local schedule date, null for manual runs;
- status: `RUNNING`, `COMPLETED`, or `FAILED`;
- window start and end timestamps;
- scheduled item and store counts;
- start and completion timestamps; and
- a bounded error-detail field.

A partial unique index permits only one automatic run row per local schedule date. Failed or abandoned automatic rows are reused for retry instead of inserting a duplicate. A run left `RUNNING` after a process crash may be reclaimed once its advisory lock has been released. The item timestamp update and transition to `COMPLETED` occur in one database transaction, preventing a completed run record without its schedule or a committed schedule without a completed run record. Failures are recorded separately after rollback.

`database/schema.sql` is updated only as the schema snapshot. No patch or runtime DML will be executed against a shared or production database until its exact SQL is shown and explicitly approved.

## Continuous Worker Changes

Remove the successful-update calculation that currently schedules the item approximately 21 to 23 hours later. On success, `complete_claimed_store_item_update` sets `next_update_at` to null while retaining the existing field-change history, lease clearing, failure reset, and product update behavior.

Failure handling is unchanged: the worker increments the consecutive failure count and assigns the normal progressive retry time, extended when necessary by a platform cooldown. A failed item may retry after the 20-hour distribution window. The following automatic or manual scheduling run may replace that outstanding retry time.

The claim query continues to require `next_update_at <= now()`, so null items cannot be selected. Any discovery or product-creation path that explicitly assigns an immediate or 22-hour due time will be changed to leave the item unscheduled.

## Admin API

Add an authenticated endpoint alongside the existing Update Monitor and worker controls:

- `POST /admin/operations/store-item-update-schedule/run`

The endpoint invokes the shared scheduling operation with trigger `MANUAL`. A successful response returns the run identifier, window boundaries, scheduled store and item counts, and completion status. It returns a conflict when another schedule run holds the advisory lock, and a server error with a persisted failed-run record when scheduling fails.

Extend the Update Monitor response with:

- the most recent schedule run;
- the most recent successful automatic run;
- the count of eligible items with no schedule;
- the count due now and scheduled later;
- the active window boundaries; and
- capacity values for the configured worker cadence and 20-hour window.

The theoretical capacity at a five-second cadence is 14,400 attempts in 20 hours. Actual capacity is lower because request duration and retries consume time. The API exposes both the configured cadence and calculated theoretical capacity instead of hard-coding the displayed number.

## Admin UI

Add **Redistribute update schedule** beside the existing Update Monitor controls. The action explains that it will reschedule every eligible item over a new 20-hour window, including items updated earlier that day and failures currently in backoff. The button is disabled while the request is running.

After success, refresh the monitor and show the run's item count and window. Show clear errors for a concurrent run or scheduling failure.

Add schedule status to the monitor:

- last run trigger and status;
- last automatic run time;
- scheduled, due, and unscheduled counts;
- current scheduling window; and
- a warning when scheduled volume approaches or exceeds theoretical worker capacity.

Keep the existing worker controls, failures-by-store statistics, attempt details, platform cooldowns, and staleness histogram with its store filter.

## Failure and Recovery Behavior

- Service restart before 3:00 AM waits for the normal trigger.
- Service restart after 3:00 AM catches up when today's automatic schedule has not completed.
- Duplicate service instances cannot run the scheduler concurrently because of the advisory lock and automatic-date uniqueness.
- A failed scheduling transaction leaves existing `next_update_at` values unchanged.
- A crashed `RUNNING` record can be retried after its database session releases the advisory lock.
- Manual runs are additive operational actions; they never disable or replace the next automatic run.
- Worker pause and platform cooldown state are unaffected by scheduling.
- Ineligible or inactive-store items retain any stored timestamp but remain unclaimable. If they become eligible, they enter the next scheduling run.

## Testing

Admin-service tests will verify:

- the 3:00 AM `America/Mexico_City` boundary;
- startup catch-up before and after the boundary;
- one successful automatic run per local date;
- advisory-lock conflict behavior;
- recovery of failed and abandoned runs;
- manual and automatic triggers calling the same scheduling operation;
- per-store random order and equal spacing within the 20-hour window;
- exclusion of inactive, unlisted, invalid, and actively leased items;
- run-history success and failure recording; and
- monitor scheduling and capacity fields.

Discovery tests will verify:

- successful updates clear `next_update_at`;
- failed updates retain progressive backoff and platform cooldown behavior;
- claims ignore null schedules; and
- new discoveries remain unscheduled.

Admin-UI tests will verify the confirmation text, request lifecycle, conflict and failure messages, successful monitor refresh, last-run information, counts, and capacity warning.

Run the focused service, discovery, and UI suites first, followed by the normal repository builds and tests. Database-backed scheduling-query verification will occur only after the exact patch and runtime SQL have been approved.

## Deployment Sequence

1. Commit the implementation and the existing historical `004` patch without altering its SQL.
2. Present the exact SQL from patch `005`, plus the runtime scheduling DML, and obtain explicit approval.
3. Apply only the approved incremental patch `005`; do not reapply `004`.
4. Deploy the admin service, discovery package, and admin UI at one exact commit.
5. Verify scheduler startup state, worker health, and the Update Monitor.
6. Run the manual schedule once if an immediate 20-hour redistribution is desired; otherwise the next 3:00 AM automatic run initializes the new schedule.
7. Confirm per-store due-time spacing, successful nulling, failure backoff, and live run-history output.
