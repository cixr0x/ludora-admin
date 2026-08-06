# Daily Item Discovery Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run product discovery automatically once per day at 05:00 `America/Mexico_City` for active stores, without catch-up runs or overlapping product-discovery jobs, while the continuous item updater keeps running.

**Architecture:** Add an admin-service one-shot schedule manager that launches the existing all-store item-discovery operation and recalculates the next local 05:00 after every trigger. Restrict default all-store discovery to active stores and add a PostgreSQL session advisory lock at the Python product-discovery boundary so manual, scheduled, HTTP-runner, and direct-CLI entry points share one coordinator. Keep this lock independent from the continuous item-update coordinator.

**Tech Stack:** TypeScript 6, Node.js timers and `Intl.DateTimeFormat`, Vitest 4, Python 3, PostgreSQL session advisory locks, standard-library `unittest`

## Global Constraints

- Automatic product discovery runs at 05:00 in `America/Mexico_City`.
- Starting the admin service after 05:00 schedules the next day; never catch up a missed automatic run.
- A launch failure or discovery conflict is not retried automatically that day.
- Manual product discovery remains available whenever no other product-discovery operation is running.
- Only one product-discovery operation may run across scheduled, manual, HTTP-runner, and direct-CLI entry points.
- The continuous item-update worker remains enabled and runs concurrently with discovery.
- Automatic and manual all-store discovery include only `stores.active = true`.
- Explicit manual store-ID discovery remains able to target the requested store IDs.
- Preserve sequential store processing, the shared cross-store three-second product throttle, continue-after-store-failure behavior, aggregate batch failure, cancellation, and existing job/trace persistence.
- Do not add a schema patch or scheduler-specific monitoring page.
- Do not execute SQL against a real database or start a real discovery operation during implementation or verification.

---

### Task 1: Restrict all-store discovery to active stores

**Files:**
- Modify: `ludora-discovery/src/ludora/database.py:294-332`
- Modify: `ludora-discovery/tests/test_database.py:538-560`

**Interfaces:**
- Consumes: `DiscoveryRepository.list_store_item_discovery_sources(*, store_ids: list[int] | None = None)`.
- Produces: unchanged return type `list[StoreItemDiscoverySource]`; `store_ids=None` means active stores only, while explicit IDs remain an operator-directed selection.

- [ ] **Step 1: Write failing active-store selection tests**

Add a default-selection test:

```python
def test_lists_only_active_store_item_discovery_sources_by_default(self):
    connection = FakeConnection(fetchall_rows=[[]])
    repository = DiscoveryRepository(connection)

    repository.list_store_item_discovery_sources()

    sql, params = connection.cursor_instance.executions[0]
    self.assertIn("where stores.active = true", sql.casefold())
    self.assertEqual(params, [])
```

Extend `test_lists_store_item_discovery_sources_for_selected_stores` to prove explicit selection uses the ID predicate and does not silently add the active predicate:

```python
self.assertIn("where stores.id in (%s, %s)", sql.casefold())
self.assertNotIn("stores.active = true", sql.casefold())
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `ludora-discovery`:

```powershell
python -m unittest tests.test_database.DiscoveryRepositoryTests.test_lists_only_active_store_item_discovery_sources_by_default -v
```

Expected: FAIL because the default query currently has no active-store predicate.

- [ ] **Step 3: Implement conditional source filtering**

Build the query predicate exactly once:

```python
params: list[int] = []
if store_ids:
    placeholders = ", ".join(["%s"] * len(store_ids))
    sql += f"\n            where stores.id in ({placeholders})"
    params.extend(store_ids)
else:
    sql += "\n            where stores.active = true"
sql += "\n            order by stores.canonical_domain asc"
```

Do not change platform inference or result mapping.

- [ ] **Step 4: Run focused database tests and verify GREEN**

Run:

```powershell
python -m unittest tests.test_database -v
```

Expected: all database tests PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- ludora-discovery/src/ludora/database.py ludora-discovery/tests/test_database.py
git commit -m "Limit all-store discovery to active stores"
```

