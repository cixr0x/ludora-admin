# AI BGG Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CodexAPI-backed BGG resolver that runs only after deterministic local-item and BGG-cache misses, caches validated AI matches, and imports/links the returned BGG item.

**Architecture:** Keep deterministic local and cache matching in `itemMatchingService`, then call a focused AI BGG matching service through the loopback CodexAPI. Validate positive AI decisions through the cached BGG thing client, store a trusted query association in the existing BGG cache tables, and reuse `BggItemImporter` for both already-imported and new catalog items. All generative AI transports use CodexAPI; only embeddings retain direct OpenAI access.

**Tech Stack:** Node.js 20+, TypeScript 6, Express 5, Vitest 4, OpenAI Node SDK as a CodexAPI-compatible transport, PostgreSQL through `pg`, Python 3.10+, and `unittest`.

## Global Constraints

- Matching order is existing Ludora items, BGG cache, then one CodexAPI call.
- The AI request's dynamic product data contains only `itemName` and nullable `imageUrl`.
- Spanish product names and Spanish-edition covers may match English BGG records.
- A missing image permits a reliable name-only match; a clear cover conflict rejects the match.
- A positive AI result must be validated through BGG before cache, import, or link acceptance.
- Positive AI matches are stored in existing cache tables; no-match and failed results are not negatively cached.
- No database schema change or incremental SQL patch is required.
- Do not execute live DDL or DML during implementation or verification without showing the exact SQL and obtaining separate approval.
- All non-embedding AI requests use loopback CodexAPI at `http://127.0.0.1:3001/v1`; direct OpenAI remains embeddings-only.
- Keep CodexAPI loopback-only and do not create an nginx or firewall route for port 3001.
- Use fixed local ports: admin service 4001, admin UI 5173, and CodexAPI 3001.

---

## File Structure

New files:

- `ludora-admin-service/src/ai/codexResponsesClient.ts`: OpenAI-compatible SDK adapter that always targets a validated CodexAPI base URL.
- `ludora-admin-service/src/ai/codexResponsesClient.test.ts`: transport construction tests.
- `ludora-admin-service/src/aiBggMatching/aiBggMatchingPrompts.ts`: fixed matching instructions and two-field user payload.
- `ludora-admin-service/src/aiBggMatching/codexAiBggMatchingClient.ts`: `/v1/responses` request, strict JSON Schema, and output parsing.
- `ludora-admin-service/src/aiBggMatching/aiBggMatchingService.ts`: semantic validation and nullable match result.
- `ludora-admin-service/src/aiBggMatching/aiBggMatchingService.test.ts`: prompt, parsing, Spanish-name, missing-image, and cover-conflict tests.
- `ludora-admin-service/src/bgg/bggMatchCache.ts`: cache-only lookup, ordinary result persistence, and trusted AI-result persistence.
- `ludora-admin-service/src/bgg/bggMatchCache.test.ts`: cache lookup/write tests.

Primary modified files:

- `ludora-admin-service/src/config.ts` and `src/config.test.ts`: CodexAPI-only configuration.
- `ludora-admin-service/src/server.ts`: CodexAPI generative clients and AI BGG matcher wiring.
- Existing `openAi*Client.ts` files: shared CodexAPI transport without an OpenAI key.
- `ludora-admin-service/src/bgg/cachedBggClient.ts` and test: delegate search caching to `BggMatchCache`.
- `ludora-admin-service/src/itemMatching/itemMatchingService.ts` and test: ordered local/cache/AI orchestration.
- `ludora-discovery/src/ludora/ai_item_classification.py`, `config.py`, and `operations.py`: CodexAPI-only classifier while preserving OpenAI embeddings.
- Current AI and deployment documentation listed in Task 6.

---

### Task 1: Enforce the CodexAPI transport for admin generative AI

**Files:**
- Create: `ludora-admin-service/src/ai/codexResponsesClient.ts`
- Create: `ludora-admin-service/src/ai/codexResponsesClient.test.ts`
- Modify: `ludora-admin-service/src/config.ts:12-74`
- Modify: `ludora-admin-service/src/config.test.ts:175-195`
- Modify: `ludora-admin-service/src/server.ts:59-94`
- Modify: `ludora-admin-service/src/amazonTitleExtraction/openAiAmazonTitleExtractionClient.ts`
- Modify: `ludora-admin-service/src/descriptionGeneration/openAiDescriptionGenerationClient.ts`
- Modify: `ludora-admin-service/src/productDetailsExtraction/openAiProductDetailsExtractionClient.ts`
- Modify: `ludora-admin-service/src/storeProfileDetection/openAiStoreProfileDetectionClient.ts`
- Modify: `ludora-admin-service/src/translation/openAiTranslationClient.ts`
- Modify: corresponding `*.test.ts` client tests
- Delete: `ludora-admin-service/src/ai/openAiResponsesClient.ts`

