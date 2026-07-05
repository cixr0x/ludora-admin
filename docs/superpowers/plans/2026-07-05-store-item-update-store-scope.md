# Store Item Update Store Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins run Store Item Update for selected stores or all stores, with backend-managed multi-store scope.

**Architecture:** Add a shared item-update scope shape to the admin API and operations clients, then pass selected store IDs through the local Python CLI into the discovery workflow. The repository query remains the single source of truth for which store items are updated, preserving the existing item eligibility filters and adding an optional `store_id` filter.

**Tech Stack:** Express, TypeScript, Vitest, React 19, MUI, Python argparse, unittest, psycopg-compatible query code.

---

### Task 1: Admin UI API Client Scope

**Files:**
- Modify: `ludora-admin-ui/src/api/client.ts`
- Modify: `ludora-admin-ui/src/api/client.test.ts`

- [ ] **Step 1: Write failing client tests**

Add tests near the existing `starts item update runs with a POST request` test:

```ts
it('starts item update runs for selected stores with a JSON body', async () => {
  const run = {
    completed_at: null,
    error: null,
    id: 'run-selected',
    result: { updated_items: 3 },
    started_at: '2026-07-05T20:00:00Z',
    status: 'completed',
    type: 'item_update'
  };
  const { adminApi } = await importClient();
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ data: run }), {
      headers: { 'Content-Type': 'application/json' },
      status: 202
    })
  );

  await expect(adminApi.startItemUpdateRun({ store_ids: [12, 34] })).resolves.toEqual(run);

  expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/item-update-runs', {
    body: JSON.stringify({ store_ids: [12, 34] }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  });
});

it('starts item update runs for all stores with a JSON body', async () => {
  const run = {
    completed_at: null,
    error: null,
    id: 'run-all',
    result: { updated_items: 8 },
    started_at: '2026-07-05T20:00:00Z',
    status: 'completed',
    type: 'item_update'
  };
  const { adminApi } = await importClient();
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ data: run }), {
      headers: { 'Content-Type': 'application/json' },
      status: 202
    })
  );

  await expect(adminApi.startItemUpdateRun({ all_stores: true })).resolves.toEqual(run);

  expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/item-update-runs', {
    body: JSON.stringify({ all_stores: true }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  });
});
```

- [ ] **Step 2: Run client tests to verify RED**

Run:

```powershell
npm test -- src/api/client.test.ts
```

Expected: the new tests fail because `startItemUpdateRun` does not accept or send a JSON body.

- [ ] **Step 3: Implement scoped client request**

Add the input type and update the method:

```ts
export type ItemUpdateRunScope = { all_stores: true } | { store_ids: number[] };

startItemUpdateRun: (scope?: ItemUpdateRunScope) =>
  scope
    ? sendJson<StoreDiscoveryRun>('/admin/operations/item-update-runs', 'POST', scope)
    : fetchData<StoreDiscoveryRun>('/admin/operations/item-update-runs', {
        method: 'POST'
      }),
```

- [ ] **Step 4: Run client tests to verify GREEN**

Run:

```powershell
npm test -- src/api/client.test.ts
```

Expected: all `client.test.ts` tests pass.

### Task 2: Admin Service Operation Scope

**Files:**
- Modify: `ludora-admin-service/src/discoveryOperations.ts`
- Modify: `ludora-admin-service/src/discoveryOperationsClient.ts`
- Modify: `ludora-admin-service/src/discoveryOperationsClient.test.ts`
- Modify: `ludora-admin-service/src/localDiscoveryOperationsClient.ts`
- Modify: `ludora-admin-service/src/localDiscoveryOperationsClient.test.ts`
- Modify: `ludora-admin-service/src/routes/operations.ts`
- Modify: `ludora-admin-service/src/app.test.ts`

- [ ] **Step 1: Write failing admin service tests**

Add these route tests near the existing item update route test:

```ts
it('starts item update runs for selected stores through the discovery operations client', async () => {
  const run: StoreDiscoveryRun = {
    completed_at: null,
    error: null,
    id: 'run-selected',
    result: { updated_items: 3 },
    started_at: '2026-07-05T20:00:00Z',
    status: 'completed',
    type: 'item_update'
  };
  const calls: unknown[] = [];
  const operationsClient: DiscoveryOperationsClient = {
    cancelStoreDiscoveryRun: async () => run,
    getLatestStoreDiscoveryRun: async () => null,
    getStoreDiscoveryRun: async () => run,
    startItemDiscoveryRun: async () => run,
    startItemEmbeddingRun: async () => run,
    startItemUpdateRun: async (scope) => {
      calls.push(scope);
      return run;
    },
    startStoreDiscoveryRun: async () => run
  };

  const response = await request(createApp({ database: idleDatabase(), operationsClient }))
    .post('/admin/operations/item-update-runs')
    .send({ store_ids: [12, 34] });

  expect(response.status).toBe(202);
  expect(response.body).toEqual({ data: run });
  expect(calls).toEqual([{ store_ids: [12, 34] }]);
});

it('rejects invalid item update store scopes', async () => {
  const operationsClient: DiscoveryOperationsClient = {
    cancelStoreDiscoveryRun: async () => {
      throw new Error('should not call operations client');
    },
    getLatestStoreDiscoveryRun: async () => null,
    getStoreDiscoveryRun: async () => null,
    startItemDiscoveryRun: async () => {
      throw new Error('should not call operations client');
    },
    startItemEmbeddingRun: async () => {
      throw new Error('should not call operations client');
    },
    startItemUpdateRun: async () => {
      throw new Error('should not call operations client');
    },
    startStoreDiscoveryRun: async () => {
      throw new Error('should not call operations client');
    }
  };

  const response = await request(createApp({ database: idleDatabase(), operationsClient }))
    .post('/admin/operations/item-update-runs')
    .send({ all_stores: true, store_ids: [12] });

  expect(response.status).toBe(400);
  expect(response.body).toEqual({ error: { message: 'Specify either all_stores or store_ids, not both' } });
});
```

Add discovery client and local client tests:

```ts
it('starts item update runs for selected stores', async () => {
  const run = {
    completed_at: null,
    error: null,
    id: 'run-selected',
    result: null,
    started_at: '2026-07-05T20:00:00Z',
    status: 'running',
    type: 'item_update'
  };
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ data: run }), {
      headers: { 'Content-Type': 'application/json' },
      status: 202
    })
  );

  await expect(createDiscoveryOperationsClient('http://localhost:8001/').startItemUpdateRun({ store_ids: [12, 34] })).resolves.toEqual(run);

  expect(fetchMock).toHaveBeenCalledWith('http://localhost:8001/operations/item-update-runs', {
    body: JSON.stringify({ store_ids: [12, 34] }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  });
});

it('starts item update by spawning the CLI with selected store ids', async () => {
  const { client, spawned } = createClient();

  await client.startItemUpdateRun({ store_ids: [12, 34] });

  expect(spawned[0].args).toEqual([
    '-m',
    'ludora.operation_cli',
    '--env-file',
    'C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/.env',
    'item-update',
    '--store-id',
    '12',
    '--store-id',
    '34'
  ]);
});
```

- [ ] **Step 2: Run admin service tests to verify RED**

Run:

```powershell
npm test -- src/app.test.ts src/discoveryOperationsClient.test.ts src/localDiscoveryOperationsClient.test.ts
```

Expected: tests fail because operation scope types, parsing, forwarding, and CLI args are missing.

- [ ] **Step 3: Implement admin service scope support**

Add to `discoveryOperations.ts`:

```ts
export type ItemUpdateRunScope = { all_stores: true } | { store_ids: number[] };

startItemUpdateRun(scope?: ItemUpdateRunScope): Promise<StoreDiscoveryRun>;
```

Add scope request handling in `discoveryOperationsClient.ts`:

```ts
function itemUpdateRequestInit(scope?: ItemUpdateRunScope): RequestInit {
  if (!scope) {
    return { method: 'POST' };
  }
  return {
    body: JSON.stringify(scope),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  };
}
```

