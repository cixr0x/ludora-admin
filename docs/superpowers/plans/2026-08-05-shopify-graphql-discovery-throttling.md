# Shopify GraphQL Discovery and Global Product-Fetch Throttling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Shopify discovery use signed Storefront GraphQL exclusively while globally pacing every per-product discovery request at least three seconds across all stores and allowing all-store batches to continue after individual store failures.

**Architecture:** Add one cancellation-aware in-memory throttle that is created per discovery process and shared through every store in a batch. Pass a `before_product_request` callback through the inventory router and each crawler, use the existing signed Shopify Storefront primitives for new-product details with discovery-specific retry semantics, and aggregate failed stores only after the batch attempts every store.

**Tech Stack:** Python 3, standard-library `unittest`, `urllib`, PostgreSQL-backed discovery repositories and traces, existing Web Bot Auth provider, existing Storefront GraphQL API `2026-07`, Node/TypeScript admin-service deployment wrapper.

## Global Constraints

- Shopify product detail discovery is GraphQL-only; never fall back to static or browser HTML.
- Shopify enumeration requires signed XML sitemap product URLs; fail the store when sitemap enumeration fails or is empty.
- Do not add Storefront GraphQL product pagination.
- Enforce a minimum three-second start-to-start interval for every per-product detail request across every store and platform in one Python discovery process.
- Sitemap, listing, search-pagination, AI, BGG, persistence, and multi-product catalog responses remain outside the per-product throttle.
- Apply the shared throttle to static product details, GraphQL product details, browser-detail fallbacks, Amazon product details, and every retry attempt.
- Use `@inContext(country: MX, language: ES)` on the Shopify Storefront product query.
- HTTP 429 and GraphQL throttling receive three total attempts; honor `Retry-After`, otherwise wait 60 seconds and then 300 seconds.
- HTTP 430 fails the current store immediately.
- A null Shopify product is logged and skipped.
- Store failures preserve already persisted products, and the next run skips those existing URLs.
- A batch continues after store failures, then ends with parent status `failed` and an aggregate bounded error.
- No database schema, DDL, DML patch, or admin UI change is part of this implementation.
- Do not expose Web Bot Auth headers, keys, tokens, or environment secrets in traces, tests, or output.
- Use `python -m unittest`; do not introduce pytest-only fixtures or dependencies.

---

## File Structure

- Create `ludora-discovery/src/ludora/product_discovery_throttle.py`: process-wide start-time pacing primitive with injectable monotonic clock and cancellation-aware waiter.
- Create `ludora-discovery/tests/test_product_discovery_throttle.py`: deterministic throttle timing and cancellation coverage.
- Modify `ludora-discovery/src/ludora/operations.py`: create/reuse the throttle, add contextual wait traces, continue batch stores, and aggregate failures.
- Modify `ludora-discovery/src/ludora/inventory.py`: pass one `before_product_request` callback through every inventory route.
- Modify `ludora-discovery/src/ludora/product_crawler.py`: invoke the callback for generic details and implement Shopify discovery through GraphQL only.
- Modify `ludora-discovery/src/ludora/shopify_storefront.py`: add Mexican Spanish query context while retaining the existing single-request transport and normalizer.
- Modify `ludora-discovery/src/ludora/amazon_discovery.py`: throttle every Amazon per-product detail attempt without throttling search pages.
- Modify `ludora-discovery/src/ludora/amukiri_discovery.py`: forward the callback to the shared generic detail crawler.
- Modify `ludora-discovery/src/ludora/catito_discovery.py`: forward the callback to the shared generic detail crawler.
- Modify `ludora-discovery/tests/test_inventory.py`: generic and Shopify routing regression coverage.
- Modify `ludora-discovery/tests/test_shopify_storefront.py`: GraphQL-only discovery, context, retry, null-product, and permanent-failure coverage.
- Modify `ludora-discovery/tests/test_amazon_discovery.py`: prove only Amazon detail attempts acquire throttle slots.
- Modify `ludora-discovery/tests/test_amukiri_discovery.py`: prove the specialized crawler forwards the callback.
- Modify `ludora-discovery/tests/test_catito_discovery.py`: prove the specialized crawler forwards the callback.
- Modify `ludora-discovery/tests/test_operations.py`: single-run throttle construction, batch sharing, continuation, aggregation, and cancellation coverage.
- Modify `ludora-discovery/README.md`: document Shopify GraphQL-only discovery and global three-second product-detail pacing.
- Modify `docs/production-deployment.md`: document the production discovery behavior and its failure semantics.

