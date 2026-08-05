# Daily Store Item Update Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Schedule every eligible active-store item once per day across a randomized, per-store-even 20-hour window while preserving five-second claims, failure backoff, platform cooldowns, and update history.

**Architecture:** A new admin-service schedule manager checks the `America/Mexico_City` 3:00 AM boundary and calls the same PostgreSQL-backed schedule service as the manual API action. The service uses one dedicated database session for a session advisory lock, durable run row, transactional per-store distribution, and crash recovery; successful Python worker updates clear `next_update_at`, while errors continue assigning backoff timestamps.

**Tech Stack:** PostgreSQL 16 SQL, Node.js/TypeScript, Express, `pg`, Vitest/Supertest, Python 3.10+/`psycopg`, `unittest`, React 19, Material UI, Testing Library.

## Global Constraints

- Automatic scheduling time zone is exactly `America/Mexico_City`.
- Automatic scheduling begins at 3:00 AM local time; delayed catch-up and manual windows begin at actual execution time.
- Every schedule window is exactly 20 hours.
- The existing `LUDORA_CONTINUOUS_ITEM_UPDATE_ENABLED` flag controls both the Python continuous worker and the automatic schedule manager; no new environment variable is introduced.
- A successful refresh sets `next_update_at` to null. A failed refresh keeps existing item and platform backoff behavior.
- New discoveries remain unscheduled until the following automatic or manual scheduling run.
- Manual and automatic triggers use the same scheduling service and SQL. Manual runs never satisfy or suppress the day's automatic run.
- Patch `20260804_004_randomize_listed_store_item_update_schedule.sql` is already applied. Commit it unchanged as history and never execute it again.
- All new schema changes belong to sequential patch `database/patches/20260804_005_daily_store_item_update_scheduling.sql`.
- Do not execute patch `005` or runtime scheduling DML against any database until the exact SQL has been shown and explicitly approved.
- `database/schema.sql` remains a snapshot and must never be applied to an existing shared or production database.
- Preserve unrelated worktree changes.

---

## File Structure

- `database/patches/20260804_004_randomize_listed_store_item_update_schedule.sql`: immutable historical patch, committed byte-for-byte as already applied.
- `database/patches/20260804_005_daily_store_item_update_scheduling.sql`: nullable due-time and durable schedule-run schema.
- `database/schema.sql`: final schema snapshot matching patch `005`.
- `ludora-admin-service/src/db.ts`: pooled query API plus dedicated-session callback needed for PostgreSQL session locks.
- `ludora-admin-service/src/storeItemUpdateScheduleService.ts`: run persistence, advisory locking, per-store distribution SQL, and retry-safe state transitions.
- `ludora-admin-service/src/storeItemUpdateScheduleService.test.ts`: service state-machine and SQL contract tests with a fake database session.
- `ludora-admin-service/src/storeItemUpdateScheduleManager.ts`: local-time trigger, startup catch-up, periodic ticking, manual delegation, and shutdown.
- `ludora-admin-service/src/storeItemUpdateScheduleManager.test.ts`: fake-clock boundary and lifecycle tests.
- `ludora-admin-service/src/app.ts`: injects the manager into the operations router.
- `ludora-admin-service/src/server.ts`: constructs, starts, and stops the schedule manager with the existing worker feature flag.
- `ludora-admin-service/src/routes/operations.ts`: manual endpoint and schedule/capacity monitor fields.
- `ludora-admin-service/src/app.test.ts`: API, monitor, and unavailable/conflict regression coverage.
- `ludora-discovery/src/ludora/continuous_update_worker.py`: stops generating a 21-to-23-hour success timestamp.
- `ludora-discovery/src/ludora/database.py`: clears scheduling on successful continuous/manual refresh and leaves inserted discoveries unscheduled.
- `ludora-discovery/tests/test_continuous_update_worker.py`: successful-null and unchanged-backoff behavior.
- `ludora-discovery/tests/test_database.py`: persistence SQL and claim-null contracts.
- `ludora-discovery/tests/test_schema.py`: patch ordering and final-schema guardrails.
- `ludora-admin-ui/src/api/client.ts`: typed schedule-run monitor contract and manual action.
- `ludora-admin-ui/src/api/client.test.ts`: endpoint and response contract coverage.
- `ludora-admin-ui/src/pages/StoreItemUpdateMonitorPage.tsx`: redistribution confirmation, run status, counts, and capacity warning.
- `ludora-admin-ui/src/pages/StoreItemUpdateMonitorPage.test.tsx`: manual-run interaction and schedule-status rendering.

