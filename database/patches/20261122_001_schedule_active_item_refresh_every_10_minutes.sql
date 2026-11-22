-- Apply to the postgres maintenance database that owns the pg_cron job.
BEGIN;

DO $$
DECLARE
    refresh_job_id bigint;
BEGIN
    IF current_database() <> 'postgres' THEN
        RAISE EXCEPTION 'this patch must be applied to the postgres database';
    END IF;

    SELECT job.jobid
    INTO STRICT refresh_job_id
    FROM cron.job AS job
    WHERE job.jobname = 'ludora-active-item-refresh'
      AND job.database = 'ludora_dev'
      AND job.command = 'select public.refresh_active_item_if_needed()';

    PERFORM cron.alter_job(refresh_job_id, schedule := '*/10 * * * *');
END;
$$;

COMMIT;
