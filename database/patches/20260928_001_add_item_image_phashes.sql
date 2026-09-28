-- Catalog cover pHashes, phash_dct256_v1. Existing covers remain uncomputed (NULL).
-- Review and obtain explicit DDL approval before applying this incremental patch.
begin;

alter table items add column if not exists image_phash text;
alter table items add column if not exists image_phash_es text;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'items'::regclass and conname = 'items_image_phash_format_check'
    ) then
        alter table items add constraint items_image_phash_format_check
            check (image_phash is null or image_phash ~ '^[0-9a-f]{64}$');
    end if;
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'items'::regclass and conname = 'items_image_phash_es_format_check'
    ) then
        alter table items add constraint items_image_phash_es_format_check
            check (image_phash_es is null or image_phash_es ~ '^[0-9a-f]{64}$');
    end if;
end $$;

comment on column items.image_phash is '256-bit lowercase hex phash_dct256_v1 for image_url; NULL means unavailable or uncomputed';
comment on column items.image_phash_es is '256-bit lowercase hex phash_dct256_v1 for image_url_es; NULL means unavailable or uncomputed';

commit;
