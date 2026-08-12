# Deterministic Live BGG Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore strict deterministic live BoardGameGeek search between the existing BGG cache lookup and AI BGG matching.

**Architecture:** Keep orchestration in `itemMatchingService.ts`: local catalog lookup remains first, cover-aware BGG cache lookup remains second, a new bounded `searchFresh()` stage becomes third, and the existing AI matcher remains last. Reuse the current BGG client, cached-client persistence, deterministic scorer, importer, linker, candidate staging, and manual AI flow without adding a database or API surface.

**Tech Stack:** TypeScript 6, Node.js 24, Vitest 4, existing BGG XML/cached clients, PostgreSQL database interface with mocked tests.

## Global Constraints

- Automated order is existing Ludora items, BGG cache, deterministic live BGG, then AI BGG matching.
- Each stage runs only when the preceding stage has no accepted match.
- Deterministic live acceptance requires `matchScore >= 0.90`.
- Live search must call `bggClient.searchFresh(candidate.title)` and must never call ordinary `search()`.
- Evaluate at most ten unique positive BGG IDs, with normalized exact-title search results first.
- Fetch full BGG Thing details before deterministic scoring.
- A live no-match, unavailable `searchFresh`, search error, or Thing-fetch error falls through to AI and is distinguishable in traces.
- The production cached BGG client remains the sole owner of fresh-search cache persistence.
- Manual `Match AI` remains AI-only and must not call the deterministic live-search stage.
- Do not add translation, image scoring, retries, schema changes, routes, UI changes, discovery changes, CodexAPI changes, or AI prompt/configuration changes.
- Do not run live BGG, AI, database, SQL, or production requests during implementation or automated verification.

---

### Task 1: Restore the deterministic live-search fallback

**Files:**
- Modify: `ludora-admin-service/src/itemMatching/itemMatchingService.ts:8-15,91,565-615`
- Modify: `ludora-admin-service/src/itemMatching/itemMatchingService.test.ts:82-145,343-365,981-1025`

**Interfaces:**
- Consumes: `BggClient.searchFresh(query: string)`, `BggClient.fetchThing(bggId: number)`, `scoreBggThing(candidate, thing)`, `mergeMatchesByBggId(matches)`, and `AUTO_MATCH_SCORE_THRESHOLD`.
- Produces: internal `generateLiveBggMatches(candidate, bggClient, traceLogger): Promise<GeneratedMatchCandidate[]>` and `prioritizeLiveBggSearchResults(searchResults, candidateTitle): BggSearchItem[]`.
- Preserves: `generateAiBggMatch(...)`, `ItemMatchingService.matchWithAi(...)`, importer/link behavior, and existing cache lookup semantics.

- [ ] **Step 1: Add test helpers for a live-search-capable fake BGG client**

Add this helper beside `clientWithThing()` in `itemMatchingService.test.ts`:

```ts
function clientWithFreshSearch(
  searchResults: BggSearchItem[],
  things: Map<number, BggThingDetails | null>
): BggClient {
  return {
    fetchThing: vi.fn(async (bggId) => {
      const details = things.get(bggId) ?? null;
      return details ? { details, rawXml: '<items />' } : null;
    }),
    search: vi.fn().mockRejectedValue(new Error('Cached BGG search must not be used by live matching')),
    searchFresh: vi.fn().mockResolvedValue(searchResults)
  };
}
```

Keep `clientWithThing()` for tests that need the older single-Thing behavior. Do not make its `search()` silently succeed.

- [ ] **Step 2: Write failing tests for cache-to-live success and live-to-AI fallback**

Add focused tests inside `describe('item matching service', ...)`:

