begin;

alter table if exists store_items
    add column if not exists original_title text not null default '';

update store_items
set original_title = title
where original_title = '';

commit;
