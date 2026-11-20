-- Run in autocommit mode after explicit approval. PostgreSQL cannot build
-- a concurrent index inside a transaction. An interrupted build can leave an
-- invalid index, so omit IF NOT EXISTS and inspect any failed build.
CREATE INDEX CONCURRENTLY store_items_unavailable_next_update_at_idx
    ON store_items (next_update_at, id)
    WHERE is_boardgame = true
      AND is_boardgame_confirmed = true
      AND item_id IS NOT NULL
      AND source_url <> ''
      AND listing_status = 'LISTED'
      AND store_active = true
      AND availability = 'unavailable'
      AND next_update_at IS NOT NULL;
