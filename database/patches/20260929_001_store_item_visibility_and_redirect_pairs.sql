-- Approval required before execution. Do not apply schema.sql.
-- Rollout: pause old discovery/update workers, apply this approved patch,
-- deploy upgraded admin, public API and UI code, then resume workers. Old target-only readers are not
-- compatible with multiple rows sharing source_url. No origin backfill.
begin;

-- This patch replaces the unapplied 20260928 redirect patch. Stop if either
-- version has already added metadata: the legacy backfill is one-time only.
do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_schema = current_schema() and table_name = 'store_items'
          and column_name in (
              'source_url_origin', 'discovery_disabled_reason', 'discovery_hidden_reason',
              'discovery_duplicate_of_id', 'discovery_superseded_by_id',
              'discovery_visibility_before_suppression', 'discovery_processing_complete'
          )
    ) then
        raise exception 'Store-item visibility migration cannot be repeated or applied after the old redirect patch';
    end if;
end $$;

-- Legacy false meant unavailable, not hidden. Retain prices and fetch times.
update store_items
set availability = 'unavailable',
    availability_source = 'legacy_store_active',
    store_active = true
where store_active = false;

comment on column store_items.store_active is 'Public visibility; false hides this offer without changing product availability';
comment on column store_items.availability is 'Product availability independent of public visibility; unavailable is terminal until manually recovered';

alter table store_items add column if not exists source_url_origin text;

alter table store_items add constraint store_items_source_url_origin_check
    check (source_url_origin is null or (source_url_origin <> '' and source_url_origin <> source_url));

alter table store_items drop constraint if exists discovery_item_candidates_store_id_source_url_title_key;
alter table store_items drop constraint if exists discovery_item_candidates_store_id_source_url_key;
alter table store_items drop constraint if exists store_items_store_id_source_url_key;

-- Nullable store IDs retain their existing NULL-distinct uniqueness semantics.
-- Empty token represents direct URLs without indexing the target twice.
create unique index store_items_discovery_url_pair_uidx
    on store_items (store_id, coalesce(source_url_origin, ''), source_url);
create unique index store_items_active_target_uidx
    on store_items (store_id, source_url)
    where store_id is not null and store_active = true and listing_status <> 'REJECTED';
create index store_items_target_url_idx on store_items (store_id, source_url, id);
create index store_items_discovered_url_idx on store_items (store_id, coalesce(source_url_origin, source_url));

-- Match automatic scheduling/claim eligibility; out_of_stock remains eligible.
drop index if exists store_items_next_update_at_idx;
create index store_items_next_update_at_idx on store_items (next_update_at, id)
where is_boardgame = true and is_boardgame_confirmed = true
  and item_id is not null and source_url <> '' and listing_status = 'LISTED'
  and store_active = true and availability <> 'unavailable';

commit;
