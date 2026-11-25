begin;

alter table public.items
    add column is_version boolean not null default false,
    add column version_of bigint,
    add constraint items_bgg_version_identity_check check (
        (not is_version and version_of is null) or
        (is_version and bgg_id is not null and bgg_id > 0 and version_of is not null and version_of > 0)
    );

create unique index items_bgg_identity_unique
on public.items (is_version, bgg_id)
where bgg_id is not null;

drop index public.items_bgg_id_unique;

commit;
