# Store item visibility and availability

A store offer needs an active store, `store_active=true`, and an availability other than `unavailable` to appear on the public site or in the SEO export. An offer with `store_active=false` remains in administration and discovery history. `out_of_stock` offers still appear as **Agotado**. Products remain in the public catalog when all their offers are hidden.

Discovery records a direct URL with `source_url_origin=NULL` and a redirect with its discovered URL in `source_url_origin`; `source_url` is always the final target. It keeps historical pairs hidden with `store_active=false`. A newly discovered or unfinished pair stays hidden until processing succeeds, then may become visible if it outranks the visible row for its target. Completed, error-free hidden rows, including manual hides, are never automatically restored. Among equally usable published records, an available redirect takes precedence over an unavailable direct row. An unavailable-only representative can retain `store_active=true`.

With only one new column, a manually hidden row that has `processed_at=NULL` or a `processing_error` cannot be distinguished from an unfinished or failed discovery candidate. Discovery retries it and may make it visible after successful processing; this preserves coverage of candidates that previously failed. If a worker stops after processing succeeds but before visibility reconciliation, the hidden completed row stays hidden for manual review because it cannot be distinguished from a manual hide.

Removed pages and updater-rejected redirects set availability to `unavailable` while preserving `store_active`. An active unavailable offer can recover through manual or scheduled updates when its store has updates enabled and an enrolled, verified sitemap confirms the offer is still listed. A repeated removed-page response during a continuous update consumes the current slot and leaves the offer eligible for the next daily schedule. A confirmed miss in a verified sitemap sets `store_active=false` and ends regular item updates. The internal `deactivated` attempt status describes the outcome of an attempt.

## Historical coordinated rollout

1. Pause discovery, continuous updates, and automatic scheduling. Do not run old workers after the backfill: they still treat visibility as availability.
2. Review and explicitly approve the exact SQL in `database/patches/20260929_001_store_item_visibility_and_redirect_pairs.sql`. This replaces the **unapplied** Sep 28 redirect patch. Never apply `database/schema.sql` to an existing database.
3. Apply the approved focused transaction. Legacy false rows become visible with `availability='unavailable'` and provenance `legacy_store_active`; prices and fetch timestamps are retained. No URL origins are guessed. The patch aborts if a prior redirect migration or unexpected redirect metadata exists, preventing accidental reruns from showing hidden rows.
4. Deploy the compatible admin service/discovery, public API, and public UI together. Coordinate their activation with the migration because the old UI derives unavailable from `store_active`, while the new UI derives it from availability. Regenerate or refresh retained SEO documents from the upgraded export/runtime.
5. Verify migrated records, direct/redirect representative visibility, visible unavailable links, hidden duplicates, updater selection, and SEO before resuming workers and schedules.

The catalog's item identity and materialized-view membership remain unchanged. PostgreSQL migration, constraints, and indexes require runtime verification after SQL approval; local verification uses static SQL checks and fake cursors only.
