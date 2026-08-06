# Daily Item Discovery Scheduling Design

## Goal

Automatically run product discovery once per day at 05:00 in `America/Mexico_City` for every active curated store. A missed automatic start is skipped until the following day, while manual product discovery remains available whenever no other product-discovery job is running.

## Scheduled Operation

Add a daily item-discovery schedule manager to the admin service. The manager uses the existing `DiscoveryOperationsClient` to launch the same all-store item-discovery batch used by the manual UI action:

```typescript
operationsClient.startItemDiscoveryRun({ all_stores: true })
```

Automatic and manual product discovery therefore share the same process construction, environment, cancellation, result parsing, job logging, and trace behavior.

The schedule is enabled in production and can be disabled through an admin-service environment flag for operational rollback. The time and timezone remain application constants: 05:00 and `America/Mexico_City`.

## Timing and Missed Runs

When the admin service starts, the schedule manager computes the next future 05:00 in the configured timezone:

- Before 05:00, the next run is 05:00 on the current local date.
- At 05:00, the run is eligible to start immediately.
- After 05:00, the next run is 05:00 on the following local date.

The manager uses a one-shot timer and recalculates the next local occurrence after every trigger. It does not use a fixed 24-hour interval, avoiding drift and retaining timezone semantics.

There is no catch-up window. If the VM or admin service is unavailable at 05:00, a restart after 05:00 schedules the next day. If launch fails or conflicts with a running product-discovery job, the automatic attempt is skipped and is not retried that day. An operator may still launch discovery manually after the conflict or failure clears.

Shutdown clears the pending timer. The existing operations-client shutdown path remains responsible for cancelling an active child process.

## Active Store Selection

The all-store discovery lookup currently returns curated stores regardless of `stores.active`. Change its default behavior so a batch with no explicit store IDs selects only:

```sql
where stores.active = true
```

This applies to automatic discovery and the manual **all stores** action. Explicit manual store-ID selection retains the existing ability to target a particular store, including an inactive store when an operator intentionally chooses it.

Stores remain ordered by canonical domain. The batch continues to process stores sequentially with one shared product-request throttle.

## Discovery Concurrency

Only one product-discovery operation may run at a time. This includes:

- the automatic all-store batch;
- a manual all-store or selected-store batch;
- a manual single-store product-discovery run;
- a directly invoked product-discovery CLI process.

Keep the existing admin-service operation guard for UI and scheduled launches. Add a product-discovery-specific PostgreSQL advisory lock with a distinct key such as `ludora:item-discovery-coordinator` at the Python operation boundary. Hold the lock on a dedicated connection for the complete top-level discovery operation and release it by closing that connection in all success, cancellation, and failure paths.

The batch acquires this coordinator once and calls an internal per-store implementation without reacquiring it. A top-level single-store run acquires the same coordinator before invoking that implementation. Failure to acquire the lock fails fast with an “Item discovery is already running” error before crawling any store.

The discovery coordinator is separate from the existing `ludora:store-item-update-coordinator` lock. The continuous item-update worker is not paused and remains free to claim and refresh products throughout discovery.

## Failure Behavior

Existing batch behavior remains unchanged after launch:

- Each store receives its own persisted job and trace context.
- A store failure is recorded and the batch continues with the remaining stores.
- After every selected store is attempted, any accumulated store failures make the parent batch fail.
- A failed automatic batch is not automatically rerun that day; manual retry remains available.

If a manual product discovery is already active at 05:00, the automatic launch is logged as skipped. If the automatic batch starts first, a subsequent manual product-discovery request receives the existing conflict response.

## Observability

Add structured admin-service log events for:

- the next scheduled discovery time;
- an automatic discovery launch and its run ID;
- an automatic attempt skipped because discovery is already running;
- an automatic launch failure;
- scheduler shutdown.

Per-store results, failures, and trace details continue to use the existing persisted discovery job and trace tables. This design does not add scheduler-specific database history or a new monitoring page.

## Data and Deployment Impact

No schema migration or one-time data update is required. The advisory lock uses PostgreSQL session locking and does not create database objects. The active-store filter is application-owned read SQL.

Deployment changes the admin service and discovery package, so production rollout must refresh both components and restart the admin service. The runbook must document the enable flag, 05:00 timezone behavior, no-catch-up rule, concurrency rule, and active-store selection.

## Verification

Admin-service tests must cover:

- scheduling the current day before 05:00;
- scheduling the following day after 05:00;
- starting exactly one all-store run at 05:00;
- recalculating the following day after a trigger;
- skipping without same-day retry when the operation client reports a conflict;
- logging launch failures without same-day retry;
- clearing the timer during shutdown;
- production-default and explicit-disable configuration;
- server lifecycle wiring.

Discovery tests must cover:

- default all-store selection filtering to active stores;
- explicit store-ID selection preserving targeted behavior;
- one batch coordinator lock covering every store;
- single-store and batch discovery rejecting a competing coordinator;
- lock release after success, failure, and cancellation;
- item-discovery and store-item-update coordinator keys remaining independent.

Run the focused scheduler, configuration, server-wiring, operations, database, and CLI tests, followed by the complete admin-service and discovery suites and the admin-service build. Tests must use fake databases, clocks, timers, processes, and network clients; they must not execute SQL against a real database or start a real discovery run.
