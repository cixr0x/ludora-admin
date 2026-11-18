begin;

alter table stores
  add column if not exists discovery_active boolean,
  add column if not exists update_active boolean;

update stores
set discovery_active = coalesce(discovery_active, active),
    update_active = coalesce(update_active, active)
where discovery_active is null or update_active is null;

alter table stores
  alter column discovery_active set default true,
  alter column discovery_active set not null,
  alter column update_active set default true,
  alter column update_active set not null;

commit;