---

### Task 1: Add the process-wide product-discovery throttle

**Files:**
- Create: `ludora-discovery/src/ludora/product_discovery_throttle.py`
- Create: `ludora-discovery/tests/test_product_discovery_throttle.py`

**Interfaces:**
- Consumes: `CancellationToken` and the cancellation-aware wait behavior already used by `ludora.webfetch`.
- Produces: `MINIMUM_PRODUCT_DISCOVERY_INTERVAL_SECONDS = 3.0`, `wait_for_discovery_delay(...)`, `ProductDiscoveryThrottleWait`, and `ProductDiscoveryRequestThrottle.wait_before_request(...)` for Tasks 2-4.

- [ ] **Step 1: Write deterministic failing tests for start-to-start pacing**

Create `tests/test_product_discovery_throttle.py` with a `unittest.TestCase` and a fake monotonic clock whose waiter advances time:

```python
import unittest

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.product_discovery_throttle import ProductDiscoveryRequestThrottle


class FakeClock:
    def __init__(self):
        self.now = 100.0
        self.waits: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def wait(self, seconds: float, cancellation_token: CancellationToken | None) -> None:
        raise_if_cancelled(cancellation_token)
        self.waits.append(seconds)
        self.now += seconds


class ProductDiscoveryRequestThrottleTests(unittest.TestCase):
    def test_spaces_request_starts_globally_by_at_least_three_seconds(self):
        clock = FakeClock()
        throttle = ProductDiscoveryRequestThrottle(clock=clock.monotonic, waiter=clock.wait)

        first = throttle.wait_before_request()
        second = throttle.wait_before_request()
        clock.now += 1.25
        third = throttle.wait_before_request()

        self.assertEqual(first.delay_seconds, 0.0)
        self.assertEqual(second.delay_seconds, 3.0)
        self.assertEqual(third.delay_seconds, 1.75)
        self.assertEqual(clock.waits, [3.0, 1.75])
```

Add a second test proving a request that consumes more than three seconds permits the next request immediately, and a third proving constructor values below `3.0` are clamped to `3.0`.

- [ ] **Step 2: Run the throttle tests and confirm the missing-module failure**

Run from `ludora-discovery`:

```powershell
python -m unittest tests.test_product_discovery_throttle -v
```

Expected: FAIL because `ludora.product_discovery_throttle` does not exist.

- [ ] **Step 3: Implement the minimal monotonic throttle**

Create `src/ludora/product_discovery_throttle.py`:

```python
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

from ludora.cancellation import CancellationToken, raise_if_cancelled


MINIMUM_PRODUCT_DISCOVERY_INTERVAL_SECONDS = 3.0
ThrottleWaiter = Callable[[float, CancellationToken | None], None]


def wait_for_discovery_delay(
    delay_seconds: float,
    cancellation_token: CancellationToken | None,
) -> None:
    deadline = time.monotonic() + max(0.0, delay_seconds)
    while True:
        raise_if_cancelled(cancellation_token)
        remaining = deadline - time.monotonic()
        if remaining <= 0.0:
            return
        time.sleep(min(1.0, remaining))


@dataclass(frozen=True)
class ProductDiscoveryThrottleWait:
    delay_seconds: float


class ProductDiscoveryRequestThrottle:
    def __init__(
        self,
        *,
        minimum_interval_seconds: float = MINIMUM_PRODUCT_DISCOVERY_INTERVAL_SECONDS,
        clock: Callable[[], float] | None = None,
        waiter: ThrottleWaiter | None = None,
    ) -> None:
        self.minimum_interval_seconds = max(
            MINIMUM_PRODUCT_DISCOVERY_INTERVAL_SECONDS,
            float(minimum_interval_seconds),
        )
        self._clock = clock or time.monotonic
        self._waiter = waiter or wait_for_discovery_delay
        self._next_request_at = 0.0

    def wait_before_request(
        self,
        cancellation_token: CancellationToken | None = None,
        *,
        on_wait: Callable[[ProductDiscoveryThrottleWait], None] | None = None,
    ) -> ProductDiscoveryThrottleWait:
        raise_if_cancelled(cancellation_token)
        delay_seconds = max(0.0, self._next_request_at - self._clock())
        wait = ProductDiscoveryThrottleWait(delay_seconds=delay_seconds)
        if delay_seconds > 0.0:
            if on_wait is not None:
                on_wait(wait)
            self._waiter(delay_seconds, cancellation_token)
        raise_if_cancelled(cancellation_token)
        self._next_request_at = self._clock() + self.minimum_interval_seconds
        return wait
```

