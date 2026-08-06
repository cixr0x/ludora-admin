# Discovery Transient Failure Remediation Design

## Goal

Allow store discovery to recover from a peer connection reset and allow an Amazon crawl to complete when one or more product-detail pages remain invalid after bounded retries.

## Confirmed behavior

- A raw `ConnectionResetError` from the static HTML request is a transient network failure.
- The static request is retried through the existing bounded transient-fetch helper.
- If all static attempts fail, the existing browser fallback remains available.
- An Amazon detail page still receives the existing three validation attempts and browser-context resets.
- A detail page that remains invalid is trace-logged and skipped without being inserted into `store_items`.
- Other valid Amazon products are processed normally and the store discovery run completes successfully.
- The skipped Amazon URL remains eligible for rediscovery on a future run.
- No schema or database patch is required.

## Approaches considered

### Selected: error-specific retry and unpersisted Amazon skip

Catch `ConnectionResetError` in `fetch_html`, preserve it in `FetchResult`, and let `fetch_with_transient_retries` use all configured attempts for that error type. For Amazon, retain the per-product exhausted trace, emit an aggregate completed-with-skips trace, and return the valid records without raising.

This is the narrowest behavior change. It does not disguise a transport exception as an HTTP status and it does not create database state for a page whose availability may change later.

### Rejected: map connection resets to HTTP 503

This would reuse the HTTP retry branch but would falsely report a TCP transport failure as an upstream HTTP response.

### Rejected: persist invalid Amazon products as rejected or inactive

This would avoid repeating the fetch on later runs, but it would require a persistence policy and could permanently suppress a product after a transient Amazon shell or redirect. The confirmed requirement is to leave the product unpersisted.

## Data flow

For a static store detail request, `fetch_html` converts `ConnectionResetError` into a status-zero `FetchResult` containing the exact error type. `fetch_with_transient_retries` recognizes that error type as transient, retries up to `max_attempts`, and returns the first success. If the attempts are exhausted, the existing product crawler can continue to its browser-rendered fallback.

For Amazon, `_fetch_valid_amazon_detail_page` keeps its current validation and retry behavior. The caller records exhausted URLs, continues processing later listing candidates, then emits `amazon_inventory.crawl.completed_with_skips` with the skipped URLs and processed count. It returns valid records instead of raising a run-level `RuntimeError`.

## Diagnostics

- Preserve `amazon_inventory.candidate.detail_fetch.invalid` for every invalid attempt.
- Preserve `amazon_inventory.candidate.detail_fetch.exhausted` for the skipped product.
- Replace the misleading aggregate `amazon_inventory.crawl.partial_failure` event with `amazon_inventory.crawl.completed_with_skips`.
- Preserve the exact `ConnectionResetError` text and error type in the fetch result so verbose retry traces remain accurate where enabled.

## Tests

- Add a `fetch_html` regression test proving a raw `ConnectionResetError` becomes a traceable `FetchResult` instead of escaping.
- Add a retry-helper regression test proving `ConnectionResetError` consumes the configured transient attempts and succeeds when a later attempt returns HTML.
- Change the Amazon invalid-detail test to assert no exception, no persistence, three detail attempts, and the existing invalid/exhausted diagnostics.
- Change the mixed Amazon crawl test to assert valid products are returned and persisted, invalid products remain absent, and the aggregate completed-with-skips event is emitted.
- Run the focused web-fetch and Amazon suites, then the complete discovery unittest suite.