**Interfaces:**
- Produces: `CodexResponsesClientOptions = { baseURL: string }`.
- Produces: `createCodexResponsesClient(options): OpenAiResponsesClient`.
- Produces: `Config.codexApiBaseUrl: string` and `Config.codexAiModel: string`.
- Consumed by: every admin generative client, including Task 2.

- [ ] **Step 1: Write failing configuration tests**

```ts
it('defaults generative AI to the loopback CodexAPI', () => {
  vi.stubEnv('CODEX_API_BASE_URL', undefined);
  vi.stubEnv('OPENAI_BASE_URL', undefined);
  vi.stubEnv('CODEX_AI_MODEL', undefined);
  vi.stubEnv('OPENAI_TRANSLATION_MODEL', undefined);
  expect(loadConfig()).toMatchObject({
    codexApiBaseUrl: 'http://127.0.0.1:3001/v1',
    codexAiModel: 'gpt-5.6-terra'
  });
});

it('accepts the legacy base URL only when it is loopback', () => {
  vi.stubEnv('OPENAI_BASE_URL', 'http://localhost:3001/v1');
  expect(loadConfig().codexApiBaseUrl).toBe('http://localhost:3001/v1');
});

it('rejects a non-loopback generative AI endpoint', () => {
  vi.stubEnv('CODEX_API_BASE_URL', 'https://api.openai.com/v1');
  expect(() => loadConfig()).toThrow('CODEX_API_BASE_URL must target loopback CodexAPI');
});
```

- [ ] **Step 2: Run the configuration tests and verify failure**

Run: `npm test -- src/config.test.ts`

Expected: FAIL because the Codex configuration fields and remote-host rejection do not exist.

- [ ] **Step 3: Implement loopback-only configuration**

```ts
const DEFAULT_CODEX_API_BASE_URL = 'http://127.0.0.1:3001/v1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function readCodexApiBaseUrl(): string {
  const value = readOptionalEnv('CODEX_API_BASE_URL')
    ?? readOptionalEnv('OPENAI_BASE_URL')
    ?? DEFAULT_CODEX_API_BASE_URL;
  const parsed = new URL(value);
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('CODEX_API_BASE_URL must target loopback CodexAPI');
  }
  return value.replace(/\/$/, '');
}
```

Add `codexApiBaseUrl` and `codexAiModel` to `Config`. Resolve the model from `CODEX_AI_MODEL`, then legacy `OPENAI_TRANSLATION_MODEL`, then `gpt-5.6-terra`. Remove `openAiApiKey`, `openAiBaseUrl`, and `openAiTranslationModel` from admin configuration.

- [ ] **Step 4: Write the failing Codex transport test**

```ts
it('constructs the SDK as a CodexAPI compatibility client', () => {
  createCodexResponsesClient({ baseURL: 'http://127.0.0.1:3001/v1' });
  expect(OpenAI).toHaveBeenCalledWith({
    apiKey: 'codexapi-local',
    baseURL: 'http://127.0.0.1:3001/v1'
  });
});
```

- [ ] **Step 5: Run the transport test and verify failure**

Run: `npm test -- src/ai/codexResponsesClient.test.ts`

Expected: FAIL because the Codex transport file does not exist.

- [ ] **Step 6: Implement the transport and migrate existing clients**

```ts
import OpenAI from 'openai';

export type CodexResponsesClientOptions = { baseURL: string };
export type OpenAiResponsesClient = { create: OpenAI['responses']['create'] };

export function createCodexResponsesClient(options: CodexResponsesClientOptions): OpenAiResponsesClient {
  return new OpenAI({ apiKey: 'codexapi-local', baseURL: options.baseURL }).responses;
}
```

Change every existing generative client constructor from `(apiKey, options)` to `(options: CodexResponsesClientOptions)`, call `createCodexResponsesClient(options)`, update tests to pass `{ baseURL }`, and delete the old shared helper after all imports move.

- [ ] **Step 7: Wire existing admin AI services without an OpenAI-key gate**

```ts
const codexOptions = { baseURL: config.codexApiBaseUrl };
const translationClient = createOpenAiTranslationClient(codexOptions);
const translationService = createTranslationService(database, translationClient, { model: config.codexAiModel });
const descriptionGenerationClient = createOpenAiDescriptionGenerationClient(codexOptions);
const productDetailsExtractionClient = createOpenAiProductDetailsExtractionClient(codexOptions);
const amazonTitleExtractionClient = createOpenAiAmazonTitleExtractionClient(codexOptions);
const storeProfileAiClient = createOpenAiStoreProfileDetectionClient(codexOptions);
```

Use `config.codexAiModel` for all five existing services. Preserve `createApp` dependency injection so route tests can still pass an absent service explicitly.

- [ ] **Step 8: Run focused tests and build**

```powershell
npm test -- src/config.test.ts src/ai/codexResponsesClient.test.ts src/translation/openAiTranslationClient.test.ts src/descriptionGeneration/openAiDescriptionGenerationClient.test.ts src/productDetailsExtraction/openAiProductDetailsExtractionClient.test.ts src/amazonTitleExtraction/openAiAmazonTitleExtractionClient.test.ts
npm run build
```