- [ ] **Step 4: Add cancellation coverage**

Add a test whose injected waiter cancels the token and calls `raise_if_cancelled(token)`. Assert `OperationCancelled` is raised and the throttle does not advance a request start after cancellation.

- [ ] **Step 5: Run the focused throttle tests**

```powershell
python -m unittest tests.test_product_discovery_throttle -v
```

Expected: all throttle tests PASS.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- ludora-discovery/src/ludora/product_discovery_throttle.py ludora-discovery/tests/test_product_discovery_throttle.py
git commit -m "Add global product discovery throttle"
```

---

### Task 2: Wire one throttle through every product-detail crawler

**Files:**
- Modify: `ludora-discovery/src/ludora/operations.py`
- Modify: `ludora-discovery/src/ludora/inventory.py`
- Modify: `ludora-discovery/src/ludora/product_crawler.py`
- Modify: `ludora-discovery/src/ludora/amazon_discovery.py`
- Modify: `ludora-discovery/src/ludora/amukiri_discovery.py`
- Modify: `ludora-discovery/src/ludora/catito_discovery.py`
- Modify: `ludora-discovery/tests/test_operations.py`
- Modify: `ludora-discovery/tests/test_inventory.py`
- Modify: `ludora-discovery/tests/test_amazon_discovery.py`
- Modify: `ludora-discovery/tests/test_amukiri_discovery.py`
- Modify: `ludora-discovery/tests/test_catito_discovery.py`

**Interfaces:**
- Consumes: `ProductDiscoveryRequestThrottle` from Task 1.
- Produces: `BeforeProductRequest = Callable[[str], None]`, a `product_request_throttle` injection point on both operation functions, and `before_product_request` parameters throughout inventory/crawler functions for Task 3.

- [ ] **Step 1: Write failing operation tests for one shared throttle**

Extend `tests/test_operations.py` so `run_item_discovery(...)` receives an injected mock throttle and passes a callable to `collect_store_inventory`. Invoke that callable twice with different product URLs and assert the same throttle receives both requests.

Add `product_request_throttle` as an injectable argument to the batch in the failing test. Patch `run_item_discovery`, invoke the received throttle for two different store calls using a fake clock, and assert the two stores are paced by the exact same object:

```python
first_throttle = run_item_discovery_.call_args_list[0].kwargs["product_request_throttle"]
second_throttle = run_item_discovery_.call_args_list[1].kwargs["product_request_throttle"]
self.assertIs(first_throttle, second_throttle)
self.assertIs(first_throttle, injected_throttle)
self.assertEqual(fake_clock.waits, [3.0])
```

- [ ] **Step 2: Write failing router and crawler propagation tests**

In `tests/test_inventory.py`, pass `before_product_request = Mock()` and assert it is forwarded by `collect_store_inventory(...)` to:

- `crawl_store_product_details`
- `crawl_amazon_store_inventory`
- `crawl_amazon_brand_inventory`
- `crawl_amukiri_inventory`
- `crawl_catito_inventory`

Add a generic detail test that asserts the callback receives the product URL immediately before `fetch_html` is called. Add a transient-HTTP test that proves every static detail retry invokes the callback. Add Amukiri and Catito tests asserting their callback reaches `crawl_listing_candidates`.

In `tests/test_amazon_discovery.py`, make the detail browser fetch fail once and then succeed. Assert `before_product_request` is called twice with the product detail URL and is never called for the Amazon search URL.

- [ ] **Step 3: Run the focused tests and confirm missing-parameter failures**

```powershell
python -m unittest tests.test_operations tests.test_inventory tests.test_amazon_discovery tests.test_amukiri_discovery tests.test_catito_discovery -v
```

Expected: FAIL because operation and crawler functions do not yet accept or propagate the new throttle/callback parameters.

- [ ] **Step 4: Create a contextual callback in `operations.py`**

Add `product_request_throttle: ProductDiscoveryRequestThrottle | None = None` to `run_item_discovery(...)`. Resolve it once and build this callback after the trace logger exists:

```python
resolved_product_request_throttle = (
    product_request_throttle
    if product_request_throttle is not None
    else ProductDiscoveryRequestThrottle()
)

