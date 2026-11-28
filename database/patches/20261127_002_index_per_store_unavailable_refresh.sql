-- Apply only after approval. Run separately in autocommit because CREATE INDEX
-- CONCURRENTLY cannot run inside a transaction block.
create index concurrently store_items_update_store_unavailable_refreshed_idx
on store_items (store_id, refreshed_date asc, id asc)
where is_boardgame = true
  and is_boardgame_confirmed = true
  and item_id is not null
  and source_url <> ''
  and listing_status = 'LISTED'
  and store_active = true
  and availability = 'unavailable';
