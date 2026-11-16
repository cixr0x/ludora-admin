alter table public.items
    add column if not exists is_rpg boolean not null default false;
