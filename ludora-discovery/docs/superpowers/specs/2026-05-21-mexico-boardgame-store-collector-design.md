# Mexico Boardgame Store Collector Design

## Goal

Build a local CLI script that gathers Mexican online boardgame and tabletop store listings using the Brave Search API, then enriches each store from its website.

## Scope

The collector keeps only Mexican online stores that sell board games, tabletop games, card games, miniatures, or TCG products. It excludes marketplaces, social-only pages, blogs, publishers, news pages, and event listings where the evidence does not indicate an online store.

## Data Shape

The requested output fields are `store_name`, `canonical_domain`, `website_url`, `instagram_url`, `facebook_url`, `city`, `state`, `country`, and `store_logo`. The script also includes `confidence`, `source_queries`, and `evidence` so results can be audited.

## Architecture

The project is a small Python package with a CLI wrapper. `queries.py` generates Mexico-focused Brave queries. `brave.py` calls Brave Web Search. `filtering.py` normalizes domains and classifies results. `enrichment.py` parses websites for social links, logos, and location hints. `collector.py` orchestrates discovery, enrichment, filtering, and export.

## Error Handling

Brave API errors return a non-zero CLI exit code with the API response. Website fetch failures do not fail the whole run; the candidate is classified using search-result evidence and any available metadata.

## Testing

Unit tests cover query generation, Brave result parsing, candidate classification, social/logo extraction, and Mexican location inference.