Expected: selected tests PASS and compilation exits 0.

- [ ] **Step 9: Commit**

```powershell
git add -- ludora-admin-service/src/ai ludora-admin-service/src/config.ts ludora-admin-service/src/config.test.ts ludora-admin-service/src/server.ts ludora-admin-service/src/amazonTitleExtraction ludora-admin-service/src/descriptionGeneration ludora-admin-service/src/productDetailsExtraction ludora-admin-service/src/storeProfileDetection ludora-admin-service/src/translation
git commit -m "refactor: route admin AI through CodexAPI"
```

---

### Task 2: Add the AI BGG matching prompt, client, and service

**Files:**
- Create: `ludora-admin-service/src/aiBggMatching/aiBggMatchingPrompts.ts`
- Create: `ludora-admin-service/src/aiBggMatching/codexAiBggMatchingClient.ts`
- Create: `ludora-admin-service/src/aiBggMatching/aiBggMatchingService.ts`
- Create: `ludora-admin-service/src/aiBggMatching/aiBggMatchingService.test.ts`

**Interfaces:**
- Consumes: `createCodexResponsesClient` from Task 1.
- Produces: `AiBggMatchRequest = { itemName: string; imageUrl: string | null }`.
- Produces: wire-level `AiBggMatchDecision`, accepted `AiBggMatchFound`, and `AiBggMatchingService.findMatch(request)`.
- Produces: `createCodexAiBggMatchingClient(options)` and `createAiBggMatchingService(client, options)` factories.
- Consumed by: Task 4.

- [ ] **Step 1: Write failing prompt-contract tests**

```ts
it('sends only itemName and imageUrl as dynamic product data', () => {
  const payload = JSON.parse(userPromptForAiBggMatch({
    itemName: 'La Guerra del Anillo',
    imageUrl: 'https://store.mx/guerra-del-anillo.jpg'
  }));
  expect(payload).toEqual({
    itemName: 'La Guerra del Anillo',
    imageUrl: 'https://store.mx/guerra-del-anillo.jpg'
  });
  expect(Object.keys(payload)).toEqual(['itemName', 'imageUrl']);
});

it('places Spanish and cover behavior in the fixed prompt', () => {
  const prompt = systemPromptForAiBggMatch();
  expect(prompt).toContain('Spanish');
  expect(prompt).toContain('store item cover');
  expect(prompt).toContain('BGG cover');
  expect(prompt).toContain('conflict');
});
```

- [ ] **Step 2: Write failing semantic-result tests**

```ts
it('accepts a Spanish name match when the image is unavailable', async () => {
  const decision = decisionFixture({
    matchFound: true,
    bggId: 115746,
    nameAssessment: 'MATCH',
    coverAssessment: 'UNAVAILABLE'
  });
  const service = createAiBggMatchingService({ findMatch: async () => decision }, { model: 'gpt-5.6-terra' });
  await expect(service.findMatch({ itemName: 'La Guerra del Anillo', imageUrl: null })).resolves.toEqual(decision);
});

it('rejects a positive decision with a conflicting cover', async () => {
  const service = createAiBggMatchingService({
    findMatch: async () => decisionFixture({ matchFound: true, coverAssessment: 'CONFLICT' })
  }, { model: 'gpt-5.6-terra' });
  await expect(service.findMatch({ itemName: 'Catan', imageUrl: 'https://store.mx/catan.jpg' }))
    .rejects.toThrow('AI BGG match cannot accept a cover conflict');
});
```

- [ ] **Step 3: Run tests and verify failure**

Run: `npm test -- src/aiBggMatching/aiBggMatchingService.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement stable request/decision interfaces**

```ts
export type AiBggMatchRequest = { itemName: string; imageUrl: string | null };

export type AiBggMatchDecision = {
  matchFound: boolean;
  bggId: number | null;
  matchedName: string | null;
  bggUrl: string | null;
  bggImageUrl: string | null;
  nameAssessment: 'MATCH' | 'NO_MATCH';
  coverAssessment: 'MATCH' | 'CONFLICT' | 'UNAVAILABLE';
  confidence: number;
  reasoning: string;
};

export type AiBggMatchFound = AiBggMatchDecision & {
  matchFound: true;
  bggId: number;
  matchedName: string;
  bggUrl: string;
};

export type AiBggMatchingClient = {
  findMatch(request: AiBggMatchRequest, context: { model: string }): Promise<AiBggMatchDecision>;
};

export type AiBggMatchingService = {
  findMatch(request: AiBggMatchRequest): Promise<AiBggMatchFound | null>;
};

