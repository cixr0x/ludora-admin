alter table if exists items
    add column if not exists is_accessory boolean not null default false;