def before_product_request(source_url: str) -> None:
    resolved_product_request_throttle.wait_before_request(
        cancellation_token,
        on_wait=lambda wait: trace_logger.log(
            "item_discovery.product_fetch.throttle_wait",
            delay_seconds=wait.delay_seconds,
            platform=platform.strip().casefold(),
            source_url=source_url,
            store_id=store_id,
            store_name=store_name,
        ),
    )
```

Pass `before_product_request` into `collect_store_inventory(...)`.

Add the same optional injection to `run_item_discovery_batch(...)`. Resolve one `ProductDiscoveryRequestThrottle` before the store loop and pass it as `product_request_throttle` to every `run_item_discovery(...)` call. This provides deterministic cross-store tests while production callers continue to omit the argument.

- [ ] **Step 5: Thread the callback through inventory and the generic crawler**

Define this alias in `product_crawler.py`:

```python
BeforeProductRequest = Callable[[str], None]
```

Add `before_product_request: BeforeProductRequest | None = None` to `collect_store_inventory`, `crawl_store_product_details`, and `crawl_listing_candidates`.

Pass it to `_fetch_detail_candidate(..., before_request=before_product_request)`. The existing `_fetch_static_product_detail` and browser-fallback paths already call `before_request` for each network attempt, so retries and browser fallback must retain those calls.

- [ ] **Step 6: Thread the callback through specialized crawlers**

Add `before_product_request` parameters to Amukiri and Catito inventory functions and forward them to `crawl_listing_candidates`.

Add the parameter to both public Amazon inventory functions, `_crawl_amazon_search_inventory`, and `_fetch_valid_amazon_detail_page`. Call it immediately before every `browser_fetcher(source_url)` detail attempt:

```python
for attempt in range(1, attempts + 1):
    raise_if_cancelled(cancellation_token)
    if before_product_request is not None:
        before_product_request(source_url)
    fetched_detail = browser_fetcher(source_url)
