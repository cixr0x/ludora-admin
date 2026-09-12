# Task 1 report: Hidralistico WooCommerce category discovery

## Summary and design

- Scoped the Store API behavior to the exact canonical domain `hidralistico.com.mx`; `www` is normalized by the existing domain helper, while lookalike and subdomain-suffix hosts retain generic discovery.
- Fetch Store API responses through a JSON-capable HTTP boundary that accepts `application/json` and structured `+json` media types while retaining HTTP status, `Retry-After`, transport-error details, transient retry behavior, and cancellation checks.
- Resolve the public Store API category dynamically with its supported `search=Juegos de mesa` query, paginate the categories endpoint with `per_page=100` and `page=N`, then select only the exact slug `juegos-de-mesa` across all returned pages. The returned positive numeric category ID is used for product enumeration; category ID `27` is not hardcoded.
- Preserve cross-page ambiguity and invalid-ID rejection, detect a repeated full category page as stalled, and cap category pagination at 100 pages as a final safety bound.
- Invoke the existing `before_product_request` callback immediately before every Store API category/product fetch attempt, including transient retries, before continuing to use it for each candidate detail fetch.
- Enumerate category products from `/wp-json/wc/store/v1/products` using `per_page=100`, advancing pages until a short page is returned and stopping immediately when the discovery `limit` is reached.
- Normalize product permalinks by removing query strings and fragments, require the store's canonical domain, deduplicate normalized URLs across pages, and map API products into `DiscoveryItemCandidateRecord` listing candidates.
- Feed successful API candidates directly into the existing `crawl_listing_candidates` path. Sitemap discovery is not invoked or merged on a successful Store API enumeration.
- Use a typed compatibility fallback for unavailable HTTP responses, invalid JSON or response shapes, missing/ambiguous exact categories, invalid category IDs, incompatible product responses, empty category results, and stalled pagination. Each fallback emits `inventory.hidralistico_store_api.fallback` with a machine-readable reason before the existing sitemap/homepage path runs.
- Emit Store API start, category selection, per-page fetch/completion, overall completion, and fallback trace events.

## Files changed

- `ludora-discovery/src/ludora/hidralistico_discovery.py`
- `ludora-discovery/src/ludora/product_crawler.py`
- `ludora-discovery/src/ludora/webfetch.py`
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

## Review correction evidence

The independent review identified that the HTML-only fetch boundary rejected Hidralistico's real JSON responses and that the exact category occurs after the first category page. Both corrections followed a separate RED/GREEN cycle.

### Correction RED

Command, run after adding the correction tests and before editing production code:

```powershell
python -m unittest tests.test_hidralistico_discovery -v
```

Observed result:

```text
Ran 11 tests in 8.515s
FAILED (failures=10)
```

The JSON integration test observed sitemap fallback for an `application/json; charset=UTF-8` response. The later-page category test failed with `category_not_found`; cross-page ambiguity, invalid-ID, and repeated-page stall expectations also failed against the single-page implementation. The unrelated-host control remained green.

### Correction focused GREEN

Command:

```powershell
python -m unittest tests.test_hidralistico_discovery -v
```

Observed result:

```text
Ran 11 tests in 0.011s
OK
```

### Correction full discovery suite

Command, run from `ludora-discovery`:

```powershell
python -m unittest discover -s tests -v
```

Observed result:

```text
Ran 494 tests in 2.036s
OK
```

### Correction commit

`b3fcc4fcb7d84a1a4704c1425c1d69c02bfd90d7`

## Final request-behavior correction evidence

The final TDD pass aligned category lookup with the live endpoint's supported `search` parameter and extended the existing outbound-request callback contract to every Store API attempt.

### Final correction RED

Command, run after adding the final regression tests and before editing production code:

```powershell
python -m unittest tests.test_hidralistico_discovery -v
```

Observed result:

```text
Ran 12 tests in 0.020s
FAILED (failures=2)
```

The later-page category test observed no `search=Juegos de mesa` parameter, and the retry-order test observed three network fetches without the required immediately preceding callback invocations.

### Final correction focused GREEN

Command:

```powershell
python -m unittest tests.test_hidralistico_discovery -v
```

Observed result:

```text
Ran 12 tests in 0.023s
OK
```

### Final correction full discovery suite

Command, run from `ludora-discovery`:

```powershell
python -m unittest discover -s tests -v
```

Observed result:

```text
Ran 495 tests in 3.348s
OK
```

### Final correction commit

`175176b75e4083f1b3ef173a9536b06cc6fb7f2b`

## Risks and follow-up notes

- The Store API remains an external storefront dependency. If it is unavailable or changes shape, discovery deliberately falls back to the existing sitemap/homepage behavior and records the reason; that compatibility path may still miss later split Hidralistico sitemap files.
- Category and product pagination use the standard full-page/short-page convention because the existing `FetchResult` does not retain WordPress total-page response headers. Category pagination additionally detects repeated pages and has a hard safety cap.
- No database schema/data, admin UI, or admin-service changes were made. No DDL or DML was executed. Nothing was pushed.
