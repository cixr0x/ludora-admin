# Sitemap Catalog Discovery Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand item discovery to use product sitemaps first and classify candidates conservatively without relying on BGG integration.

**Architecture:** Add sitemap URL discovery, add deterministic item candidate classification, expand candidate persistence with classification metadata, and update the product crawler to use sitemap product URLs before homepage fallback.

**Tech Stack:** Python standard library XML/HTML parsing, existing urllib fetcher, PostgreSQL through existing repository, `unittest`.

---

## Task 1: Classification Schema And Model

**Files:**
- Modify `C:/PROJECTS/ludora/database/schema.sql`
- Modify `C:/PROJECTS/ludora/ludora-discovery/src/ludora/models.py`
- Test `C:/PROJECTS/ludora/ludora-discovery/tests/test_schema.py`
- Test `C:/PROJECTS/ludora/ludora-discovery/tests/test_listing_candidate_model.py`

- [ ] Add failing tests for `candidate_category`, `category_confidence`, and `classification_reasons`.
- [ ] Add schema columns and model serialization fields.
- [ ] Run `python -m unittest tests.test_schema tests.test_listing_candidate_model -v`.

## Task 2: Repository Persistence

**Files:**
- Modify `C:/PROJECTS/ludora/ludora-discovery/src/ludora/database.py`
- Test `C:/PROJECTS/ludora/ludora-discovery/tests/test_database.py`

- [ ] Extend the item upsert test to assert classification columns and JSON reasons are persisted.
- [ ] Update insert/update SQL and params.
- [ ] Run `python -m unittest tests.test_database -v`.

## Task 3: Sitemap Product URL Discovery

**Files:**
- Create `C:/PROJECTS/ludora/ludora-discovery/src/ludora/sitemap_discovery.py`
- Test `C:/PROJECTS/ludora/ludora-discovery/tests/test_sitemap_discovery.py`

- [ ] Add tests for sitemap index parsing, product sitemap parsing, `&amp;` entity handling, same-domain filtering, and deduplication.
- [ ] Implement `discover_product_urls_from_sitemaps(store_url, fetcher=fetch_html, limit=None)`, with optional explicit limits for diagnostics.
- [ ] Run `python -m unittest tests.test_sitemap_discovery -v`.

## Task 4: Candidate Classification

**Files:**
- Create `C:/PROJECTS/ludora/ludora-discovery/src/ludora/item_classification.py`
- Test `C:/PROJECTS/ludora/ludora-discovery/tests/test_item_classification.py`

- [ ] Add tests for likely board games, likely expansions, obvious non-boardgames, and positive-signal override of negative terms.
- [ ] Implement deterministic scoring using extracted fields and `raw_payload`.
- [ ] Run `python -m unittest tests.test_item_classification -v`.

## Task 5: Crawler Orchestration

**Files:**
- Modify `C:/PROJECTS/ludora/ludora-discovery/src/ludora/product_crawler.py`
- Test `C:/PROJECTS/ludora/ludora-discovery/tests/test_inventory.py`

- [ ] Add tests proving sitemap product URLs are preferred and homepage links are fallback.
- [ ] Update crawler to discover sitemap URLs, fetch detail pages, classify records, and persist them.
- [ ] Run `python -m unittest tests.test_inventory -v`.

## Task 6: Verification And Migration

- [ ] Apply `database/schema.sql` to the configured database.
- [ ] Verify live `store_items` has classification columns.
- [ ] Run `python -m unittest discover -s tests -v`.
