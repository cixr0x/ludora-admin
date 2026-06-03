# BGG Match Staging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate and store local/BGG match candidates for discovery item candidates in admin-service.

**Architecture:** Shared SQL schema adds the staging table. Admin-service owns BGG API calls, XML parsing, conservative matching, persistence, and API endpoints. Tests use injected fake BGG clients and databases.

**Tech Stack:** PostgreSQL SQL schema, Express, TypeScript, Vitest, BGG XMLAPI2.

---

### Task 1: Match Candidate Schema

**Files:**
- Modify: `C:/PROJECTS/ludora/database/schema.sql`
- Modify: `C:/PROJECTS/ludora/ludora-discovery/tests/test_schema.py`

- [ ] Add failing schema assertions for `item_match_candidates`.
- [ ] Update `database/schema.sql`.
- [ ] Run `python -m unittest tests.test_schema`.

### Task 2: BGG Parser And Client

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/bgg/bggParser.ts`
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/bgg/bggClient.ts`
- Test: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/bgg/bggParser.test.ts`

- [ ] Add parser tests for BGG search and thing XML.
- [ ] Add XML parsing dependency.
- [ ] Implement parser and HTTP client.
- [ ] Run `npm test -- src/bgg/bggParser.test.ts`.

### Task 3: Conservative Matcher

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/itemMatching/itemMatcher.ts`
- Test: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/itemMatching/itemMatcher.test.ts`

- [ ] Add tests for exact alternate-name match and `Catan Plus` not exact-matching `Catan`.
- [ ] Implement normalization and scoring.
- [ ] Run matcher tests.

### Task 4: Matching Service And Routes

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/itemMatching/itemMatchingService.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/routes/discovery.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/app.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/server.ts`
- Test: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/itemMatching/itemMatchingService.test.ts`
- Test: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/app.test.ts`

- [ ] Add service and route tests.
- [ ] Implement service and API routes.
- [ ] Wire production server config.
- [ ] Run admin-service tests and build.

### Task 5: Live Database And Service Restart

**Files:**
- Read: `C:/PROJECTS/ludora/ludora-discovery/.env`
- Read: `C:/PROJECTS/ludora/database/schema.sql`

- [ ] Apply schema to the configured database.
- [ ] Restart admin-service so the new endpoint is active.
- [ ] Verify health endpoint and schema introspection.