```ts
it('uses an accepted fresh BGG result before AI', async () => {
  const updates: RecordedQuery[] = [];
  const ai = aiService(null);
  const cache = matchCache({
    cacheHit: true,
    matches: [{ item: bggSearchItem(999, 'Coffee Rush: Expansion', 2024), verifiedByAi: false }]
  });
  const freshThing = bggThingDetails({
    bggId: 377061,
    name: 'Coffee Rush',
    yearPublished: 2023
  });
  const bggClient = clientWithFreshSearch(
    [bggSearchItem(377061, 'Coffee Rush', 2023)],
    new Map([[377061, freshThing]])
  );
  const importer = itemImporter(88);
  const database = matchingDatabase(storeItemCandidate({ title: 'Coffee Rush' }), [], {
    onStoreItemUpdate: (query) => updates.push(query)
  });

  await createItemMatchingService(database, dependencies({ ai, bggClient, cache, importer }))
    .confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

  expect(bggClient.searchFresh).toHaveBeenCalledOnce();
  expect(bggClient.searchFresh).toHaveBeenCalledWith('Coffee Rush');
  expect(bggClient.search).not.toHaveBeenCalled();
  expect(ai.findMatch).not.toHaveBeenCalled();
  expect(importer.importBggId).toHaveBeenCalledWith(377061);
  expect(linkUpdate(updates)?.params?.slice(0, 4)).toEqual([88, 'BGG', 377061, 'Coffee Rush']);
});

it('continues to AI when fresh BGG results stay below the deterministic threshold', async () => {
  const ai = aiService(aiMatchFound());
  const bggClient = clientWithFreshSearch(
    [bggSearchItem(999, 'War Ring Card Game', 2010)],
    new Map([
      [999, bggThingDetails({ bggId: 999, name: 'War Ring Card Game', type: 'boardgame' })],
      [115746, bggThingDetails()]
    ])
  );

  await createItemMatchingService(
    matchingDatabase(storeItemCandidate({ title: 'La Guerra del Anillo' })),
    dependencies({ ai, bggClient, cache: matchCache(), importer: itemImporter(88) })
  ).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

  expect(bggClient.searchFresh).toHaveBeenCalledWith('La Guerra del Anillo');
  expect(ai.findMatch).toHaveBeenCalledOnce();
});
```

Also add a search-error fallback test:

```ts
it('continues to AI when fresh BGG search fails', async () => {
  const ai = aiService(aiMatchFound());
  const bggClient = clientWithFreshSearch([], new Map([[115746, bggThingDetails()]]));
  vi.mocked(bggClient.searchFresh!).mockRejectedValueOnce(new Error('BGG temporarily unavailable'));

  await createItemMatchingService(
    matchingDatabase(storeItemCandidate({ title: 'La Guerra del Anillo' })),
    dependencies({ ai, bggClient, cache: matchCache(), importer: itemImporter(88) })
  ).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

  expect(ai.findMatch).toHaveBeenCalledOnce();
});
```

Add the unavailable-capability fallback without making ordinary `search()` a substitute:

```ts
it('continues to AI without using cached search when searchFresh is unavailable', async () => {
  const ai = aiService(aiMatchFound());
  const bggClient: BggClient = {
    fetchThing: vi.fn().mockResolvedValue({ details: bggThingDetails(), rawXml: '<items />' }),
    search: vi.fn().mockRejectedValue(new Error('Cached search must remain unused'))
  };

  await createItemMatchingService(
    matchingDatabase(storeItemCandidate({ title: 'La Guerra del Anillo' })),
    dependencies({ ai, bggClient, cache: matchCache(), importer: itemImporter(88) })
  ).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

  expect(bggClient.search).not.toHaveBeenCalled();
  expect(ai.findMatch).toHaveBeenCalledOnce();
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run from `ludora-admin-service/`:

```powershell
npm test -- src/itemMatching/itemMatchingService.test.ts
```

Expected: the new success test fails because `searchFresh` is not called and the importer/link never receives BGG ID `377061`; fallback tests expose the absent live stage.

- [ ] **Step 4: Add constants and deterministic result prioritization**

In `itemMatchingService.ts`, import `normalizeTitle` alongside `normalizeTitleVariants` and add:

```ts
const MAX_LIVE_BGG_THING_FETCHES = 10;

