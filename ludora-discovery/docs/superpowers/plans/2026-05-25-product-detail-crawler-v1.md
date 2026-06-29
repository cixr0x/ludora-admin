# Product Detail Crawler V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first product detail crawler that finds product pages for curated stores, extracts dirty item data, and upserts `store_items`.

**Architecture:** Expand the item candidate schema/model first, then add focused crawler modules: product link discovery, product detail extraction, and crawl orchestration. Keep storage behind the existing repository interface and expose the crawler through the existing CLI inventory path.

**Tech Stack:** Python standard library HTML parsing and JSON parsing, existing `urllib` fetcher, PostgreSQL through existing `psycopg` repository, `unittest`.

---

## File Structure

- Modify `C:/PROJECTS/ludora/database/schema.sql`: add crawler-ready item candidate columns and indexes.
- Modify `C:/PROJECTS/ludora/ludora-discovery/src/ludora/models.py`: add new `DiscoveryItemCandidateRecord` fields.
- Modify `C:/PROJECTS/ludora/ludora-discovery/src/ludora/database.py`: upsert new columns and keep `last_seen_at` separate from `last_updated`.
- Create `C:/PROJECTS/ludora/ludora-discovery/src/ludora/product_detail_extraction.py`: extract detail fields from JSON-LD, meta tags, and simple HTML text.
- Create `C:/PROJECTS/ludora/ludora-discovery/src/ludora/product_crawler.py`: orchestrate listing page fetch, product detail fetch, extraction, and persistence.
- Modify `C:/PROJECTS/ludora/ludora-discovery/src/ludora/inventory.py`: call the product detail crawler from the existing `collect_store_inventory` entrypoint.
- Modify tests under `C:/PROJECTS/ludora/ludora-discovery/tests`: add schema/model/database/extractor/crawler coverage.

## Task 1: Expand Schema And Candidate Model

**Files:**
- Modify: `C:/PROJECTS/ludora/database/schema.sql`
- Modify: `C:/PROJECTS/ludora/ludora-discovery/src/ludora/models.py`
- Test: `C:/PROJECTS/ludora/ludora-discovery/tests/test_schema.py`
- Test: `C:/PROJECTS/ludora/ludora-discovery/tests/test_listing_candidate_model.py`

- [ ] **Step 1: Write failing schema/model tests**

Add assertions that `store_items` contains `source_listing_url`, `image_url`, `item_type`, `min_minutes`, `max_minutes`, `min_age`, `currency`, `store_sku`, `raw_payload`, and `last_seen_at`.

Add a model test that constructs:

```python
DiscoveryItemCandidateRecord(
    store_id=12,
    source_url="https://example.mx/products/catan",
    source_listing_url="https://example.mx/collections/juegos",
    title="Catan",
    publisher="Devir",
    description="Juego base",
    item_type="base_game",
    min_players=3,
    max_players=4,
    min_minutes=60,
    max_minutes=90,
    min_age=10,
    language="es",
    image_url="https://example.mx/catan.jpg",
    raw_price="$899 MXN",
    price="899.00",
    currency="MXN",
    availability="available",
    store_sku="CATAN-ES",
    raw_payload={"json_ld": {"name": "Catan"}},
)
```

Assert `to_db_dict()` includes each new field and converts an empty price to `None`.

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
python -m unittest tests.test_schema tests.test_listing_candidate_model -v
```

Expected: failures for missing schema columns/model fields.

- [ ] **Step 3: Implement schema/model changes**

Add the new columns to `store_items`, plus `alter table if exists` statements for existing databases. Add a check constraint for `item_type in ('unknown', 'base_game', 'expansion')`. Add `last_seen_at` and keep `last_updated`.

Update `DiscoveryItemCandidateRecord` with the new fields and serialize `raw_payload` as a dict.

- [ ] **Step 4: Run tests to verify pass**

Run:

```powershell
python -m unittest tests.test_schema tests.test_listing_candidate_model -v
```

Expected: all selected tests pass.

## Task 2: Update Database Upsert

**Files:**
- Modify: `C:/PROJECTS/ludora/ludora-discovery/src/ludora/database.py`
- Test: `C:/PROJECTS/ludora/ludora-discovery/tests/test_database.py`

- [ ] **Step 1: Write failing upsert test**

Extend `test_upsert_item_candidate_writes_dirty_item_record` to assert the SQL includes every new column and params include `source_listing_url`, `image_url`, `item_type`, `currency`, `store_sku`, and JSON-encoded `raw_payload`.

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
python -m unittest tests.test_database -v
```

