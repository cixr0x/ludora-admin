# Manual AI BGG Match Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a review-page `Match AI` button that always makes a fresh AI BGG match attempt and replaces the primary catalog item only after successful BGG validation, cache persistence, and import.

**Architecture:** Add a dedicated `matchWithAi` orchestration method beside the existing automatic matcher so the manual action bypasses deterministic local and cache reads while reusing the same AI/BGG validation and positive cache-write logic. Expose it through one authenticated admin-service route and a typed UI client method, then place the action in the review-only linked-item panel with localized loading and feedback state.

**Tech Stack:** TypeScript, Express 5, PostgreSQL database adapter with mocked tests, React 19, Material UI 7, Vitest, Testing Library.

## Global Constraints

- The action is review-only and is available with or without an existing primary item.
- Every click makes exactly one fresh AI request using only the stored item name and optional stored image URL.
- Manual matching bypasses deterministic local matches and BGG cache reads, but writes a positive validated result to the existing cache.
- A successful result uses the existing BGG importer and immediately replaces the primary association.
- No-match or any failure preserves `store_items.item_id` and the current match metadata.
- Missing images remain valid input and must not force a no-match.
- No DDL, DML patch, new dependency, direct OpenAI client, or CodexAPI change is allowed.
- Automated tests must not call live AI, BGG, database, or production services.

---

### Task 1: Add the force-AI item-matching service operation

**Files:**
- Modify: `ludora-admin-service/src/itemMatching/itemMatchingService.ts`
- Test: `ludora-admin-service/src/itemMatching/itemMatchingService.test.ts`

**Interfaces:**
- Consumes: existing `AiBggMatchingService.findMatch({ itemName, imageUrl })`, `generateAiBggMatch`, `BggMatchCache.recordAiMatch`, `BggItemImporter.importBggId`, `linkStoreItemMatch`, and `TraceLogger`.
- Produces: `ItemMatchingService.matchWithAi(discoveryItemCandidateId, options?)` returning `ManualAiItemMatchResult`.

- [ ] **Step 1: Write failing tests for a successful forced rematch**

Add the exported result contract to the test import once it exists, and add a test that starts from a candidate representing an already-linked Spanish store item. The test must prove that local and cache-read stages are bypassed while positive caching, import, and linking still happen:

```ts
it('forces a fresh AI match for an already-linked store item', async () => {
  const queries: RecordedQuery[] = [];
  const updates: RecordedQuery[] = [];
  const database = matchingDatabase(
    storeItemCandidate({
      image_url: 'https://store.mx/guerra-del-anillo.jpg',
      item_id: 77,
      match_source: 'LOCAL',
      title: 'La Guerra del Anillo'
    }),
    [localItemRow()],
    {
      onQuery: (query) => queries.push(query),
      onStoreItemUpdate: (query) => updates.push(query)
    }
  );
  const ai = aiService(aiMatchFound());
  const cache = matchCache({
    cacheHit: true,
    matches: [{ item: bggSearchItem(999, 'Wrong Game', 2010), verifiedByAi: true }]
  });
  const importer = itemImporter(88);
  const service = createItemMatchingService(
    database,
    dependencies({ ai, bggClient: clientWithThing(bggThingDetails()), cache, importer })
  );

  const result = await service.matchWithAi?.(42);

  expect(cache.lookup).not.toHaveBeenCalled();
  expect(queries.some((query) => normalizeSql(query.sql).includes('from items'))).toBe(false);
  expect(ai.findMatch).toHaveBeenCalledOnce();
  expect(ai.findMatch).toHaveBeenCalledWith({
    itemName: 'La Guerra del Anillo',
    imageUrl: 'https://store.mx/guerra-del-anillo.jpg'
  });
  expect(cache.recordAiMatch).toHaveBeenCalledOnce();
  expect(importer.importBggId).toHaveBeenCalledWith(115746);
  expect(linkUpdate(updates)?.params?.slice(0, 5)).toEqual([
    88,
    'BGG',
    115746,
    'War of the Ring: Second Edition',
    0.83
  ]);
  expect(result).toEqual({
    status: 'matched',
    itemId: 88,
    bggId: 115746,
    matchedName: 'War of the Ring: Second Edition'
  });
});
```

