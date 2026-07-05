-- Incremental patch: add field-level store item update change logs.
begin;

create table if not exists store_item_update_change_log (
    id bigserial primary key,
    job_id bigint not null references job_store_item_update_log(id) on delete cascade,
    run_id text not null,
    store_item_id bigint not null,
    field_name text not null,
    old_value jsonb not null,
    new_value jsonb not null,
    created_at timestamptz not null default now()
);

alter table if exists store_item_update_change_log
add column if not exists job_id bigint;

do $$
begin
    if to_regclass('store_item_update_change_log') is not null
       and not exists (
           select 1
           from pg_constraint
           where conrelid = 'store_item_update_change_log'::regclass
             and conname = 'store_item_update_change_log_job_id_fkey'
       ) then
        alter table store_item_update_change_log
        add constraint store_item_update_change_log_job_id_fkey
        foreign key (job_id) references job_store_item_update_log(id) on delete cascade;
    end if;
end $$;

create index if not exists store_item_update_change_log_job_id_idx
on store_item_update_change_log (job_id);

create index if not exists store_item_update_change_log_run_id_idx
on store_item_update_change_log (run_id);

create index if not exists store_item_update_change_log_store_item_created_idx
on store_item_update_change_log (store_item_id, created_at desc);

commit;
