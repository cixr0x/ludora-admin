# BGG Metadata Schema Design

## Goal

Add normalized storage for BoardGameGeek item metadata so Ludora can enrich curated `items` with categories, mechanics, families, contributors, publishers, and reusable BGG search results.

## Scope

This iteration is schema-only. It does not implement the BGG API client, matching flow, import jobs, translations, or admin UI actions.

## Tables

BGG taxonomy tables store one row per BGG metadata entity:

- `boardgame_categories`: BGG category links such as `Economic`.
- `boardgame_mechanics`: BGG mechanic links such as `Contracts`.
- `boardgame_families`: BGG family links such as `Food & Drink: Coffee`.
- `contributors`: BGG people-like links used by designers and artists.

Each taxonomy table stores the BGG id, English/source name, optional Spanish display name, and timestamps. Contributor rows store the BGG id, name, and timestamps.

Relationship tables connect curated Ludora items to BGG metadata:

- `item_categories`
- `item_mechanics`
- `item_families`
- `item_contributors`

`item_contributors` includes `contribution_role` with values `designer` or `artist`.

Publishers remain in the existing core `publishers` table. The schema adds nullable `publishers.bgg_id` plus a partial unique index when present. Existing `item_publishers` remains the item-publisher relationship table.

`bgg_search_cache` stores one cached BGG search result per BGG id. `bgg_id` is unique so the same BGG entry has one cached row. `bgg_search_queries` stores normalized search requests, and `bgg_search_query_results` preserves the ranked result list for each query. This cache is intentionally detached from `items`; imported items already carry their BGG ids, while the cache helps repeated candidate matching avoid unnecessary BGG search calls.

## Existing Tables

The previous `item_categories` and `item_mechanics` tables were simple text association tables and are not currently populated. They will be recreated as normalized relationship tables. `item_themes` remains unchanged because it is not part of the BGG metadata shape selected for this iteration.

## Constraints

- BGG ids are unique in each BGG-owned metadata table.
- Item relationship tables use composite primary keys to avoid duplicate links.
- Relationship rows cascade when an item or metadata entity is deleted.
- `contributors` can be linked multiple times to the same item only when the role differs.