Use it in `startItemUpdateRun`.

Add local CLI args in `localDiscoveryOperationsClient.ts`:

```ts
function itemUpdateCommandArgs(scope?: ItemUpdateRunScope): string[] {
  const args = ['item-update'];
  if (scope && 'store_ids' in scope) {
    for (const storeId of scope.store_ids) {
      args.push('--store-id', String(storeId));
    }
  }
  return args;
}
```

Use `startRun('item_update', itemUpdateCommandArgs(scope))`.

Add route parsing in `routes/operations.ts`:

```ts
function parseItemUpdateRunScope(body: unknown): ItemUpdateRunScope | undefined {
  if (!body || (typeof body === 'object' && Object.keys(body as Record<string, unknown>).length === 0)) {
    return undefined;
  }
  if (!isRecord(body)) {
    throw httpError(400, 'Item update scope must be an object');
  }
  const hasAllStores = body.all_stores === true;
  const hasStoreIds = Object.hasOwn(body, 'store_ids');
  if (hasAllStores && hasStoreIds) {
    throw httpError(400, 'Specify either all_stores or store_ids, not both');
  }
  if (hasAllStores) {
    return { all_stores: true };
  }
  if (!hasStoreIds) {
    return undefined;
  }
  if (!Array.isArray(body.store_ids) || body.store_ids.length === 0) {
    throw httpError(400, 'store_ids must be a non-empty array');
  }
  const storeIds = body.store_ids.map((value) => Number(value));
  if (storeIds.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw httpError(400, 'store_ids must contain positive integers');
  }
  if (new Set(storeIds).size !== storeIds.length) {
    throw httpError(400, 'store_ids must not contain duplicates');
  }
  return { store_ids: storeIds };
}
```

- [ ] **Step 4: Run admin service tests to verify GREEN**

Run:

```powershell
npm test -- src/app.test.ts src/discoveryOperationsClient.test.ts src/localDiscoveryOperationsClient.test.ts
```

Expected: targeted admin service tests pass.

### Task 3: Discovery API, CLI, and Operation Scope

**Files:**
- Modify: `ludora-discovery/src/ludora/api.py`
- Modify: `ludora-discovery/src/ludora/operation_cli.py`
- Modify: `ludora-discovery/src/ludora/operations.py`
- Modify: `ludora-discovery/tests/test_api.py`
- Modify: `ludora-discovery/tests/test_operation_cli.py`
- Modify: `ludora-discovery/tests/test_operations.py`

- [ ] **Step 1: Write failing discovery scope tests**

Add tests:

```py
def test_starts_item_update_run_for_selected_stores(self):
    calls = []

    manager = StoreDiscoveryRunManager(
        runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
        item_update_runner=lambda store_ids=None: (
            calls.append(store_ids)
            or ItemUpdateRunResult(updated_items=8)
        ),
        background=False,
    )

    status, payload = route_request("POST", "/operations/item-update-runs", manager, {"store_ids": [12, 34]})

    self.assertEqual(status, 202)
    self.assertEqual(payload["data"]["type"], "item_update")
    self.assertEqual(payload["data"]["result"]["updated_items"], 8)
    self.assertEqual(calls, [[12, 34]])

def test_item_update_rejects_invalid_store_scope(self):
    manager = StoreDiscoveryRunManager(
        runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
        background=False,
    )

    status, payload = route_request("POST", "/operations/item-update-runs", manager, {"store_ids": []})

    self.assertEqual(status, 400)
    self.assertEqual(payload, {"error": {"message": "store_ids must be a non-empty array"}})
```

```py
def test_runs_item_update_with_selected_store_ids(self):
    stdout = StringIO()
    with patch("sys.stdout", stdout), patch(
        "ludora.operation_cli.run_item_update",
        return_value=ItemUpdateRunResult(updated_items=7),
    ) as runner:
        exit_code = main(["item-update", "--store-id", "12", "--store-id", "34"])

    self.assertEqual(exit_code, 0)
    runner.assert_called_once()
    self.assertEqual(runner.call_args.kwargs["store_ids"], [12, 34])
    self.assertEqual(json.loads(stdout.getvalue())["result"]["updated_items"], 7)
```

