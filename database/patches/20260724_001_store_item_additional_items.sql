-- Incremental patch: allow exceptional store listings to expose offers for additional catalog items.
begin;

create table if not exists store_item_additional_items (
    store_item_id bigint not null references store_items(id) on delete cascade,
    item_id bigint not null references items(id) on delete cascade,
    primary key (store_item_id, item_id)
);

create index if not exists store_item_additional_items_item_id_idx
on store_item_additional_items (item_id);

create or replace view active_item as
select
    i.*,
    exists (
        select 1
        from store_items si
        where (
            si.item_id = i.id
            or exists (
                select 1
                from store_item_additional_items siai
                where siai.store_item_id = si.id
                  and siai.item_id = i.id
            )
        )
          and si.is_boardgame = true
          and si.is_boardgame_confirmed = true
          and si.listing_status = 'LISTED'
    ) as has_approved_listing,
    exists (
        select 1
        from item_relationships ir
        where (ir.link_type = 'extension' and ir.item_a_id = i.id)
           or (ir.link_type = 'expansion' and ir.item_b_id = i.id)
    ) as is_expansion
from items i
where exists (
    select 1
    from store_items si
    where (
        si.item_id = i.id
        or exists (
            select 1
            from store_item_additional_items siai
            where siai.store_item_id = si.id
              and siai.item_id = i.id
        )
    )
      and si.is_boardgame = true
      and si.is_boardgame_confirmed = true
);

commit;