export function createAiBggMatchingService(
  client: AiBggMatchingClient,
  options: { model: string }
): AiBggMatchingService;
```

Normalize strings, convert valid `matchFound: false` to `null`, require a positive integer ID and BGG URL for positive decisions, reject `CONFLICT`, and reject confidence outside `0..1`.

- [ ] **Step 5: Implement prompts with exactly two dynamic fields**

```ts
export function userPromptForAiBggMatch(request: AiBggMatchRequest): string {
  return JSON.stringify({ itemName: request.itemName, imageUrl: request.imageUrl });
}
```

The system prompt requires BGG search, Spanish-to-English name handling, store-cover-to-BGG-cover comparison, missing-image name-only acceptance, cover-conflict rejection, edition/expansion disambiguation, no guessing, and treating both values as data rather than instructions.

- [ ] **Step 6: Implement the strict CodexAPI client**

Use `responses.create` with system/user messages and this JSON Schema:

```ts
const aiBggMatchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    matchFound: { type: 'boolean' },
    bggId: { type: ['integer', 'null'] },
    matchedName: { type: ['string', 'null'] },
    bggUrl: { type: ['string', 'null'] },
    bggImageUrl: { type: ['string', 'null'] },
    nameAssessment: { type: 'string', enum: ['MATCH', 'NO_MATCH'] },
    coverAssessment: { type: 'string', enum: ['MATCH', 'CONFLICT', 'UNAVAILABLE'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasoning: { type: 'string' }
  },
  required: ['matchFound', 'bggId', 'matchedName', 'bggUrl', 'bggImageUrl', 'nameAssessment', 'coverAssessment', 'confidence', 'reasoning']
} as const;
```

Parse `response.output_text`; malformed JSON propagates as a processing error.

Export the transport factory with this exact signature:

```ts
export function createCodexAiBggMatchingClient(
  options: CodexResponsesClientOptions
): AiBggMatchingClient;
```

- [ ] **Step 7: Run tests and build**

```powershell
npm test -- src/aiBggMatching/aiBggMatchingService.test.ts
npm run build
```

Expected: tests PASS and compilation exits 0.

- [ ] **Step 8: Commit**

```powershell
git add -- ludora-admin-service/src/aiBggMatching
git commit -m "feat: add CodexAPI BGG resolver"
```

---

### Task 3: Centralize cache-only lookup and trusted AI-result persistence

**Files:**
- Create: `ludora-admin-service/src/bgg/bggMatchCache.ts`
- Create: `ludora-admin-service/src/bgg/bggMatchCache.test.ts`
- Modify: `ludora-admin-service/src/bgg/cachedBggClient.ts:1-188`
- Modify: `ludora-admin-service/src/bgg/cachedBggClient.test.ts`

**Interfaces:**
- Produces: `BggCachedMatch = { item: BggSearchItem; verifiedByAi: boolean }`.
- Produces: `lookup`, `recordSearch`, and `recordAiMatch` methods on `BggMatchCache`.
- Consumed by: `cachedBggClient` and Task 4.

- [ ] **Step 1: Write failing cache lookup tests**

```ts
it('marks AI query associations as verified', async () => {
  const cache = createBggMatchCache(databaseForAiQueryRow({
    bgg_id: 115746,
    name: 'War of the Ring: Second Edition',
    item_type: 'boardgame',
    year_published: 2011
  }));
  await expect(cache.lookup('La Guerra del Anillo')).resolves.toEqual({
    cacheHit: true,
    matches: [{
      item: { bggId: 115746, name: 'War of the Ring: Second Edition', type: 'boardgame', yearPublished: 2011 },
      verifiedByAi: true
    }]
  });
});

it('returns a complete miss without an upstream dependency', async () => {
  const cache = createBggMatchCache(databaseWithEmptyRows());
  await expect(cache.lookup('Juego desconocido')).resolves.toEqual({ cacheHit: false, matches: [] });
});
```

Add corresponding ordinary query, direct `bgg_search_cache`, and `bgg_thing_cache` cases with `verifiedByAi: false`.

- [ ] **Step 2: Write failing AI cache-write tests**

```ts
await cache.recordAiMatch(
  ['La Guerra del Anillo', 'War of the Ring: Second Edition'],
  { bggId: 115746, name: 'War of the Ring: Second Edition', type: 'boardgame', yearPublished: 2011 }
);
expect(executedSql).toContainEqual(expect.stringContaining('insert into bgg_search_cache'));
expect(executedParams).toContainEqual(expect.arrayContaining(['ai_match:boardgame,boardgameexpansion']));
```

Assert both query strings are written once and linked at rank zero.

- [ ] **Step 3: Run tests and verify failure**

Run: `npm test -- src/bgg/bggMatchCache.test.ts`

Expected: FAIL because the component does not exist.

- [ ] **Step 4: Implement cache lookup with an AI-specific search type**

```ts
export const BGG_SEARCH_TYPE = 'boardgame,boardgameexpansion';
export const BGG_AI_MATCH_SEARCH_TYPE = `ai_match:${BGG_SEARCH_TYPE}`;

