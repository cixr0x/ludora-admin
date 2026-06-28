# Product Details Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable AI product details extraction for no-BGG manual item creation and existing linked products.

**Architecture:** Add a focused `productDetailsExtraction` module in the admin service with prompt, service, enrichment, and OpenAI client files. Inject the enrichment service into `createApp` and `createDiscoveryRouter`; manual create uses it to fill missing values before inserting `items`, and an explicit admin endpoint reruns it for existing linked candidates. Reuse the existing `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and model configuration shared by current AI calls.

**Tech Stack:** TypeScript, Express, Vitest, OpenAI Responses API, PostgreSQL through the existing `Database` interface.

---

## Dirty Worktree Note

`ludora-admin-service/src/app.test.ts` and `ludora-admin-service/src/routes/discovery.ts` already contain unrelated uncommitted edits. Do not revert them and do not commit implementation changes from those files in this run. Verify with targeted tests, build, and `git diff` instead.

### Task 1: Extraction Client and Pure Service

**Files:**
- Create: `ludora-admin-service/src/productDetailsExtraction/productDetailsExtractionService.ts`
- Create: `ludora-admin-service/src/productDetailsExtraction/productDetailsExtractionPrompts.ts`
- Create: `ludora-admin-service/src/productDetailsExtraction/openAiProductDetailsExtractionClient.ts`
- Test: `ludora-admin-service/src/productDetailsExtraction/productDetailsExtractionService.test.ts`
- Test: `ludora-admin-service/src/productDetailsExtraction/openAiProductDetailsExtractionClient.test.ts`

- [ ] **Step 1: Write failing service tests**

Add tests proving existing non-null values win, missing values are filled, invalid values are discarded, and extraction is skipped when all target fields already exist.

Run: `npm test -- productDetailsExtractionService.test.ts`

Expected before implementation: FAIL because the module does not exist.

- [ ] **Step 2: Implement minimal service**

Define `ProductDetails`, `ProductDetailsExtractionRequest`, `ProductDetailsExtractionService`, `ProductDetailsExtractionClient`, `createProductDetailsExtractionService`, `mergeProductDetails`, `hasMissingProductDetails`, and `normalizeProductDetails`.

The service should call the client only when at least one target field is missing and usable evidence exists. It should return `extractedDetails`, `details`, `metadata`, `model`, `promptVersion`, and `skipped`.

- [ ] **Step 3: Run service tests**

Run: `npm test -- productDetailsExtractionService.test.ts`

Expected after implementation: PASS.

- [ ] **Step 4: Write failing OpenAI client tests**

Add parser tests for scalar numeric values, blank/invalid values, metadata arrays, and configured `baseURL`.

Run: `npm test -- openAiProductDetailsExtractionClient.test.ts`

Expected before implementation: FAIL until the OpenAI client exports the parser and factory.

- [ ] **Step 5: Implement prompts and OpenAI client**

Use the same OpenAI SDK pattern as translation and description generation. Send structured JSON with nullable `minPlayers`, `maxPlayers`, `minMinutes`, `maxMinutes`, `minAge`, and metadata containing `confidence`, `evidence`, and `warnings`.

- [ ] **Step 6: Run client tests**

Run: `npm test -- openAiProductDetailsExtractionClient.test.ts`

Expected after implementation: PASS.

### Task 2: Enrichment Service

**Files:**
- Create/modify: `ludora-admin-service/src/productDetailsExtraction/productDetailsExtractionService.ts`
- Test: `ludora-admin-service/src/productDetailsExtraction/productDetailsExtractionService.test.ts`

- [ ] **Step 1: Write failing enrichment tests**

Add tests for `createProductDetailsEnrichmentService(database, extractionService)` showing:

- it loads `store_items` by ID,
- updates `store_items` with merged extracted details,
- updates linked `items` when `item_id` is present,
- returns the updated candidate plus extraction metadata,
- returns null or throws a 404-compatible error when the candidate is missing.

Run: `npm test -- productDetailsExtractionService.test.ts`

Expected before implementation: FAIL because enrichment is missing.

- [ ] **Step 2: Implement enrichment**

Use `Database.query` with `itemCandidateSelect`-compatible fields supplied by the route, or expose a route-level select helper. Keep SQL parameterized and update only `min_players`, `max_players`, `min_minutes`, `max_minutes`, `min_age`, and `last_updated`.

- [ ] **Step 3: Run enrichment tests**

Run: `npm test -- productDetailsExtractionService.test.ts`

Expected after implementation: PASS.

### Task 3: Discovery Route Wiring

**Files:**
- Modify: `ludora-admin-service/src/app.ts`
- Modify: `ludora-admin-service/src/server.ts`
- Modify: `ludora-admin-service/src/routes/discovery.ts`
- Test: `ludora-admin-service/src/app.test.ts`

- [ ] **Step 1: Write failing route tests**

In `app.test.ts`, add tests showing:

- manual `POST /discovery/listings/:id/create-item` calls product detail enrichment when details are missing and inserts the item using extracted values,
- manual create does not call enrichment when all details exist,
- `POST /admin/discovery/item-candidates/:id/product-details` returns `503` when no enrichment service is injected,
- the explicit endpoint updates both a linked candidate and item through the enrichment service.

Run: `npm test -- app.test.ts`

Expected before implementation: FAIL with missing option/route behavior.

- [ ] **Step 2: Wire types and app injection**

Add `productDetailsEnrichmentService?: ProductDetailsEnrichmentService` to `CreateAppOptions` and pass it to `createDiscoveryRouter`.

- [ ] **Step 3: Wire server configuration**

Create `createOpenAiProductDetailsExtractionClient(config.openAiApiKey, { baseURL: config.openAiBaseUrl })`, then `createProductDetailsExtractionService(client, { model: config.openAiTranslationModel })`, then `createProductDetailsEnrichmentService(database, extractionService)`. This intentionally reuses the same AI configuration as the current AI services.

- [ ] **Step 4: Update manual create SQL**

Before the current insert CTE, call enrichment when configured and missing details exist. Pass merged values as parameters and replace `candidate.min_players`, `candidate.max_players`, `candidate.min_minutes`, `candidate.max_minutes`, and `candidate.min_age` in the item insert select with those parameters. Ensure `store_items` is also updated by the enrichment service.

- [ ] **Step 5: Add explicit endpoint**

Add `POST /admin/discovery/item-candidates/:id/product-details` to `routes/discovery.ts`. If no enrichment service is injected, throw `503 Product details extraction service is not configured`. Otherwise call `enrichCandidate(id, { updateLinkedItem: true })` and return `data` plus snake_case extraction metadata.

- [ ] **Step 6: Run route tests**

Run: `npm test -- app.test.ts`

Expected after implementation: PASS for the new tests and no regressions in the file.

### Task 4: Final Verification

**Files:**
- All modified admin service files.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm test -- productDetailsExtractionService.test.ts openAiProductDetailsExtractionClient.test.ts app.test.ts
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run TypeScript build**

Run:

```bash
npm run build
```

Expected: build exits 0.

- [ ] **Step 3: Review diff**

Run:

```bash
git diff -- ludora-admin-service/src/productDetailsExtraction ludora-admin-service/src/app.ts ludora-admin-service/src/server.ts ludora-admin-service/src/routes/discovery.ts ludora-admin-service/src/app.test.ts
```

Expected: diff contains only scoped product-details extraction changes plus the pre-existing unrelated edits already noted.
