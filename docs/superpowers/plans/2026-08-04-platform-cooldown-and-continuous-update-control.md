# Platform Cooldown and Continuous Update Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply platform-wide HTTP 429 cooldowns to Shopify and WooCommerce and add process-local pause/resume controls for the continuous automatic store-item update worker.

**Architecture:** Persist rate-limit state by worker and normalized platform in a new operational table, exclude blocked platforms in the claim query, and update that state transactionally with item outcomes. Extend the existing Node worker supervisor with an in-memory desired state, expose it through authenticated operations endpoints and monitor data, and render controls in the existing Update Monitor page.

**Tech Stack:** PostgreSQL incremental patches, Python 3 discovery worker and `unittest`, Node.js/TypeScript/Express and Vitest/Supertest, React/TypeScript/MUI and Testing Library.

## Global Constraints

- Cooldown scope is the normalized shop platform, not an individual store.
- Shopify and WooCommerce have independent platform blocks.
- Backoff remains 15 minutes, 60 minutes, 6 hours, and 24 hours, honors longer `Retry-After`, and is capped at 24 hours.
- Pausing stops only the supervised automatic worker and releases its advisory lock after the in-flight item finishes.
- Pause state is process-local; an admin-service or VM restart starts the worker again when configuration enables it.
- Do not execute DDL or DML against a shared or production database until the exact incremental SQL is shown and explicitly approved.
- Do not apply `database/schema.sql`; it remains a snapshot only.

---

### Task 1: Add platform cooldown schema

**Files:**
- Create: `database/patches/20260804_003_store_item_update_platform_cooldown.sql`
- Modify: `database/schema.sql`
- Modify: `ludora-discovery/tests/test_schema.py`

**Interfaces:**
- Produces: `store_item_update_platform_cooldown(worker_name, platform, blocked_until, consecutive_429s, updated_at)` keyed by `(worker_name, platform)`.
- Preserves: legacy `shopify_blocked_until` and `shopify_consecutive_429s` columns for deployment compatibility.

- [ ] **Step 1: Write the failing schema test**

Add assertions that both the patch and snapshot contain the table, composite primary key, worker-state foreign key, platform validation, and Shopify state migration:

```python
def test_schema_contains_platform_update_cooldowns(self):
    schema = self.schema.casefold()
    self.assertIn("create table if not exists store_item_update_platform_cooldown", schema)
    self.assertIn("primary key (worker_name, platform)", schema)
    self.assertIn("references store_item_update_worker_state(worker_name) on delete cascade", schema)
    self.assertIn("check (platform in ('shopify', 'woocommerce'))", schema)
```

- [ ] **Step 2: Run the schema test and verify RED**

Run: `python tests/test_schema.py SchemaTests.test_schema_contains_platform_update_cooldowns -v`

Expected: FAIL because the table is absent.

- [ ] **Step 3: Add the incremental patch and snapshot definition**

Use this focused schema contract:

```sql
create table if not exists store_item_update_platform_cooldown (
    worker_name text not null
        references store_item_update_worker_state(worker_name) on delete cascade,
    platform text not null
        check (platform in ('shopify', 'woocommerce')),
    blocked_until timestamptz,
    consecutive_429s integer not null default 0
        check (consecutive_429s >= 0),
    updated_at timestamptz not null default now(),
    primary key (worker_name, platform)
);
```

The patch also copies existing non-empty Shopify state using an idempotent `insert ... select ... on conflict ... do update` statement. Do not remove legacy columns.

- [ ] **Step 4: Run the focused schema tests and verify GREEN**

Run: `python tests/test_schema.py -v`

Expected: PASS. This reads SQL files only and does not execute the patch.

- [ ] **Step 5: Commit the schema contract**

```powershell
git add -- database/patches/20260804_003_store_item_update_platform_cooldown.sql database/schema.sql ludora-discovery/tests/test_schema.py
git commit -m "Add platform update cooldown schema"
```

### Task 2: Make cooldown scheduling platform-aware

**Files:**
- Modify: `ludora-discovery/src/ludora/database.py`
- Modify: `ludora-discovery/src/ludora/continuous_update_worker.py`
- Modify: `ludora-discovery/tests/test_database.py`
- Modify: `ludora-discovery/tests/test_continuous_update_worker.py`

