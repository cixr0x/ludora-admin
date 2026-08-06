# Shopify GraphQL Discovery and Global Product-Fetch Throttling Design

## Context

Shopify item updates already use signed Storefront GraphQL requests, but new-item discovery still enumerates products and then fetches each Shopify product detail page as HTML. Those high-volume HTML detail requests are repeatedly receiving HTTP 429 responses and make Shopify store discovery unreliable.

The change described here stabilizes discovery before daily discovery automation is added. It replaces Shopify product-detail HTML requests with the existing Storefront GraphQL path and adds one shared product-detail request throttle across the entire discovery process and every store.

Daily discovery scheduling itself is outside this design.

## Goals

- Use Storefront GraphQL exclusively for Shopify product details during discovery.
- Keep signed XML sitemaps as the required Shopify product enumerator.
- Enforce at least three seconds between product-detail request starts across all stores and platforms in one discovery process.
- Retry Shopify throttling conservatively, then fail the affected store rather than silently completing partially.
- Continue an all-store batch after an individual store fails and report the parent batch as failed at the end.
- Preserve successful product work so a later run resumes instead of repeating it.
- Make throttle, retry, skip, and failure decisions visible through existing discovery traces and job records.

## Non-goals

- Automating the daily discovery schedule.
- Replacing sitemap enumeration with Storefront GraphQL pagination.
- Falling back to Shopify homepage, listing, product HTML, or browser-rendered product pages.
- Recovering gameplay, theme, player-count, duration, age, or language metadata that Storefront GraphQL does not expose tokenlessly.
- Coordinating throttling across multiple Python processes or VMs.
- Adding database schema, migration, or admin UI changes.

## Architecture

### Process-wide product-detail throttle

A cancellation-aware `ProductDiscoveryRequestThrottle` will enforce a minimum three-second interval between product-detail request start times.

The throttle is shared as follows:

- A single-store discovery run creates one throttle for that Python process.
- A batch discovery run creates one throttle and passes the same instance through every store in the batch.
- Every product-detail attempt uses that instance, regardless of store, host, or platform.
- Retry attempts and browser-detail fallbacks acquire another throttle slot.

The normal admin VM path permits one active discovery operation at a time, so an in-memory process-wide coordinator covers the supported production execution path. A database-backed distributed throttle is unnecessary for this scope.

The interval is measured start-to-start with a monotonic clock. If one request takes longer than three seconds, the following request may start immediately after it completes because its start time is already more than three seconds after the preceding start. Backoff waits may make the effective interval longer, but never shorter.

Throttle waits must be cancellation-aware. Cancellation during a throttle or retry wait stops the run without issuing another request.

### Throttled request boundary

The throttle applies only to network calls that fetch one product's detail:

- Shopify Storefront GraphQL product-by-handle requests.
- Generic static product-detail HTML requests for non-Shopify stores.
- Product-detail browser fallbacks.
- Amazon and other specialized crawler requests that fetch one product's detail.
- Every retry of those requests.

The throttle does not apply to:

- Sitemap requests.
- Store homepage or listing enumeration for non-Shopify stores.
- Search and listing pagination.
- One inventory response that contains multiple products without separate per-product detail requests.
- AI classification, admin matching, BGG lookup, or persistence calls.

Specialized crawlers must receive the shared throttle or an equivalent `before_product_request` callback so they cannot accidentally bypass the process-wide rule.

## Shopify Discovery Data Flow

1. The discovery run obtains Shopify product URLs from the store's signed XML sitemap flow.
2. If sitemap fetching fails, is blocked, or produces no product URLs, the store discovery fails. There is no homepage HTML fallback and no GraphQL product-pagination fallback.
3. Product URLs already present for the store continue to be skipped before any detail request.
4. For each new product URL, discovery waits for the shared product-detail throttle.
5. Discovery extracts the Shopify handle and sends the existing Web Bot Auth-signed Storefront GraphQL POST request.
6. The product query uses the existing supported API version and `@inContext(country: MX, language: ES)`.
7. The existing Shopify GraphQL normalizer produces the discovery candidate from title, description, vendor, image, variants, SKU, price, currency, and availability. Product type remains available in the retained raw GraphQL payload.
8. The candidate continues through the existing classification, upsert, and item-matching pipeline.

Shopify discovery must never invoke static or browser product-detail HTML as a fallback.

The normalized candidate may omit gameplay and theme metadata previously extracted from theme-specific HTML. The complete GraphQL product payload remains available in `raw_payload.shopify_graphql`, and downstream enrichment may populate missing catalog metadata later.

## Shopify Response Handling

### Published product

A valid GraphQL product is normalized and processed through the existing discovery pipeline.

### Null product

`data.product: null` means the sitemap entry is stale, unpublished, or unavailable to the Storefront API. Discovery logs a bounded skip event containing the store and product URL, then continues with the next product. It does not fall back to HTML and does not fail the store.

### Throttling

HTTP 429 and GraphQL errors with a throttling code or message use three total attempts:

1. Initial attempt.
2. First retry after `Retry-After`, when present, otherwise 60 seconds.
3. Second retry after `Retry-After`, when present, otherwise five minutes.

The process-wide three-second throttle is acquired before every attempt in addition to the retry backoff. If the third attempt is also throttled, the store discovery fails.

### Security rejection

HTTP 430 is treated as a Shopify security rejection rather than an ordinary rate limit. The store fails immediately with bounded diagnostic details and no HTML fallback.

### Other failures

- Existing bounded transient retry behavior remains for timeouts, transport failures, and HTTP 5xx responses, with the process-wide throttle applied before each attempt.
- Permanent HTTP errors, non-throttling GraphQL errors, invalid JSON, invalid product URLs, or malformed required product fields fail the store.
- Signed request headers, private keys, tokens, and other authentication material are never logged.

## Persistence and Resumption

Discovery remains incrementally persistent. If a store fails on product 80, products 1 through 79 that completed successfully remain saved.

The next discovery run enumerates the sitemap again, skips those existing product URLs before detail fetching, and resumes work on products that were not saved. A failed store is therefore explicitly incomplete without discarding valid completed work or repeating successful GraphQL calls.

## Batch Failure Semantics

An all-store batch processes stores sequentially and shares one product-detail throttle across them.

When one store fails:

- Its existing per-store discovery job is marked failed with a bounded error.
- The batch records the store ID, store name, and error summary.
- The batch continues with the next store using the same throttle.
- Successful stores retain their normal completed status and persisted products.

After all stores have been attempted, any recorded store failure raises one aggregate batch error containing a summary of every failed store. The parent discovery operation therefore finishes with status `failed`; it must not report success when a store did not complete.

## Observability

The existing discovery trace and job-detail surfaces will expose the behavior without new UI or schema.

Trace coverage includes:

- Product-fetch throttle waits with duration, platform, store ID, and product URL.
- Shopify GraphQL attempt start and completion.
- HTTP status, GraphQL error code, attempt number, maximum attempts, `Retry-After`, and selected backoff for failures.
- Null-product skips.
- Final per-store failure.
- End-of-batch failed-store summary.

Response excerpts and errors remain bounded. Request bodies may be logged only if they contain no credentials; signed request headers must never be logged.

## Testing Strategy

### Shared throttle

- Use fake clock and wait functions to prove a minimum three-second start-to-start interval.
- Prove spacing is shared across different stores, hosts, and platforms.
- Prove retry and browser-detail attempts acquire throttle slots.
- Prove cancellation interrupts throttle and backoff waits before another request begins.
- Prove long-running requests do not incur an unnecessary additional delay after the three-second start interval has already elapsed.

### Shopify discovery

- Sitemap URL enumeration leads to signed Storefront GraphQL POST requests for new products.
- The GraphQL query includes Mexican Spanish context.
- Existing product URLs are skipped before GraphQL.
- Static HTML, browser HTML, homepage fallback, and GraphQL enumeration pagination are never called for Shopify.
- Sitemap failure or an empty sitemap fails the store.
- A valid product is normalized, classified, persisted, and processed.
- A null product is traced and skipped.
- HTTP 429 and GraphQL throttling honor `Retry-After` or the 60-second and five-minute defaults.
- Persistent throttling fails the store after three attempts.
- HTTP 430 fails immediately.
- Permanent GraphQL and malformed-response failures fail the store with bounded diagnostics.

### Batch behavior

- One throttle instance is shared across successive stores.
- A failed store does not prevent later stores from running.
- Successful stores retain completed status and persisted work.
- The parent operation reports status `failed` after processing all stores and includes every failed store in its aggregate error.

### Regression verification

- Focused Shopify, inventory, specialized-crawler, operations, and cancellation tests.
- Full Python discovery test suite.
- Admin-service tests and build if the operation result contract changes.
- `git diff --check` before integration.

## Deployment and Verification

This design requires no DDL or DML patch.

Deployment will use the repository-owned exact-SHA Ludora admin VM workflow after implementation and approval. Routine deployment verification must remain read-only. Starting a live discovery run is a mutating operational action and is not an automatic smoke test; it requires separate authorization or an explicit user request.

## Acceptance Criteria

- Shopify discovery makes no product-detail HTML request under any outcome.
- Shopify discovery requires sitemap enumeration and does not paginate GraphQL for enumeration.
- New Shopify product details use signed Storefront GraphQL in Mexican Spanish context.
- Every per-product detail request in a discovery process is globally spaced at least three seconds from the preceding per-product detail request start.
- Retry attempts cannot bypass the global throttle.
- Persistent Shopify throttling fails that store after the approved retry sequence.
- A failed store does not stop an all-store batch from attempting remaining stores.
- A batch with any store failure cannot report full success.
- Null Shopify products are logged and skipped.
- Existing candidates and successfully persisted partial work are not fetched again on the next run.
- Existing traces provide enough bounded detail to identify throttling, retry, skip, and final-failure causes without exposing credentials.
