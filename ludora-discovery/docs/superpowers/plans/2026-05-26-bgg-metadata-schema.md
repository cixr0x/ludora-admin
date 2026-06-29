# BGG Metadata Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add normalized database tables for BoardGameGeek metadata linked to curated Ludora items.

**Architecture:** The shared SQL schema owns the actual database objects. Discovery tests validate the schema contract because BGG import work will start in `ludora-discovery`. The live database is updated by applying `database/schema.sql`.

**Tech Stack:** PostgreSQL, SQL schema migrations, Python `unittest`.

---

### Task 1: Schema Contract Tests

**Files:**
- Modify: `C:/PROJECTS/ludora/ludora-discovery/tests/test_schema.py`

- [ ] **Step 1: Add failing tests**

Add assertions for `boardgame_categories`, `boardgame_mechanics`, `boardgame_families`, `contributors`, `item_families`, `item_contributors`, `publishers.bgg_id`, `bgg_search_cache`, `bgg_search_queries`, and `bgg_search_query_results`.

- [ ] **Step 2: Verify failure**

Run: `python -m unittest tests.test_schema`

Expected: failures for missing BGG metadata tables and columns.

### Task 2: SQL Schema

**Files:**
- Modify: `C:/PROJECTS/ludora/database/schema.sql`

- [ ] **Step 1: Add BGG metadata tables**

Add normalized lookup tables, relationship tables, publisher BGG id support, unique BGG search result cache storage, and query-to-result cache mapping.

- [ ] **Step 2: Verify schema tests**

Run: `python -m unittest tests.test_schema`

Expected: all schema tests pass.

### Task 3: Live Database

**Files:**
- Read: `C:/PROJECTS/ludora/ludora-discovery/.env`
- Read: `C:/PROJECTS/ludora/database/schema.sql`

- [ ] **Step 1: Apply schema**

Use the existing discovery database config resolver and psycopg connection to execute `database/schema.sql`.

- [ ] **Step 2: Verify live tables**

Query `information_schema.tables`, `information_schema.columns`, and `pg_indexes` for the new metadata objects.

### Task 4: Full Verification

**Files:**
- Test: `C:/PROJECTS/ludora/ludora-discovery/tests`

- [ ] **Step 1: Run discovery tests**

Run: `python -m unittest discover -s tests`

Expected: all tests pass.
