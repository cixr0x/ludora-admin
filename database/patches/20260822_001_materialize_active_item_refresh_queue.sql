begin;

set local lock_timeout = '15s';
set local statement_timeout = '5min';

drop view active_item;

create materialized view active_item as
with eligible_item_links as (
    select
        primary_store_item.item_id,
        primary_store_item.listing_status
    from store_items primary_store_item
    where primary_store_item.item_id is not null
      and primary_store_item.is_boardgame = true
      and primary_store_item.is_boardgame_confirmed = true

    union all

    select
        additional_link.item_id,
        bundled_store_item.listing_status
    from store_item_additional_items additional_link
    join store_items bundled_store_item
      on bundled_store_item.id = additional_link.store_item_id
    where bundled_store_item.is_boardgame = true
      and bundled_store_item.is_boardgame_confirmed = true
),
active_item_links as (
    select
        eligible_item_links.item_id,
        coalesce(
            bool_or(eligible_item_links.listing_status = 'LISTED'),
            false
        ) as has_approved_listing
    from eligible_item_links
    group by eligible_item_links.item_id
)
select
    catalog_item.*,
    active_item_links.has_approved_listing,
    exists (
        select 1
        from item_relationships relationship
        where (
            relationship.link_type = 'extension'
            and relationship.item_a_id = catalog_item.id
        )
        or (
            relationship.link_type = 'expansion'
            and relationship.item_b_id = catalog_item.id
        )
    ) as is_expansion
from active_item_links
join items catalog_item
  on catalog_item.id = active_item_links.item_id
with data;

create unique index active_item_id_uidx
on active_item (id);

create table active_item_refresh_state (
    singleton boolean primary key default true check (singleton),
    requested_generation bigint not null default 0 check (requested_generation >= 0),
    refreshed_generation bigint not null default 0 check (refreshed_generation >= 0),
    refresh_requested_at timestamptz,
    last_refreshed_at timestamptz not null,
    check (refreshed_generation <= requested_generation)
);

-- Queue one post-migration refresh. This closes the window in which a source
-- table could change while the materialized view and its triggers are created.
insert into active_item_refresh_state (
    singleton,
    requested_generation,
    refreshed_generation,
    refresh_requested_at,
    last_refreshed_at
)
values (
    true,
    1,
    0,
    clock_timestamp(),
    clock_timestamp()
);

create function request_active_item_refresh()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
    update public.active_item_refresh_state
    set
        requested_generation = requested_generation + 1,
        refresh_requested_at = clock_timestamp()
    where singleton = true;

    if not found then
        raise exception 'active_item refresh state is missing';
    end if;

    return null;
end;
$$;

revoke all on function request_active_item_refresh() from public;

create function refresh_active_item_if_needed()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    target_generation bigint;
    current_refreshed_generation bigint;
begin
    if not pg_try_advisory_xact_lock(
        hashtext(current_database()),
        hashtext('public.active_item')
    ) then
        return false;
    end if;

    select
        state.requested_generation,
        state.refreshed_generation
    into
        target_generation,
        current_refreshed_generation
    from public.active_item_refresh_state state
    where state.singleton = true;

    if not found then
        raise exception 'active_item refresh state is missing';
    end if;

    if target_generation <= current_refreshed_generation then
        return false;
    end if;

    refresh materialized view concurrently public.active_item;

    update public.active_item_refresh_state
    set
        refreshed_generation = greatest(refreshed_generation, target_generation),
        refresh_requested_at = case
            when requested_generation <= target_generation then null
            else refresh_requested_at
        end,
        last_refreshed_at = clock_timestamp()
    where singleton = true;

    return true;
end;
$$;

revoke all on function refresh_active_item_if_needed() from public;

create trigger request_active_item_refresh_on_items
after insert or update or delete or truncate on items
for each statement
execute function request_active_item_refresh();

create trigger request_active_item_refresh_on_store_item_membership
after insert or delete or truncate on store_items
for each statement
execute function request_active_item_refresh();

create trigger request_active_item_refresh_on_store_item_membership_update
after update of item_id, is_boardgame, is_boardgame_confirmed, listing_status on store_items
for each statement
execute function request_active_item_refresh();

create trigger request_active_item_refresh_on_additional_items
after insert or update or delete or truncate on store_item_additional_items
for each statement
execute function request_active_item_refresh();

create trigger request_active_item_refresh_on_item_relationships
after insert or delete or truncate on item_relationships
for each statement
execute function request_active_item_refresh();

create trigger request_active_item_refresh_on_item_relationship_updates
after update of item_a_id, link_type, item_b_id on item_relationships
for each statement
execute function request_active_item_refresh();

commit;
