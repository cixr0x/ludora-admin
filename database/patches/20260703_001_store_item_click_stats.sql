-- Incremental patch: add hourly store item click counters.
begin;

create table if not exists store_item_click_stats (
    store_item_id bigint not null,
    clicked_hour timestamptz not null,
    click_count bigint not null default 0,
    primary key (store_item_id, clicked_hour)
);

commit;
