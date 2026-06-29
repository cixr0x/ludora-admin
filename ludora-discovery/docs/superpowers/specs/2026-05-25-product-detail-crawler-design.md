# Product Detail Crawler V1 Design

## Goal

Build the first inventory crawler for Ludora Discovery. The crawler starts from curated stores, finds product detail pages, visits each page, extracts board game or expansion data, and stores dirty item candidates for admin review.

The crawler is not expected to perfectly normalize items in v1. Its job is to capture useful product-level evidence from Mexican board game stores, preserve the raw extraction context, and keep candidate records fresh enough for later matching and curation.

## Scope

In scope:

- Crawl approved stores from the clean `stores` table.
- Discover likely product links from store pages.
- Visit product detail pages.
- Extract item fields from structured data first, then HTML heuristics.
- Upsert into `store_items`.
- Keep enough raw data to debug extraction quality and improve adapters later.

Out of scope for v1:

- Browser automation for JavaScript-only stores.
- Store-specific adapters unless a simple generic parser cannot work at all.
- Full crawl run analytics tables.
- Automatic item normalization against BGG or curated `items`.
- Cart, checkout, login, or private pages.

## Schema

`store_items` should keep the current item-shaped columns and add fields needed by detail page crawling:

- `source_listing_url text not null default ''`
- `image_url text not null default ''`
- `item_type text not null default 'unknown'`
- `min_minutes integer`
- `max_minutes integer`
- `min_age integer`
- `currency text not null default 'MXN'`
- `store_sku text not null default ''`
- `raw_payload jsonb not null default '{}'::jsonb`
- `last_seen_at timestamptz not null default now()`

`source_url` remains the canonical product detail URL. `source_listing_url` records the page where the crawler found the product link. `raw_payload` stores structured and heuristic extraction evidence without requiring a migration for every new field.

Run and page diagnostics should be added later as separate tables, likely `discovery_crawl_runs` and `discovery_crawl_pages`, instead of expanding item candidate rows with operational fields.

## Architecture

The crawler will live in `ludora-discovery` and use focused modules:

- Store loader: reads target stores from the clean `stores` table.
- Link discovery: fetches seed pages and extracts likely product URLs.
- Detail fetcher: downloads product pages with timeouts and safe HTTP behavior.
- Detail extractor: parses JSON-LD `Product` and `Offer`, meta tags, and visible HTML.
- Candidate repository: upserts `DiscoveryItemCandidateRecord` rows.
- CLI/API operation entrypoint: runs the crawler from admin operations later.

The generic extractor should favor explicit structured fields, then fall back to heuristics. Store-specific parsing can be introduced as adapters after v1 shows real gaps.

## Data Flow

1. Load approved stores.
2. Build seed URLs from each store website, starting with the homepage.
3. Fetch seed pages and collect same-domain product-looking links.
4. Visit each product detail page.
5. Extract title, publisher, description, item type, player counts, play time, age, image, price, currency, availability, SKU, and language when present.
6. Persist the candidate with `status = 'PENDING'`.
7. Update `last_seen_at` on every successful observation and `last_updated` when extracted data changes.

## Error Handling

The crawler should skip failed pages and continue with the next URL. Network failures, unsupported content types, invalid HTML, and missing product fields should not fail the whole store crawl.

V1 should keep failures simple: return summary counts from the run and write raw extraction payloads for successful candidates. Detailed per-page failure history belongs in later crawl run tables.

## Testing

Unit tests should cover:

- Schema columns for the expanded `store_items` table.
- Product link discovery from listing pages.
- JSON-LD product extraction.
- HTML/meta fallback extraction.
- Candidate serialization and database upsert columns.
- A small crawler orchestration test proving a product detail page is fetched and persisted.

No live external store should be required for automated tests.