export type BggCachedMatch = { item: BggSearchItem; verifiedByAi: boolean };
export type BggMatchCache = {
  lookup(query: string): Promise<{ cacheHit: boolean; matches: BggCachedMatch[] }>;
  recordSearch(query: string, results: BggSearchItem[]): Promise<void>;
  recordAiMatch(queries: string[], result: BggSearchItem): Promise<void>;
};
```

Look up the AI search type first, then ordinary query associations, direct BGG names, and thing-cache names. Deduplicate by BGG ID while preserving `verifiedByAi: true`. Never accept an upstream BGG client dependency.

- [ ] **Step 5: Move ordinary search persistence from `cachedBggClient`**

Implement `recordSearch(query, results)` with the existing standard search type and existing replace/rank behavior. This is a mechanical extraction of the current `writeSearchCache` SQL.

- [ ] **Step 6: Implement exact runtime DML for trusted AI matches**

Tests use a fake database; do not execute these statements against a live database in this task.

```sql
insert into bgg_search_cache (bgg_id, name, item_type, year_published, result_json, updated_at)
values ($1, $2, $3, $4, $5::jsonb, now())
on conflict (bgg_id) do update set
  name = excluded.name,
  item_type = excluded.item_type,
  year_published = excluded.year_published,
  result_json = excluded.result_json,
  updated_at = now()
returning id;
```

```sql
insert into bgg_search_queries (query, normalized_query, search_type, result_count, fetched_at, updated_at)
values ($1, $2, $3, 1, now(), now())
on conflict (normalized_query, search_type) do update set
  query = excluded.query,
  result_count = 1,
  fetched_at = excluded.fetched_at,
  updated_at = now()
returning id;
```

```sql
delete from bgg_search_query_results where query_id = $1;
```

```sql
insert into bgg_search_query_results (query_id, cache_id, result_rank)
values ($1, $2, 0)
on conflict (query_id, cache_id) do update set result_rank = 0;
```

Use `BGG_AI_MATCH_SEARCH_TYPE` as the third query parameter. The distinct search type marks only AI-confirmed associations as trusted without a schema change.

- [ ] **Step 7: Refactor `cachedBggClient` to use `BggMatchCache`**

```ts
export function createCachedBggClient(
  database: Database,
  upstreamClient: BggThingXmlClient,
  matchCache: BggMatchCache = createBggMatchCache(database)
): BggClient
```

For `search`, return cached items when `cacheHit`; otherwise call upstream and `recordSearch`. For `searchFresh`, always call upstream and `recordSearch`. Keep thing-cache fetch/write behavior in `cachedBggClient.ts`.

- [ ] **Step 8: Run tests and build**

```powershell
npm test -- src/bgg/bggMatchCache.test.ts src/bgg/cachedBggClient.test.ts
npm run build
```

Expected: tests PASS and compilation exits 0.

- [ ] **Step 9: Commit**

```powershell
git add -- ludora-admin-service/src/bgg/bggMatchCache.ts ludora-admin-service/src/bgg/bggMatchCache.test.ts ludora-admin-service/src/bgg/cachedBggClient.ts ludora-admin-service/src/bgg/cachedBggClient.test.ts
git commit -m "refactor: centralize BGG match caching"
```

---

### Task 4: Replace live deterministic BGG matching with cache-then-AI orchestration

**Files:**
- Modify: `ludora-admin-service/src/itemMatching/itemMatchingService.ts:1-1010`
- Modify: `ludora-admin-service/src/itemMatching/itemMatchingService.test.ts`
- Modify: `ludora-admin-service/src/server.ts:8-96`

**Interfaces:**
- Consumes: `AiBggMatchingService` from Task 2.
- Consumes: `BggMatchCache` and `BggCachedMatch` from Task 3.
- Consumes: existing `BggClient.fetchThing` and `BggItemImporter.importBggId`.
- Produces: `createItemMatchingService(database, dependencies)`.
- Preserves: `confirmBoardgameAndMatch`, `generateMatchCandidates`, and `listMatchCandidates`.

- [ ] **Step 1: Write failing ordered-fallback tests**

```ts
it('does not call AI when a local item is accepted', async () => {
  const ai = { findMatch: vi.fn() };
  const service = createItemMatchingService(databaseWithExactLocalItem(), {
    aiBggMatchingService: ai,
    bggClient,
    bggItemImporter,
    bggMatchCache
  });
  await service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });
  expect(ai.findMatch).not.toHaveBeenCalled();
});

