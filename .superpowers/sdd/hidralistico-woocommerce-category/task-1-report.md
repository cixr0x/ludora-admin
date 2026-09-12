# Task 1 report: Hidralistico WooCommerce category discovery

## Summary and design

- Scoped the Store API behavior to the exact canonical domain `hidralistico.com.mx`; `www` is normalized by the existing domain helper, while lookalike and subdomain-suffix hosts retain generic discovery.
- Resolve the public Store API category dynamically by the exact slug `juegos-de-mesa`. The returned positive numeric category ID is used for product enumeration; category ID `27` is not hardcoded.
- Enumerate category products from `/wp-json/wc/store/v1/products` using `per_page=100`, advancing pages until a short page is returned and stopping immediately when the discovery `limit` is reached.
- Normalize product permalinks by removing query strings and fragments, require the store's canonical domain, deduplicate normalized URLs across pages, and map API products into `DiscoveryItemCandidateRecord` listing candidates.
- Feed successful API candidates directly into the existing `crawl_listing_candidates` path. Sitemap discovery is not invoked or merged on a successful Store API enumeration.
- Use a typed compatibility fallback for unavailable HTTP responses, invalid JSON or response shapes, missing/ambiguous exact categories, invalid category IDs, incompatible product responses, empty category results, and stalled pagination. Each fallback emits `inventory.hidralistico_store_api.fallback` with a machine-readable reason before the existing sitemap/homepage path runs.
- Emit Store API start, category selection, per-page fetch/completion, overall completion, and fallback trace events.

## Files changed

- `ludora-discovery/src/ludora/hidralistico_discovery.py`
- `ludora-discovery/src/ludora/product_crawler.py`
- `ludora-discovery/tests/test_hidralistico_discovery.py`

## TDD evidence

### RED

Command, run before production code was added:

```powershell
python -m unittest tests.test_hidralistico_discovery -v
```

Observed result:

```text
Ran 6 tests in 0.008s
FAILED (failures=5)
```

The failures showed the pre-change crawler invoked sitemap discovery for Hidralistico, never fetched the Store API, and emitted none of the required Store API fallback reasons. The unrelated/lookalike-host control passed.

### Focused GREEN

Command:

```powershell
python -m unittest tests.test_hidralistico_discovery -v
```

Observed result:

```text
Ran 6 tests in 0.007s
OK
```

### Full discovery suite

Command, run from `ludora-discovery`:

```powershell
python -m unittest discover -s tests -v
```

Observed result:

```text
Ran 489 tests in 1.942s
OK
```

## Implementation commit

`bbaee4aee2f2762566d1c1330cd8f462f2d65b9a`

## Risks and follow-up notes

- The Store API remains an external storefront dependency. If it is unavailable or changes shape, discovery deliberately falls back to the existing sitemap/homepage behavior and records the reason; that compatibility path may still miss later split Hidralistico sitemap files.
- Pagination termination uses the standard full-page/short-page convention because the existing `FetchResult` does not retain WordPress total-page response headers.
- No database schema/data, admin UI, or admin-service changes were made. No DDL or DML was executed. Nothing was pushed.