---

### Task 1: Add the sequential schema patch and snapshot

**Files:**
- Preserve and add: `database/patches/20260804_004_randomize_listed_store_item_update_schedule.sql`
- Create: `database/patches/20260804_005_daily_store_item_update_scheduling.sql`
- Modify: `database/schema.sql:132-180`
- Modify: `ludora-discovery/tests/test_schema.py:1-100`

**Interfaces:**
- Produces: nullable `store_items.next_update_at` without a default.
- Produces: `store_item_update_schedule_runs` with `AUTOMATIC|MANUAL` triggers and `RUNNING|COMPLETED|FAILED` statuses.
- Produces: unique automatic-run identity by `automatic_schedule_date`.

- [ ] **Step 1: Write failing schema contract tests**

Add tests that read patch `005` and the snapshot and assert these normalized fragments:

```python
def test_daily_update_schedule_patch_is_sequential_and_nullable(self):
    patch = (patches_path() / "20260804_005_daily_store_item_update_scheduling.sql").read_text(
        encoding="utf-8"
    ).casefold()
    self.assertIn("alter column next_update_at drop not null", patch)
    self.assertIn("alter column next_update_at drop default", patch)
    self.assertIn("create table if not exists store_item_update_schedule_runs", patch)
    self.assertIn("where trigger = 'automatic'", patch)

def test_store_item_schedule_snapshot_matches_patch(self):
    schema = schema_path().read_text(encoding="utf-8").casefold()
    self.assertIn("next_update_at timestamptz", schema)
    self.assertNotIn("next_update_at timestamptz not null default now()", schema)
    self.assertIn("create table if not exists store_item_update_schedule_runs", schema)
```

Also assert that patch filenames sort with `004` before `005`, without changing the bytes of `004`.

- [ ] **Step 2: Run the schema tests and verify the new contract fails**

Run:

```powershell
Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-discovery
python -m unittest tests.test_schema -v
```

Expected: failure because patch `005` and the schedule-run snapshot do not exist.

- [ ] **Step 3: Create patch `005` and update the snapshot**

Create the patch with this exact schema shape, inside `begin`/`commit`:

```sql
alter table if exists store_items alter column next_update_at drop not null;
alter table if exists store_items alter column next_update_at drop default;

create table if not exists store_item_update_schedule_runs (
    id bigserial primary key,
    trigger text not null check (trigger in ('AUTOMATIC', 'MANUAL')),
    automatic_schedule_date date,
    status text not null check (status in ('RUNNING', 'COMPLETED', 'FAILED')),
    window_start timestamptz not null,
    window_end timestamptz not null,
    scheduled_item_count integer not null default 0 check (scheduled_item_count >= 0),
    scheduled_store_count integer not null default 0 check (scheduled_store_count >= 0),
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    error_detail text not null default '',
    check (window_end > window_start),
    check (
      (trigger = 'AUTOMATIC' and automatic_schedule_date is not null)
      or (trigger = 'MANUAL' and automatic_schedule_date is null)
    )
);

create unique index if not exists store_item_update_schedule_runs_automatic_date_uidx
on store_item_update_schedule_runs (automatic_schedule_date)
where trigger = 'AUTOMATIC';

create index if not exists store_item_update_schedule_runs_started_at_idx
on store_item_update_schedule_runs (started_at desc, id desc);
```

Mirror the resulting column and table definitions in `database/schema.sql`; remove its compatibility statements that restore the old default and `NOT NULL` constraint.

- [ ] **Step 4: Run schema tests and verify they pass**

Run:

```powershell
Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-discovery
python -m unittest tests.test_schema -v
```

Expected: all schema guardrail tests pass without connecting to PostgreSQL.