Add a companion missing-image case asserting `findMatch({ itemName: 'Coffee Rush', imageUrl: null })` and a successful matched result.

- [ ] **Step 2: Write failing preservation and configuration tests**

Add a no-match test that asserts the result is `{ status: 'not_found' }`, cache/import are not used, and the only store-item query is the initial read—there must be no `update store_items` query.

Add table-driven failure cases for AI and import rejection:

```ts
it.each([
  ['AI failure', aiServiceRejecting(new Error('CodexAPI unavailable')), itemImporter(88)],
  ['import failure', aiService(aiMatchFound()), itemImporterRejecting(new Error('Import failed'))]
])('%s preserves the current association', async (_label, ai, importer) => {
  const updates: RecordedQuery[] = [];
  const service = createItemMatchingService(
    matchingDatabase(storeItemCandidate({ item_id: 77 }), [], {
      onStoreItemUpdate: (query) => updates.push(query)
    }),
    dependencies({ ai, bggClient: clientWithThing(bggThingDetails()), importer })
  );

  await expect(service.matchWithAi?.(42)).rejects.toThrow();
  expect(linkUpdate(updates)).toBeUndefined();
});
```

Add these focused fake helpers so the cases reject without making live requests:

```ts
function aiServiceRejecting(error: Error): AiBggMatchingService {
  return { findMatch: vi.fn().mockRejectedValue(error) };
}

function itemImporterRejecting(error: Error): BggItemImporter {
  return { importBggId: vi.fn().mockRejectedValue(error) };
}
```

Add a configuration test asserting an absent AI matcher, BGG client, or importer rejects with status `503` before any store-item update.

Add two more explicit preservation tests:

```ts
it('preserves the current association when BGG validation fails', async () => {
  const updates: RecordedQuery[] = [];
  const service = createItemMatchingService(
    matchingDatabase(storeItemCandidate({ item_id: 77 }), [], {
      onStoreItemUpdate: (query) => updates.push(query)
    }),
    dependencies({
      ai: aiService(aiMatchFound()),
      bggClient: clientWithThing(null),
      importer: itemImporter(88)
    })
  );

  await expect(service.matchWithAi?.(42)).rejects.toThrow('could not validate');
  expect(linkUpdate(updates)).toBeUndefined();
});

it('preserves the current association when positive cache persistence fails', async () => {
  const updates: RecordedQuery[] = [];
  const cache = matchCache();
  vi.mocked(cache.recordAiMatch).mockRejectedValue(new Error('Cache failed'));
  const importer = itemImporter(88);
  const service = createItemMatchingService(
    matchingDatabase(storeItemCandidate({ item_id: 77 }), [], {
      onStoreItemUpdate: (query) => updates.push(query)
    }),
    dependencies({
      ai: aiService(aiMatchFound()),
      bggClient: clientWithThing(bggThingDetails()),
      cache,
      importer
    })
  );

  await expect(service.matchWithAi?.(42)).rejects.toThrow('Cache failed');
  expect(importer.importBggId).not.toHaveBeenCalled();
  expect(linkUpdate(updates)).toBeUndefined();
});
```

- [ ] **Step 3: Run the service tests and capture RED**

Run:

```powershell
npm test -- --run src/itemMatching/itemMatchingService.test.ts
```

Expected: FAIL because `matchWithAi` and `ManualAiItemMatchResult` do not exist.

- [ ] **Step 4: Add the manual result type and service interface**

In `itemMatchingService.ts`, export:

```ts
export type ManualAiItemMatchResult =
  | {
      status: 'matched';
      itemId: number;
      bggId: number;
      matchedName: string;
    }
  | { status: 'not_found' };

type ManualAiMatchOptions = {
  traceLogger?: TraceLogger;
};
```

