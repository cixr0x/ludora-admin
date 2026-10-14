-- Requires explicit approval of these exact statements before execution.
-- Run in autocommit mode, without a transaction wrapper or --single-transaction:
-- PostgreSQL does not allow CREATE INDEX CONCURRENTLY inside a transaction.
-- A failed concurrent build can leave an invalid index. Inspect any failure;
-- dropping/replacing an invalid index requires separate, explicit approval.
-- Deliberately omit IF NOT EXISTS so an invalid/different index is not accepted.

CREATE INDEX CONCURRENTLY store_items_pending_review_title_id_idx
    ON store_items (title ASC, id ASC)
    WHERE is_boardgame = true
      AND is_boardgame_confirmed = true
      AND listing_status = 'PENDING';

-- DESC retains PostgreSQL's existing default NULLS FIRST ordering for this query.
CREATE INDEX CONCURRENTLY store_items_last_updated_desc_idx
    ON store_items (last_updated DESC);