- [ ] **Step 5: Commit the immutable `004` history and new schema contract**

```powershell
Set-Location C:\PROJECTS\ludora\ludora-admin
git diff --no-index -- NUL database\patches\20260804_004_randomize_listed_store_item_update_schedule.sql
git add database\patches\20260804_004_randomize_listed_store_item_update_schedule.sql database\patches\20260804_005_daily_store_item_update_scheduling.sql database\schema.sql ludora-discovery\tests\test_schema.py
git commit -m "Add daily store item schedule schema"
```

The first command is inspection only. Do not execute either SQL patch.

---

### Task 2: Build the transactional schedule service

**Files:**
- Modify: `ludora-admin-service/src/db.ts:1-30`
- Create: `ludora-admin-service/src/storeItemUpdateScheduleService.ts`
- Create: `ludora-admin-service/src/storeItemUpdateScheduleService.test.ts`

**Interfaces:**
- Produces: `SessionDatabase.withSession<T>(operation: (session: Database) => Promise<T>): Promise<T>`.
- Produces: `StoreItemUpdateScheduleTrigger = 'AUTOMATIC' | 'MANUAL'`.
- Produces: `StoreItemUpdateScheduleRun` using snake-case properties matching the API and table.
- Produces: `StoreItemUpdateScheduleConflictError`.
- Produces: `StoreItemUpdateScheduleService.runAutomatic(now: Date, localDate: string)` and `.runManual(now: Date)`.

- [ ] **Step 1: Write failing service state-machine tests**

Use a fake `SessionDatabase` that records SQL and returns queued rows. Cover:

```typescript
it('spreads shuffled items evenly per store inside one 20-hour window', async () => {
  const result = await service.runManual(new Date('2026-08-05T15:00:00.000Z'));
  expect(result.window_start).toBe('2026-08-05T15:00:00.000Z');
  expect(result.window_end).toBe('2026-08-06T11:00:00.000Z');
  expect(normalizeSql(distributionSql)).toContain('row_number() over (partition by store_items.store_id order by random())');
  expect(normalizeSql(distributionSql)).toContain('count(*) over (partition by store_items.store_id)');
  expect(normalizeSql(distributionSql)).toContain('(eligible.random_rank + store_phases.phase)');
});

it('returns the completed automatic run without redistributing twice', async () => {
  const run = await service.runAutomatic(
    new Date('2026-08-05T09:01:00.000Z'),
    '2026-08-05'
  );
  expect(run.status).toBe('COMPLETED');
  expect(distributionQueries).toHaveLength(0);
});

it('throws a conflict when the schedule advisory lock is busy', async () => {
  await expect(service.runManual(now)).rejects.toBeInstanceOf(StoreItemUpdateScheduleConflictError);
});

it('rolls back schedule changes and records a bounded failure', async () => {
  await expect(service.runManual(now)).rejects.toThrow('distribution failed');
  expect(commands).toContain('rollback');
  expect(failureParams.error_detail).toHaveLength(2000);
});
```

Also test that an existing automatic `FAILED` or stale `RUNNING` row is reset and reused, and that the session advisory lock is released in `finally`.

- [ ] **Step 2: Run the new service test and verify it fails**

Run:

```powershell
Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npx vitest run src/storeItemUpdateScheduleService.test.ts
```

Expected: failure because the session database and schedule service are absent.

- [ ] **Step 3: Add dedicated database sessions**

Extend `db.ts` without making existing test databases implement the new method:

```typescript
export type SessionDatabase = Database & {
  withSession<T>(operation: (session: Database) => Promise<T>): Promise<T>;
};

export function createDatabase(databaseUrl: string): SessionDatabase {
  const pool = new pg.Pool(databaseConfig(databaseUrl));
  const toQueryResult = (result: pg.QueryResult): QueryResult => ({ rows: result.rows });
  return {
    query: async (text, params) => toQueryResult(await pool.query(text, params)),
    async withSession<T>(operation: (session: Database) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        return await operation({
          query: async (text, params) => toQueryResult(await client.query(text, params))
        });
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
}
```

