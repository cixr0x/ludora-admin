-- Incremental patch: add store item discovery run logs.
begin;

create table if not exists job_store_item_discovery_log (
    id bigserial primary key,
    run_id text not null unique,
    store_id bigint not null,
    website_url text not null default '',
    status text not null default 'running' check (status in ('running', 'cancelled', 'completed', 'failed')),
    error text not null default '',
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    new_items integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists job_store_item_discovery_log_store_id_started_at_idx
on job_store_item_discovery_log (store_id, started_at desc);

create index if not exists job_store_item_discovery_log_status_idx
on job_store_item_discovery_log (status);

commit;