---

### Task 2: Enforce one cross-process product-discovery coordinator

**Files:**
- Modify: `ludora-discovery/src/ludora/database.py:417-424`
- Modify: `ludora-discovery/src/ludora/operations.py:212-582`
- Modify: `ludora-discovery/tests/test_database.py`
- Modify: `ludora-discovery/tests/test_operations.py:212-672`
- Modify: `ludora-discovery/tests/test_operation_cli.py`
- Modify: `ludora-admin-service/src/localDiscoveryOperationsClient.ts`
- Modify: `ludora-admin-service/src/localDiscoveryOperationsClient.test.ts`
- Modify: `ludora-admin-service/src/dailyItemDiscoveryScheduleManager.test.ts`

**Interfaces:**
- Consumes: `connect_database(database_url)`, `DiscoveryRepository`, `OperationAlreadyRunning`, public `run_item_discovery(...)`, and public `run_item_discovery_batch(...)`.
- Produces: `DiscoveryRepository.try_acquire_item_discovery_coordinator_lock() -> bool`; both public product-discovery operations fail fast with `OperationAlreadyRunning("Item discovery is already running")` when the lock is unavailable. Each public operation accepts an optional `on_accepted: Callable[[], None]` callback for the local child-process launch handshake.
- Internal contract: `_run_item_discovery_for_store(...)` contains the existing per-store work without coordinator acquisition; both public entry points own a dedicated autocommit coordinator connection, acquire the lock, invoke `on_accepted` when provided, and only then list or process stores.
- Local-process contract: item-discovery single and batch CLI children emit a flushed `@@LUDORA_OPERATION_EVENT@@{"event":"item_discovery.accepted"}` stderr frame after coordinator acquisition. Final stdout remains the existing result JSON. A pre-acceptance conflict exits with the bounded structured stderr code `OPERATION_ALREADY_RUNNING`, which the local Node client maps to `DiscoveryOperationError(..., 409)` before resolving `startItemDiscoveryRun()`.

- [ ] **Step 1: Write the failing repository lock test**

Add a test beside the existing store-item-update coordinator coverage:

```python
def test_acquires_item_discovery_coordinator_with_distinct_advisory_key(self):
    connection = FakeConnection(fetchone_rows=[(True,), (True,)])
    repository = DiscoveryRepository(connection)

    self.assertTrue(repository.try_acquire_item_discovery_coordinator_lock())
    self.assertTrue(repository.try_acquire_store_item_update_coordinator_lock())

    discovery_sql, discovery_params = connection.cursor_instance.executions[0]
    update_sql, update_params = connection.cursor_instance.executions[1]
    self.assertIn("pg_try_advisory_lock", discovery_sql.casefold())
    self.assertIn("pg_try_advisory_lock", update_sql.casefold())
    self.assertEqual(discovery_params, ("ludora:item-discovery-coordinator",))
    self.assertEqual(update_params, ("ludora:store-item-update-coordinator",))
    self.assertNotEqual(discovery_params, update_params)
```

- [ ] **Step 2: Run the repository test and verify RED**

Run:

```powershell
python -m unittest tests.test_database.DiscoveryRepositoryTests.test_acquires_item_discovery_coordinator_with_distinct_advisory_key -v
```

Expected: ERROR because `try_acquire_item_discovery_coordinator_lock` does not exist.

- [ ] **Step 3: Add the repository advisory-lock method**

Implement:

```python
def try_acquire_item_discovery_coordinator_lock(self) -> bool:
    with self.connection.cursor() as cursor:
        cursor.execute(
            "select pg_try_advisory_lock(hashtext(%s))",
            ("ludora:item-discovery-coordinator",),
        )
        row = cursor.fetchone()
    return bool(row and row[0])
```

This is a session lock; closing its owning connection releases it. Do not add explicit unlock SQL or schema objects.

- [ ] **Step 4: Write failing single-store and batch coordination tests**

Add operation tests that prove:

```python
with self.assertRaisesRegex(OperationAlreadyRunning, "Item discovery is already running"):
    run_item_discovery(...)
```

when the dedicated coordinator repository returns `False`, with no operation connection opened and no persisted job started. Add the equivalent rejection case for `run_item_discovery_batch` and prove it does not list or crawl stores.

For successful single-store and batch operations, prove the call order enables autocommit on the dedicated coordinator connection before lock acquisition, then emits acceptance before existing work/listing. For the batch, assert the internal helper is called once per store while the coordinator is acquired only once:

```python
self.assertEqual(run_item_discovery_for_store.call_count, 2)
self.assertEqual(
    [entry.kwargs["store_id"] for entry in run_item_discovery_for_store.call_args_list],
    [12, 34],
)
coordinator_repository.try_acquire_item_discovery_coordinator_lock.assert_called_once_with()
coordinator_connection.close.assert_called_once_with()
```

Use separate `coordinator_connection`, `listing_connection`, per-store connections, and optional `trace_connection` mocks so connection ownership is unambiguous.

Add single-store and batch tests that assert the coordinator connection closes after success, ordinary failure, aggregate failure, and `OperationCancelled`. Extend the CLI error test to assert a coordinator conflict returns exit code `1`, emits no success JSON, and includes the bounded conflict message on stderr.

- [ ] **Step 5: Run coordination tests and verify RED**

Run:

```powershell
python -m unittest tests.test_operations tests.test_operation_cli -v
```

Expected: the new coordination assertions FAIL because product discovery does not yet acquire the advisory lock.

- [ ] **Step 6: Extract the uncoordinated per-store implementation**

Move the current `run_item_discovery` body that opens the trace/job connection and crawls one store into a private helper:

```python
def _run_item_discovery_for_store(
    *,
    database_url: str,
    current_env: Mapping[str, str],
    store_id: int,
    website_url: str,
    # preserve every remaining existing per-store argument
) -> ItemDiscoveryRunResult:
```

The helper must preserve the existing trace events, persisted job lifecycle, request throttle, cancellation paths, and `finally: connection.close()`. It does not acquire or release the coordinator.

- [ ] **Step 7: Coordinate top-level single-store discovery on a dedicated connection**

Keep existing `run_item_discovery(...)` callers compatible while adding the optional `on_accepted` callback. Resolve `database_url`, open a coordinator connection, enable autocommit, acquire the advisory lock, emit acceptance when requested, and invoke the private helper only after successful acquisition:

```python
coordinator_connection = connect_database(database_url)
try:
    coordinator_connection.autocommit = True
    coordinator_repository = DiscoveryRepository(coordinator_connection)
    if not coordinator_repository.try_acquire_item_discovery_coordinator_lock():
        raise OperationAlreadyRunning("Item discovery is already running")
    if on_accepted is not None:
        on_accepted()
    return _run_item_discovery_for_store(
        database_url=database_url,
        current_env=current_env,
        # forward every public argument unchanged
    )
finally:
    coordinator_connection.close()
```

The lock connection remains open across the entire private operation and closes on success, cancellation, conflict, and failure. The operation's existing job/trace connection remains separate.

- [ ] **Step 8: Coordinate the entire batch with a dedicated connection**

At the start of `run_item_discovery_batch`, after resolving `database_url`, acquire one dedicated coordinator connection:

```python
coordinator_connection = connect_database(database_url)
try:
    coordinator_connection.autocommit = True
    coordinator_repository = DiscoveryRepository(coordinator_connection)
    if not coordinator_repository.try_acquire_item_discovery_coordinator_lock():
        raise OperationAlreadyRunning("Item discovery is already running")
    if on_accepted is not None:
        on_accepted()

    # Keep the existing short-lived listing connection and batch body here.
finally:
    coordinator_connection.close()
```

Keep the listing connection separate and close it immediately after loading stores. Call the private helper for each store, forwarding the shared throttle:

```python
_run_item_discovery_for_store(
    database_url=database_url,
    current_env=current_env,
    product_request_throttle=resolved_product_request_throttle,
    # existing per-store arguments
)
```

The coordinator `try/finally` must enclose store selection, selected-ID validation, all per-store calls, aggregate failure tracing, and the final return/raise. Autocommit is required so the session advisory lock is not left idle in a transaction while crawling. Do not call the public coordinated wrapper from the batch. Do not alter the existing shared throttle, continuation, aggregation, trace, or cancellation behavior.

The local Node client must wait only for item-discovery single/batch acceptance; other operation launch semantics stay unchanged. Its stderr frame decoder buffers across chunks, ignores ordinary diagnostics, rejects malformed frames and pre-acceptance terminal paths, maps `OPERATION_ALREADY_RUNNING` to status `409`, and removes child listeners on every terminal path. After acceptance, the child continues to own the existing final stdout result JSON and run-completion lifecycle. A scheduler integration test with this real local client and a fake child must prove a coordinator conflict logs `automatic run skipped` without first logging `automatic run started`.

- [ ] **Step 9: Run focused discovery tests and verify GREEN**

Run:

```powershell
python -m unittest tests.test_database tests.test_operations tests.test_operation_cli -v
```

Expected: all focused tests PASS, with lock connections closed in every terminal path.

- [ ] **Step 10: Commit Task 2**

```powershell
git add -- ludora-discovery/src/ludora/database.py ludora-discovery/src/ludora/operations.py ludora-discovery/tests/test_database.py ludora-discovery/tests/test_operations.py ludora-discovery/tests/test_operation_cli.py
git commit -m "Coordinate product discovery runs"
```

---

### Task 3: Add the exact 05:00 no-catch-up schedule manager

**Files:**
- Create: `ludora-admin-service/src/dailyItemDiscoveryScheduleManager.ts`
- Create: `ludora-admin-service/src/dailyItemDiscoveryScheduleManager.test.ts`

**Interfaces:**
- Consumes: `Pick<DiscoveryOperationsClient, 'startItemDiscoveryRun'>`, `DiscoveryOperationError`, Node timers, and an injectable `now: () => Date`.
- Produces: `nextMexicoCityDiscoveryAt(now: Date) -> Date`; `createDailyItemDiscoveryScheduleManager(options) -> DailyItemDiscoveryScheduleManager` with synchronous `disarm(): void`, `start(): void`, and idempotent `shutdown(): Promise<void>`.

- [ ] **Step 1: Write failing timezone-boundary tests**

Create tests for these exact instants:

```typescript
it.each([
  ['2026-08-05T10:59:59.000Z', '2026-08-05T11:00:00.000Z'],
  ['2026-08-05T11:00:00.000Z', '2026-08-05T11:00:00.000Z'],
  ['2026-08-05T11:00:00.001Z', '2026-08-06T11:00:00.000Z']
])('maps %s to the next Mexico City 05:00 occurrence', (now, expected) => {
  expect(nextMexicoCityDiscoveryAt(new Date(now)).toISOString()).toBe(expected);
});
```

These encode no catch-up after the scheduled instant.

- [ ] **Step 2: Run the new manager test and verify RED**

Run from `ludora-admin-service`:

```powershell
npm test -- src/dailyItemDiscoveryScheduleManager.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement timezone-safe next-occurrence calculation**

Define constants:

```typescript
const DISCOVERY_START_HOUR = 5;
const DISCOVERY_TIME_ZONE = 'America/Mexico_City';
```

Use `Intl.DateTimeFormat(...).formatToParts()` to obtain the local calendar date and timezone offset. Convert the current local date at 05:00 back to a UTC `Date`; return it when it is greater than or equal to `now`, otherwise increment the local calendar date by one day and convert that date at 05:00. Do not hardcode UTC-6 and do not add a date library.

Expose only:

```typescript
export function nextMexicoCityDiscoveryAt(now: Date): Date;
```

- [ ] **Step 4: Write failing scheduler lifecycle and failure-policy tests**

Using Vitest fake timers and a fake operations client, test:

```typescript
expect(operationsClient.startItemDiscoveryRun).toHaveBeenCalledWith({ all_stores: true });
```

at the scheduled instant, then prove the next call occurs only on the following local day. Starting at `2026-08-05T11:00:00.001Z` must produce zero immediate calls.

Add a conflict case using:

```typescript
new DiscoveryOperationError('Discovery operation is already running', 409)
```

Assert one warning, no same-day retry, and the next attempt on the following day. Add a non-409 rejection case that logs one error and also waits until the next day. Add shutdown coverage that disarms the timer synchronously, waits for every in-flight launch promise, and logs stopped only once across repeated calls.

- [ ] **Step 5: Implement the one-shot manager**

Use this public contract:

```typescript
export type DailyItemDiscoveryScheduleManager = {
  disarm(): void;
  start(): void;
  shutdown(): Promise<void>;
};

export function createDailyItemDiscoveryScheduleManager(options: {
  now?: () => Date;
  operationsClient: Pick<DiscoveryOperationsClient, 'startItemDiscoveryRun'>;
}): DailyItemDiscoveryScheduleManager;
```

`start()` computes the next occurrence and creates one timeout. When it fires:

1. Clear the stored timer handle.
2. Schedule the following occurrence from `scheduledAt + 1ms` before launching, preventing an exact-boundary duplicate.
3. Call `startItemDiscoveryRun({ all_stores: true })` exactly once.
4. Log the returned run ID on success.
5. Log a skip for status `409`; log an error for other failures.
6. Never create an additional same-day retry timer.

Use stable log prefixes:

```text
[item-discovery-schedule] next run scheduled
[item-discovery-schedule] automatic run started
[item-discovery-schedule] automatic run skipped
[item-discovery-schedule] automatic launch failed
[item-discovery-schedule] stopped
```

`disarm()` synchronously marks the manager stopped and clears the pending timer without logging. `shutdown()` calls `disarm()`, reuses one shutdown promise across repeated calls, waits for every in-flight launch request, and logs the stop event exactly once. It does not wait for an accepted spawned discovery child; the operations client owns that process lifecycle.

- [ ] **Step 6: Run scheduler tests and verify GREEN**

Run:

```powershell
npm test -- src/dailyItemDiscoveryScheduleManager.test.ts
```

Expected: all new scheduler tests PASS without real waiting.

- [ ] **Step 7: Commit Task 3**

```powershell
git add -- ludora-admin-service/src/dailyItemDiscoveryScheduleManager.ts ludora-admin-service/src/dailyItemDiscoveryScheduleManager.test.ts
git commit -m "Add daily item discovery scheduler"
```

---

### Task 4: Wire production configuration and server lifecycle

**Files:**
- Modify: `ludora-admin-service/src/config.ts`
- Modify: `ludora-admin-service/src/config.test.ts`
- Create: `ludora-admin-service/src/runtimeManagerLifecycle.ts`
- Create: `ludora-admin-service/src/runtimeManagerLifecycle.test.ts`
- Modify: `ludora-admin-service/src/server.ts:1-190`

**Interfaces:**
- Consumes: `createDailyItemDiscoveryScheduleManager`, `DiscoveryOperationsClient`, and the existing continuous-update and update-schedule runtime managers.
- Produces: `Config['dailyItemDiscoverySchedule'].enabled`; `createRuntimeManagerLifecycle(options) -> RuntimeManagerLifecycle` with `start(): void` and `shutdown(): Promise<void>`; production server creation/start/shutdown of the daily discovery scheduler.

- [ ] **Step 1: Write failing configuration tests**

Add:

```typescript
it('keeps daily item discovery scheduling off outside production and accepts an explicit override', () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LUDORA_DAILY_ITEM_DISCOVERY_ENABLED', undefined);
  expect(loadConfig().dailyItemDiscoverySchedule.enabled).toBe(false);

  vi.stubEnv('LUDORA_DAILY_ITEM_DISCOVERY_ENABLED', 'true');
  expect(loadConfig().dailyItemDiscoverySchedule.enabled).toBe(true);
});