Keep `Database` as the query-only interface used by existing app tests.

- [ ] **Step 4: Implement lock and run lifecycle**

In `storeItemUpdateScheduleService.ts`, define these public signatures:

```typescript
export type StoreItemUpdateScheduleService = {
  runAutomatic(now: Date, localDate: string): Promise<StoreItemUpdateScheduleRun>;
  runManual(now: Date): Promise<StoreItemUpdateScheduleRun>;
};

export function createStoreItemUpdateScheduleService(
  database: SessionDatabase,
  options: { advisoryLockKey?: number; windowHours?: number } = {}
): StoreItemUpdateScheduleService;
```

On one session:

1. Call `select pg_try_advisory_lock($1) as acquired`.
2. Throw `StoreItemUpdateScheduleConflictError` when false.
3. Return an existing completed automatic row for the supplied local date.
4. Insert a manual run or insert/reset the automatic row to `RUNNING` in autocommit mode.
5. Run `begin`, the distribution update, the completed-run update, then `commit`.
6. On error, issue `rollback`, update the durable run to `FAILED` with `String(error).slice(0, 2000)`, and rethrow.
7. Always call `select pg_advisory_unlock($1)`.

Normalize every returned timestamp with `new Date(String(value)).toISOString()` and every count with `Number(value)` before exposing a `StoreItemUpdateScheduleRun`, so the service, API, and UI all use the exact string/number types declared here.

- [ ] **Step 5: Implement the exact distribution DML**

Use one update query parameterized with `[windowStart, windowEnd]`:

```sql
with eligible as materialized (
  select
    store_items.id,
    store_items.store_id,
    row_number() over (
      partition by store_items.store_id order by random()
    ) - 1 as random_rank,
    count(*) over (partition by store_items.store_id) as store_item_count
  from store_items
  join stores on stores.id = store_items.store_id
  where stores.active = true
    and store_items.store_active = true
    and store_items.is_boardgame = true
    and store_items.is_boardgame_confirmed = true
    and store_items.item_id is not null
    and store_items.source_url <> ''
    and store_items.listing_status = 'LISTED'
    and (
      store_items.update_lease_token is null
      or store_items.update_lease_expires_at <= now()
    )
), store_phases as materialized (
  select store_id, random() as phase
  from eligible
  group by store_id
), scheduled as (
  update store_items
  set next_update_at = $1::timestamptz
    + (($2::timestamptz - $1::timestamptz)
      * ((eligible.random_rank + store_phases.phase) / eligible.store_item_count))
  from eligible
  join store_phases on store_phases.store_id = eligible.store_id
  where store_items.id = eligible.id
  returning store_items.id, store_items.store_id
)
select count(*)::int as scheduled_item_count,
       count(distinct store_id)::int as scheduled_store_count
from scheduled
```

Do not include platform cooldown rows in eligibility and do not reset failures, leases, or history.

- [ ] **Step 6: Run service tests and build**

```powershell
Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npx vitest run src/storeItemUpdateScheduleService.test.ts
npm run build
```

Expected: schedule-service tests pass and TypeScript compiles.

- [ ] **Step 7: Commit the service boundary**

```powershell
git add src\db.ts src\storeItemUpdateScheduleService.ts src\storeItemUpdateScheduleService.test.ts
git commit -m "Add store item update schedule service"
```

---

### Task 3: Add the 3:00 AM schedule manager

**Files:**
- Create: `ludora-admin-service/src/storeItemUpdateScheduleManager.ts`
- Create: `ludora-admin-service/src/storeItemUpdateScheduleManager.test.ts`

**Interfaces:**
- Consumes: `StoreItemUpdateScheduleService.runAutomatic(now, localDate)` and `.runManual(now)` from Task 2.
- Produces: `StoreItemUpdateScheduleManager.start()`, `.runManual()`, and `.shutdown()`.
- Produces: exported `mexicoCityScheduleDate(now: Date): string | null` for deterministic boundary testing.

- [ ] **Step 1: Write failing local-time and lifecycle tests**

Use fake timers and explicit UTC instants, noting that 3:00 AM Mexico City is 09:00 UTC in August 2026:

```typescript
it.each([
  ['2026-08-05T08:59:59.000Z', null],
  ['2026-08-05T09:00:00.000Z', '2026-08-05'],
  ['2026-08-05T15:30:00.000Z', '2026-08-05']
])('maps %s to the due automatic date', (instant, expected) => {
  expect(mexicoCityScheduleDate(new Date(instant))).toBe(expected);
});

it('catches up once when the service starts after 3am', async () => {
  manager.start();
  await vi.runAllTicks();
  expect(scheduleService.runAutomatic).toHaveBeenCalledWith(now, '2026-08-05');
});

it('does not overlap periodic automatic ticks', async () => {
  manager.start();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(maximumConcurrentAutomaticCalls).toBe(1);
});
```

Also verify pre-3:00 startup, logged automatic failures followed by a later retry, manual delegation with the actual clock time, and interval cleanup on shutdown.
After a successful or already-completed automatic response, cache that local date in the manager so later ticks on the same date do not repeat the database call; the service's unique automatic date remains the cross-process guard.

- [ ] **Step 2: Run the manager tests and verify they fail**

```powershell
Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npx vitest run src/storeItemUpdateScheduleManager.test.ts
```

Expected: failure because the manager module is absent.

- [ ] **Step 3: Implement the time-zone helper and manager**

Use `Intl.DateTimeFormat(...).formatToParts()` with:

```typescript
const SCHEDULE_TIME_ZONE = 'America/Mexico_City';
const SCHEDULE_START_HOUR = 3;
const DEFAULT_TICK_MS = 60_000;
```

The manager signature is:

```typescript
export type StoreItemUpdateScheduleManager = {
  runManual(): Promise<StoreItemUpdateScheduleRun>;
  shutdown(): Promise<void>;
  start(): void;
};

export function createStoreItemUpdateScheduleManager(options: {
  now?: () => Date;
  scheduleService: StoreItemUpdateScheduleService;
  tickMs?: number;
}): StoreItemUpdateScheduleManager;
```

`start()` performs an immediate guarded tick and creates one interval. Automatic errors are written with `console.error('[store-item-update-schedule] automatic run failed', error)` and do not terminate the service. `shutdown()` clears the interval and awaits the active tick. `runManual()` directly calls the shared service with `now()`.

- [ ] **Step 4: Run manager tests and build**

```powershell
npx vitest run src/storeItemUpdateScheduleManager.test.ts
npm run build
```

Expected: boundary, catch-up, non-overlap, retry, manual, and shutdown tests pass.

- [ ] **Step 5: Commit the automatic trigger**

```powershell
git add src\storeItemUpdateScheduleManager.ts src\storeItemUpdateScheduleManager.test.ts
git commit -m "Schedule store item updates daily"
```

---

### Task 4: Make successful refreshes leave items unscheduled

**Files:**
- Modify: `ludora-discovery/tests/test_continuous_update_worker.py:45-100`
- Modify: `ludora-discovery/tests/test_database.py:130-225,820-910`
- Modify: `ludora-discovery/src/ludora/continuous_update_worker.py:20-30,230-260`
- Modify: `ludora-discovery/src/ludora/database.py:450-490,694-745,1560-1670`

**Interfaces:**
- Changes: `DiscoveryRepository.complete_claimed_store_item_update(...)` no longer accepts `next_update_at`.
- Preserves: `fail_claimed_store_item_update(..., next_update_at: datetime, ...)` unchanged.
- Produces: successful continuous and manual price/availability refreshes set `next_update_at = null`.

- [ ] **Step 1: Replace the success scheduling test with a failing null contract**

```python
def test_success_clears_due_time_and_completes_lease(self):
    _process_claim(...)
    kwargs = repository.complete_claimed_store_item_update.call_args.kwargs
    self.assertNotIn("next_update_at", kwargs)
    repository.fail_claimed_store_item_update.assert_not_called()
```

In `test_database.py`, assert the completion SQL contains `next_update_at = null`, the price/availability refresh SQL contains the same assignment, and `_insert_item_candidate_sql()` does not name `next_update_at`. Keep all existing 429 and non-429 backoff assertions unchanged.

