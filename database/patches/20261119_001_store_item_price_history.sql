begin;

create table if not exists store_item_price_history (
    id bigserial primary key,
    store_item_id bigint not null references store_items(id) on delete cascade,
    price numeric(12, 2) not null,
    date timestamptz not null default clock_timestamp()
);

create index if not exists store_item_price_history_store_item_date_idx
    on store_item_price_history (store_item_id, date, id);

commit;
