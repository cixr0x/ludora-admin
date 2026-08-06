# Deterministic Store Item Schedule Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every eligible product a stable relative slot in its store's daily 20-hour update schedule while preserving the random per-store phase and all worker-side randomness.

**Architecture:** Change only the window-function ordering in the admin-service schedule distribution SQL. The existing scheduler transaction, eligibility rules, schedule formula, manual/automatic entry points, worker claim selection, throttling, and retry logic remain untouched.

**Tech Stack:** TypeScript 6, PostgreSQL SQL embedded in the admin service, Vitest 4

## Global Constraints

- Rank eligible products within each store by `store_items.id`.
- Keep the existing random per-store phase.
- Keep the 20-hour schedule window and existing eligibility and locking rules.
- Do not change worker claim selection, request jitter, failure jitter, or platform cooldown behavior.
- Do not create or execute a database patch; the change is application-owned runtime SQL.

---

### Task 1: Make product schedule ranking deterministic

**Files:**
- Modify: `ludora-admin-service/src/storeItemUpdateScheduleService.test.ts:50-97`
- Modify: `ludora-admin-service/src/storeItemUpdateScheduleService.ts:84-104`

**Interfaces:**
- Consumes: `createStoreItemUpdateScheduleService(database, options)` and the existing `DISTRIBUTE_STORE_ITEMS_SQL` execution path.
- Produces: The same `StoreItemUpdateScheduleService` interface and schedule-run result, with deterministic product ranking inside each store.

- [ ] **Step 1: Write the failing regression test**

Rename the first scheduler test and replace its product-ranking assertions with:

```typescript
it('spreads deterministically ranked items evenly per store inside one 20-hour window', async () => {
  // Keep the existing setup and result assertions.

  expect(distributionSql).toContain(
    'row_number() over ( partition by store_items.store_id order by store_items.id )'
  );
  expect(distributionSql).not.toContain(
    'partition by store_items.store_id order by random()'
  );
  expect(distributionSql).toContain('select store_id, random() as phase');
  expect(distributionSql).toContain('(ranked.schedule_rank + store_phases.phase)');

  // Keep the remaining eligibility, locking, transaction, and result assertions.
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `ludora-admin-service`:

```powershell
npm test -- src/storeItemUpdateScheduleService.test.ts
```

Expected: FAIL because the current rank uses `order by random()` and exposes `random_rank`.

- [ ] **Step 3: Implement the minimal deterministic ranking change**

Update only the ranked CTE and its schedule formula:

```sql
row_number() over (
  partition by store_items.store_id order by store_items.id
) - 1 as schedule_rank
```

```sql
* ((ranked.schedule_rank + store_phases.phase) / ranked.store_item_count))
```

Keep this CTE unchanged so the store-level phase remains random:

```sql
select store_id, random() as phase
from ranked
group by store_id
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npm test -- src/storeItemUpdateScheduleService.test.ts
```

Expected: all tests in the scheduler test file PASS.

- [ ] **Step 5: Run admin-service regression verification**

Run:

```powershell
npm test
npm run build
```

Expected: the complete admin-service test suite passes and TypeScript compilation exits successfully.

- [ ] **Step 6: Review and commit the implementation**

Run from the repository root:

```powershell
git diff --check
git diff -- ludora-admin-service/src/storeItemUpdateScheduleService.ts ludora-admin-service/src/storeItemUpdateScheduleService.test.ts
git add -- ludora-admin-service/src/storeItemUpdateScheduleService.ts ludora-admin-service/src/storeItemUpdateScheduleService.test.ts docs/superpowers/plans/2026-08-05-deterministic-store-item-schedule-order.md
git commit -m "Make store item schedule order deterministic"
```