Extend `ItemMatchingService` with:

```ts
matchWithAi?(
  discoveryItemCandidateId: number,
  options?: ManualAiMatchOptions
): Promise<ManualAiItemMatchResult>;
```

The method remains optional so existing narrowly scoped route fakes do not need unrelated implementations.

- [ ] **Step 5: Implement the force-AI orchestration**

Add `matchWithAi` to the object returned by `createItemMatchingService`:

```ts
async matchWithAi(
  discoveryItemCandidateId: number,
  options: ManualAiMatchOptions = {}
): Promise<ManualAiItemMatchResult> {
  const traceLogger = options.traceLogger ?? nullTraceLogger;
  const candidate = await loadDiscoveryItemCandidate(database, discoveryItemCandidateId);

  if (!aiBggMatchingService || !bggClient || !bggItemImporter) {
    throw httpError(503, 'Manual AI item matching is not configured');
  }

  traceLog(traceLogger, 'item_matcher.manual_ai.start', {
    candidate_id: discoveryItemCandidateId
  });

  try {
    const match = await generateAiBggMatch(
      candidate,
      { aiBggMatchingService, bggClient, bggMatchCache },
      traceLogger
    );
    if (!match?.bggId) {
      traceLog(traceLogger, 'item_matcher.manual_ai.completed', {
        candidate_id: discoveryItemCandidateId,
        result: 'not_found'
      });
      return { status: 'not_found' };
    }

    const itemId = await bggItemImporter.importBggId(match.bggId);
    if (!itemId) {
      throw new Error('BGG item could not be imported');
    }

    await linkStoreItemMatch(database, discoveryItemCandidateId, match, itemId, true);
    traceLog(traceLogger, 'item_matcher.manual_ai.completed', {
      bgg_id: match.bggId,
      candidate_id: discoveryItemCandidateId,
      item_id: itemId,
      result: 'matched'
    });
    return {
      status: 'matched',
      itemId,
      bggId: match.bggId,
      matchedName: match.matchedName
    };
  } catch (error) {
    traceLog(traceLogger, 'item_matcher.manual_ai.failed', {
      candidate_id: discoveryItemCandidateId,
      error: error instanceof Error ? error.message : 'Manual AI item matching failed'
    });
    throw error;
  }
}
```

Do not call `confirmStoreItemAsBoardgame`, `generateLocalMatches`, `generateBggMatches`, `markStoreItemMatchNotFound`, or `markStoreItemProcessingError` from this method. Those operations would either short-circuit AI or mutate the current association on no-match/failure.

- [ ] **Step 6: Run focused service tests and build**

Run:

```powershell
npm test -- --run src/itemMatching/itemMatchingService.test.ts
npm run build
```

Expected: all item-matching tests pass and TypeScript build exits `0`.

- [ ] **Step 7: Commit the service operation**

```powershell
git add -- ludora-admin-service/src/itemMatching/itemMatchingService.ts ludora-admin-service/src/itemMatching/itemMatchingService.test.ts
git commit -m "feat: add manual AI item matching"
```

---

### Task 2: Expose the manual matcher through the admin API and UI client

**Files:**
- Modify: `ludora-admin-service/src/routes/discovery.ts`
- Test: `ludora-admin-service/src/app.test.ts`
- Modify: `ludora-admin-ui/src/api/client.ts`

**Interfaces:**
- Consumes: `ItemMatchingService.matchWithAi(id, { traceLogger })` and `ManualAiItemMatchResult` from Task 1.
- Produces: `POST /discovery/listings/:id/match-ai` and `adminApi.matchItemCandidateWithAi(id): Promise<ManualAiBggMatchResponse>`.

- [ ] **Step 1: Write failing route tests**

In `app.test.ts`, add a matched response test with a fake matching service:

```ts
const itemMatchingService: ItemMatchingService = {
  generateMatchCandidates: async () => [],
  listMatchCandidates: async () => [],
  matchWithAi: async (id, options) => {
    calls.push({ id, options });
    return {
      status: 'matched',
      itemId: 88,
      bggId: 115746,
      matchedName: 'War of the Ring: Second Edition'
    };
  }
};

const response = await request(createApp({ database, itemMatchingService }))
  .post('/discovery/listings/42/match-ai');

expect(response.status).toBe(200);
expect(response.body).toEqual({
  data: {
    candidate: row,
    result: {
      status: 'matched',
      item_id: 88,
      bgg_id: 115746,
      matched_name: 'War of the Ring: Second Edition'
    }
  }
});
```

Assert the call receives candidate ID `42` and a trace logger when internal trace headers are present. Add a `not_found` test asserting `{ candidate: row, result: { status: 'not_found' } }`. Add a missing-service test asserting HTTP `503`, and retain integer path validation coverage through a non-integer path request.

- [ ] **Step 2: Run the route tests and capture RED**

Run:

```powershell
npm test -- --run src/app.test.ts -t "manual AI"
```

Expected: FAIL with `404` because `/discovery/listings/:id/match-ai` is absent.

- [ ] **Step 3: Implement the route**

Add the route next to `confirm-boardgame` and `associate-item`:

```ts
router.post('/discovery/listings/:id/match-ai', async (request, response, next) => {
  try {
    if (!itemMatchingService?.matchWithAi) {
      throw httpError(503, 'Manual AI item matching is not configured');
    }

    const candidateId = integerPathParam(request.params.id);
    const traceLogger = createTraceLoggerFromHeaders(request.headers, database);
    let matchResult: ManualAiItemMatchResult;
    try {
      matchResult = await itemMatchingService.matchWithAi(candidateId, {
        ...(traceLogger ? { traceLogger } : {})
      });
    } finally {
      await traceLogger?.flush?.();
    }

    const result = await database.query(
      `select ${itemCandidateSelect} from store_items where id = $1`,
      [candidateId]
    );
    if (!result.rows[0]) {
      throw httpError(404, 'Item candidate not found');
    }

    response.json({
      data: {
        candidate: result.rows[0],
        result: matchResult.status === 'matched'
          ? {
              status: 'matched',
              item_id: matchResult.itemId,
              bgg_id: matchResult.bggId,
              matched_name: matchResult.matchedName
            }
          : { status: 'not_found' }
      }
    });
  } catch (error) {
    next(error);
  }
});
```

Update the existing type-only import from `itemMatchingService.ts` to import both `ItemMatchingService` and `ManualAiItemMatchResult`.

- [ ] **Step 4: Run route tests and service build**

Run:

```powershell
npm test -- --run src/app.test.ts -t "manual AI"
npm run build
```

Expected: focused route tests pass and the service build exits `0`.

- [ ] **Step 5: Add the typed admin UI client method**

In `ludora-admin-ui/src/api/client.ts`, export:

```ts
export type ManualAiBggMatchResult =
  | {
      status: 'matched';
      item_id: number;
      bgg_id: number;
      matched_name: string;
    }
  | { status: 'not_found' };

export type ManualAiBggMatchResponse = {
  candidate: AdminRecord;
  result: ManualAiBggMatchResult;
};
```

Add the API method beside `confirmItemCandidateBoardgame`:

```ts
matchItemCandidateWithAi: (id: string) =>
  fetchData<ManualAiBggMatchResponse>(
    `/discovery/listings/${encodeURIComponent(id)}/match-ai`,
    { method: 'POST' }
  ),
```

This endpoint has no JSON request body because the service loads the stored title and image.

- [ ] **Step 6: Build the admin UI**

Run:

```powershell
npm run build
```

Expected: TypeScript and Vite build exit `0`.

- [ ] **Step 7: Commit the route and client contract**

From `ludora-admin`:

```powershell
git add -- ludora-admin-service/src/routes/discovery.ts ludora-admin-service/src/app.test.ts ludora-admin-ui/src/api/client.ts
git commit -m "feat: expose manual AI BGG matching"
```

---

### Task 3: Add the review-only Match AI interaction

**Files:**
- Modify: `ludora-admin-ui/src/pages/ListingCandidatesPage.tsx`
- Test: `ludora-admin-ui/src/pages/ListingCandidatesPage.test.tsx`

**Interfaces:**
- Consumes: `adminApi.matchItemCandidateWithAi(id)` and `ManualAiBggMatchResult` from Task 2.
- Produces: review-only `Match AI`/`Matching...` interaction and refreshed candidate/linked-item UI state.

- [ ] **Step 1: Write failing visibility tests**

Add a parameterized review-detail test for candidates with `item_id: 77` and `item_id: null`. For both, assert:

```ts
expect(await screen.findByRole('button', { name: 'Match AI' })).toBeEnabled();
```

Render the existing standard detail flow separately and assert:

```ts
expect(screen.queryByRole('button', { name: 'Match AI' })).not.toBeInTheDocument();
```

The mocks must continue to return current linked-item details only when `item_id` is present and return an empty additional-item list.

- [ ] **Step 2: Write failing success, no-match, and error interaction tests**

Add a successful replacement test using an existing linked item `77` and matched item `88`. Mock:

```ts
if (path === '/discovery/listings/920/match-ai' && init?.method === 'POST') {
  candidate = {
    ...candidate,
    item_id: 88,
    match_source: 'BGG',
    matched_bgg_id: 115746,
    matched_name: 'War of the Ring: Second Edition'
  };
  return jsonResponse({
    candidate,
    result: {
      status: 'matched',
      item_id: 88,
      bgg_id: 115746,
      matched_name: 'War of the Ring: Second Edition'
    }
  });
}
```

After clicking `Match AI`, assert the button shows `Matching...` while the deferred response is unresolved and a second click cannot produce another request. Resolve it and assert item `88` is loaded, the item ID input changes to `88`, and success feedback names `War of the Ring: Second Edition`. Assert the request is:

```ts
expect(fetchMock).toHaveBeenCalledWith(
  'http://127.0.0.1:4001/discovery/listings/920/match-ai',
  { credentials: 'include', method: 'POST' }
);
```

Add a no-match test returning `{ candidate: originalCandidate, result: { status: 'not_found' } }`; assert the existing linked item and item ID remain `77`, and the page displays `AI did not find a reliable BGG match.`

Add an error test returning HTTP `503`; assert the existing linked item remains and the page displays `AI matching could not be completed.`

- [ ] **Step 3: Run the UI tests and capture RED**

Run:

```powershell
npm test -- --run src/pages/ListingCandidatesPage.test.tsx -t "Match AI"
```

Expected: FAIL because the button and handler are absent.

- [ ] **Step 4: Thread the review-only callback through the form**

Import `ManualAiBggMatchResult` from the API client. Add a parent callback that updates the table row and selected candidate, increments `linkedItemRefreshToken`, refreshes the table, and sets feedback:

```ts
function handleManualAiMatch(candidate: AdminRecord, result: ManualAiBggMatchResult) {
  const id = field(candidate, ['id'], '');
  setRows((currentRows) =>
    currentRows.map((row, index) => (field(row, ['id'], String(index)) === id ? candidate : row))
  );
  setSelectedCandidate(candidate);
  if (result.status === 'matched') {
    setLinkedItemRefreshToken((currentToken) => currentToken + 1);
    setSaveMessage(`AI matched ${result.matched_name}.`);
  } else {
    setSaveMessage('AI did not find a reliable BGG match.');
  }
  setSaveError('');
  table.refresh();
}
```

Pass it through `ItemCandidateForm` only when `detailMode === 'review'`, and then into `PrimaryItemSection` as an optional prop:

```ts
onAiMatch?: (candidate: AdminRecord, result: ManualAiBggMatchResult) => void;
```

