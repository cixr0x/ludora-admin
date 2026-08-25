-- Apply this patch to the PostgreSQL maintenance database named `postgres`,
-- not to the Ludora application database. The target job runs in `ludora_dev`.
-- The Lightsail database parameter `shared_preload_libraries` must include
-- `pg_cron`, and the database must be rebooted, before this patch is applied.

begin;

do $$
begin
    if current_database() <> 'postgres' then
        raise exception 'this patch must be applied to the postgres database';
    end if;

    if not (
        'pg_cron' = any (
            regexp_split_to_array(
                current_setting('shared_preload_libraries'),
                '\s*,\s*'
            )
        )
    ) then
        raise exception 'pg_cron must be present in shared_preload_libraries before this patch is applied';
    end if;
end;
$$;

create extension if not exists pg_cron;

-- Omit the optional username argument. pg_cron rejects any explicit username
-- for non-superusers, even when it is the same as current_user. With the
-- argument omitted, pg_cron owns the job as the calling role and defaults it
-- to active.
select cron.schedule_in_database(
    'ludora-active-item-refresh',
    '* * * * *',
    'select public.refresh_active_item_if_needed()',
    'ludora_dev'
);

commit;
