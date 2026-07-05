-- Incremental patch: track source refresh timestamps separately from admin edits.
begin;

alter table if exists store_items
add column if not exists refreshed_date timestamptz;

update store_items
set refreshed_date = last_updated
where refreshed_date is null;

alter table if exists store_items
alter column refreshed_date set default now();

alter table if exists store_items
alter column refreshed_date set not null;

create index if not exists store_items_refreshed_date_idx
on store_items (refreshed_date, id);

commit;