**Interfaces:**
- `ClaimedStoreItemUpdate.platform_consecutive_429s: int` replaces the Shopify-specific claim field.
- `DiscoveryRepository.fail_claimed_store_item_update(..., platform_blocked_until: datetime | None, platform: str)` persists a qualifying platform block in the same transaction as the failed item.
- `DiscoveryRepository.complete_claimed_store_item_update(..., platform: str)` resets the qualifying platform after a successful item update.
- `_platform_retry_at(consecutive_429s: int, retry_after_seconds: float | None) -> datetime` calculates the shared backoff.

- [ ] **Step 1: Write failing worker tests for WooCommerce and shared backoff**

Create a WooCommerce claim and assert the first 429 passes a 15-minute `platform_blocked_until`; add cases for a 90-minute `Retry-After`, the 24-hour cap, and non-429 behavior:

```python
woocommerce_claim = replace(
    self.claim,
    platform="woocommerce",
    platform_consecutive_429s=0,
)
# _process_claim(...)
self.assertEqual(
    repository.fail_claimed_store_item_update.call_args.kwargs["platform_blocked_until"],
    self.now + timedelta(minutes=15),
)
```

- [ ] **Step 2: Run the focused worker test and verify RED**

Run: `python tests/test_continuous_update_worker.py -v`

Expected: FAIL because the claim and failure interfaces are Shopify-specific.

- [ ] **Step 3: Implement the minimal shared worker calculation**

Rename the constants and helper to platform-neutral names, define `RATE_LIMITED_PLATFORMS = {"shopify", "woocommerce"}`, and calculate a platform block only for a 429 on those platforms. Keep normal item backoff for all other failures.

- [ ] **Step 4: Run worker tests and verify GREEN**

Run: `python tests/test_continuous_update_worker.py -v`

Expected: PASS.

- [ ] **Step 5: Write failing repository tests**

Add SQL-contract tests asserting:

- the claim query excludes a store when its normalized platform has `blocked_until > now()`;
- the claim returns the platform's consecutive 429 count;
- a qualifying 429 upserts `blocked_until` and increments `consecutive_429s`;
- a successful Shopify or WooCommerce update clears its row to `blocked_until = null, consecutive_429s = 0`;
- other platforms do not mutate platform cooldown state.

- [ ] **Step 6: Run repository tests and verify RED**

Run: `python tests/test_database.py -v`

Expected: FAIL on the missing platform table queries and renamed parameters.

- [ ] **Step 7: Implement repository cooldown reads and writes**

Normalize inferred Shopify exactly once in the claim CTE, exclude active platform blocks with `not exists`, select the matching platform count into the claim, and add the transactional upsert/reset statements to failure/success persistence.

- [ ] **Step 8: Run discovery focused tests and verify GREEN**

Run:

```powershell
python tests/test_database.py -v
python tests/test_continuous_update_worker.py -v
```

Expected: PASS.

- [ ] **Step 9: Commit platform scheduling**

```powershell
git add -- ludora-discovery/src/ludora/database.py ludora-discovery/src/ludora/continuous_update_worker.py ludora-discovery/tests/test_database.py ludora-discovery/tests/test_continuous_update_worker.py
git commit -m "Apply platform cooldowns to continuous updates"
```

### Task 3: Add worker manager pause and resume lifecycle

**Files:**
- Modify: `ludora-admin-service/src/continuousItemUpdateWorkerManager.ts`
- Modify: `ludora-admin-service/src/continuousItemUpdateWorkerManager.test.ts`

**Interfaces:**
- `ContinuousItemUpdateWorkerControlStatus = 'running' | 'stopping' | 'paused'`.
- `ContinuousItemUpdateWorkerManager.getStatus(): ContinuousItemUpdateWorkerControlStatus`.
- `ContinuousItemUpdateWorkerManager.pause(): ContinuousItemUpdateWorkerControlStatus`.
- `ContinuousItemUpdateWorkerManager.resume(): ContinuousItemUpdateWorkerControlStatus`.
- Existing `start()` and `shutdown()` remain available.

- [ ] **Step 1: Write failing manager lifecycle tests**

