-- Incremental patch: track whether a store item is still active on its source page.
begin;

alter table if exists store_items
add column if not exists store_active boolean;

update store_items
set store_active = true
where store_active is null;

alter table if exists store_items
alter column store_active set default true;

alter table if exists store_items
alter column store_active set not null;

commit;