it('enables daily item discovery scheduling by default in production', () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('LUDORA_DAILY_ITEM_DISCOVERY_ENABLED', undefined);
  expect(loadConfig().dailyItemDiscoverySchedule.enabled).toBe(true);
});

it('accepts an explicit production disable for daily item discovery scheduling', () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('LUDORA_DAILY_ITEM_DISCOVERY_ENABLED', 'false');
  expect(loadConfig().dailyItemDiscoverySchedule.enabled).toBe(false);
});
```

Use the existing boolean parser, including its invalid-value coverage pattern.

- [ ] **Step 2: Run config tests and verify RED**

Run:

```powershell
npm test -- src/config.test.ts
```

Expected: FAIL because `dailyItemDiscoverySchedule` is absent.

- [ ] **Step 3: Add the configuration property**

Extend `Config`:

```typescript
dailyItemDiscoverySchedule: {
  enabled: boolean;
};
```

Populate it with:

```typescript
enabled: readBooleanEnv(
  'LUDORA_DAILY_ITEM_DISCOVERY_ENABLED',
  process.env.NODE_ENV === 'production'
)
```

Do not add configurable hour or timezone fields.

- [ ] **Step 4: Write failing runtime-manager assembly and lifecycle tests**

Test the production wiring through a pure lifecycle factory. When daily discovery is enabled and an operations client exists, assert the injected discovery-manager factory receives that client and all three managers start and shut down exactly once in the supplied order:

```typescript
const lifecycle = createRuntimeManagerLifecycle({
  continuousItemUpdateWorkerManager: first,
  createDailyItemDiscoveryScheduleManager: dailyFactory,
  dailyItemDiscoveryEnabled: true,
  operationsClient,
  storeItemUpdateScheduleManager: second
});

lifecycle.start();
await lifecycle.shutdown();

expect(events).toEqual([
  'first.start',
  'second.start',
  'daily.start',
  'daily.disarm',
  'first.shutdown',
  'second.shutdown',
  'daily.shutdown'
]);
```

Also prove the discovery manager is not constructed when the flag is disabled or no operations client exists. `undefined` continuous/update managers must be skipped. This is the server-wiring seam; tests must not import side-effectful `server.ts`.

- [ ] **Step 5: Implement the runtime-manager lifecycle factory**

Define:

```typescript
export type RuntimeManager = {
  start(): void;
  shutdown(): Promise<void>;
};

export type RuntimeManagerLifecycle = RuntimeManager;