function prioritizeLiveBggSearchResults(
  searchResults: BggSearchItem[],
  candidateTitle: string
): BggSearchItem[] {
  const exactTitles = new Set(normalizeTitleVariants(candidateTitle));
  const seen = new Set<number>();
  const exact: BggSearchItem[] = [];
  const remaining: BggSearchItem[] = [];

  for (const result of searchResults) {
    if (!Number.isInteger(result.bggId) || result.bggId <= 0 || seen.has(result.bggId)) {
      continue;
    }
    seen.add(result.bggId);
    (exactTitles.has(normalizeTitle(result.name)) ? exact : remaining).push(result);
  }

  return [...exact, ...remaining].slice(0, MAX_LIVE_BGG_THING_FETCHES);
}
```

Do not add translated queries or remove store suffixes in this task.

- [ ] **Step 5: Implement the bounded live BGG generator**

Add an internal helper before `generatedCacheMatch()`:

```ts
async function generateLiveBggMatches(
  candidate: DiscoveryItemCandidateRow,
  bggClient: BggClient | undefined,
  traceLogger: TraceLogger
): Promise<GeneratedMatchCandidate[]> {
  traceLog(traceLogger, 'item_matcher.bgg_live_search.start', {
    candidate_id: candidate.id,
    query: candidate.title
  });

  if (!bggClient?.searchFresh) {
    traceLog(traceLogger, 'item_matcher.bgg_live_search.failed', {
      candidate_id: candidate.id,
      error: 'Fresh BGG search is not configured',
      stage: 'search'
    });
    return [];
  }

  let searchResults: BggSearchItem[];
  try {
    searchResults = await bggClient.searchFresh(candidate.title);
  } catch {
    traceLog(traceLogger, 'item_matcher.bgg_live_search.failed', {
      candidate_id: candidate.id,
      error: 'Live BGG search failed',
      stage: 'search'
    });
    return [];
  }

  const selected = prioritizeLiveBggSearchResults(searchResults, candidate.title);
  const matches: GeneratedMatchCandidate[] = [];

  for (const searchResult of selected) {
    traceLog(traceLogger, 'item_matcher.bgg_thing_fetch.start', {
      bgg_id: searchResult.bggId,
      candidate_id: candidate.id,
      source: 'live_bgg_search'
    });

    let thing: Awaited<ReturnType<BggClient['fetchThing']>>;
    try {
      thing = await bggClient.fetchThing(searchResult.bggId);
    } catch {
      traceLog(traceLogger, 'item_matcher.bgg_live_search.failed', {
        bgg_id: searchResult.bggId,
        candidate_id: candidate.id,
        error: 'BGG Thing fetch failed',
        stage: 'thing_fetch'
      });
      return matches;
    }

    traceLog(traceLogger, 'item_matcher.bgg_thing_fetch.completed', {
      bgg_id: searchResult.bggId,
      candidate_id: candidate.id,
      found: thing !== null,
      source: 'live_bgg_search'
    });
    if (!thing) {
      continue;
    }

    const score = scoreBggThing(discoveryCandidateForMatch(candidate), thing.details);
    const match: GeneratedMatchCandidate = {
      accepted: score.matchScore >= AUTO_MATCH_SCORE_THRESHOLD,
      bggId: thing.details.bggId,
      itemId: null,
      matchReasons: score.matchReasons,
      matchScore: score.matchScore,
      matchedName: thing.details.name,
      rawPayload: {
        search_result: searchResult,
        source: 'live_bgg_search',
        thing: thing.details
      },
      source: 'BGG'
    };
    matches.push(match);
    if (match.accepted) {
      break;
    }
  }

  const accepted = bestAcceptedMatch(matches);
  traceLog(traceLogger, 'item_matcher.bgg_live_search.completed', {
    accepted_bgg_id: accepted?.bggId ?? null,
    accepted_match: accepted !== null,
    candidate_id: candidate.id,
    evaluated_count: matches.length,
    result_count: searchResults.length
  });
  return matches;
}
```

Use fixed path-free failure messages in traces; do not log raw XML or network response bodies.

- [ ] **Step 6: Insert the live stage between cache and AI**

Replace the tail of `generateBggMatches()` after the accepted-cache return with:

```ts
const liveMatches = await generateLiveBggMatches(candidate, dependencies.bggClient, traceLogger);
const deterministicMatches = mergeMatchesByBggId([...cacheMatches, ...liveMatches]);
if (hasAcceptedMatch(deterministicMatches)) {
  return deterministicMatches;
}

const aiMatch = await generateAiBggMatch(candidate, dependencies, traceLogger);
return aiMatch
  ? mergeMatchesByBggId([...deterministicMatches, aiMatch])
  : deterministicMatches;
