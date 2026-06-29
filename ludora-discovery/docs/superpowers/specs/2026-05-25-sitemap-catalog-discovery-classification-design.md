# Sitemap Catalog Discovery And Classification Design

## Goal

Expand item discovery from homepage-only product links to sitemap-first catalog discovery, while filtering non-boardgame products conservatively enough to minimize false negatives.

The crawler should find substantially more product detail pages per store and classify candidates for admin review without silently discarding plausible board games or expansions.

## Problem

The current crawler fetches a store homepage, extracts product links from that single page, then visits those product detail pages. This only captures featured products. For example, `alfaydelta.com` produced 12 candidates from the homepage, while its product sitemap exposes hundreds of product URLs.

Broad hobby stores also include paints, miniatures, tools, TCG products, sleeves, books, and other non-boardgame inventory. We need to reduce admin noise without losing local board games, expansions, or games that may not appear in external normalization sources yet.

## Scope

In scope:

- Fetch `/sitemap.xml` for a clean store.
- Follow product sitemap files such as `sitemap_products_1.xml`.
- Extract same-domain `/products/...` URLs from product sitemaps.
- Fall back to homepage product-link extraction when sitemaps are missing or empty.
- Visit product detail pages from discovered URLs.
- Classify each item candidate as likely board game, likely expansion, uncertain, or likely non-boardgame.
- Persist classification metadata with item candidates.

Out of scope:

- AI-based classification.
- Auto-rejecting non-boardgame candidates.
- Full pagination crawling outside sitemap discovery.
- Store-specific adapters.
- Browser automation for JavaScript-only storefronts.

## Classification Strategy

Filtering should be classification, not deletion. The crawler should persist anything that is not obvious junk, and use classification metadata to help the admin UI sort and filter review queues.

Use these categories:

- `LIKELY_BOARDGAME`
- `LIKELY_EXPANSION`
- `UNCERTAIN`
- `LIKELY_NON_BOARDGAME`

External normalization matching is not part of this iteration. Classification must rely on store-provided product evidence only.

Strong positive signals:

- Player count, play time, or minimum age fields.
- Product type, tags, or breadcrumbs containing boardgame terms such as `juegos de mesa`, `board games`, `familiares`, `party games`, or `estrategia`.
- Known boardgame publishers.
- Description mentions gameplay, players, components, scenarios, turns, cooperative/competitive play, or expansion compatibility.

Strong expansion signals:

- Title or description contains accent-normalized expansion terms such as `expansion`, `ampliacion`, `expande`, or compatibility phrasing such as `requiere el juego base`.

Strong negative signals:

- Paints, brushes, glue, tools, basing materials, and hobby supplies.
- Card sleeves, deck boxes, binders, dice-only accessories, tokens-only accessories.
- TCG boosters or singles clearly tied to `Magic`, `Pokemon`, `Yu-Gi-Oh`, or similar collectible card games.
- Miniatures-only products, terrain, army units, and wargame model kits.
- RPG books/manuals unless the platform later decides to include them.

Negative signals should not override strong positive signals automatically. For example, `card game` is not enough to classify a product as non-boardgame because many board games are card games.

## Schema

Add classification metadata to `store_items`:

- `candidate_category text not null default 'UNCERTAIN'`
- `category_confidence numeric(4, 2)`
- `classification_reasons jsonb not null default '[]'::jsonb`

Keep `status` as the admin workflow status:

- `PENDING`
- `ACCEPTED`
- `REJECTED`

Example:

```text
status = PENDING
candidate_category = LIKELY_NON_BOARDGAME
category_confidence = 0.82
classification_reasons = ["title contains paint color code", "product type indicates hobby paint"]
```

## Architecture

Add focused discovery modules:

- Sitemap discovery: fetches root sitemap, follows sitemap index entries, and returns product URLs.
- Candidate classification: scores extracted product detail data and returns category, confidence, and reasons.
- Crawler orchestration: uses sitemap product URLs first, then homepage links as fallback.

The product detail extractor should preserve raw data in `raw_payload`, including tags, product type, breadcrumbs, and metadata when present. The classifier consumes that extracted record plus raw payload evidence.

## Data Flow

1. Admin starts item discovery for a clean store.
2. Discovery fetches the root sitemap.
3. Discovery follows product sitemap URLs.
4. Discovery extracts same-domain product URLs.
5. If no sitemap product URLs are found, discovery falls back to homepage product links.
6. Discovery visits every discovered product detail page unless an explicit diagnostic limit is provided.
7. Discovery extracts product data.
8. Discovery classifies the candidate.
9. Discovery persists the candidate with `status = PENDING` and classification metadata.

## Admin Behavior

Admin item candidate views should eventually expose category filters. Default review should include:

- `LIKELY_BOARDGAME`
- `LIKELY_EXPANSION`
- `UNCERTAIN`

`LIKELY_NON_BOARDGAME` should be available but not prioritized. It should not be deleted automatically.

## Testing

Unit tests should cover:

- Product sitemap URL extraction from sitemap index files and product sitemap files.
- HTML entity handling in sitemap URLs, such as `&amp;`.
- Same-domain product URL filtering.
- Homepage fallback when sitemap discovery returns no product URLs.
- Classification of likely board games.
- Classification of likely expansions.
- Classification of obvious non-boardgame products.
- Conservative handling where positive boardgame signals prevent a non-boardgame classification.
- Repository upsert of classification metadata.
