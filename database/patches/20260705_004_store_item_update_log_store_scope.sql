-- Incremental patch: track the store processed by each item update run.
begin;

alter table if exists job_store_item_update_log
add column if not exists store_id bigint;

create index if not exists job_store_item_update_log_store_id_started_at_idx
on job_store_item_update_log (store_id, started_at desc);

commit;