```py
def test_run_item_update_passes_selected_store_ids_to_update_workflow(self):
    connection = Mock()
    repository = Mock()
    repository.start_store_item_update_log.return_value = 99
    records = [object()]

    with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
        "ludora.operations.resolve_browser_fetch_enabled", return_value=False
    ), patch("ludora.operations.connect_database", return_value=connection), patch(
        "ludora.operations.DiscoveryRepository", return_value=repository
    ), patch("ludora.operations.update_confirmed_store_items", return_value=records) as update_confirmed_store_items:
        result = run_item_update(env_file="custom.env", store_ids=[12, 34], run_id="run-123")

    update_confirmed_store_items.assert_called_once_with(
        repository,
        browser_fetch_enabled=False,
        job_id=99,
        run_id="run-123",
        store_ids=[12, 34],
    )
    self.assertEqual(result.updated_items, 1)
```

- [ ] **Step 2: Run discovery tests to verify RED**

Run:

```powershell
python -m unittest tests.test_api tests.test_operation_cli tests.test_operations -v
```

Expected: tests fail because selected store scope is not parsed or forwarded.

- [ ] **Step 3: Implement discovery scope support**

In `api.py`, change `RunManager.start_item_update` to accept `store_ids=None`, parse the body, and pass `store_ids`.

```py
def _parse_item_update_store_ids(body: dict[str, object] | None) -> list[int] | None:
    request_body = body or {}
    if request_body.get("all_stores") is True and "store_ids" in request_body:
        raise ValueError("Specify either all_stores or store_ids, not both")
    if request_body.get("all_stores") is True:
        return None
    if "store_ids" not in request_body:
        return None
    raw_store_ids = request_body["store_ids"]
    if not isinstance(raw_store_ids, list) or not raw_store_ids:
        raise ValueError("store_ids must be a non-empty array")
    store_ids = [int(value) for value in raw_store_ids]
    if any(value <= 0 for value in store_ids):
        raise ValueError("store_ids must contain positive integers")
    if len(set(store_ids)) != len(store_ids):
        raise ValueError("store_ids must not contain duplicates")
    return store_ids
```

In `operation_cli.py`, add repeatable args:

```py
item_update = subparsers.add_parser("item-update")
item_update.add_argument("--store-id", action="append", type=int, default=[])
```

Forward:

```py
return run_item_update(
    env_file=args.env_file,
    cancellation_token=cancellation_token,
    store_ids=args.store_id or None,
)
```

In `operations.py`, add `store_ids: list[int] | None = None` to `run_item_update`, `StoreDiscoveryRunManager.start_item_update`, `_execute_item_update_run`, `_update_runner_with_token`, and `_update_runner_arguments`, then pass `store_ids` into `update_confirmed_store_items`.

- [ ] **Step 4: Run discovery tests to verify GREEN**

Run:

```powershell
python -m unittest tests.test_api tests.test_operation_cli tests.test_operations -v
```

Expected: targeted discovery operation tests pass.

### Task 4: Repository-Level Store Filtering

**Files:**
- Modify: `ludora-discovery/src/ludora/inventory.py`
- Modify: `ludora-discovery/src/ludora/product_crawler.py`
- Modify: `ludora-discovery/src/ludora/database.py`
- Modify: `ludora-discovery/tests/test_inventory.py`
- Modify: `ludora-discovery/tests/test_database.py`

- [ ] **Step 1: Write failing repository and inventory tests**

Add test assertions:

```py
def test_update_confirmed_store_item_details_filters_selected_stores(self):
    repository = FakeRepository(confirmed_items=[])

    update_confirmed_store_item_details(repository, store_ids=[12, 34])

    self.assertEqual(repository.confirmed_items_store_ids, [12, 34])
```

Update `FakeRepository.list_confirmed_boardgame_item_candidates`:

```py
def list_confirmed_boardgame_item_candidates(self, limit=None, store_ids=None):
    self.confirmed_items_limit = limit
    self.confirmed_items_store_ids = store_ids
    return self.confirmed_items
```

Add a database test:

```py
def test_lists_confirmed_boardgame_item_candidates_for_selected_stores(self):
    connection = FakeConnection([])
    repository = DiscoveryRepository(connection)

    records = repository.list_confirmed_boardgame_item_candidates(store_ids=[12, 34])

    sql, params = connection.cursor_instance.executions[0]
    normalized_sql = sql.casefold()
    self.assertIn("store_id in (%s, %s)", normalized_sql)
    self.assertIn("listing_status = 'listed'", normalized_sql)
    self.assertEqual(params, (12, 34))
    self.assertEqual(records, [])
```

- [ ] **Step 2: Run repository tests to verify RED**

Run:

```powershell
python -m unittest tests.test_inventory tests.test_database -v
```

Expected: tests fail because `store_ids` is not accepted or used.

- [ ] **Step 3: Implement store filtering**

Update protocol signatures in `inventory.py` and `product_crawler.py`:

```py
def list_confirmed_boardgame_item_candidates(
    self,
    limit: int | None = None,
    store_ids: list[int] | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    ...
```

Add `store_ids` parameters to `update_confirmed_store_items` and `update_confirmed_store_item_details`, then call:

```py
repository.list_confirmed_boardgame_item_candidates(limit=limit, store_ids=store_ids)
```

Update `database.py`:

```py
def list_confirmed_boardgame_item_candidates(
    self,
    limit: int | None = None,
    store_ids: list[int] | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    sql = f"""
        select {_item_candidate_select_columns()}
        from store_items
        where is_boardgame = true
          and is_boardgame_confirmed = true
          and item_id is not null
          and source_url <> ''
          and listing_status = 'LISTED'
    """
    params: list[object] = []
    if store_ids:
        placeholders = ", ".join(["%s"] * len(store_ids))
        sql += f"\n              and store_id in ({placeholders})"
        params.extend(store_ids)
    sql += "\n            order by last_updated asc, id asc"
    if limit is not None:
        sql += "\nlimit %s"
        params.append(limit)
```

- [ ] **Step 4: Run repository tests to verify GREEN**

Run:

```powershell
python -m unittest tests.test_inventory tests.test_database -v
```

Expected: targeted repository tests pass.

### Task 5: Store Item Update UI

**Files:**
- Modify: `ludora-admin-ui/src/pages/OperationsPage.tsx`
- Modify: `ludora-admin-ui/src/pages/OperationsPage.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Add tests:

```tsx
it('starts item update for selected stores from the checkbox list', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
      return jsonResponse({ data: null });
    }
    if (url.endsWith('/stores')) {
      return jsonResponse({
        data: [
          { canonical_domain: 'alpha.mx', id: 12, name: 'Alpha Games', platform: 'shopify', website_url: 'https://alpha.mx/' },
          { canonical_domain: 'beta.mx', id: 34, name: 'Beta Games', platform: 'custom', website_url: 'https://beta.mx/' }
        ]
      });
    }
    if (url.endsWith('/admin/operations/item-update-runs') && init?.method === 'POST') {
      return jsonResponse({
        data: {
          completed_at: '2026-07-05T20:02:00Z',
          error: null,
          id: 'run-selected',
          result: { updated_items: 3 },
          started_at: '2026-07-05T20:00:00Z',
          status: 'completed',
          type: 'item_update'
        }
      }, 202);
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  render(<OperationsPage operation="item_update" />);

  await screen.findByText('Alpha Games');
  await userEvent.click(screen.getByRole('checkbox', { name: /Alpha Games/i }));
  await userEvent.click(screen.getByRole('button', { name: /Run for selected stores/i }));

  expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/item-update-runs', {
    body: JSON.stringify({ store_ids: [12] }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  });
});

