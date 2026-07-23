-- Incremental patch: add real-time classification statistics to store item discovery runs.
begin;

alter table if exists job_store_item_discovery_log
    add column if not exists items_discovered integer not null default 0,
    add column if not exists confirmed_boardgames integer not null default 0,
    add column if not exists confirmed_non_boardgames integer not null default 0,
    add column if not exists unconfirmed_boardgames integer not null default 0,
    add column if not exists unconfirmed_non_boardgames integer not null default 0;

commit;