Cover:

```typescript
manager.start();
expect(manager.getStatus()).toBe('running');
expect(manager.pause()).toBe('stopping');
expect(child.killSignals).toEqual(['SIGTERM']);
child.emit('close', 0, 'SIGTERM');
expect(manager.getStatus()).toBe('paused');
expect(manager.resume()).toBe('running');
expect(spawned).toHaveLength(2);
```

Also assert Pause and Resume are idempotent and Resume during stopping relaunches only after close.

- [ ] **Step 2: Run the manager test and verify RED**

Run: `npm test -- src/continuousItemUpdateWorkerManager.test.ts --maxWorkers=1`

Expected: FAIL because the control methods do not exist.

- [ ] **Step 3: Implement process-local desired state**

Track `isPaused`, `isShuttingDown`, the active child, and restart timer separately. Pause cancels pending restart and signals the child without starting a force-kill timer. The close handler relaunches only when neither paused nor shutting down, including the Resume-during-stop case.

- [ ] **Step 4: Run the manager test and verify GREEN**

Run: `npm test -- src/continuousItemUpdateWorkerManager.test.ts --maxWorkers=1`

Expected: PASS.

- [ ] **Step 5: Commit the lifecycle control**

```powershell
git add -- ludora-admin-service/src/continuousItemUpdateWorkerManager.ts ludora-admin-service/src/continuousItemUpdateWorkerManager.test.ts
git commit -m "Add continuous update pause and resume"
```

### Task 4: Expose authenticated controls and cooldown state

**Files:**
- Modify: `ludora-admin-service/src/app.ts`
- Modify: `ludora-admin-service/src/server.ts`
- Modify: `ludora-admin-service/src/routes/operations.ts`
- Modify: `ludora-admin-service/src/app.test.ts`

**Interfaces:**
- `CreateAppOptions.continuousItemUpdateWorkerManager?: ContinuousItemUpdateWorkerManager`.
- `POST /admin/operations/store-item-update-worker/pause` returns `{ data: { status } }`.
- `POST /admin/operations/store-item-update-worker/resume` returns `{ data: { status } }`.
- Monitor response adds `control_status` and `platform_cooldowns`.

- [ ] **Step 1: Write failing endpoint and monitor tests**

Inject a fake manager into `createApp`, assert both POST routes call the right method, and assert an absent manager returns HTTP 409. Extend the monitor database fixture with Shopify and WooCommerce cooldown rows and assert both are returned.

- [ ] **Step 2: Run focused service tests and verify RED**

Run: `npm test -- src/app.test.ts --maxWorkers=1`

Expected: FAIL because the manager dependency and routes are absent.

- [ ] **Step 3: Implement dependency injection, routes, and monitor query**

Pass the manager from `server.ts` through `createApp` to `createOperationsRouter`. Keep routes protected by the existing admin-auth middleware. Query platform cooldown rows independently and include the manager status in the monitor payload.

- [ ] **Step 4: Run focused service tests and verify GREEN**

Run: `npm test -- src/app.test.ts --maxWorkers=1`

Expected: PASS.

- [ ] **Step 5: Commit the operations API**

```powershell
git add -- ludora-admin-service/src/app.ts ludora-admin-service/src/server.ts ludora-admin-service/src/routes/operations.ts ludora-admin-service/src/app.test.ts
git commit -m "Expose automatic update worker controls"
```

### Task 5: Add Update Monitor controls

**Files:**
- Modify: `ludora-admin-ui/src/api/client.ts`
- Modify: `ludora-admin-ui/src/api/client.test.ts`
- Modify: `ludora-admin-ui/src/pages/StoreItemUpdateMonitorPage.tsx`
- Modify: `ludora-admin-ui/src/pages/StoreItemUpdateMonitorPage.test.tsx`

**Interfaces:**
- `StoreItemUpdateMonitor.control_status` is `running | stopping | paused | unavailable`.
- `StoreItemUpdateMonitor.platform_cooldowns` contains normalized platform, block expiry, count, and active flag.
- `adminApi.pauseContinuousStoreItemUpdates()` and `resumeContinuousStoreItemUpdates()` return the control status record.

- [ ] **Step 1: Write failing API client tests**

