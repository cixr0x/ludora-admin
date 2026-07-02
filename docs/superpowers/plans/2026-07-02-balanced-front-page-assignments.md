# Balanced Front Page Assignments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second front page assignment algorithm that randomly considers eligible base games and assigns each one to its least-covered matching front page category.

**Architecture:** Keep the existing random assignment endpoint and UI action untouched. Add a new admin-service SQL mutation endpoint, expose it through the admin UI API client, and add a separate UI button on the Front Page Categories page.

**Tech Stack:** Express 5, TypeScript, PostgreSQL SQL executed through the existing `Database` abstraction, React 19, MUI 7, Vitest, Testing Library.

---

## File Structure

- Modify `ludora-admin-service/src/app.test.ts`: add route-level coverage for the new balanced endpoint SQL.
- Modify `ludora-admin-service/src/routes/discovery.ts`: add the balanced assignment SQL constant and the new POST route.
- Modify `ludora-admin-ui/src/api/client.test.ts`: add API client coverage for the new endpoint.
- Modify `ludora-admin-ui/src/api/client.ts`: add `assignBalancedFrontPageCategoryItems`.
- Modify `ludora-admin-ui/src/pages/FrontPageCategoriesPage.test.tsx`: add UI coverage for the new button and success message.
- Modify `ludora-admin-ui/src/pages/FrontPageCategoriesPage.tsx`: add the button, handler, and distinct messages.

Do not run direct SQL commands. The tests in this plan inspect SQL strings and use mocked `Database.query` calls only.

### Task 1: Admin Service Balanced Endpoint

**Files:**
- Modify: `ludora-admin-service/src/app.test.ts`
- Modify: `ludora-admin-service/src/routes/discovery.ts`

- [ ] **Step 1: Write the failing route test**

Add this test immediately after the existing `randomly assigns active items through thirty-two category cycles without reusing games` test in `ludora-admin-service/src/app.test.ts`.

```typescript
  it('assigns randomly ordered active items to the least-covered matching front page category', async () => {
    const rows = [{ assigned_count: 3, skipped_count: 1, replaced_count: 4, removed_count: 1 }];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows };
      }
    };

    const response = await request(createApp({ database })).post(
      '/front-page-categories/balanced-random-item-assignments'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows[0] });
    const sql = normalizeSql(queries[0].sql);
    expect(sql).toContain('from front_page_category_items');
    expect(sql).toContain('eligible_items as');
    expect(sql).toContain('row_number() over (order by random()) as position');
    expect(sql).toContain('from active_item ai');
    expect(sql).toContain('ai.has_approved_listing = true');
    expect(sql).toContain('ai.is_expansion = false');
    expect(sql).toContain('from front_page_categories fpc');
    expect(sql).toContain('from item_categories ic');
    expect(sql).toContain('from item_families ifa');
    expect(sql).toContain('from item_mechanics im');
    expect(sql).toContain('remaining.position >= mc.position');
    expect(sql).toContain('remaining_unassigned_count');
    expect(sql).toContain(
      'row_number() over (partition by mc.item_id order by count(remaining.item_id) asc, random()) as category_rank'
    );
    expect(sql).toContain('where category_rank = 1');
    expect(sql).toContain(
      'row_number() over (partition by front_page_category_id order by position asc)::int as item_order'
    );
    expect(sql).toContain('insert into front_page_category_items (front_page_category_id, item_id, item_order)');
    expect(sql).toContain('on conflict (item_id) do update');
    expect(sql).toContain('delete from front_page_category_items fpci');
    expect(sql).not.toContain('generate_series(1, 32) as cycle_number');
    expect(queries[0].params).toBeUndefined();
  });
```

- [ ] **Step 2: Run the service test to verify it fails**

Run from `ludora-admin/ludora-admin-service`:

```powershell
npm test -- src/app.test.ts
```

Expected: FAIL. The new test should fail because `POST /front-page-categories/balanced-random-item-assignments` does not exist yet, so `response.status` is not `200`.

- [ ] **Step 3: Add the balanced assignment SQL**

In `ludora-admin-service/src/routes/discovery.ts`, add this constant after `randomFrontPageCategoryAssignmentsSql` and before `frontPagePreviewSql`.

