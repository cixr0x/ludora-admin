# Active Item Materialized View

This runbook covers the one-time conversion of `public.active_item` from a
regular view to a materialized view with durable, PostgreSQL-side refresh
requests.

Do not apply either SQL patch or change the Lightsail database parameters
until the exact target and statements have been shown and DDL/DML approval has
been granted. Never apply `database/schema.sql` to an existing database.

## Current target and prerequisites

- Lightsail PostgreSQL endpoint: `ls-1fcebfabc409a029a599d794f0afbf9bbbbef4cd.cwl9oewa85gv.us-east-1.rds.amazonaws.com`
- Application database: `ludora_dev`
- Maintenance database: `postgres`
- PostgreSQL version observed before implementation: `18.4`
- `pg_cron` version available before implementation: `1.6`
- `pg_cron` was not installed before implementation.
- PostgreSQL reported the effective `shared_preload_libraries` value as
  `rdsutils,pg_stat_statements,rds_casts`; it did not contain `pg_cron`.
- Lightsail exposed the modifiable `shared_preload_libraries` parameter as
  `pg_stat_statements`. The additional effective libraries are service-managed
  and must not be copied into the Lightsail parameter value.
- `cron.database_name` was `postgres`.

The Lightsail relational database resource name is `ludera` in `us-east-1`.

## 1. Enable pg_cron in Lightsail

Read the current parameter first:

```powershell
aws lightsail get-relational-database-parameters `
  --relational-database-name ludera `
  --region us-east-1 `
  --query "parameters[?parameterName=='shared_preload_libraries']"
```

Preserve the existing modifiable library and add `pg_cron`. For the currently
observed Lightsail parameter value, the intended result is:

```text
pg_stat_statements,pg_cron
```

Apply the static parameter as pending reboot:

```powershell
aws lightsail update-relational-database-parameters `
  --relational-database-name ludera `
  --region us-east-1 `
  --parameters '[{"parameterName":"shared_preload_libraries","parameterValue":"pg_stat_statements,pg_cron","applyMethod":"pending-reboot"}]'
```

Restart the managed database through the Lightsail console or approved API
workflow. After it is available, verify read-only from `ludora_dev`:

```sql
select
    current_setting('shared_preload_libraries') as shared_preload_libraries,
    current_setting('cron.database_name') as cron_database_name;
```

Expected: `shared_preload_libraries` contains `pg_cron`, and
`cron_database_name` is `postgres`.

## 2. Apply the Ludora schema patch

Target: `ludora_dev` only.

Patch:

```text
database/patches/20260822_001_materialize_active_item_refresh_queue.sql
```

Use the standard Node `pg` path documented in
`database/runbooks/apply-database-patches.md`. This patch atomically:

- replaces the regular `active_item` view with a populated materialized view;
- adds the unique `active_item(id)` index required for concurrent refreshes;
- creates the generation-based refresh state row;
- creates the refresh-request and refresh-worker functions;
- adds statement-level triggers to the four source tables; and
- queues an initial refresh to close the migration race window.

## 3. Install pg_cron and schedule the worker

Target: `postgres` maintenance database only.

Patch:

```text
database/patches/20260822_002_schedule_active_item_refresh.sql
```

This patch refuses to run outside the `postgres` database or before `pg_cron`
is preloaded. It installs `pg_cron` and schedules the named job
`ludora-active-item-refresh` once per minute in `ludora_dev`.

When using the admin-service `.env`, derive a maintenance connection URL
without printing its credentials, then apply only the approved patch:

```powershell
$patch = Resolve-Path ..\database\patches\20260822_002_schedule_active_item_refresh.sql

@'
import fs from 'node:fs';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ quiet: true });

const patchPath = process.argv[2];
if (!patchPath) throw new Error('Patch path argument is required');
if (!process.env.LUDORA_DATABASE_URL) throw new Error('LUDORA_DATABASE_URL is required');

const maintenanceUrl = new URL(process.env.LUDORA_DATABASE_URL);
maintenanceUrl.pathname = '/postgres';

const client = new pg.Client({
  connectionString: maintenanceUrl.toString(),
  ssl: process.env.PGSSLMODE === 'no-verify' ? { rejectUnauthorized: false } : undefined
});

await client.connect();
try {
  await client.query(fs.readFileSync(patchPath, 'utf8'));
  console.log(`Applied maintenance database patch: ${patchPath}`);
} finally {
  await client.end();
}
'@ | node --input-type=module - $patch
```

## 4. Verify

In `ludora_dev`, verify the materialized view, queue state, and triggers:

```sql
select schemaname, matviewname, ispopulated
from pg_matviews
where schemaname = 'public'
  and matviewname = 'active_item';

select
    requested_generation,
    refreshed_generation,
    refresh_requested_at,
    last_refreshed_at
from active_item_refresh_state
where singleton = true;

select event_object_table, trigger_name
from information_schema.triggers
where trigger_name like 'request_active_item_refresh_on_%'
order by event_object_table, trigger_name;
```

After at most one minute, `requested_generation` and
`refreshed_generation` should match, `refresh_requested_at` should be null,
and `last_refreshed_at` should advance.

In `postgres`, verify the scheduled job and its latest execution:

```sql
select jobid, jobname, schedule, database, username, active, command
from cron.job
where jobname = 'ludora-active-item-refresh';

select status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (
    select jobid
    from cron.job
    where jobname = 'ludora-active-item-refresh'
)
order by start_time desc
limit 5;
```

## Rollback boundary

Do not drop the materialized view while the cron job is active. A rollback must
first unschedule `ludora-active-item-refresh` in `postgres`, then apply a new
focused Ludora patch that drops the six source triggers and two functions,
drops `active_item_refresh_state`, drops the materialized view, and recreates
the prior regular `active_item` view definition. Prepare and approve that exact
rollback SQL before using it.