export function createRuntimeManagerLifecycle(options: {
  continuousItemUpdateWorkerManager?: RuntimeManager;
  createDailyItemDiscoveryScheduleManager?: typeof createDailyItemDiscoveryScheduleManager;
  dailyItemDiscoveryEnabled: boolean;
  operationsClient?: Pick<DiscoveryOperationsClient, 'startItemDiscoveryRun'>;
  storeItemUpdateScheduleManager?: RuntimeManager;
}): RuntimeManagerLifecycle;
```

Use the real daily-manager factory by default. Construct the daily manager only when enabled and an operations client exists. Store the defined managers in this exact order: continuous update, update schedule, daily discovery. `start()` calls each manager once in order. On the first `shutdown()` call, synchronously invoke `dailyItemDiscoveryScheduleManager.disarm()` before awaiting any manager, then drain continuous update, update schedule, and daily discovery sequentially in the established order. Repeated shutdown calls reuse the same drain promise. This two-phase disarm-then-drain behavior prevents the 05:00 timer from firing while an older manager is still shutting down without changing their drain order.

- [ ] **Step 6: Wire the scheduler into `server.ts`**

Create one lifecycle object after `operationsClient`, `continuousItemUpdateWorkerManager`, and `storeItemUpdateScheduleManager` have been resolved:

```typescript
const runtimeManagerLifecycle = createRuntimeManagerLifecycle({
  continuousItemUpdateWorkerManager,
  dailyItemDiscoveryEnabled: config.dailyItemDiscoverySchedule.enabled,
  operationsClient,
  storeItemUpdateScheduleManager
});
```

Start the lifecycle after the server begins listening:

```typescript
runtimeManagerLifecycle.start();
```

During shutdown, stop the lifecycle before shutting down the operations client:

```typescript
await runtimeManagerLifecycle.shutdown();
await shutdownOperationsClient();
```

Do not pass the discovery schedule manager into `createApp`; this task adds no route or UI control.

- [ ] **Step 7: Run configuration, manager, and lifecycle tests**

Run:

```powershell
npm test -- src/config.test.ts src/dailyItemDiscoveryScheduleManager.test.ts src/runtimeManagerLifecycle.test.ts
npm run build
```

Expected: all focused tests PASS and TypeScript compilation exits successfully.

- [ ] **Step 8: Commit Task 4**

```powershell
git add -- ludora-admin-service/src/config.ts ludora-admin-service/src/config.test.ts ludora-admin-service/src/runtimeManagerLifecycle.ts ludora-admin-service/src/runtimeManagerLifecycle.test.ts ludora-admin-service/src/server.ts
git commit -m "Wire daily discovery scheduling"
```

---

### Task 5: Document and verify production behavior

**Files:**
- Modify: `ludora-discovery/README.md`
- Modify: `docs/production-deployment.md`

**Interfaces:**
- Consumes: the behavior delivered by Tasks 1-4.
- Produces: operator-facing configuration, timing, missed-run, concurrency, and verification guidance.

- [ ] **Step 1: Update discovery documentation**

Add a concise coordinator section to `ludora-discovery/README.md` stating:

- all-store discovery selects active stores only;
- explicit store IDs remain targetable;
- one product-discovery job may run at a time across batch and single-store entry points;
- the discovery lock is independent from continuous item updates;
- discovery and continuous updates may run concurrently.

- [ ] **Step 2: Update the production runbook**

Add this production environment setting:

```dotenv
LUDORA_DAILY_ITEM_DISCOVERY_ENABLED=true
```

Document:

- automatic launch at 05:00 `America/Mexico_City`;
- no catch-up after a missed 05:00 start;
- no same-day automatic retry after conflict or launch failure;
- manual retry remains available;
- scheduled and manual all-store runs use active stores only;
- a second product-discovery job is rejected;
- the continuous item-update worker remains active during discovery;
- schedule events appear in `journalctl -u ludora-admin-service.service`;
- deployment smoke tests must not start a real discovery run.

- [ ] **Step 3: Run focused cross-component verification**

From `ludora-discovery`:

```powershell
python -m unittest tests.test_database tests.test_operations tests.test_operation_cli -v
```

From `ludora-admin-service`:

```powershell
npm test -- src/config.test.ts src/dailyItemDiscoveryScheduleManager.test.ts src/runtimeManagerLifecycle.test.ts src/localDiscoveryOperationsClient.test.ts
npm run build
```

Expected: all focused tests and the build PASS without real SQL or discovery requests.

- [ ] **Step 4: Run complete regression suites**

From `ludora-discovery`:

```powershell
python -m unittest discover -s tests -v
```

From `ludora-admin-service`:

```powershell
npm test
npm run build
```

Expected: both complete suites PASS and TypeScript compilation succeeds. If Vitest reports only a worker-process crash without an assertion failure, rerun the identical command once to determine reproducibility and report both results; do not change production code without a reproducible cause.

- [ ] **Step 5: Review and commit documentation**

```powershell
git diff --check
git status --short
git add -- ludora-discovery/README.md docs/production-deployment.md
git commit -m "Document daily discovery operations"
```

- [ ] **Step 6: Final branch verification**

```powershell
git diff --check HEAD~5..HEAD
git log -5 --oneline
git status --short
```

Expected: five task commits, no whitespace errors, and a clean working tree. Do not apply SQL, start a discovery operation, push, merge, or deploy without separate user authorization.
