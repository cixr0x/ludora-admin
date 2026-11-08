# Verified Sitemap Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Skip product requests for conclusively absent URLs at verified stores and persist the hidden/unavailable outcome.
**Architecture:** A strict, cache-backed sitemap membership helper is shared by the continuous and manual updater. An optional helper is created per worker session/manual run; repository methods persist only the item being updated. Keep existing discovery enumeration separate.
**Tech Stack:** Python 3.12, stdlib XML/HTTP, PostgreSQL repository, unittest.
**Spec:** `docs/superpowers/specs/2026-11-07-verified-sitemap-updates-design.md`

## Global Constraints

- No behavior for unverified stores; no live config, DDL/DML execution, production calls, or deployment. Use fake cursors and network fixtures.
- The operator enrolls only independently verified stores. Use `LUDORA_VERIFIED_UPDATE_SITEMAPS` as a JSON mapping of string store IDs to `{"url":"https://store.example/sitemap.xml","min_urls":100}`; document an empty default. `min_urls` is an operator-confirmed lower bound for the verified full sitemap tree (count unique valid page URLs, including nonproducts); a suspicious drop below it disables negative decisions until corrected.
- Reuse the existing env/dotenv flow on both paths. Invalid or unconfigured stores are unknown. Don't allow redirects to untrusted origins; configured sitemap roots and child references require same store host, HTTP(S), no credentials, and standard ports. No crawling storefront routes to infer verification.
- Fresh, well-formed, bounded traversal from the configured root through all referenced XML children. Empty/malformed/challenged/non-200/incomplete/capped/untrusted/cyclic snapshots are unknown. Keep a bounded per-store cache, including short failure caching. Expired good results do not authorize misses if reloading fails. Match page locs without discovery product URL heuristics; err on the side of presence for harmless URL variants. Cancellation must propagate.
- Atomically set availability, provenance, and visibility on conclusive miss. Preserve listing state, item linkage, price and actual refresh time. Keep lease/ownership and URL identity guards, clear applicable update scheduling/lease bookkeeping, finish continuous attempt with existing `deactivated` status and explicit reason; log actual changed fields. Don't overload HTTP status or removed-page handling.

## Review Focus

- Valid XML from a partial child or a stale successful cache must not hide products.
- Wrong-store URL, malformed URL, or plausible URL alias must not be a false miss.
- A WooCommerce lookahead target can be fetched before it is claimed; filter every conclusively absent target without persisting unclaimed rows.
- Lost or stale continuous lease, or changed manual source/store identity, must not write a terminal transition.
- Snapshot retrieval errors, disabled config, and sitemap-positive items must still reach the existing product fetch; terminal misses must never reach it.

### Task 1: Shared membership gate and both updater integrations

**Files:** New `ludora-discovery/src/ludora/update_sitemap.py` and focused tests. Wire `continuous_update_worker.py`, `woocommerce_batch_refresh.py`, `operations.py`, `inventory.py`, `product_crawler.py`, `database.py`, relevant existing tests, and discovery README / admin-service .env example as appropriate.

**Interfaces:** A session/run-scoped `UpdateSitemapChecker` resolves the verified config and accepts `is_missing(store_id, source_url, ...)`; returns true only for trusted fresh negative evidence. Dependency inject fetcher/clock for tests. Both update paths share this method; WooCommerce accepts the same predicate for every lookahead target. Add a dedicated persistence path, or a strictly opt-in reason branch of existing terminal completion helpers, for `sitemap_missing`.

- [ ] Add failing tests for complete direct/index snapshots, known presence, strict negative trust, failure cases and expiry, normalized variants, unknown stores, and cancellation. Record the expected failure.
- [ ] Implement the minimal strict reader and config/TTL handling, verify fixtures pass.
- [ ] Add failing integration tests covering both updater entry points, terminal no product request, normal fallback, WooCommerce target filtering, and guarded persistence/logging. Record the expected failure.
- [ ] Wire both gates before transport and persist under the appropriate guard, with reason and no fake fetch or generic HTTP failure. Document opt-in and the verification/fallback/recovery behavior.
- [ ] Run the discovery suite from its package using `PYTHONPATH=src python -m unittest discover -s tests -v`, verify diff and commit on the feature branch. Independently review the whole task before push.