```

Do not call it from `_fetch_valid_amazon_listing_page` or catalog/search enumeration functions.

- [ ] **Step 7: Run the focused wiring tests**

```powershell
python -m unittest tests.test_operations tests.test_inventory tests.test_amazon_discovery tests.test_amukiri_discovery tests.test_catito_discovery -v
```

Expected: all new propagation tests and existing focused tests PASS.

- [ ] **Step 8: Commit Task 2**

```powershell
git add -- ludora-discovery/src/ludora/operations.py ludora-discovery/src/ludora/inventory.py ludora-discovery/src/ludora/product_crawler.py ludora-discovery/src/ludora/amazon_discovery.py ludora-discovery/src/ludora/amukiri_discovery.py ludora-discovery/src/ludora/catito_discovery.py ludora-discovery/tests/test_operations.py ludora-discovery/tests/test_inventory.py ludora-discovery/tests/test_amazon_discovery.py ludora-discovery/tests/test_amukiri_discovery.py ludora-discovery/tests/test_catito_discovery.py
git commit -m "Throttle product discovery across stores"
```

---

### Task 3: Replace Shopify discovery product HTML with signed GraphQL

**Files:**
- Modify: `ludora-discovery/src/ludora/shopify_storefront.py`
- Modify: `ludora-discovery/src/ludora/product_crawler.py`
- Modify: `ludora-discovery/src/ludora/inventory.py`
- Modify: `ludora-discovery/tests/test_shopify_storefront.py`
- Modify: `ludora-discovery/tests/test_inventory.py`

**Interfaces:**
- Consumes: `before_product_request` from Task 2 and existing Storefront transport/parsing helpers.
- Produces: `_fetch_shopify_discovery_candidate(...) -> DiscoveryItemCandidateRecord | None`; `None` is the explicit stale/unpublished sitemap skip result.

- [ ] **Step 1: Write a failing GraphQL-only discovery test**

Add a new-product fixture without `store_item_id` to `tests/test_shopify_storefront.py`. Patch sitemap discovery to return its URL and patch `fetch_shopify_storefront_product` to return a valid payload. Assert:

```python
self.assertEqual(len(records), 1)
self.assertEqual(records[0].price_source, "shopify_storefront_graphql")
fetch_product.assert_called_once_with(PRODUCT_URL, request_headers_provider=headers_provider)
fetch_html.assert_not_called()
browser_fetcher.assert_not_called()
self.assertEqual(before_product_request.call_args_list, [call(PRODUCT_URL)])
```

Also assert the existing-candidate check occurs before GraphQL and prevents the request entirely.

- [ ] **Step 2: Write failing strict-sitemap and null-product tests**

In `tests/test_inventory.py`, assert a Shopify store with no sitemap product URLs raises:

```text
Shopify sitemap discovery returned no product URLs
```

Assert `fetch_html` is never called for homepage fallback.

In `tests/test_shopify_storefront.py`, return `{"data":{"product":null}}`; assert the product is omitted, the store continues, and trace event `item_discovery.candidate.shopify_graphql.not_found` contains the source URL and handle.

- [ ] **Step 3: Write failing context, throttle-retry, and security tests**

Update the existing request payload assertion to require:

```python
self.assertIn("@inContext(country: MX, language: ES)", request_payload["query"])
```

Add discovery tests for:

- HTTP 429 followed by success, honoring response `Retry-After`.
- Three HTTP 429 responses with missing headers, waiting `60.0` then `300.0` and failing the store.
- HTTP 200 GraphQL `THROTTLED` errors using the same fallback waits.
- HTTP 430 failing after one request with no retry.
- A non-throttling GraphQL error failing immediately.
- Invalid JSON and missing required title failing with bounded response/error details.

Patch `ludora.product_crawler.wait_for_discovery_delay` so tests assert wait values without sleeping.

- [ ] **Step 4: Run Shopify and inventory tests to verify the HTML path and retry failures**

```powershell
python -m unittest tests.test_shopify_storefront tests.test_inventory -v
```

Expected: FAIL because Shopify discovery still uses generic HTML and the query lacks context and discovery-specific throttle retries.

- [ ] **Step 5: Add Mexican Spanish context to the shared product query**

Change the query declaration in `shopify_storefront.py` to:

```graphql
query LudoraProduct($handle: String!) @inContext(country: MX, language: ES) {
  product(handle: $handle) {
    ...
  }
}
```

Keep the existing API version, endpoint builder, signed header provider, single HTTP request transport, parser, and normalizer.

- [ ] **Step 6: Make Shopify sitemap enumeration strict**

Pass `platform` from `collect_store_inventory(...)` to `crawl_store_product_details(...)`. After sitemap enumeration, add:

```python
normalized_platform = platform.strip().casefold()
if normalized_platform == "shopify" and not product_urls:
    raise RuntimeError(
        f"Shopify sitemap discovery returned no product URLs: {store_url}"
    )