- [ ] **Step 2: Run the focused discovery tests and verify they fail**

```powershell
Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-discovery
python -m unittest tests.test_continuous_update_worker tests.test_database -v
```

Expected: success-path assertions fail because the worker still supplies a 21-to-23-hour timestamp.

- [ ] **Step 3: Remove success jitter and clear the due time**

Delete `SUCCESS_MIN_HOURS` and `SUCCESS_MAX_HOURS`, stop passing `next_update_at` from `_process_claim`, remove that keyword parameter from `complete_claimed_store_item_update`, and use:

```sql
next_update_at = null,
update_lease_token = null,
update_lease_expires_at = null,
consecutive_update_failures = 0,
last_update_error = ''
```

Change `_update_item_candidate_price_availability_sql()` from `now() + interval '22 hours'` to null. Leave failure jitter and platform cooldown code untouched. Make interrupted recovery explicit with `coalesce(next_update_at, now() + interval '1 minute')` so a recovered claimed item always re-enters the queue.

- [ ] **Step 4: Run focused discovery tests**

```powershell
python -m unittest tests.test_continuous_update_worker tests.test_database -v
```

Expected: all focused tests pass, including existing failure backoff tests.

- [ ] **Step 5: Run the complete discovery suite**

```powershell
python -m unittest discover -s tests -v
```

Expected: all discovery tests pass.

- [ ] **Step 6: Commit worker scheduling semantics**

```powershell
git add src\ludora\continuous_update_worker.py src\ludora\database.py tests\test_continuous_update_worker.py tests\test_database.py
git commit -m "Clear completed store item update schedules"
```

---

### Task 5: Wire the scheduler into the service and monitor API

**Files:**
- Modify: `ludora-admin-service/src/app.ts:1-130`
- Modify: `ludora-admin-service/src/server.ts:1-155`
- Modify: `ludora-admin-service/src/routes/operations.ts:1-160,250-310,507-760`
- Modify: `ludora-admin-service/src/app.test.ts:4240-4420,5260-5280`

**Interfaces:**
- Consumes: `StoreItemUpdateScheduleManager` from Task 3.
- Produces: `POST /admin/operations/store-item-update-schedule/run`.
- Produces monitor fields: `latest_schedule_run`, `latest_automatic_schedule_run`, `scheduled_items`, `scheduled_later_items`, `unscheduled_items`, `schedule_window_hours`, `schedule_window_capacity`, and `schedule_utilization_percent`.

- [ ] **Step 1: Write failing route and monitor tests**

Add an `idleStoreItemUpdateScheduleManager()` helper and tests:

```typescript
it('runs the same store item scheduler from the admin endpoint', async () => {
  const response = await request(app)
    .post('/admin/operations/store-item-update-schedule/run')
    .send({});
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    trigger: 'MANUAL',
    scheduled_item_count: 100,
    scheduled_store_count: 4,
    status: 'COMPLETED'
  });
  expect(scheduleManager.runManual).toHaveBeenCalledOnce();
});

it('returns 409 when a schedule is already running', async () => {
  scheduleManager.runManual.mockRejectedValue(new StoreItemUpdateScheduleConflictError());
  expect((await request(app).post('/admin/operations/store-item-update-schedule/run')).status).toBe(409);
});
```

Extend the monitor database fake and expectations to include a latest manual run, latest completed automatic run, `unscheduled_items`, `scheduled_later_items`, a 20-hour capacity of `14_400` at five seconds, and utilization based on eligible items divided by `14_400`.

- [ ] **Step 2: Run focused app tests and verify they fail**

```powershell
Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npx vitest run src/app.test.ts -t "store item update"
```

Expected: endpoint and new monitor-field assertions fail.

- [ ] **Step 3: Inject the manager and add the authenticated endpoint**

Add optional `storeItemUpdateScheduleManager` to `CreateAppOptions` and `createOperationsRouter`. The endpoint calls `runManual()`. Convert `StoreItemUpdateScheduleConflictError` to:

```typescript
throw httpError(409, 'A store item update schedule run is already in progress');
```

