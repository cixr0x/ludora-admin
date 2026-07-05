-- Incremental patch: add store item update run logs.
begin;

create table if not exists job_store_item_update_log (
    id bigserial primary key,
    run_id text not null unique,
    status text not null default 'running' check (status in ('running', 'cancelled', 'completed', 'failed')),
    error text not null default '',
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    scanned_items integer not null default 0,
    updated_items integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists job_store_item_update_log_started_at_idx
on job_store_item_update_log (started_at desc);

create index if not exists job_store_item_update_log_status_idx
on job_store_item_update_log (status);

commit;