```

This check must run before the existing generic listing-page fallback.

- [ ] **Step 7: Implement a discovery-specific Shopify GraphQL helper**

In `product_crawler.py`, add constants:

```python
SHOPIFY_DISCOVERY_MAX_THROTTLE_ATTEMPTS = 3
SHOPIFY_DISCOVERY_THROTTLE_BACKOFF_SECONDS = (60.0, 300.0)
```

Implement `_fetch_shopify_discovery_candidate(...)` using the existing endpoint, handle, request, payload, error, and extraction helpers. The helper must:

- Call `before_product_request(listing_candidate.source_url)` before every network attempt so throttle traces identify the product; include `graphql_endpoint` separately in the Shopify trace fields.
- Use `fetch_with_transient_retries` for existing timeout/transport/5xx behavior, with HTTP 429 returned immediately to the outer Shopify loop. HTTP 430 is already non-transient and must be checked and raised before payload parsing.
- Retry HTTP 429 and GraphQL throttling at most twice.
- Use `fetched.retry_after_seconds` when present; otherwise select `60.0` then `300.0` by attempt.
- Log attempt number, maximum attempts, status, GraphQL error messages, retry delay, and bounded response excerpts without headers.
- Raise immediately for HTTP 430 and permanent errors.
- Return `None` and log `item_discovery.candidate.shopify_graphql.not_found` for a null product.
- Return `extract_shopify_storefront_candidate(...)` for a valid product.

Use this retry branch:

```python
if throttled:
    if attempt >= SHOPIFY_DISCOVERY_MAX_THROTTLE_ATTEMPTS:
        raise TransientProductFetchError(
            message,
            retry_after_seconds=fetched.retry_after_seconds,
            status_code=429,
        )
    retry_in_seconds = (
        fetched.retry_after_seconds
        if fetched.retry_after_seconds is not None
        else SHOPIFY_DISCOVERY_THROTTLE_BACKOFF_SECONDS[attempt - 1]
    )
    trace.log(
        "item_discovery.candidate.shopify_graphql.retry_scheduled",
        attempt=attempt,
        max_attempts=SHOPIFY_DISCOVERY_MAX_THROTTLE_ATTEMPTS,
        retry_in_seconds=retry_in_seconds,
        source_url=listing_candidate.source_url,
    )
    wait_for_discovery_delay(retry_in_seconds, cancellation_token)
    continue
```

- [ ] **Step 8: Route Shopify candidates to GraphQL before generic detail fetching**

Add `platform: str = ""` as a keyword-only argument to `crawl_listing_candidates(...)`, pass the store platform from `crawl_store_product_details(...)`, and retain the empty default for specialized non-Shopify callers. Inside the existing-candidate-skipping loop:

```python
if platform.strip().casefold() == "shopify":
    detail_candidate = _fetch_shopify_discovery_candidate(
        listing_candidate,
        source_listing_url=listing_candidate.source_listing_url or source_listing_url,
        cancellation_token=cancellation_token,
        trace_logger=trace,
        before_product_request=before_product_request,
        request_headers_provider=request_headers_provider,
    )
    if detail_candidate is None:
        continue
else:
    detail_candidate = _fetch_detail_candidate(
        listing_candidate=listing_candidate,
        source_listing_url=listing_candidate.source_listing_url or source_listing_url,
        platform=platform,
        browser_fetcher=browser_fetcher,
        item_detail_extractor=item_detail_extractor,
        trace_logger=trace,
        cancellation_token=cancellation_token,
        before_request=before_product_request,
        request_headers_provider=request_headers_provider,
    )
