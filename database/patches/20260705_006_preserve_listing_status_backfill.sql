-- Incremental patch: make listing status setup idempotent without overwriting reviewed values.
begin;

alter table if exists store_items
drop constraint if exists store_items_listing_status_check;

alter table if exists store_items
add column if not exists listing_status text;

update store_items
set listing_status = 'PENDING'
where listing_status is null;

alter table if exists store_items
alter column listing_status set default 'PENDING';

alter table if exists store_items
alter column listing_status set not null;

alter table if exists store_items
add constraint store_items_listing_status_check
check (listing_status in ('PENDING', 'LISTED', 'UNLISTED', 'REJECTED'));

create index if not exists store_items_listing_status_idx
on store_items (listing_status);

commit;