```

Do not change `matchWithAi()`; it calls `generateAiBggMatch()` directly and therefore remains AI-only.

- [ ] **Step 7: Repair existing test fixtures that now encounter the live stage**

Existing automated-flow tests use `clientWithThing()` with a deliberately rejecting `searchFresh`. Leave that default rejection in place when the test is proving error fallback. For tests that inspect AI validation-specific `searchFresh` calls or `.mockResolvedValueOnce(...)` sequencing, provide two explicit outcomes:

```ts
vi.mocked(bggClient.searchFresh!)
  .mockResolvedValueOnce([]) // deterministic live stage
  .mockResolvedValueOnce([bggSearchItem(377061, 'Coffee Rush', 2023)]); // AI ID correction
```

Update exact trace arrays to include these entries before `item_matcher.ai_match.start` when the fixture's `searchFresh` rejects:

```ts
'item_matcher.bgg_cache.completed',
'item_matcher.bgg_live_search.start',
'item_matcher.bgg_live_search.failed',
'item_matcher.ai_match.start',
```

Do not weaken exact event-order assertions to unordered containment.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```powershell
npm test -- src/itemMatching/itemMatchingService.test.ts
```

Expected: all item-matching tests pass; the accepted fresh result skips AI, and live misses/errors reach AI.

- [ ] **Step 9: Commit the core fallback**

```powershell
git add -- ludora-admin-service/src/itemMatching/itemMatchingService.ts ludora-admin-service/src/itemMatching/itemMatchingService.test.ts
git diff --cached --check
git commit -m "feat: restore deterministic live BGG matching"
```

---

### Task 2: Prove selection bounds, evidence, tracing, and manual-AI isolation

**Files:**
- Modify: `ludora-admin-service/src/itemMatching/itemMatchingService.test.ts:146-325,664-806,1019-1112`
- Modify only if a test exposes a defect: `ludora-admin-service/src/itemMatching/itemMatchingService.ts`

**Interfaces:**
- Consumes: `generateLiveBggMatches()` behavior added in Task 1 through the public `confirmBoardgameAndMatch()`, `generateMatchCandidates()`, and `matchWithAi()` methods.
- Produces: regression coverage for the ten-ID bound, deduplication, exact-title priority, full-Thing scoring, staged evidence, trace order, and manual AI-only behavior.

- [ ] **Step 1: Write failing selection and full-Thing scoring tests**

Add these cases:

```ts
it('prioritizes an exact live title beyond the first ten search results', async () => {
  const unrelated = Array.from({ length: 11 }, (_, index) =>
    bggSearchItem(1000 + index, `Different Game ${index}`, 2000 + index)
  );
  const exact = bggSearchItem(377061, 'Coffee Rush', 2023);
  const bggClient = clientWithFreshSearch(
    [...unrelated, exact],
    new Map([[377061, bggThingDetails({ bggId: 377061, name: 'Coffee Rush', yearPublished: 2023 })]])
  );
  const ai = aiService(null);

  await createItemMatchingService(
    matchingDatabase(storeItemCandidate({ title: 'Coffee Rush' })),
    dependencies({ ai, bggClient, cache: matchCache(), importer: itemImporter(88) })
  ).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

  expect(bggClient.fetchThing).toHaveBeenCalledTimes(1);
  expect(bggClient.fetchThing).toHaveBeenCalledWith(377061);
  expect(ai.findMatch).not.toHaveBeenCalled();
});

it('deduplicates live IDs and evaluates at most ten Things', async () => {
  const searchResults = [
    bggSearchItem(1000, 'Different Game 0', 2000),
    bggSearchItem(1000, 'Different Game 0', 2000),
    ...Array.from({ length: 11 }, (_, index) =>
      bggSearchItem(1001 + index, `Different Game ${index + 1}`, 2001 + index)
    )
  ];
  const things = new Map<number, BggThingDetails | null>(
    searchResults.map((result) => [
      result.bggId,
      bggThingDetails({ bggId: result.bggId, name: result.name, maxPlayers: null, minPlayers: null })
    ])
  );
  const bggClient = clientWithFreshSearch(searchResults, things);

  await createItemMatchingService(
    matchingDatabase(storeItemCandidate({ title: 'Unmatched Store Title' })),
    dependencies({ ai: aiService(null), bggClient, cache: matchCache() })
  ).generateMatchCandidates(42);

  expect(bggClient.fetchThing).toHaveBeenCalledTimes(10);
  expect(vi.mocked(bggClient.fetchThing).mock.calls.filter(([id]) => id === 1000)).toHaveLength(1);
});