```typescript
const balancedRandomFrontPageCategoryAssignmentsSql = `
  with
  existing_count as (
    select count(*)::int as replaced_count
    from front_page_category_items
  ),
  eligible_items as (
    select
      ai.id as item_id,
      row_number() over (order by random()) as position
    from active_item ai
    where ai.has_approved_listing = true
      and ai.is_expansion = false
  ),
  matching_categories as (
    select
      ei.position,
      ei.item_id,
      fpc.id as front_page_category_id,
      fpc.category_type,
      fpc.category_id
    from eligible_items ei
    join front_page_categories fpc on (
      (
        fpc.category_type = 'category'
        and exists (
          select 1
          from item_categories ic
          where ic.item_id = ei.item_id
            and ic.category_id = fpc.category_id
        )
      )
      or (
        fpc.category_type = 'family'
        and exists (
          select 1
          from item_families ifa
          where ifa.item_id = ei.item_id
            and ifa.family_id = fpc.category_id
        )
      )
      or (
        fpc.category_type = 'mechanic'
        and exists (
          select 1
          from item_mechanics im
          where im.item_id = ei.item_id
            and im.mechanic_id = fpc.category_id
        )
      )
    )
  ),
  ranked_matches as (
    select
      mc.position,
      mc.item_id,
      mc.front_page_category_id,
      count(remaining.item_id)::int as remaining_unassigned_count,
      row_number() over (
        partition by mc.item_id
        order by count(remaining.item_id) asc, random()
      ) as category_rank
    from matching_categories mc
    join eligible_items remaining
      on remaining.position >= mc.position
     and (
      (
        mc.category_type = 'category'
        and exists (
          select 1
          from item_categories ic
          where ic.item_id = remaining.item_id
            and ic.category_id = mc.category_id
        )
      )
      or (
        mc.category_type = 'family'
        and exists (
          select 1
          from item_families ifa
          where ifa.item_id = remaining.item_id
            and ifa.family_id = mc.category_id
        )
      )
      or (
        mc.category_type = 'mechanic'
        and exists (
          select 1
          from item_mechanics im
          where im.item_id = remaining.item_id
            and im.mechanic_id = mc.category_id
        )
      )
    )
    group by mc.position, mc.item_id, mc.front_page_category_id
  ),
  selected_assignments as (
    select position, item_id, front_page_category_id
    from ranked_matches
    where category_rank = 1
  ),
  ordered_assignments as (
    select
      front_page_category_id,
      item_id,
      row_number() over (partition by front_page_category_id order by position asc)::int as item_order
    from selected_assignments
  ),
  upserted as (
    insert into front_page_category_items (front_page_category_id, item_id, item_order)
    select front_page_category_id, item_id, item_order
    from ordered_assignments
    on conflict (item_id) do update
    set front_page_category_id = excluded.front_page_category_id,
        item_order = excluded.item_order,
        updated_at = now()
    returning front_page_category_id, item_id, item_order
  ),
  deleted as (
    delete from front_page_category_items fpci
    where not exists (
      select 1
      from ordered_assignments assigned
      where assigned.item_id = fpci.item_id
    )
    returning item_id
  ),
  deleted_count as (
    select count(*)::int as removed_count
    from deleted
  )
  select
    count(upserted.item_id)::int as assigned_count,
    ((select count(*) from eligible_items) - (select count(*) from selected_assignments))::int as skipped_count,
    (select replaced_count from existing_count)::int as replaced_count,
    (select removed_count from deleted_count)::int as removed_count
  from upserted
`;
```

- [ ] **Step 4: Add the route**

In `ludora-admin-service/src/routes/discovery.ts`, add this route immediately after the existing random assignment route.

```typescript
  router.post('/front-page-categories/balanced-random-item-assignments', async (_request, response, next) => {
    try {
      const result = await database.query(balancedRandomFrontPageCategoryAssignmentsSql);

      response.json({
        data: result.rows[0] ?? {
          assigned_count: 0,
          removed_count: 0,
          replaced_count: 0,
          skipped_count: 0
        }
      });
    } catch (error) {
      next(error);
    }
  });
```

- [ ] **Step 5: Run the service test to verify it passes**

Run from `ludora-admin/ludora-admin-service`:

```powershell
npm test -- src/app.test.ts
```