Expected: failure because the repository does not insert the new columns yet.

- [ ] **Step 3: Implement upsert changes**

Update `upsert_item_candidate` insert/update lists. Set `last_seen_at = now()` on every conflict update. Set `last_updated = now()` when updating the extracted fields in the same conflict statement.

- [ ] **Step 4: Run test to verify pass**

Run:

```powershell
python -m unittest tests.test_database -v
```

Expected: database repository tests pass.

## Task 3: Add Product Detail Extraction

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-discovery/src/ludora/product_detail_extraction.py`
- Test: `C:/PROJECTS/ludora/ludora-discovery/tests/test_product_detail_extraction.py`

- [ ] **Step 1: Write failing extractor tests**

Add tests for JSON-LD `Product` with nested `Offer`, OpenGraph image/description fallback, player/time/age heuristics, and missing title returning `None`.

The JSON-LD test should expect:

```python
record.title == "Catan"
record.publisher == "Devir"
record.description == "Trade, build, settle."
record.image_url == "https://example.mx/catan.jpg"
record.raw_price == "899.00"
record.price == "899.00"
record.currency == "MXN"
record.availability == "available"
record.store_sku == "CATAN-ES"
record.raw_payload["json_ld"]["name"] == "Catan"
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
python -m unittest tests.test_product_detail_extraction -v
```

Expected: import failure because the module does not exist.

- [ ] **Step 3: Implement extractor**

Create `extract_product_detail_candidate(html, product_url, store_id, source_listing_url)` returning `DiscoveryItemCandidateRecord | None`.

Use `html.parser.HTMLParser` to collect JSON-LD scripts, meta tags, title text, image candidates, and visible text. Parse JSON-LD objects whose `@type` contains `Product`. Map schema.org availability URLs to `available`, `out_of_stock`, or `unknown`. Extract price and currency from `offers`.

- [ ] **Step 4: Run test to verify pass**

Run:

```powershell
python -m unittest tests.test_product_detail_extraction -v
```

Expected: extractor tests pass.

## Task 4: Add Product Detail Crawler Orchestration

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-discovery/src/ludora/product_crawler.py`
- Modify: `C:/PROJECTS/ludora/ludora-discovery/src/ludora/inventory.py`
- Test: `C:/PROJECTS/ludora/ludora-discovery/tests/test_inventory.py`

- [ ] **Step 1: Write failing crawler test**

Patch fetch calls so the listing page returns a product link and the product page returns JSON-LD. Assert one persisted candidate uses `source_url` as the detail URL and `source_listing_url` as the listing page URL.

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
python -m unittest tests.test_inventory -v
```

Expected: failure because `collect_store_inventory` currently persists listing rows without visiting product pages.

- [ ] **Step 3: Implement crawler**

Create `crawl_store_product_details(store_url, store_id, repository, limit=None)`:

1. Fetch `store_url`.
2. Use existing `extract_listing_candidates` for product links.
3. Fetch each candidate `source_url`.
4. Extract a detail candidate with `extract_product_detail_candidate`.
5. Fall back to the listing candidate if detail extraction fails.
6. Persist each candidate.

Update `collect_store_inventory` to delegate to `crawl_store_product_details`.

- [ ] **Step 4: Run test to verify pass**

Run:

```powershell
python -m unittest tests.test_inventory -v
```

Expected: inventory tests pass.

## Task 5: Full Verification And Database Migration

**Files:**
- Shared schema: `C:/PROJECTS/ludora/database/schema.sql`
- Discovery code: `C:/PROJECTS/ludora/ludora-discovery/src/ludora/*.py`

- [ ] **Step 1: Run full discovery tests**

Run:

```powershell
python -m unittest discover -s tests -v
```

Expected: all discovery tests pass.

- [ ] **Step 2: Apply schema to live database**

Use the existing database URL from `ludora-admin/ludora-admin-service/.env` without printing secrets. Apply `database/schema.sql` to the configured database.

- [ ] **Step 3: Verify live table shape**

Query `information_schema.columns` for `store_items` and confirm the new columns exist.

- [ ] **Step 4: Run a no-network smoke at code level**

Run the full unit suite again after migration:

```powershell
python -m unittest discover -s tests -v
```

Expected: all discovery tests pass.
