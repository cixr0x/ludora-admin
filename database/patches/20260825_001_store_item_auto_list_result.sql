begin;

alter table store_items
add column if not exists auto_list_result jsonb;

commit;