it('starts item update for all stores without selecting checkboxes', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
      return jsonResponse({ data: null });
    }
    if (url.endsWith('/stores')) {
      return jsonResponse({ data: [] });
    }
    if (url.endsWith('/admin/operations/item-update-runs') && init?.method === 'POST') {
      return jsonResponse({
        data: {
          completed_at: null,
          error: null,
          id: 'run-all',
          result: null,
          started_at: '2026-07-05T20:00:00Z',
          status: 'running',
          type: 'item_update'
        }
      }, 202);
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  render(<OperationsPage operation="item_update" />);

  await screen.findByText('No recent operation run.');
  await userEvent.click(screen.getByRole('button', { name: /Run for all/i }));

  expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/item-update-runs', {
    body: JSON.stringify({ all_stores: true }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  });
});
```

Add the local helper if not present:

```ts
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}
```

- [ ] **Step 2: Run UI tests to verify RED**

Run:

```powershell
npm test -- src/pages/OperationsPage.test.tsx
```

Expected: tests fail because the item update page does not load stores or render selection controls.

- [ ] **Step 3: Implement UI controls**

Add state:

```ts
const [stores, setStores] = useState<AdminRecord[]>([]);
const [storeLoadState, setStoreLoadState] = useState<LoadState>('loading');
const [selectedStoreIds, setSelectedStoreIds] = useState<number[]>([]);
```

Load stores only for `operation === 'item_update'`:

```ts
useEffect(() => {
  if (operation !== 'item_update') {
    return undefined;
  }
  let ignore = false;
  setStoreLoadState('loading');
  adminApi
    .getStores()
    .then((rows) => {
      if (!ignore) {
        setStores(rows);
        setStoreLoadState('ready');
      }
    })
    .catch(() => {
      if (!ignore) {
        setStoreLoadState('error');
      }
    });
  return () => {
    ignore = true;
  };
}, [operation]);
```

Replace the single `Run Item Update` button with:

```tsx
<Button
  disabled={Boolean(startingOperation) || runIsActive || selectedStoreIds.length === 0}
  startIcon={startingOperation === 'item_update' || runIsActive ? <CircularProgress color="inherit" size={16} /> : <PlayArrowIcon />}
  variant="contained"
  onClick={() => handleStartItemUpdate({ store_ids: selectedStoreIds })}
>
  Run for selected stores
</Button>
<Button
  disabled={Boolean(startingOperation) || runIsActive}
  startIcon={startingOperation === 'item_update' || runIsActive ? <CircularProgress color="inherit" size={16} /> : <PlayArrowIcon />}
  variant="outlined"
  onClick={() => handleStartItemUpdate({ all_stores: true })}
>
  Run for all
</Button>
```

Render a compact checkbox list with `Checkbox`, store name, canonical domain, website URL, and platform.

- [ ] **Step 4: Run UI tests to verify GREEN**

Run:

```powershell
npm test -- src/pages/OperationsPage.test.tsx
```

Expected: targeted UI tests pass.

### Task 6: Full Verification, Commit, Push

**Files:**
- Verify all modified files.
- Commit and push from `C:\PROJECTS\ludora\ludora-admin`.

- [ ] **Step 1: Run full verification**

Run:

```powershell
npm test
```

from `ludora-admin-service`, then:

```powershell
npm test
```

from `ludora-admin-ui`, then:

```powershell
python -m unittest discover -s tests -v
```

from `ludora-discovery`.

Expected: all three suites pass.

- [ ] **Step 2: Review git diff**

Run:

```powershell
git diff --stat
git diff -- docs/superpowers/plans/2026-07-05-store-item-update-store-scope.md ludora-admin-service/src ludora-admin-ui/src ludora-discovery/src ludora-discovery/tests
```

Expected: changes are limited to the store item update scope feature and its plan/tests.

- [ ] **Step 3: Commit and push**

Run:

```powershell
git status --short
git add docs/superpowers/plans/2026-07-05-store-item-update-store-scope.md ludora-admin-service/src ludora-admin-ui/src ludora-discovery/src ludora-discovery/tests
git commit -m "Scope store item update by stores"
git push
```

Expected: commit succeeds and pushes to `main`.