it('uses a trusted Spanish cache association without AI', async () => {
  bggMatchCache.lookup = vi.fn().mockResolvedValue({
    cacheHit: true,
    matches: [{ item: bggSearchItem(115746, 'War of the Ring: Second Edition'), verifiedByAi: true }]
  });
  await service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });
  expect(ai.findMatch).not.toHaveBeenCalled();
  expect(bggItemImporter.importBggId).toHaveBeenCalledWith(115746);
});
```

- [ ] **Step 2: Write failing AI success and no-match tests**

For success, assert exact dynamic input, BGG validation, both cache queries, import, and link:

```ts
expect(ai.findMatch).toHaveBeenCalledWith({
  itemName: 'La Guerra del Anillo',
  imageUrl: 'https://store.mx/guerra-del-anillo.jpg'
});
expect(bggClient.fetchThing).toHaveBeenCalledWith(115746);
expect(bggMatchCache.recordAiMatch).toHaveBeenCalledWith(
  ['La Guerra del Anillo', 'War of the Ring: Second Edition'],
  { bggId: 115746, name: 'War of the Ring: Second Edition', type: 'boardgame', yearPublished: 2011 }
);
expect(bggItemImporter.importBggId).toHaveBeenCalledWith(115746);
```

For no-match, return `null` from AI and assert no `fetchThing`, cache write, import, or link occurs; the store item receives the current normal no-match state.

- [ ] **Step 3: Write failing error and staging tests**

Add these exact cases:

```ts
it('records a processing error when the returned BGG ID does not resolve');
it('records a processing error when CodexAPI fails');
it('does not cache or import a failed AI decision');
it('stages an AI candidate without auto-linking from generateMatchCandidates');
it('uses a name-only AI result when candidate image_url is empty');
it('logs AI start, result, validation, cache, import, and link events');
```

For staging, assert `item_match_candidates` gets `source = 'BGG'`, AI confidence as `match_score`, and AI evidence in `raw_payload`, while no store-item link update runs.

- [ ] **Step 4: Run matching tests and verify failure**

Run: `npm test -- src/itemMatching/itemMatchingService.test.ts`

Expected: FAIL because the constructor has no AI/cache dependencies and the candidate query does not load `image_url`.

- [ ] **Step 5: Introduce explicit item-matching dependencies**

```ts
export type ItemMatchingDependencies = {
  aiBggMatchingService?: AiBggMatchingService;
  bggClient?: BggClient;
  bggItemImporter?: BggItemImporter;
  bggMatchCache: BggMatchCache;
};

export function createItemMatchingService(
  database: Database,
  dependencies: ItemMatchingDependencies
): ItemMatchingService
```

Add `image_url?: string | null` to `DiscoveryItemCandidateRow` and select it from `store_items`. Remove `TranslationService` from matching and delete the translated-query helper.

- [ ] **Step 6: Implement deterministic cache resolution without network fallback**

Call `bggMatchCache.lookup(candidate.title)`. Convert each cached result into:

```ts
const score = scoreBggThing(discoveryCandidateForMatch(candidate), bggThingFromSearchItem(cached.item));
return {
  accepted: cached.verifiedByAi || score.matchScore >= AUTO_MATCH_SCORE_THRESHOLD,
  bggId: cached.item.bggId,
  itemId: null,
  matchReasons: cached.verifiedByAi
    ? ['AI-verified BGG cache association', ...score.matchReasons]
    : score.matchReasons,
  matchScore: cached.verifiedByAi ? Math.max(score.matchScore, AUTO_MATCH_SCORE_THRESHOLD) : score.matchScore,
  matchedName: cached.item.name,
  rawPayload: { search_result: cached.item, source: cached.verifiedByAi ? 'ai_match_cache' : 'bgg_cache' },
  source: 'BGG'
};
```

Use `accepted` when selecting an automatic match. Remove `cachedBggSearch`, live `bggClient.search/searchFresh` resolution, and translated BGG queries from `itemMatchingService.ts`.

- [ ] **Step 7: Implement the AI fallback**

```ts
const decision = await aiBggMatchingService?.findMatch({
  itemName: candidate.title,
  imageUrl: nonEmptyStringOrNull(candidate.image_url)
});
if (!decision) return null;

const thing = await bggClient?.fetchThing(decision.bggId);
if (!thing || thing.details.bggId !== decision.bggId) {
  throw new Error(`AI BGG match could not validate BGG ID ${decision.bggId}`);
}

