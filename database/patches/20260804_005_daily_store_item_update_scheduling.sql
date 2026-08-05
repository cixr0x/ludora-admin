begin;

alter table if exists store_items alter column next_update_at drop not null;
alter table if exists store_items alter column next_update_at drop default;

create table if not exists store_item_update_schedule_runs (
    id bigserial primary key,
    trigger text not null check (trigger in ('AUTOMATIC', 'MANUAL')),
    automatic_schedule_date date,
    status text not null check (status in ('RUNNING', 'COMPLETED', 'FAILED')),
    window_start timestamptz not null,
    window_end timestamptz not null,
    scheduled_item_count integer not null default 0 check (scheduled_item_count >= 0),
    scheduled_store_count integer not null default 0 check (scheduled_store_count >= 0),
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    error_detail text not null default '',
    check (window_end > window_start),
    check (
      (trigger = 'AUTOMATIC' and automatic_schedule_date is not null)
      or (trigger = 'MANUAL' and automatic_schedule_date is null)
    )
);

create unique index if not exists store_item_update_schedule_runs_automatic_date_uidx
on store_item_update_schedule_runs (automatic_schedule_date)
where trigger = 'AUTOMATIC';

create index if not exists store_item_update_schedule_runs_started_at_idx
on store_item_update_schedule_runs (started_at desc, id desc);

commit;