```

Do not pass a browser fetcher to the Shopify helper and do not catch its permanent/throttle failures as product-level skips.

- [ ] **Step 9: Run the Shopify and inventory tests**

```powershell
python -m unittest tests.test_shopify_storefront tests.test_inventory -v
```

Expected: GraphQL-only discovery, context, retry, null skip, and strict sitemap tests PASS; confirmed-item update GraphQL tests remain PASS.

- [ ] **Step 10: Commit Task 3**

```powershell
git add -- ludora-discovery/src/ludora/shopify_storefront.py ludora-discovery/src/ludora/product_crawler.py ludora-discovery/src/ludora/inventory.py ludora-discovery/tests/test_shopify_storefront.py ludora-discovery/tests/test_inventory.py
git commit -m "Use GraphQL for Shopify product discovery"
```

---

### Task 4: Continue batch discovery after store failures and fail the parent at the end

**Files:**
- Modify: `ludora-discovery/src/ludora/operations.py`
- Modify: `ludora-discovery/tests/test_operations.py`
- Modify: `ludora-discovery/tests/test_operation_cli.py`

**Interfaces:**
- Consumes: shared `product_request_throttle` injection from Task 2.
- Produces: `ItemDiscoveryStoreFailure` and `ItemDiscoveryBatchError.failures`, plus an aggregate CLI/admin operation failure after all stores have been attempted.

- [ ] **Step 1: Write a failing continue-after-failure test**

In `tests/test_operations.py`, configure three stores and patch `run_item_discovery` with failure, success, failure. Assert all three calls occur in order and the same throttle is passed to each.

Assert the raised `ItemDiscoveryBatchError` contains two immutable failures:

```python
self.assertEqual(
    [(failure.store_id, failure.store_name) for failure in raised.exception.failures],
    [(12, "Alpha Games"), (56, "Gamma Games")],
)
self.assertIn("Alpha Games", str(raised.exception))
self.assertIn("Gamma Games", str(raised.exception))
```

Add a test that `OperationCancelled` aborts immediately and does not attempt later stores.

- [ ] **Step 2: Write a failing CLI aggregate-error test**

In `tests/test_operation_cli.py`, patch `run_item_discovery_batch` to raise an `ItemDiscoveryBatchError`. Assert `main(...)` returns `1`, writes one bounded JSON error to stderr, and does not print a success result to stdout.

- [ ] **Step 3: Run the focused operation tests**

```powershell
python -m unittest tests.test_operations tests.test_operation_cli -v
```

Expected: FAIL because the current batch stops at the first store exception and no aggregate error type exists.

- [ ] **Step 4: Add immutable failure records and a bounded aggregate error**

In `operations.py` add:

```python
ITEM_DISCOVERY_STORE_ERROR_MAX_LENGTH = 500
ITEM_DISCOVERY_BATCH_ERROR_MAX_LENGTH = 4000


@dataclass(frozen=True)
class ItemDiscoveryStoreFailure:
    store_id: int
    store_name: str
    error: str


class ItemDiscoveryBatchError(RuntimeError):
    def __init__(self, failures: list[ItemDiscoveryStoreFailure]) -> None:
        self.failures = tuple(failures)
        summary = "; ".join(
            f"{failure.store_id} ({failure.store_name}): {failure.error}"
            for failure in self.failures
        )
        message = f"Item discovery batch failed for {len(self.failures)} store(s): {summary}"
        if len(message) > ITEM_DISCOVERY_BATCH_ERROR_MAX_LENGTH:
            message = f"{message[:ITEM_DISCOVERY_BATCH_ERROR_MAX_LENGTH - 3]}..."
        super().__init__(message)
```

Declare named constants for the 500-character per-store error limit and 4,000-character aggregate-message limit rather than leaving magic values in production code. Normalize empty store names to `Store <id>` and truncate each source exception string before constructing the failure record. The immutable `failures` tuple and the batch trace retain every failed store even when the human-facing aggregate string is truncated. Extend the test to assert `len(str(raised.exception)) <= 4000` for long failures.

- [ ] **Step 5: Catch store failures, continue, and aggregate after the loop**

Wrap only the per-store `run_item_discovery(...)` call:

```python
failures: list[ItemDiscoveryStoreFailure] = []
for store in stores:
    raise_if_cancelled(cancellation_token)
    try:
        result = run_item_discovery(...)
    except OperationCancelled:
        raise
    except Exception as exc:
        failure = ItemDiscoveryStoreFailure(
            store_id=store.store_id,
            store_name=store.store_name.strip() or f"Store {store.store_id}",
            error=(str(exc).strip() or type(exc).__name__)[
                :ITEM_DISCOVERY_STORE_ERROR_MAX_LENGTH
            ],
        )
        failures.append(failure)
        continue
    # Accumulate successful result counters exactly as today.