const searchItem = {
  bggId: thing.details.bggId,
  name: thing.details.name,
  type: thing.details.type,
  yearPublished: thing.details.yearPublished
};
await bggMatchCache.recordAiMatch([candidate.title, thing.details.name], searchItem);
```

Return an accepted generated match with `source: 'BGG'`, `matchScore: decision.confidence`, and `rawPayload: { ai_match: decision, thing: thing.details }`. Positive `matchFound` is authoritative after semantic and BGG validation; do not reapply the deterministic `0.9` threshold.

When staging candidates, change the existing filter to retain accepted results even when their informational confidence is below the deterministic review threshold:

```ts
.filter((match) => match.accepted || match.matchScore >= 0.3)
```

- [ ] **Step 8: Preserve automatic versus staging behavior**

`confirmBoardgameAndMatch` imports and links an accepted AI result. `generateMatchCandidates` stores the result in `item_match_candidates` but does not import or link. Both paths validate and cache a positive result. Keep current no-match/error semantics for automated and admin-confirmed items.

Add these trace event names through the existing logger so tests and production traces share a stable vocabulary:

```text
item_matcher.ai_match.start
item_matcher.ai_match.completed
item_matcher.ai_match.no_match
item_matcher.ai_match.failed
item_matcher.ai_match.validation.completed
item_matcher.ai_match.cache.completed
```

- [ ] **Step 9: Wire cache and AI dependencies in `server.ts`**

```ts
const bggMatchCache = createBggMatchCache(database);
const bggClient = rawBggClient ? createCachedBggClient(database, rawBggClient, bggMatchCache) : undefined;
const aiBggMatchingClient = createCodexAiBggMatchingClient({ baseURL: config.codexApiBaseUrl });
const aiBggMatchingService = createAiBggMatchingService(aiBggMatchingClient, { model: config.codexAiModel });
const bggItemImporter = bggClient ? createBggItemImporter(database, bggClient) : undefined;
const itemMatchingService = createItemMatchingService(database, {
  aiBggMatchingService,
  bggClient,
  bggItemImporter,
  bggMatchCache
});
```

If `BGG_API_TOKEN` is absent, retain processing-error behavior rather than accept an unvalidated AI ID.

- [ ] **Step 10: Run matching, route, and build verification**

```powershell
npm test -- src/itemMatching/itemMatcher.test.ts src/itemMatching/itemMatchingService.test.ts src/bgg/bggItemImporter.test.ts src/app.test.ts
npm run build
```

Expected: selected tests PASS and compilation exits 0.

- [ ] **Step 11: Commit**

```powershell
git add -- ludora-admin-service/src/itemMatching ludora-admin-service/src/server.ts ludora-admin-service/src/app.test.ts
git commit -m "feat: resolve BGG misses with AI"
```

---

### Task 5: Route the Python classifier through CodexAPI without the embedding key

**Files:**
- Modify: `ludora-discovery/src/ludora/ai_item_classification.py:11-77`
- Modify: `ludora-discovery/src/ludora/config.py:63-128`
- Modify: `ludora-discovery/src/ludora/operations.py:15-28,668-680,806-825`
- Modify: `ludora-discovery/tests/test_ai_item_classification.py`
- Modify: `ludora-discovery/tests/test_config.py:155-205`
- Modify: `ludora-discovery/tests/test_operations.py`

**Interfaces:**
- Produces: `CodexApiItemClassifier(model, base_url=DEFAULT_CODEX_API_BASE_URL)`.
- Produces: `resolve_codex_api_base_url(...) -> str`.
- Preserves: `resolve_openai_api_key(...)` exclusively for `run_item_embeddings`.

- [ ] **Step 1: Write failing classifier/configuration tests**

```python
def test_codex_api_base_url_defaults_to_loopback(self):
    self.assertEqual(
        resolve_codex_api_base_url(env={}, dotenv_path=Path('missing.env')),
        'http://127.0.0.1:3001/v1',
    )

def test_codex_api_base_url_rejects_official_openai(self):
    with self.assertRaisesRegex(ValueError, 'must target loopback CodexAPI'):
        resolve_codex_api_base_url(env={'CODEX_API_BASE_URL': 'https://api.openai.com/v1'})

def test_classifier_uses_local_compatibility_authorization(self):
    classifier = CodexApiItemClassifier(model='gpt-5.6-terra')
    request = classifier._build_request(sample_record())
    self.assertEqual(request.headers['Authorization'], 'Bearer codexapi-local')
```

- [ ] **Step 2: Write failing operation-boundary tests**

Assert `_resolve_item_classifier` does not call `resolve_openai_api_key`:

```python
resolve_openai_api_key.assert_not_called()
CodexApiItemClassifier.assert_called_once_with(
    model='classifier-model',
    base_url='http://127.0.0.1:3001/v1',
)
```

Keep existing embedding assertions: missing `OPENAI_API_KEY` raises `Missing OpenAI API key`, and `OpenAIEmbeddingClient` receives the resolved key.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `python -m unittest tests.test_config tests.test_ai_item_classification tests.test_operations -v`

Expected: FAIL because the Codex-named classifier and resolver do not exist.

- [ ] **Step 4: Implement CodexAPI-only classifier configuration**

```python
DEFAULT_CODEX_API_BASE_URL = 'http://127.0.0.1:3001/v1'
LOOPBACK_HOSTS = {'127.0.0.1', 'localhost', '::1'}

def resolve_codex_api_base_url(env=None, dotenv_path='.env') -> str:
    current_env = env if env is not None else os.environ
    dotenv = load_dotenv_values(dotenv_path)
    value = (
        current_env.get('CODEX_API_BASE_URL', '').strip()
        or dotenv.get('CODEX_API_BASE_URL', '').strip()
        or current_env.get('OPENAI_BASE_URL', '').strip()
        or dotenv.get('OPENAI_BASE_URL', '').strip()
        or DEFAULT_CODEX_API_BASE_URL
    )
    if urlparse(value).hostname not in LOOPBACK_HOSTS:
        raise ValueError('CODEX_API_BASE_URL must target loopback CodexAPI')
    return value.rstrip('/')
