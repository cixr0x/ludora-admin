# Automated Store Item Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert store item discovery into a lifecycle that can classify products, match existing items or BGG entries, import BGG metadata, and link store rows directly to catalog items when confidence is high.

**Architecture:** Discovery owns scan-time orchestration because the flow starts during product crawling. PostgreSQL owns store item state, item metadata, and item relationships. BGG matching/import is implemented as a discovery-side service so item scans can run without calling admin-service.

**Tech Stack:** Python discovery crawler/repository, PostgreSQL schema, BoardGameGeek XML API, existing admin-service/admin-ui tables for visibility.

---

### Task 1: Candidate Lifecycle Schema

**Files:**
- Modify: `C:/PROJECTS/ludora/database/schema.sql`
- Modify: `C:/PROJECTS/ludora/ludora-discovery/src/ludora/models.py`
- Test: `C:/PROJECTS/ludora/ludora-discovery/tests/test_schema.py`
- Test: `C:/PROJECTS/ludora/ludora-discovery/tests/test_listing_candidate_model.py`

- [x] Add store item statuses `NEW`, `REJECTED`, `NOT_BOARDGAME`, `LISTED`, `UNLISTED`, `NEEDS_REVIEW`, and `MATCH_NOT_FOUND`.
- [x] Add store item match audit columns: `match_source`, `matched_bgg_id`, `matched_name`, `match_score`, `match_reasons`, `match_payload`, `matched_at`, `processed_at`, and `processing_error`; `item_id` is the linked item reference.
- [x] Rename `discovery_item_candidates` to `store_items` and remove the separate `offers` workflow.
- [x] Add `item_relationships` for BGG parent/child and implementation relationships.

### Task 2: Repository Store Item Lifecycle

**Files:**
- Modify: `C:/PROJECTS/ludora/ludora-discovery/src/ludora/database.py`
- Test: `C:/PROJECTS/ludora/ludora-discovery/tests/test_database.py`

- [x] Existing `REJECTED`, `NOT_BOARDGAME`, and `MATCH_NOT_FOUND` candidates update only `last_seen_at`.
- [x] Existing active candidates update extracted fields and price/availability.
- [x] Existing linked store items refresh their own price, availability, source URL/title, and `last_seen_at`.
- [x] New store items insert as `NEW`.

### Task 3: BGG Import Service

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-discovery/src/ludora/bgg.py`
- Create: `C:/PROJECTS/ludora/ludora-discovery/src/ludora/item_import.py`
- Test: `C:/PROJECTS/ludora/ludora-discovery/tests/test_bgg_import.py`

- [x] Parse BGG XML search and thing responses.
- [x] Upsert item rows and aliases from BGG.
- [x] Upsert publishers, categories, mechanics, families, contributors, and snapshots.
- [x] Import linked parent/base items when required, but do not create store rows for imported parents.
- [x] Insert item relationships with stable direction and `link_type`.

### Task 4: Automated Product Processing

**Files:**
- Modify: `C:/PROJECTS/ludora/ludora-discovery/src/ludora/product_crawler.py`
- Create: `C:/PROJECTS/ludora/ludora-discovery/src/ludora/item_processing.py`
- Test: `C:/PROJECTS/ludora/ludora-discovery/tests/test_item_processing.py`

- [x] Classify new candidates.
- [x] Set `NOT_BOARDGAME` for likely non-boardgames.
- [x] Match local items above `0.90` and link the store item.
- [x] Search BGG above `0.90`, import metadata, then link the store item.
- [x] Set `MATCH_NOT_FOUND` when neither local nor BGG passes threshold.

### Task 5: Admin Visibility

**Files:**
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/routes/discovery.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/app.test.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-ui/src/pages/ListingCandidatesPage.tsx`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-ui/src/pages/ListingCandidatesPage.test.tsx`

- [x] Return new lifecycle and match audit fields from `/discovery/listings`.
- [x] Show key status/match fields in the admin store items table.

### Task 6: Live Migration And Verification

**Files:**
- Read: `C:/PROJECTS/ludora/database/schema.sql`
- Read: `C:/PROJECTS/ludora/ludora-discovery/.env`

- [x] Apply schema to the live database.
- [x] Restart admin-service.
- [x] Run discovery tests, admin-service tests/build, and admin-ui tests/build.
