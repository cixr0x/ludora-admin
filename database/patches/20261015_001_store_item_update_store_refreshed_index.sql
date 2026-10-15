-- Requires explicit approval of this exact statement before execution.
-- Run in autocommit mode, without a transaction wrapper or --single-transaction:
-- PostgreSQL does not allow CREATE INDEX CONCURRENTLY inside a transaction.
-- A failed concurrent build can leave an invalid index. Inspect any failure;
-- dropping/replacing an invalid index requires separate, explicit approval.
-- Deliberately omit IF NOT EXISTS so an invalid/different index is not accepted.

CREATE INDEX CONCURRENTLY store_items_update_store_refreshed_date_idx
    ON store_items (store_id, refreshed_date ASC, id ASC)
    WHERE is_boardgame = true
      AND is_boardgame_confirmed = true
      AND item_id is not null
      AND source_url <> ''
      AND listing_status = 'LISTED'
      AND store_active = true
      AND availability <> 'unavailable';