```

Read `CODEX_CLASSIFIER_MODEL` before legacy `OPENAI_CLASSIFIER_MODEL`; retain `gpt-5.4-mini` as the default.

- [ ] **Step 5: Rename and simplify the classifier transport**

```python
class CodexApiItemClassifier:
    def __init__(self, *, model: str, base_url: str = DEFAULT_CODEX_API_BASE_URL, timeout_seconds: float = 60):
        self.model = model
        self.base_url = base_url.rstrip('/')
        self.timeout_seconds = timeout_seconds

    def _build_request(self, record: DiscoveryItemCandidateRecord) -> Request:
        return Request(
            f'{self.base_url}/responses',
            data=json.dumps(_request_payload(self.model, record)).encode('utf-8'),
            headers={'Authorization': 'Bearer codexapi-local', 'Content-Type': 'application/json'},
            method='POST',
        )
```

Remove `api_key` from the constructor and call `_build_request` from `_request_classification`.

- [ ] **Step 6: Update operation wiring and preserve embeddings**

Construct `CodexApiItemClassifier` with model and base URL only. Do not resolve an OpenAI key in `_resolve_item_classifier`. Leave `run_item_embeddings` unchanged.

- [ ] **Step 7: Run focused and full discovery tests**

```powershell
python -m unittest tests.test_config tests.test_ai_item_classification tests.test_operations -v
python -m unittest discover -s tests -v
```

Expected: focused and full suites PASS.

- [ ] **Step 8: Commit**

```powershell
git add -- ludora-discovery/src/ludora/ai_item_classification.py ludora-discovery/src/ludora/config.py ludora-discovery/src/ludora/operations.py ludora-discovery/tests/test_ai_item_classification.py ludora-discovery/tests/test_config.py ludora-discovery/tests/test_operations.py
git commit -m "refactor: route classification through CodexAPI"
```

---

### Task 6: Document the AI policy and run repository verification

**Files:**
- Modify: `AGENTS.md:47-50`
- Modify: `docs/ai-api-flow.md:1-39`
- Modify: `README.md:52-62`
- Modify: `ludora-discovery/README.md:101-124`
- Modify: `docs/production-deployment.md:100-118`

**Interfaces:**
- Documents: `CODEX_API_BASE_URL`, `CODEX_AI_MODEL`, and `CODEX_CLASSIFIER_MODEL`.
- Documents: `OPENAI_API_KEY` and `OPENAI_EMBEDDING_MODEL` as embeddings-only.
- Preserves: fixed ports and exact-SHA deployment instructions.

- [ ] **Step 1: Update `AGENTS.md` with the provider rule**

Use this policy text:

```markdown
All non-embedding AI requests must use the private CodexAPI service at
`http://127.0.0.1:3001/v1`. Do not add a direct OpenAI Responses or Chat
Completions fallback. The OpenAI-compatible SDK is transport-only. Direct
OpenAI access is allowed only for embeddings because CodexAPI does not expose
an embeddings endpoint.
```

Retain the admin-service ownership rule for new discovery AI tasks and identify classification as an existing intentional direct CodexAPI caller.

- [ ] **Step 2: Update current operational documentation**

Document this configuration:

```text
CODEX_API_BASE_URL=http://127.0.0.1:3001/v1
CODEX_AI_MODEL=gpt-5.6-terra
CODEX_CLASSIFIER_MODEL=gpt-5.4-mini
OPENAI_API_KEY=<embeddings only>
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

Remove statements that an absent base URL selects official OpenAI. Explain legacy loopback `OPENAI_BASE_URL` and `OPENAI_TRANSLATION_MODEL` as compatibility aliases only. Require CodexAPI health in production verification without changing exact-SHA deployment steps.

- [ ] **Step 3: Verify no official generative fallback remains**

```powershell
rg -n "leave it unset|official OpenAI API|OpenAI-backed|OPENAI_BASE_URL" AGENTS.md README.md docs/ai-api-flow.md docs/production-deployment.md ludora-discovery/README.md
```

Expected: direct OpenAI statements are embeddings-only; legacy base URL mentions are loopback compatibility only.

- [ ] **Step 4: Run complete admin-service verification**

From `ludora-admin-service`:

```powershell
npm test
npm run build
```

Expected: full Vitest suite PASS and compilation exits 0.

- [ ] **Step 5: Run complete discovery verification**

From `ludora-discovery`:

```powershell
python -m unittest discover -s tests -v
```

Expected: full discovery suite PASS using test doubles or test-local resources, not a shared/live database.

- [ ] **Step 6: Review final diff and confirm no schema patch exists**

```powershell
git diff --check
git status --short
git diff -- database/schema.sql database/patches
```

Expected: diff check exits 0, only task files changed, and no schema/patch diff exists.

- [ ] **Step 7: Commit documentation**

```powershell
git add -- AGENTS.md README.md docs/ai-api-flow.md docs/production-deployment.md ludora-discovery/README.md
git commit -m "docs: require CodexAPI for generative AI"
```

- [ ] **Step 8: Push and verify the exact SHA**

```powershell
$expectedSha = git rev-parse HEAD
git push origin HEAD
git fetch origin
git rev-parse HEAD
git rev-parse '@{upstream}'
```

Expected: local `HEAD` and upstream both equal `$expectedSha`.

Do not run a live matching request, deploy, or execute database writes unless the user separately approves the exact target and write effects.
