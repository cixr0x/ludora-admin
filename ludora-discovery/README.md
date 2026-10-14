# Ludora

Collect Mexican online boardgame and tabletop store listings with the Brave Search API.

The collector searches Brave, deduplicates candidate store domains, fetches each store website, and stores dirty discovery records in Postgres with:

- `store_name`
- `canonical_domain`
- `website_url`
- `instagram_url`
- `facebook_url`
- `city`
- `state`
- `country`
- `store_logo`
- `status`
- `confidence`
- `source_queries`
- `evidence`

The filter is intentionally strict: accepted results must look like Mexican online stores that sell board games, tabletop games, card games, miniatures, or TCG products. Marketplaces, social-only pages, blogs, news, publishers, and event pages are excluded where possible.

## Quick Start

From `C:\PROJECTS\ludora\ludora-admin\ludora-discovery`:

```powershell
python .\scripts\collect_boardgame_stores_mx.py --query-scope expanded --verbose
```

The script reads `BRAVE_SEARCH_API_KEY`, `LUDORA_DATABASE_URL`, and BGG configuration from `.env` by default:

```text
BRAVE_SEARCH_API_KEY=your_brave_key_here
LUDORA_DATABASE_URL=postgresql://user:password@localhost:5432/ludora
BGG_API_TOKEN=your_bgg_token_here
BGG_API_BASE_URL=https://boardgamegeek.com/xmlapi2
```

You can still override them with environment variables, `--api-key`, or `--database-url`.

Database output:

```text
discovery_store_candidates
```

## Database Persistence

Use incremental patches in `..\database\patches` for existing databases. The shared `schema.sql` file is a snapshot/reference and is not the routine update mechanism.

Apply only the patch required by the change after explicit DDL/DML approval:

```powershell
psql "$env:LUDORA_DATABASE_URL" -f ..\database\patches\YYYYMMDD_NNN_description.sql
```

Store candidates are persisted by default. To also extract raw listing candidates from accepted store homepages:

```powershell
python .\scripts\collect_boardgame_stores_mx.py --collect-listings --listing-limit 100
```

The database path writes only dirty discovery tables. Curated `stores`, `items`, and `offers` are created by the admin workflow.

## Optional Discovery API

The admin service runs discovery operations locally by default. The HTTP API is kept for direct debugging and fallback testing with `LUDORA_DISCOVERY_RUNNER=http`.

Run the local operations API only when you need direct debugging or HTTP fallback testing:

```powershell
$env:PYTHONPATH='src'
python -m ludora.api --host 127.0.0.1 --port 8001
```

The API reads `BRAVE_SEARCH_API_KEY`, `LUDORA_DATABASE_URL`, and `BGG_API_TOKEN` from `.env` by default, matching the CLI. For local development you can point it at the admin-service env file if that is where the shared credentials live:

```powershell
python -m ludora.api --host 127.0.0.1 --port 8001 --env-file ..\ludora-admin-service\.env
```

Some stores block plain HTTP crawlers but allow a real browser session to read their product sitemap and product pages. Enable the browser-backed fallback before starting the API:

```powershell
$env:LUDORA_BROWSER_FETCH_ENABLED='true'
```

Moonlight discovery (`moonlightgamestore.com` and its `www` alias) uses a separate
plain HTTP request profile for sitemaps, homepage fallback, and product details.
Its default User-Agent is the deployed Chromium identity validated on 2026-10-11:
`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36`.
After validating a newer identity, set `LUDORA_MOONLIGHT_USER_AGENT` in the worker
environment or the discovery operation's `.env`/`env_file`; the environment takes
precedence. Do not append the collector identifier, which the site rejected.
This profile does not change other stores or Shopify Web Bot Auth.

Moonlight's crawl fails on HTTP 403 before attempting browser fallback or another
URL. It also fails on three consecutive observed connection refusals across
static and browser fetches; successful access resets the counter. The existing
failed-job path retains saved progress and marks coverage as interrupted. Product
request pacing remains at least three seconds, and browser rendering fallback
remains available for otherwise accessible pages.