```

Keep the existing per-store logging in `run_item_discovery`; it marks the failed child store job before the batch catches the exception. Successful stores remain committed and completed.

- [ ] **Step 6: Add aggregate trace/error context**

Do not retain the initial store-listing database connection during the globally throttled batch; a batch can run for hours. After the store loop records failures, open a fresh short-lived connection, create a batch trace logger using `resolved_run_id`, log the summary below, and close the connection in `finally`:

```python
batch_trace.log(
    "item_discovery.batch.failed",
    failed_store_count=len(failures),
    failed_stores=[
        {"store_id": failure.store_id, "store_name": failure.store_name, "error": failure.error}
        for failure in failures
    ],
    stores_attempted=len(stores),
)
```

Then construct the aggregate error, write the trace, and raise in that order:

```python
if failures:
    batch_error = ItemDiscoveryBatchError(failures)
    _log_item_discovery_batch_failure(
        database_url=database_url,
        run_id=resolved_run_id,
        failures=failures,
        stores_attempted=len(stores),
    )
    raise batch_error
```

Implement `_log_item_discovery_batch_failure(...)` so connection creation, trace logging, and cleanup are best effort; an unavailable trace connection must never replace the aggregate batch exception. Add tests that the short-lived connection is closed after the summary and that a trace connection or logger failure still results in the original aggregate error. Do not create a new table or parent job row.

- [ ] **Step 7: Run operation and CLI tests**

```powershell
python -m unittest tests.test_operations tests.test_operation_cli -v
```

Expected: continuation, aggregation, cancellation, JSON error, and existing success tests PASS.

- [ ] **Step 8: Commit Task 4**

```powershell
git add -- ludora-discovery/src/ludora/operations.py ludora-discovery/tests/test_operations.py ludora-discovery/tests/test_operation_cli.py
git commit -m "Continue discovery after store failures"
```

---

### Task 5: Document behavior and run complete regression verification

**Files:**
- Modify: `ludora-discovery/README.md`
- Modify: `docs/production-deployment.md`
- Verify: all files changed since the plan base

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: repository-owned operating guidance and final verification evidence; no runtime interface changes.

- [ ] **Step 1: Update discovery documentation**

Add a concise section to `ludora-discovery/README.md` stating:

- Product-detail requests are globally start-paced at three seconds across a discovery process.
- The throttle spans all stores in a batch and applies to retries.
- Shopify requires sitemap enumeration and uses signed GraphQL product details only.
- Shopify has no HTML or GraphQL-enumeration fallback.
- Null products are skipped and logged.
- Failed stores do not stop the batch, but any store failure makes the parent batch fail after all stores run.

- [ ] **Step 2: Update production runbook behavior**

In `docs/production-deployment.md`, add the same operational contract near the discovery configuration section. Explicitly state that deployment smoke tests do not start a discovery run because it persists candidates and job/trace data.

- [ ] **Step 3: Run the focused cross-component discovery tests**

```powershell
python -m unittest tests.test_product_discovery_throttle tests.test_shopify_storefront tests.test_inventory tests.test_amazon_discovery tests.test_amukiri_discovery tests.test_catito_discovery tests.test_operations tests.test_operation_cli -v
```

Expected: all focused tests PASS with no real waits or network requests.

- [ ] **Step 4: Run the full discovery suite**

```powershell
python -m unittest discover -s tests -v
```

Expected: all discovery tests PASS.

- [ ] **Step 5: Run repository verification**

From `ludora-admin`:

```powershell
git diff --check
git status --short
```

Expected: `git diff --check` exits `0`; status lists only the intended uncommitted documentation changes before the final commit.

If TypeScript operation contracts changed during implementation despite the plan's Python-only contract, also run:

```powershell
Set-Location ludora-admin-service
npm run build
```

Expected: TypeScript build exits `0`.

- [ ] **Step 6: Commit Task 5**

```powershell
git add -- ludora-discovery/README.md docs/production-deployment.md
git commit -m "Document GraphQL discovery pacing"
```

- [ ] **Step 7: Verify the final committed branch**

```powershell
git status --short
git log -6 --oneline
git diff --check afc5fa070288e99326bd3fcd6e1c5346730aa337..HEAD
```

Expected: clean status, the task commits are visible, and every committed change since the approved design-spec commit has no whitespace errors.

Do not apply SQL, start a local or production discovery operation, push, merge, or deploy as part of this task unless the user separately authorizes those actions.
