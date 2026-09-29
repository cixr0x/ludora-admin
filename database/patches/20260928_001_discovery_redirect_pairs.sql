-- Approval required before execution. Do not apply schema.sql.
-- Rollout: pause old discovery/update workers, apply this approved patch,
-- deploy upgraded code, then resume workers. Old target-only readers are not
-- compatible with multiple rows sharing source_url. No origin backfill.
begin;

alter table store_items add column if not exists source_url_origin text;
alter table store_items add column if not exists discovery_disabled_reason text;
alter table store_items add column if not exists discovery_duplicate_of_id bigint references store_items(id) on delete set null;
alter table store_items add column if not exists discovery_superseded_by_id bigint references store_items(id) on delete set null;
alter table store_items add column if not exists discovery_store_active_before_suppression boolean;
alter table store_items add column if not exists discovery_processing_complete boolean not null default true;

alter table store_items add constraint store_items_source_url_origin_check
    check (source_url_origin is null or (source_url_origin <> '' and source_url_origin <> source_url));
alter table store_items add constraint store_items_discovery_suppression_check
    check (
        (discovery_disabled_reason is null and discovery_store_active_before_suppression is null
         and discovery_duplicate_of_id is null and discovery_superseded_by_id is null)
        or
        (discovery_disabled_reason is not null and discovery_disabled_reason in ('pending', 'duplicate', 'superseded')
         and discovery_store_active_before_suppression is not null and store_active = false)
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

create or replace function preserve_discovery_suppression_active_intent()
returns trigger language plpgsql as $$
begin
    -- Reconciliation changes suppression metadata. An independent explicit
    -- store_active write with unchanged metadata instead updates saved intent,
    -- including false-to-false deactivation of an already suppressed row.
    if old.discovery_disabled_reason is not null
       and new.discovery_disabled_reason is not distinct from old.discovery_disabled_reason
       and new.discovery_duplicate_of_id is not distinct from old.discovery_duplicate_of_id
       and new.discovery_superseded_by_id is not distinct from old.discovery_superseded_by_id
       and new.discovery_store_active_before_suppression is not distinct from old.discovery_store_active_before_suppression then
        new.discovery_store_active_before_suppression := new.store_active;
        new.store_active := false;
    end if;
    return new;
end $$;
create trigger store_items_preserve_discovery_active_intent
    before update of store_active on store_items
    for each row execute function preserve_discovery_suppression_active_intent();

create or replace function protect_discovery_pair_identity()
returns trigger language plpgsql as $$
begin
    if (old.source_url_origin is not null or old.discovery_disabled_reason is not null)
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