Browser fallback uses the installed Chrome executable when available. You can override it with:

```powershell
$env:LUDORA_BROWSER_EXECUTABLE_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
```

## Chocita continuous item updates

The continuous updater uses Chocita's public WooCommerce Store API for stores
whose database `canonical_domain` is exactly `chocitajuegos.com`, platform is
`woocommerce`, and product source URL has the exact HTTPS Chocita origin. Other
stores keep their existing refresh flow. The adapter is not tied to a particular
numeric store ID.

A claimed item starts one targeted request to `/wp-json/wc/store/v1/products`
with up to 100 product slugs, `per_page=100`, and only the price/stock/identity
fields. The targets are the claimed product plus the oldest eligible existing
store items, excluding competing active non-rejected representatives of the same
source URL and items still in failure backoff or leased elsewhere. Inactive
direct or completed redirect history sharing a target URL does not compete with
its active representative. Slugs select API results; only an exact returned
`permalink` matching a unique requested source URL establishes product identity.
The encoded request URL is limited to 8,000 bytes, so unusually long slugs can
reduce the batch size. There is no catalog page scan or inline HTTP retry.

Each response is cached within that worker session for at most ten minutes,
with a maximum of 100 targets. Entries are scoped by store ID, store item ID, and
exact source URL, consumed once, and discarded on a new batch or worker restart.
Missing or invalid targets also have bounded negative entries. Each subsequent
item still obtains its own normal lease and completes through the existing
timestamp, scheduling, failure-counter and change-log paths. The adapter changes
only price, currency, stock, and their source fields; titles, images, SKU, catalog
associations, confirmation and listing visibility are preserved.

Supported products are purchasable simple products with an explicit null price
range, a positive current `prices.price`, MXN currency, integer minor unit 0–2,
and explicit boolean stock state. The current price, including sale pricing, is
normalized using that minor unit. Missing, duplicate, malformed, ranged, variable,
or unsupported results fail the affected attempt without overwriting product
values or deactivating it. API failures never fall back to HTML, browser, or AI.
HTTP 429 retains its status and `Retry-After` and follows the existing store
cooldown and item retry policy; cached results are invalidated.

Actual API request starts are spaced at least 15 seconds apart. Cache hits do
not wait. An early cache miss can hold the shared worker for at most the remaining
15-second pacing interval plus one HTTP request (the normal 20-second timeout),
then other stores continue. Trace events under `item_update.item.woocommerce_batch`
include the batch ID, request URL, cache hit and snapshot age, together with the
current item/attempt context.

This pacing is local to the continuous worker session. Discovery is a separate
process and retains its current behavior; its requests do not share this throttle.
The existing cooldown is respected and is not reset by enabling the adapter. No
database migration or immediate catalog refresh is required to deploy this code.

## Product-detail pacing and Shopify discovery

Product-detail requests are globally start-paced at three seconds across a discovery process. The throttle spans every store in a batch and also applies to retry attempts.

Discovery still enumerates listings, sitemaps, and Amazon search pages to find new URLs. Before requesting a product, it skips any URL already recorded for that store as either `source_url` or `source_url_origin`, including pending, failed, inactive, and unclassified rows. URL identity is exact after fragment removal; HTTP and HTTPS remain distinct. Early skips emit `inventory.candidate.skipped_existing` (or `amazon_inventory.candidate.skipped_existing`) with `stage=before_fetch` and perform no classification, matching, or persistence. New URLs retain post-fetch redirect validation and pair reconciliation. Existing item refreshes remain the updater's responsibility.

Shopify discovery enumerates product URLs from the sitemap and fetches new product details through signed Storefront GraphQL only. It has no HTML fallback and does not use GraphQL for product enumeration. A null Shopify product is skipped and logged. A failed store does not stop the remaining stores in the batch, but any store failure causes the parent batch to fail after all stores have run.

Two stores use domain-specific catalog discovery because their public storefronts do not expose compatible product sitemaps:

- `demonjuegosdemesa.com` walks the storefront's `scpp`/`spage` catalog pages with browser request headers, recognizes root-level product URLs, and reads product identity, price, SKU, and availability from schema.org microdata. Blank source product cards are traced and left unpersisted.
- `diadejuegos.mx` reads category IDs from the public sitemap page, walks the theme's paginated `diadjuegoscms` catalog endpoint, deduplicates category overlap by PrestaShop product ID, and treats the endpoint's explicit price and stock as authoritative over unrelated product-page text.

Nalua (`naluajuegos.com` and `www.naluajuegos.com`) combines sitemap URLs with
every page of its complete `/2-inicio` catalog, following same-catalog
`rel="next"` links while preserving `?page=`. When standard sitemap paths yield
no products, discovery reads same-store `Sitemap:` directives from optional
`robots.txt`, including nested indexes with duplicate/cycle guards. Nalua's
numeric-ID `.html` product routes are recognized at the root and under arbitrary
categories; this recognition is restricted to its exact hosts.

Catalog URLs take precedence over sitemap aliases of the same PrestaShop product
ID, and sitemap-only IDs still enter the normal detail pipeline. Catalog traces
record each page's count, advertised total, enumerated total, and merged sitemap
count. Missing pages, invalid pagination, repeated products, and coverage
mismatches fail the run; a requested limit emits an explicit partial-coverage
trace. Traversal is bounded at 500 pages. Enumeration performs no product-detail,
AI, or repository work. A read-only URL probe can call
`ludora.nalua_discovery.discover_nalua_product_urls("https://naluajuegos.com/")`
with an in-memory trace logger.

Item discovery uses the AI classifier by default. It calls the private loopback CodexAPI `/responses` endpoint, stores the returned reasoning in `classification_reasons`, and fails the discovery run if the classifier request or response contract fails. The OpenAI-compatible request format is transport-only; do not add an official OpenAI Responses or Chat Completions fallback. The classifier itself runs inside the Python discovery operation as the intentional existing direct CodexAPI caller:

```text
AI_ENABLED_CLASSIFIER=true
CODEX_API_BASE_URL=http://127.0.0.1:3001/v1
CODEX_CLASSIFIER_MODEL=gpt-5.6-terra
```

`OPENAI_BASE_URL` and `OPENAI_CLASSIFIER_MODEL` are legacy loopback compatibility aliases only. Set `AI_ENABLED_CLASSIFIER=false` to use the older heuristic classifier.

Amazon store item discovery calls the admin-service AI endpoint to normalize Amazon product titles before saving `store_items`. The route is `POST /admin/ai/amazon-title-extractions`, and it uses the shared admin-service AI configuration described in `..\docs\ai-api-flow.md`.

Discovery-to-admin calls use `LUDORA_ADMIN_API_URL` plus the `X-Ludora-Internal-Token` header sourced from `LUDORA_INTERNAL_API_TOKEN`. Normal local admin-service runs generate this token and pass it to the Python subprocess automatically. If an internal admin call fails, discovery raises the error so the run is marked failed instead of silently storing partial data.

Amazon supports two platform modes:

- `amazon`: `website_url` is an Amazon Stores page. Discovery builds the store search URL from the page ID.
- `amazon_brand`: `website_url` is an Amazon search URL such as `https://www.amazon.com.mx/s?srs=19815643011&rh=p_89%3AHasbro%2BGaming`. Discovery crawls up to 5 result pages and only stores detail pages whose Amazon `Marca` value matches the configured store `name`.

Item embeddings use the official OpenAI embeddings endpoint only. CodexAPI does not support embeddings, so `CODEX_API_BASE_URL` and its legacy aliases are not used for embedding runs; configure `OPENAI_API_KEY=<embeddings only>` and `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`.

