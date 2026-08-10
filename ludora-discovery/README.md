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

Browser fallback uses the installed Chrome executable when available. You can override it with:

```powershell
$env:LUDORA_BROWSER_EXECUTABLE_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
```

## Product-detail pacing and Shopify discovery

Product-detail requests are globally start-paced at three seconds across a discovery process. The throttle spans every store in a batch and also applies to retry attempts.

Shopify discovery enumerates product URLs from the sitemap and fetches each product detail through signed Storefront GraphQL only. It has no HTML fallback and does not use GraphQL for product enumeration. A null Shopify product is skipped and logged. A failed store does not stop the remaining stores in the batch, but any store failure causes the parent batch to fail after all stores have run.

Item discovery uses the AI classifier by default. It calls the private loopback CodexAPI `/responses` endpoint, stores the returned reasoning in `classification_reasons`, and fails the discovery run if the classifier request or response contract fails. The OpenAI-compatible request format is transport-only; do not add an official OpenAI Responses or Chat Completions fallback. The classifier itself runs inside the Python discovery operation as the intentional existing direct CodexAPI caller:

```text
AI_ENABLED_CLASSIFIER=true
CODEX_API_BASE_URL=http://127.0.0.1:3001/v1
CODEX_CLASSIFIER_MODEL=gpt-5.4-mini
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
