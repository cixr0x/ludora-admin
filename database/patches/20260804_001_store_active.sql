-- Incremental patch: control whether a curated store participates in automated operations.
begin;

alter table if exists stores
add column if not exists active boolean;

update stores
set active = true
where active is null;

alter table if exists stores
alter column active set default true;

alter table if exists stores
alter column active set not null;

commit;
