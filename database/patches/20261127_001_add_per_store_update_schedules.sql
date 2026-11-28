begin;

-- Keep the old AUTOMATIC partial index for deployments of the legacy updater.
alter table store_item_update_schedule_runs
    drop constraint store_item_update_schedule_runs_trigger_check,
    drop constraint store_item_update_schedule_runs_check1,
    add constraint store_item_update_schedule_runs_trigger_check
      check (trigger in ('AUTOMATIC', 'MANUAL', 'STORE_AUTOMATIC', 'STORE_MANUAL')),
    add constraint store_item_update_schedule_runs_check1 check (
      (trigger in ('AUTOMATIC', 'STORE_AUTOMATIC', 'STORE_MANUAL') and automatic_schedule_date is not null)
      or (trigger = 'MANUAL' and automatic_schedule_date is null)
    );

create unique index if not exists store_item_update_schedule_runs_store_date_uidx
on store_item_update_schedule_runs (automatic_schedule_date)
where trigger in ('STORE_AUTOMATIC', 'STORE_MANUAL');

create table if not exists store_item_update_store_schedules (
    store_id bigint primary key references stores(id) on delete cascade,
    window_start timestamptz not null,
    window_end timestamptz not null,
    eligible_item_count integer not null check (eligible_item_count > 0),
    phase double precision not null check (phase >= 0 and phase < 1),
    next_slot_index integer not null check (next_slot_index >= 0),
    next_due_at timestamptz,
    check (window_end > window_start),
    check (
      (next_slot_index < eligible_item_count and next_due_at is not null
        and next_due_at >= window_start and next_due_at < window_end)
      or (next_slot_index = eligible_item_count and next_due_at is null)
    )
);

create index if not exists store_item_update_store_schedules_next_due_idx
on store_item_update_store_schedules (next_due_at, store_id)
where next_due_at is not null;

grant select, insert, update on table public.store_item_update_store_schedules to ludora_background;
grant select on table public.store_item_update_store_schedules to ludora_admin_api;

commit;