When the manager is unavailable, return `409` with `Store item update scheduling is not configured`.

- [ ] **Step 4: Extend monitor queries and capacity math**

Add `next_update_at is null`, `next_update_at is not null`, and `next_update_at > now()` filtered counts to the existing eligible summary as `unscheduled_items`, `scheduled_items`, and `scheduled_later_items`. Load the two latest run rows with one query:

```sql
select
  (select row_to_json(latest_run) from (
    select * from store_item_update_schedule_runs
    order by started_at desc, id desc limit 1
  ) latest_run) as latest_schedule_run,
  (select row_to_json(latest_automatic) from (
    select * from store_item_update_schedule_runs
    where trigger = 'AUTOMATIC' and status = 'COMPLETED'
    order by automatic_schedule_date desc, id desc limit 1
  ) latest_automatic) as latest_automatic_schedule_run
```

Calculate:

```typescript
const scheduleWindowHours = 20;
const scheduleWindowCapacity = Math.floor((scheduleWindowHours * 3_600) / pollSeconds);
const scheduleUtilizationPercent = scheduleWindowCapacity > 0
  ? (eligibleItems / scheduleWindowCapacity) * 100
  : 0;
```

Keep the existing 24-hour capacity field for operational comparison, but change projected daily demand from `eligibleItems * (24 / 22)` to `eligibleItems`.

- [ ] **Step 5: Construct and lifecycle-manage the scheduler in `server.ts`**

When `config.continuousItemUpdateWorker.enabled` is true, construct the service with the `SessionDatabase` returned by `createDatabase`, construct the manager, pass it into `createApp`, call `.start()` in the listen callback, and await `.shutdown()` during service shutdown. This applies even if the discovery runner uses HTTP mode; scheduling is a database/admin-service responsibility, while the existing Python worker construction remains local-mode-only.

- [ ] **Step 6: Run focused service tests and build**

```powershell
npx vitest run src/app.test.ts -t "store item update"
npx vitest run src/storeItemUpdateScheduleService.test.ts src/storeItemUpdateScheduleManager.test.ts
npm run build
```

Expected: routes, monitor, service, manager, and TypeScript build pass.

- [ ] **Step 7: Commit API and lifecycle wiring**

```powershell
git add src\app.ts src\server.ts src\routes\operations.ts src\app.test.ts
git commit -m "Expose daily store item scheduling"
```

---

### Task 6: Add schedule controls and status to Update Monitor

**Files:**
- Modify: `ludora-admin-ui/src/api/client.ts:45-105,680-725`
- Modify: `ludora-admin-ui/src/api/client.test.ts:500-565`
- Modify: `ludora-admin-ui/src/pages/StoreItemUpdateMonitorPage.tsx:1-220`
- Modify: `ludora-admin-ui/src/pages/StoreItemUpdateMonitorPage.test.tsx:1-210`

**Interfaces:**
- Consumes: Task 5 endpoint and monitor fields.
- Produces: `adminApi.runStoreItemUpdateSchedule(): Promise<StoreItemUpdateScheduleRun>`.
- Produces: confirmation dialog and success/error feedback.

- [ ] **Step 1: Write the failing API client test**

```typescript
it('runs the daily store item schedule operation', async () => {
  await expect(adminApi.runStoreItemUpdateSchedule()).resolves.toMatchObject({
    status: 'COMPLETED',
    trigger: 'MANUAL'
  });
  expect(fetch).toHaveBeenCalledWith(
    'http://127.0.0.1:4001/admin/operations/store-item-update-schedule/run',
    expect.objectContaining({ method: 'POST' })
  );
});
```

- [ ] **Step 2: Write failing monitor interaction tests**

Extend the monitor fixture with schedule run objects and counts, then verify:

```typescript
await userEvent.click(screen.getByRole('button', { name: 'Redistribute update schedule' }));
expect(screen.getByText(/including products already updated today and failures in backoff/i)).toBeInTheDocument();
await userEvent.click(screen.getByRole('button', { name: 'Confirm redistribution' }));
await waitFor(() => expect(adminApi.runStoreItemUpdateSchedule).toHaveBeenCalledOnce());
await waitFor(() => expect(adminApi.getStoreItemUpdateMonitor).toHaveBeenCalledTimes(2));
expect(await screen.findByText(/scheduled 100 items across 4 stores/i)).toBeInTheDocument();
```

