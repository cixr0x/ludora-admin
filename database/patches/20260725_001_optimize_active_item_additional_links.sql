-- Optimize active_item by resolving primary and additional store-item links
-- as a set before joining them to catalog items.
begin;

create or replace view active_item as
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
  on catalog_item.id = active_item_links.item_id;

commit;
