begin;

create table if not exists store_item_update_store_cooldown (
    worker_name text not null
        references store_item_update_worker_state(worker_name) on delete cascade,
    store_id bigint not null
        references stores(id) on delete cascade,
    blocked_until timestamptz,
    consecutive_429s integer not null default 0
        check (consecutive_429s >= 0),
    updated_at timestamptz not null default now(),
    primary key (worker_name, store_id)
);

commit;