Expected: PASS. The new balanced route test and the existing random route test both pass.

- [ ] **Step 6: Commit the backend endpoint**

Run from `ludora-admin`:

```powershell
git add ludora-admin-service/src/app.test.ts ludora-admin-service/src/routes/discovery.ts
git commit -m "feat: add balanced front page assignment endpoint"
```

### Task 2: Admin UI API Client

**Files:**
- Modify: `ludora-admin-ui/src/api/client.test.ts`
- Modify: `ludora-admin-ui/src/api/client.ts`

- [ ] **Step 1: Write the failing API client test**

Add this test immediately after `starts random front page category item assignment with a POST request` in `ludora-admin-ui/src/api/client.test.ts`.

```typescript
  it('starts balanced front page category item assignment with a POST request', async () => {
    const result = { assigned_count: 3, skipped_count: 1, replaced_count: 4, removed_count: 1 };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: result }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.assignBalancedFrontPageCategoryItems()).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4001/front-page-categories/balanced-random-item-assignments',
      {
        method: 'POST'
      }
    );
  });
```

- [ ] **Step 2: Run the UI API client test to verify it fails**

Run from `ludora-admin/ludora-admin-ui`:

```powershell
npm test -- src/api/client.test.ts
```

Expected: FAIL with a message showing `adminApi.assignBalancedFrontPageCategoryItems` is not a function.

- [ ] **Step 3: Add the API client method**

In `ludora-admin-ui/src/api/client.ts`, add this method immediately after `assignRandomFrontPageCategoryItems`.

```typescript
  assignBalancedFrontPageCategoryItems: () =>
    fetchData<FrontPageCategoryRandomAssignmentResult>('/front-page-categories/balanced-random-item-assignments', {
      method: 'POST'
    }),
```

The surrounding block should become:

```typescript
  assignRandomFrontPageCategoryItems: () =>
    fetchData<FrontPageCategoryRandomAssignmentResult>('/front-page-categories/random-item-assignments', {
      method: 'POST'
    }),
  assignBalancedFrontPageCategoryItems: () =>
    fetchData<FrontPageCategoryRandomAssignmentResult>('/front-page-categories/balanced-random-item-assignments', {
      method: 'POST'
    }),
  getFrontPagePreview: () => fetchRows<FrontPagePreviewCategory>('/front-page-preview'),
```

- [ ] **Step 4: Run the UI API client test to verify it passes**

Run from `ludora-admin/ludora-admin-ui`:

```powershell
npm test -- src/api/client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the API client**

Run from `ludora-admin`:

```powershell
git add ludora-admin-ui/src/api/client.test.ts ludora-admin-ui/src/api/client.ts
git commit -m "feat: add balanced assignment admin client"
```

### Task 3: Front Page Categories UI Button

**Files:**
- Modify: `ludora-admin-ui/src/pages/FrontPageCategoriesPage.test.tsx`
- Modify: `ludora-admin-ui/src/pages/FrontPageCategoriesPage.tsx`

- [ ] **Step 1: Write the failing page test**

Add this test immediately after `starts random item assignment from the table screen` in `ludora-admin-ui/src/pages/FrontPageCategoriesPage.test.tsx`.

```typescript
  it('starts balanced item assignment from the table screen', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/front-page-categories' && !init) {
        return jsonResponse([
          {
            category_id: 5,
            category_name: 'Party Game',
            category_type: 'category',
            id: 1,
            order: 10,
            title: 'Need a laugh?'
          }
        ]);
      }
      if (pathOf(url) === '/front-page-categories/balanced-random-item-assignments' && init?.method === 'POST') {
        return jsonResponse({ assigned_count: 3, skipped_count: 1, replaced_count: 4, removed_count: 1 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<FrontPageCategoriesPage />);

    await user.click(await screen.findByRole('button', { name: 'Assign Balanced Games' }));

    expect(await screen.findByText('Balanced assignments complete: 3 assigned, 1 skipped.')).toBeInTheDocument();
    const assignmentCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        pathOf(String(url)) === '/front-page-categories/balanced-random-item-assignments' && init?.method === 'POST'
    );
    expect(assignmentCall?.[1]).toEqual({ method: 'POST' });
  });
