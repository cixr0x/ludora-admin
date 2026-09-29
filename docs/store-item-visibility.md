# Store item visibility and availability

`store_items.store_active` controls public offer visibility. A false row remains in administration and discovery history but is excluded from public offers. `availability` describes the product independently: `unavailable` shows **No disponible**, retains the store link, hides its price, and is excluded from price claims and structured offers. `out_of_stock` remains **Agotado** and continues automatic updating.

Discovery records a direct URL with `source_url_origin=NULL` and a redirect with its discovered URL in `source_url_origin`; `source_url` is always the final target. It keeps historical pairs hidden with `store_active=false`. A newly discovered or unfinished pair stays hidden until processing succeeds, then may become visible if it outranks the visible row for its target. Completed, error-free hidden rows, including manual hides, are never automatically restored. Among equally usable published records, an available redirect takes precedence over an unavailable direct row. An unavailable-only representative can remain visible.

With only one new column, a manually hidden row that has `processed_at=NULL` or a `processing_error` cannot be distinguished from an unfinished or failed discovery candidate. Discovery retries it and may make it visible after successful processing; this preserves coverage of candidates that previously failed. If a worker stops after processing succeeds but before visibility reconciliation, the hidden completed row stays hidden for manual review because it cannot be distinguished from a manual hide.

Removed pages and updater-rejected redirects set availability to `unavailable` without changing visibility. The retained internal `deactivated` attempt status and worker event names describe that terminal update outcome. Historical `store_active` update log entries retain their former activated/deactivated labels because they predate this semantic change; new unavailable transitions log the actual previous and new availability values.

## Coordinated rollout

1. Pause discovery, continuous updates, and automatic scheduling. Do not run old workers after the backfill: they still treat visibility as availability.
2. Review and explicitly approve the exact SQL in `database/patches/20260929_001_store_item_visibility_and_redirect_pairs.sql`. This replaces the **unapplied** Sep 28 redirect patch. Never apply `database/schema.sql` to an existing database.
3. Apply the approved focused transaction. Legacy false rows become visible with `availability='unavailable'` and provenance `legacy_store_active`; prices and fetch timestamps are retained. No URL origins are guessed. The patch aborts if a prior redirect migration or unexpected redirect metadata exists, preventing accidental reruns from showing hidden rows.
4. Deploy the compatible admin service/discovery, public API, and public UI together. Coordinate their activation with the migration because the old UI derives unavailable from `store_active`, while the new UI derives it from availability. Regenerate or refresh retained SEO documents from the upgraded export/runtime.
5. Verify migrated records, direct/redirect representative visibility, visible unavailable links, hidden duplicates, updater selection, and SEO before resuming workers and schedules.

The catalog's item identity and materialized-view membership remain unchanged. PostgreSQL migration, constraints, and indexes require runtime verification after SQL approval; local verification uses static SQL checks and fake cursors only.
