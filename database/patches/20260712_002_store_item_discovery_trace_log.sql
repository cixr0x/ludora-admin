create table if not exists store_item_discovery_trace_log (
    id bigserial primary key,
    run_id text not null,
    source text not null default 'discovery',
    event text not null,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists store_item_discovery_trace_log_run_id_id_idx
on store_item_discovery_trace_log (run_id, id);
