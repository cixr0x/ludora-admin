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
          and column_name in ('discovery_disabled_reason', 'discovery_visibility_before_suppression')
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
alter table store_items add column if not exists discovery_hidden_reason text;
alter table store_items add column if not exists discovery_duplicate_of_id bigint references store_items(id) on delete set null;
alter table store_items add column if not exists discovery_superseded_by_id bigint references store_items(id) on delete set null;
alter table store_items add column if not exists discovery_visibility_before_suppression boolean;
alter table store_items add column if not exists discovery_processing_complete boolean not null default true;

alter table store_items add constraint store_items_source_url_origin_check
    check (source_url_origin is null or (source_url_origin <> '' and source_url_origin <> source_url));
alter table store_items add constraint store_items_discovery_suppression_check
    check (
        (discovery_hidden_reason is null and discovery_visibility_before_suppression is null
         and discovery_duplicate_of_id is null and discovery_superseded_by_id is null)
        or
        (discovery_hidden_reason is not null and discovery_hidden_reason in ('pending', 'duplicate', 'superseded')
         and discovery_visibility_before_suppression is not null and store_active = false)
    );

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

create or replace function preserve_discovery_suppression_visibility_intent()
returns trigger language plpgsql as $$
begin
    -- Reconciliation changes suppression metadata. An independent explicit
    -- store_active write with unchanged metadata instead updates saved intent,
    -- including false-to-false hiding of an already suppressed row.
    if old.discovery_hidden_reason is not null
       and new.discovery_hidden_reason is not distinct from old.discovery_hidden_reason
       and new.discovery_duplicate_of_id is not distinct from old.discovery_duplicate_of_id
       and new.discovery_superseded_by_id is not distinct from old.discovery_superseded_by_id
       and new.discovery_visibility_before_suppression is not distinct from old.discovery_visibility_before_suppression then
        new.discovery_visibility_before_suppression := new.store_active;
        new.store_active := false;
    end if;
    return new;
end $$;
create trigger store_items_preserve_discovery_visibility_intent
    before update of store_active on store_items
    for each row execute function preserve_discovery_suppression_visibility_intent();

create or replace function protect_discovery_pair_identity()
returns trigger language plpgsql as $$
begin
    if (old.source_url_origin is not null or old.discovery_hidden_reason is not null)
       and (new.store_id is distinct from old.store_id
            or new.source_url is distinct from old.source_url
            or new.source_url_origin is distinct from old.source_url_origin) then
        raise exception using errcode = '23514',
            constraint = 'store_items_discovery_pair_identity_guard',
            message = 'Discovery URL-pair identity cannot be edited; discover the new source/target pair instead';
    end if;
    return new;
end $$;
create trigger store_items_protect_discovery_pair_identity
    before update of store_id, source_url, source_url_origin on store_items
    for each row execute function protect_discovery_pair_identity();

commit;
