# Admin Translation Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic cache-backed translation service in admin-service and use it to improve BGG search-query recall.

**Architecture:** Shared SQL owns the `translation_jobs` cache. Admin-service owns translation prompts, client abstraction, OpenAI-backed implementation, and first consumer integration in the item matcher. Tests use fake translation clients and avoid live OpenAI requests.

**Tech Stack:** PostgreSQL schema, Express/TypeScript, OpenAI Responses API structured outputs, Vitest.

---

### Task 1: Translation Cache Schema

**Files:**
- Modify: `C:/PROJECTS/ludora/database/schema.sql`
- Modify: `C:/PROJECTS/ludora/ludora-discovery/tests/test_schema.py`

- [ ] Add failing schema tests for `translation_jobs`.
- [ ] Add `translation_jobs` table and cache indexes including model and prompt version.
- [ ] Run `python -m unittest tests.test_schema`.

### Task 2: Translation Service

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/translation/translationService.ts`
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/translation/translationPrompts.ts`
- Test: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/translation/translationService.test.ts`

- [ ] Add tests for cache hit, cache miss, and failed client call.
- [ ] Implement hash-based cache lookup and persistence.
- [ ] Run translation service tests.

### Task 3: OpenAI Translation Client

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/translation/openAiTranslationClient.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/config.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/.env.example`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/package.json`

- [ ] Add OpenAI SDK dependency.
- [ ] Add optional OpenAI translation config.
- [ ] Implement structured-output client.
- [ ] Run admin-service build.

### Task 4: BGG Matcher Integration

**Files:**
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/itemMatching/itemMatchingService.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/server.ts`
- Test: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/itemMatching/itemMatchingService.test.ts`

- [ ] Add test showing translated BGG search query is used.
- [ ] Inject optional translation service into item matching.
- [ ] Wire production server.
- [ ] Run admin-service tests and build.

### Task 5: Admin Translation Endpoint

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/routes/translation.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/app.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/server.ts`
- Test: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/app.test.ts`

- [ ] Add endpoint tests for success, missing service, and invalid purpose.
- [ ] Expose `POST /admin/translations` with snake_case HTTP fields.
- [ ] Wire the optional production translation service into the app.
- [ ] Run admin-service tests and build.

### Task 6: Live Database And Restart

**Files:**
- Read: `C:/PROJECTS/ludora/database/schema.sql`
- Read: `C:/PROJECTS/ludora/ludora-discovery/.env`

- [ ] Apply schema.
- [ ] Restart admin-service.
- [ ] Verify health and table introspection.