```

- [ ] **Step 2: Run the page test to verify it fails**

Run from `ludora-admin/ludora-admin-ui`:

```powershell
npm test -- src/pages/FrontPageCategoriesPage.test.tsx
```

Expected: FAIL because the `Assign Balanced Games` button is not rendered.

- [ ] **Step 3: Add the icon import**

In `ludora-admin-ui/src/pages/FrontPageCategoriesPage.tsx`, add the `BalanceIcon` import near the other MUI icon imports.

```typescript
import BalanceIcon from '@mui/icons-material/Balance';
```

The import block should start like this:

```typescript
import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import BalanceIcon from '@mui/icons-material/Balance';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';
import ShuffleIcon from '@mui/icons-material/Shuffle';
```

- [ ] **Step 4: Add the balanced assignment handler**

In `ludora-admin-ui/src/pages/FrontPageCategoriesPage.tsx`, add this function immediately after `handleAssignRandomItems`.

```typescript
  async function handleAssignBalancedItems() {
    setIsAssigning(true);
    setAssignmentError('');
    setSaveMessage('');

    try {
      const result = await adminApi.assignBalancedFrontPageCategoryItems();
      setSaveMessage(
        `Balanced assignments complete: ${result.assigned_count} assigned, ${result.skipped_count} skipped.`
      );
    } catch {
      setAssignmentError('Balanced assignments could not be completed.');
    } finally {
      setIsAssigning(false);
    }
  }
```

- [ ] **Step 5: Add the UI button**

In the button group inside `FrontPageCategoriesPage`, add this button immediately after `Assign Random Games`.

```tsx
            <Button
              disabled={isAssigning || rows.length === 0}
              startIcon={isAssigning ? <CircularProgress size={16} /> : <BalanceIcon />}
              variant="outlined"
              onClick={handleAssignBalancedItems}
            >
              Assign Balanced Games
            </Button>
```

The button group should contain `New Category`, `Assign Random Games`, and `Assign Balanced Games`.

- [ ] **Step 6: Run the page test to verify it passes**

Run from `ludora-admin/ludora-admin-ui`:

```powershell
npm test -- src/pages/FrontPageCategoriesPage.test.tsx
```

Expected: PASS. The existing random assignment test and the new balanced assignment test both pass.

- [ ] **Step 7: Commit the UI page**

Run from `ludora-admin`:

```powershell
git add ludora-admin-ui/src/pages/FrontPageCategoriesPage.test.tsx ludora-admin-ui/src/pages/FrontPageCategoriesPage.tsx
git commit -m "feat: add balanced assignment UI action"
```

### Task 4: Final Verification

**Files:**
- Verify: `ludora-admin-service/src/app.test.ts`
- Verify: `ludora-admin-ui/src/api/client.test.ts`
- Verify: `ludora-admin-ui/src/pages/FrontPageCategoriesPage.test.tsx`
- Verify: `ludora-admin-service/src/routes/discovery.ts`
- Verify: `ludora-admin-ui/src/api/client.ts`
- Verify: `ludora-admin-ui/src/pages/FrontPageCategoriesPage.tsx`

- [ ] **Step 1: Run the admin service test suite**

Run from `ludora-admin/ludora-admin-service`:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 2: Build the admin service**

Run from `ludora-admin/ludora-admin-service`:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run the admin UI test suite**

Run from `ludora-admin/ludora-admin-ui`:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 4: Build the admin UI**

Run from `ludora-admin/ludora-admin-ui`:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 5: Inspect the final diff**

Run from `ludora-admin`:

```powershell
git diff --stat HEAD
git diff -- ludora-admin-service/src/app.test.ts ludora-admin-service/src/routes/discovery.ts ludora-admin-ui/src/api/client.test.ts ludora-admin-ui/src/api/client.ts ludora-admin-ui/src/pages/FrontPageCategoriesPage.test.tsx ludora-admin-ui/src/pages/FrontPageCategoriesPage.tsx
```

Expected: The diff only contains the balanced assignment endpoint, API client method, UI button, and tests. Existing unrelated dirty files remain untouched.

- [ ] **Step 6: Report completion**

Summarize:

```text
Implemented balanced front page assignments with a new endpoint and UI action.
Verified with admin service tests/build and admin UI tests/build.
Existing random assignment endpoint and button remain available.
```