it('accepts a live match from a full Thing alternate name', async () => {
  const ai = aiService(null);
  const bggClient = clientWithFreshSearch(
    [bggSearchItem(115746, 'War of the Ring: Second Edition', 2011)],
    new Map([[115746, bggThingDetails({ alternateNames: ['La Guerra del Anillo'] })]])
  );

  await createItemMatchingService(
    matchingDatabase(storeItemCandidate({ title: 'La Guerra del Anillo' })),
    dependencies({ ai, bggClient, cache: matchCache(), importer: itemImporter(88) })
  ).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

  expect(ai.findMatch).not.toHaveBeenCalled();
});
```

Add the type-conflict case:

```ts
it('rejects an exact live title when the BGG Thing type conflicts', async () => {
  const ai = aiService(null);
  const bggClient = clientWithFreshSearch(
    [bggSearchItem(377061, 'Coffee Rush', 2023)],
    new Map([[
      377061,
      bggThingDetails({ bggId: 377061, name: 'Coffee Rush', type: 'boardgameexpansion' })
    ]])
  );

  await createItemMatchingService(
    matchingDatabase(storeItemCandidate({ item_type: 'base_game', title: 'Coffee Rush' })),
    dependencies({ ai, bggClient, cache: matchCache() })
  ).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

  expect(ai.findMatch).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the new selection tests and verify RED if Task 1 is incomplete**

Run:

```powershell
npm test -- src/itemMatching/itemMatchingService.test.ts
```

Expected before any required correction: failures identify only a concrete missing priority, deduplication, cap, full-Thing, or type-conflict behavior. If all pass from Task 1, record that as the valid GREEN baseline and do not manufacture a production change.

- [ ] **Step 3: Add candidate-staging and Thing-fetch-error regressions**

Add a staging test using a partial title overlap so the live score is above the existing `0.3` display filter but below `0.90`:

```ts
it('stages rejected live BGG evidence without linking it', async () => {
  const updates: RecordedQuery[] = [];
  const thing = bggThingDetails({ bggId: 377061, name: 'Coffee Rush' });
  const bggClient = clientWithFreshSearch(
    [bggSearchItem(377061, 'Coffee Rush', 2023)],
    new Map([[377061, thing]])
  );

  const result = await createItemMatchingService(
    matchingDatabase(storeItemCandidate({ title: 'Coffee Rush Deluxe' }), [], {
      onStoreItemUpdate: (query) => updates.push(query)
    }),
    dependencies({ ai: aiService(null), bggClient, cache: matchCache() })
  ).generateMatchCandidates(42);

  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ bgg_id: 377061, source: 'BGG', status: 'PENDING' });
  expect(result[0].raw_payload).toMatchObject({ source: 'live_bgg_search', thing });
  expect(updates).toEqual([]);
});
```

Add a Thing-fetch error test:

```ts
it('continues to AI and traces a sanitized failure when a live Thing fetch fails', async () => {
  const events: TraceEvent[] = [];
  const ai = aiService(null);
  const bggClient = clientWithFreshSearch(
    [bggSearchItem(377061, 'Coffee Rush', 2023)],
    new Map()
  );
  vi.mocked(bggClient.fetchThing).mockRejectedValueOnce(new Error('private upstream response text'));

  await createItemMatchingService(
    matchingDatabase(storeItemCandidate({ title: 'Coffee Rush' })),
    dependencies({ ai, bggClient, cache: matchCache() })
  ).confirmBoardgameAndMatch?.(42, {
    confirmationSource: 'automated',
    traceLogger: { log: (event, fields = {}) => events.push({ event, fields }) }
  });

  expect(ai.findMatch).toHaveBeenCalledOnce();
  expect(traceFields(events, 'item_matcher.bgg_live_search.failed')).toEqual({
    bgg_id: 377061,
    candidate_id: 42,
    error: 'BGG Thing fetch failed',
    stage: 'thing_fetch'
  });
  expect(JSON.stringify(events)).not.toContain('private upstream response text');
});
```

- [ ] **Step 4: Add explicit trace-order assertions**

For a cache miss, live no-match, and AI no-match, assert ordered indexes rather than simple containment:

```ts
const eventNames = events.map(({ event }) => event);
expect(eventNames.indexOf('item_matcher.bgg_cache.completed')).toBeLessThan(
  eventNames.indexOf('item_matcher.bgg_live_search.start')
);
expect(eventNames.indexOf('item_matcher.bgg_live_search.completed')).toBeLessThan(
  eventNames.indexOf('item_matcher.ai_match.start')
);
```

For accepted live matching, assert `item_matcher.bgg_live_search.completed` contains:

```ts
{
  accepted_bgg_id: 377061,
  accepted_match: true,
  candidate_id: 42,
  evaluated_count: 1,
  result_count: 1
}
```

and assert the event list does not contain `item_matcher.ai_match.start`.

- [ ] **Step 5: Strengthen short-circuit and manual AI-only regressions**

In the accepted-local test, retain a reference to the BGG client passed through `dependencies(...)`, then assert:

```ts
expect(cache.lookup).not.toHaveBeenCalled();
expect(bggClient.searchFresh).not.toHaveBeenCalled();
expect(ai.findMatch).not.toHaveBeenCalled();
```

In the accepted-cache test, retain its BGG client and assert:

```ts
expect(bggClient.searchFresh).not.toHaveBeenCalled();
expect(ai.findMatch).not.toHaveBeenCalled();
```

In the existing successful manual-AI test, use a client whose AI-returned Thing validates directly, then add:

```ts
expect(bggClient.searchFresh).not.toHaveBeenCalled();
expect(bggClient.search).not.toHaveBeenCalled();
expect(ai.findMatch).toHaveBeenCalledOnce();
```

This assertion applies only when the returned AI ID/name validates directly. AI's existing corrective `searchFresh(aiMatchedName)` remains allowed when AI validation itself needs ID correction; that is not the deterministic pre-AI stage.

- [ ] **Step 6: Make only test-proven production corrections**

If Steps 1-5 expose a defect, change only the relevant helper in `itemMatchingService.ts`. Preserve these exact contracts:

```ts
return [...exact, ...remaining].slice(0, MAX_LIVE_BGG_THING_FETCHES);
```

```ts
if (match.accepted) {
  break;
}
```

```ts
const aiMatch = await generateAiBggMatch(candidate, dependencies, traceLogger);
```

Do not broaden scope into `bggClient.ts`, `cachedBggClient.ts`, routes, UI, translation, prompt logic, or database code.

- [ ] **Step 7: Run focused service and cache tests**

Run from `ludora-admin-service/`:

```powershell
npm test -- src/itemMatching/itemMatchingService.test.ts src/bgg/cachedBggClient.test.ts
```

Expected: all tests pass. The existing cached-client test must still prove `searchFresh()` bypasses lookup and records upstream results through `recordSearch`.

- [ ] **Step 8: Run the admin-service build and complete regression gate**

Run:

```powershell
npm run build
npm test
git diff --check
```

Expected: TypeScript build exits `0`; the full admin-service test suite passes without live services; diff check is clean.

- [ ] **Step 9: Review the final diff against the approved spec**

Run:

```powershell
git diff -- ludora-admin-service/src/itemMatching/itemMatchingService.ts ludora-admin-service/src/itemMatching/itemMatchingService.test.ts
git status --short
```

Confirm from the diff that:

- order is cache then live then AI;
- only `searchFresh()` performs deterministic live search;
- threshold is still `0.90`;
- no image, translation, schema, route, UI, discovery, or CodexAPI behavior changed;
- manual AI still enters through `generateAiBggMatch()` directly;
- no unrelated worktree files are staged.

- [ ] **Step 10: Commit the boundary and regression coverage**

```powershell
git add -- ludora-admin-service/src/itemMatching/itemMatchingService.ts ludora-admin-service/src/itemMatching/itemMatchingService.test.ts
git diff --cached --check
git commit -m "test: cover deterministic live BGG fallback"
```

If Task 2 required no production or test changes beyond Task 1 because all coverage was already included and green, do not create an empty commit.

---

## Final Verification and Handoff

After the last non-empty commit, rerun fresh verification from `ludora-admin-service/`:

```powershell
npm test -- src/itemMatching/itemMatchingService.test.ts src/bgg/cachedBggClient.test.ts
npm run build
npm test
```

From the repository root, run:

```powershell
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline origin/main..HEAD
```

Report the exact commit SHAs and test counts. Do not push or deploy unless the user separately requests it.