- [ ] **Step 5: Implement the localized button state and request handler**

Inside `PrimaryItemSection`, add `isMatchingWithAi` state and:

```ts
async function handleAiMatch() {
  if (!storeItemId || !onAiMatch || isMatchingWithAi) {
    return;
  }

  setIsMatchingWithAi(true);
  setError('');
  try {
    const response = await adminApi.matchItemCandidateWithAi(storeItemId);
    onAiMatch(response.candidate, response.result);
  } catch {
    setError('AI matching could not be completed.');
  } finally {
    setIsMatchingWithAi(false);
  }
}
```

Render a compact action stack in the linked-item header. Only render the AI button when `onAiMatch` is provided:

```tsx
{onAiMatch ? (
  <Button
    disabled={!storeItemId || isMatchingWithAi || isAssociating}
    startIcon={isMatchingWithAi ? <CircularProgress size={18} /> : <AutoFixHighIcon />}
    type="button"
    variant="contained"
    onClick={() => void handleAiMatch()}
  >
    {isMatchingWithAi ? 'Matching...' : 'Match AI'}
  </Button>
) : null}
```

Disable the `Link item`/`Change linked item` button while `isMatchingWithAi` is true, and disable `Match AI` while a catalog association request is active. Reuse the existing section error alert for request failures.

- [ ] **Step 6: Run focused UI tests and build**

Run:

```powershell
npm test -- --run src/pages/ListingCandidatesPage.test.tsx
npm run build
```

Expected: all listing-candidate page tests pass and the UI production build exits `0`.

- [ ] **Step 7: Commit the UI interaction**

From `ludora-admin`:

```powershell
git add -- ludora-admin-ui/src/pages/ListingCandidatesPage.tsx ludora-admin-ui/src/pages/ListingCandidatesPage.test.tsx
git commit -m "feat: add Match AI review action"
```

---

### Task 4: Run cross-layer verification and inspect the final diff

**Files:**
- Verify only: all files changed by Tasks 1-3

**Interfaces:**
- Consumes: the complete service, route, client, and UI flow.
- Produces: fresh verification evidence for handoff; no new production interface.

- [ ] **Step 1: Run the focused admin-service tests**

```powershell
Set-Location ludora-admin-service
npm test -- --run src/itemMatching/itemMatchingService.test.ts src/app.test.ts
```

Expected: both focused test files pass.

- [ ] **Step 2: Run the full admin-service suite and build**

```powershell
npm test
npm run build
```

Expected: the full Vitest suite and TypeScript build pass.

- [ ] **Step 3: Run the focused and full admin UI suites and build**

```powershell
Set-Location ..\ludora-admin-ui
npm test -- --run src/pages/ListingCandidatesPage.test.tsx
npm test
npm run build
```

Expected: focused and full UI suites pass, followed by a successful production build.

- [ ] **Step 4: Verify no out-of-scope database or AI-client changes**

From `ludora-admin`:

```powershell
git diff origin/main...HEAD --name-only
git diff origin/main...HEAD -- ludora-admin/database database ludora-discovery
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: only the design/plan plus admin-service/admin-UI feature files are changed; database and discovery diffs are empty; diff check is clean.

- [ ] **Step 5: Review the behavior against the approved specification**

Confirm from tests and diff that:

- `Match AI` is review-only and works with both linked and unlinked candidates;
- the endpoint has no product-data request body;
- `matchWithAi` calls `generateAiBggMatch` directly and never calls local/cache-read matching;
- positive results are cached before import and link;
- no-match and failures do not call any store-item update helper;
- success updates the linked item and page feedback;
- no database patch or new AI client was introduced.

- [ ] **Step 6: Commit any verification-only correction**

If verification exposes a defect, add a failing regression test first, apply the smallest correction, rerun the affected focused suite, and commit only that correction with a message describing the behavior fixed. If no correction is needed, do not create an empty commit.