For new AI-backed discovery tasks, add the prompt and CodexAPI client to admin-service, expose an admin endpoint, and call that endpoint from Python. The direct Python classifier is the existing intentional CodexAPI caller; embeddings remain official-OpenAI-only by design. AI BGG matching is owned by admin-service: it checks local and BGG cache candidates first, validates any CodexAPI decision against a BGG thing, records the verified title association in the cache, and then performs the normal BGG import.

Classifier results with `LIKELY_NON_BOARDGAME` and confidence greater than `60` are auto-confirmed as not boardgames.

Available endpoints:

```text
GET  /health
POST /operations/store-discovery-runs
POST /operations/stores/{store_id}/item-discovery-runs
POST /operations/item-update-runs
POST /operations/item-embedding-runs
POST /operations/store-discovery-runs/{run_id}/cancel
GET  /operations/store-discovery-runs/latest
GET  /operations/store-discovery-runs/{run_id}
```

## Product-discovery coordinator

Scheduled and manual all-store item-discovery runs select active stores only. Explicit store IDs remain targetable, including when a store is inactive. One product-discovery job may run at a time across batch and single-store entry points; a second product-discovery start is rejected with HTTP `409`.

This product-discovery lock is independent from the continuous item-update lock. Discovery and continuous item updates may run concurrently.

To also export the old CSV/JSON files for manual inspection:

```powershell
python .\scripts\collect_boardgame_stores_mx.py --export-files --output-dir data
```

When `--export-files` is enabled, audit files include every discovered candidate domain that reached enrichment, including rejected domains and the rejection reasons. Use them to understand why a store you expected did not make the final dataset.

Preview the search queries without spending API credits:

```powershell
python .\scripts\collect_boardgame_stores_mx.py --dry-run-queries --query-scope core
```

For broader coverage:

```powershell
python .\scripts\collect_boardgame_stores_mx.py --query-scope full --pages 10 --verbose
```

That uses more Brave requests. Brave Web Search supports up to 20 results per request and offsets up to 9, so `--pages 10` is the broadest setting per query. `expanded` is the default balance between coverage and API usage.

## Options

```text
--query-scope core|expanded|full
--max-queries N
--count N
--pages N
--output-dir data
--env-file .env
--request-delay 1.1
--website-delay 0.3
--max-enrichment-pages 3
--include-low-confidence
--database-url postgresql://...
--collect-listings
--listing-limit 100
--export-files
--dry-run-queries
--verbose
```

## Development

Run tests:

```powershell
python -m unittest discover -s tests -v
```

Optional editable install:

```powershell
python -m pip install -e .
ludora-collect-stores --dry-run-queries
```

Estimate whether a flat reference image appears inside a larger or perspective-distorted candidate image:

```powershell
$env:PYTHONPATH='src'
python -m ludora.image_similarity .\reference-cover.jpg .\product-photo.jpg
```

The command prints the same `sift_homography_v1` JSON result used by the admin service. Its `score` is a calibratable `0..100` signal rather than a probability or a built-in match threshold.

## Spanish Cover Asset Workflow

Use the cover asset helper when a scraped store image has the right Spanish box art but needs a manual crop/perspective edit.

Stage the source image and open it in GIMP:

```powershell
python .\scripts\cover_asset_workflow.py stage "https://store.example/game-box.jpg" --name "Catan Piratas y Exploradores" --s3-prefix "covers/es" --open-editor
```

Export the corrected flat cover from GIMP to the printed `edited.png` path. Then create the final WebP:

```powershell
python .\scripts\cover_asset_workflow.py finish ".\output\cover-assets\catan-piratas-y-exploradores" --public-base-url "https://cdn.example.com" --copy-url
```

To upload to S3 during `finish`, configure:

```text
LUDORA_COVER_S3_BUCKET=your-bucket
LUDORA_COVER_S3_PREFIX=covers/es
LUDORA_COVER_PUBLIC_BASE_URL=https://cdn.example.com
```

Then run:

```powershell
python .\scripts\cover_asset_workflow.py finish ".\output\cover-assets\catan-piratas-y-exploradores" --upload --copy-url
```
# ludora-search
# ludora-discovery