Add separate assertions for last trigger/status/window, unscheduled count, disabled button while pending, conflict error retention, and a warning at 90% or greater utilization.

- [ ] **Step 3: Run focused UI tests and verify they fail**

```powershell
Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui
npx vitest run src/api/client.test.ts src/pages/StoreItemUpdateMonitorPage.test.tsx
```

Expected: missing method, types, dialog, and status assertions fail.

- [ ] **Step 4: Add typed client contracts**

Define:

```typescript
export type StoreItemUpdateScheduleRun = {
  automatic_schedule_date: string | null;
  completed_at: string | null;
  error_detail: string;
  id: number;
  scheduled_item_count: number;
  scheduled_store_count: number;
  started_at: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  trigger: 'AUTOMATIC' | 'MANUAL';
  window_end: string;
  window_start: string;
};
```

Add the Task 5 monitor properties and implement:

```typescript
runStoreItemUpdateSchedule: () =>
  sendJson<StoreItemUpdateScheduleRun>(
    '/admin/operations/store-item-update-schedule/run',
    'POST',
    {}
  )
```

- [ ] **Step 5: Implement the monitor interaction**

Add `scheduleDialogOpen`, `scheduleLoading`, and `scheduleSuccess` state. The confirmation dialog must state that every eligible item is redistributed over a new 20-hour window and that completed-today and backoff items are included. On confirmation, call the client, close the dialog after success, show the exact scheduled item/store counts, and await `loadMonitor()`.

Render schedule status near worker health and replace the old “22h mean interval” copy with the 20-hour scheduled-volume/capacity metrics. Show an MUI warning alert when `schedule_utilization_percent >= 90`, with an exceeded-capacity message at `>= 100`.

- [ ] **Step 6: Run focused UI tests and build**

```powershell
npx vitest run src/api/client.test.ts src/pages/StoreItemUpdateMonitorPage.test.tsx
npm run build
```

Expected: client and page tests pass and Vite production build succeeds.

- [ ] **Step 7: Commit the Update Monitor scheduling UI**

```powershell
git add src\api\client.ts src\api\client.test.ts src\pages\StoreItemUpdateMonitorPage.tsx src\pages\StoreItemUpdateMonitorPage.test.tsx
git commit -m "Add update schedule controls to monitor"
```

---

### Task 7: Verify the complete implementation and stop at the SQL approval gate

**Files:**
- Verify: all files changed in Tasks 1-6
- Update only if behavior changed: `docs/superpowers/specs/2026-08-05-daily-store-item-update-scheduling-design.md`

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: a tested implementation commit set and exact SQL approval packet; no database mutation or deployment.

- [ ] **Step 1: Run every repository test suite**

```powershell
Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-discovery
python -m unittest discover -s tests -v

Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npm test

Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui
npm test
```

Expected: all discovery, service, and UI tests pass.

- [ ] **Step 2: Run production builds and repository checks**

```powershell
Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npm run build

Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui
npm run build

Set-Location C:\PROJECTS\ludora\ludora-admin
git diff --check
git status --short
```

Expected: both builds pass, no whitespace errors, and only intentional files are changed.

- [ ] **Step 3: Review the exact database boundary**

Display without executing:

```powershell
Get-Content database\patches\20260804_005_daily_store_item_update_scheduling.sql
rg -n -A 50 -B 10 "with eligible as materialized" ludora-admin-service\src\storeItemUpdateScheduleService.ts
```

Confirm that `004` remains byte-for-byte unchanged and is marked as already applied. Present the complete patch `005` SQL and runtime distribution DML to the user and request explicit execution approval.

- [ ] **Step 4: Stop before database execution or deployment**

Do not run the patch executor, the manual scheduling endpoint, or the production deployment script in this implementation plan. Database application requires the user's next explicit SQL approval; deployment requires a separate deploy instruction after the patch is applied.