Assert POST requests to the exact pause and resume paths and response decoding.

- [ ] **Step 2: Run client tests and verify RED**

Run: `npm test -- src/api/client.test.ts --maxWorkers=1`

Expected: FAIL because the methods are absent.

- [ ] **Step 3: Add client types and methods**

Use the existing `sendJson` helper with an empty object payload for both operations endpoints.

- [ ] **Step 4: Run client tests and verify GREEN**

Run: `npm test -- src/api/client.test.ts --maxWorkers=1`

Expected: PASS.

- [ ] **Step 5: Write failing Update Monitor interaction tests**

Verify:

- Running status renders **Pause automatic updates**.
- Clicking Pause calls the client and refreshes monitor data.
- Stopping status renders a disabled **Stopping automatic updates** button.
- Paused status renders **Resume automatic updates** and invokes Resume.
- Active Shopify and WooCommerce cooldown chips include their expiry time.
- API errors remain visible without replacing the last monitor snapshot.

- [ ] **Step 6: Run page tests and verify RED**

Run: `npm test -- src/pages/StoreItemUpdateMonitorPage.test.tsx --maxWorkers=1`

Expected: FAIL because controls and generic cooldown chips are absent.

- [ ] **Step 7: Implement monitor controls and feedback**

Add a control-request loading flag, render the appropriate button beside Refresh, call the corresponding API method, then reload the monitor. Replace the Shopify-only chip with one chip per active `platform_cooldowns` row.

- [ ] **Step 8: Run UI focused tests and verify GREEN**

Run:

```powershell
npm test -- src/api/client.test.ts src/pages/StoreItemUpdateMonitorPage.test.tsx --maxWorkers=1
```

Expected: PASS.

- [ ] **Step 9: Commit the admin UI**

```powershell
git add -- ludora-admin-ui/src/api/client.ts ludora-admin-ui/src/api/client.test.ts ludora-admin-ui/src/pages/StoreItemUpdateMonitorPage.tsx ludora-admin-ui/src/pages/StoreItemUpdateMonitorPage.test.tsx
git commit -m "Add automatic update controls to monitor"
```

### Task 6: Document, verify, and prepare deployment

**Files:**
- Modify: `docs/production-deployment.md`
- Modify: `docs/superpowers/plans/2026-08-04-platform-cooldown-and-continuous-update-control.md`

**Interfaces:**
- Documents platform-wide cooldowns and process-local pause behavior.
- Produces a clean, pushed exact commit ready for the database approval and admin VM deploy workflow.

- [ ] **Step 1: Update the production runbook**

Replace Shopify-only cooldown wording with platform-wide Shopify/WooCommerce behavior and document that pause releases the coordinator lock after the current item finishes and resets to running on service restart.

- [ ] **Step 2: Run focused and full verification**

Run:

```powershell
Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-discovery
python -m unittest discover -s tests -v

Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npm test -- --maxWorkers=1
npm run build

Set-Location C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui
npm test -- --maxWorkers=1
npm run build

Set-Location C:\PROJECTS\ludora\ludora-admin
git diff --check
git status --short
```

Expected: all suites and builds pass; only intended files are changed.

- [ ] **Step 3: Commit documentation and any plan checkmarks**

```powershell
git add -- docs/production-deployment.md docs/superpowers/plans/2026-08-04-platform-cooldown-and-continuous-update-control.md
git commit -m "Document platform cooldown operations"
```

- [ ] **Step 4: Review and push**

Inspect `git diff HEAD~6..HEAD`, confirm no unrelated changes, then push `main`.

- [ ] **Step 5: Stop at the database approval gate**

Show the exact contents of `database/patches/20260804_003_store_item_update_platform_cooldown.sql` and request explicit approval before executing it. After approval, apply only that patch using the documented database workflow; never apply `database/schema.sql`.

- [ ] **Step 6: Deploy after the patch is applied**

Use `ops/Deploy-LudoraAdmin.ps1 -ExpectedCommit <full SHA> -Component Auto -AssetMarker 'Pause automatic updates' -AllowDatabasePatchPresence` without `-RunTests`, then report exact-SHA, service, authenticated API, HTTPS, and blocked-port verification evidence.
