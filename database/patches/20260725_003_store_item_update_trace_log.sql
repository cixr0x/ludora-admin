begin;

create table if not exists store_item_update_trace_log (
    id bigserial primary key,
    job_id bigint not null references job_store_item_update_log(id) on delete cascade,
    run_id text not null,
    source text not null default 'item_update',
    event text not null,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists store_item_update_trace_log_job_id_id_idx
on store_item_update_trace_log (job_id, id);

create index if not exists store_item_update_trace_log_run_id_id_idx
on store_item_update_trace_log (run_id, id);

commit;
