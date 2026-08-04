begin;

alter table store_items
add column if not exists next_update_at timestamptz;

update store_items
set next_update_at = least(now(), refreshed_date + interval '22 hours')
where next_update_at is null;

alter table store_items
alter column next_update_at set default now();

alter table store_items
alter column next_update_at set not null;

alter table store_items
add column if not exists update_lease_token uuid;

alter table store_items
add column if not exists update_lease_expires_at timestamptz;

alter table store_items
add column if not exists consecutive_update_failures integer not null default 0;

alter table store_items
add column if not exists last_update_attempt_at timestamptz;

alter table store_items
add column if not exists last_update_error text not null default '';

create index if not exists store_items_next_update_at_idx
on store_items (next_update_at, id)
where is_boardgame = true
  and is_boardgame_confirmed = true
  and item_id is not null
  and source_url <> ''
  and listing_status = 'LISTED'
  and store_active = true;

create index if not exists store_items_update_lease_expires_at_idx
on store_items (update_lease_expires_at)
where update_lease_token is not null;

create table if not exists store_item_update_attempt_log (
    id bigserial primary key,
    store_item_id bigint not null references store_items(id) on delete cascade,
    store_id bigint references stores(id) on delete set null,
    worker_id text not null,
    lease_token uuid not null,
    platform text not null default '',
    status text not null default 'running'
        check (status in ('running', 'succeeded', 'failed', 'deactivated', 'lease_lost')),
    changed boolean,
    http_status integer,
    error text not null default '',
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    duration_ms integer,
    created_at timestamptz not null default now()
);

create index if not exists store_item_update_attempt_log_started_at_idx
on store_item_update_attempt_log (started_at desc);

create index if not exists store_item_update_attempt_log_status_started_at_idx
on store_item_update_attempt_log (status, started_at desc);

create index if not exists store_item_update_attempt_log_store_started_at_idx
on store_item_update_attempt_log (store_id, started_at desc);

create table if not exists store_item_update_worker_state (
    worker_name text primary key,
    worker_id text not null,
    status text not null
        check (status in ('starting', 'idle', 'running', 'stopped', 'error')),
    poll_seconds numeric(8, 2) not null,
    heartbeat_at timestamptz not null default now(),
    started_at timestamptz not null default now(),
    current_store_item_id bigint references store_items(id) on delete set null,
    last_attempt_at timestamptz,
    last_success_at timestamptz,
    last_failure_at timestamptz,
    last_error text not null default '',
    shopify_blocked_until timestamptz,
    shopify_consecutive_429s integer not null default 0,
    updated_at timestamptz not null default now()
);

commit;
