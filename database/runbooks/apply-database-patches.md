# Apply Database Patches Runbook

Use this runbook for every Ludora database patch. The goal is to avoid ad hoc SQL execution paths and make approval, execution, and verification repeatable.

## Source Of Truth

- Patch files live in `ludora-admin/database/patches/`.
- Patch filenames use `YYYYMMDD_NNN_short_description.sql`.
- `ludora-admin/database/schema.sql` is a snapshot for review and bootstrap only. Do not apply it to an existing shared or live database.
- The admin service environment file, `ludora-admin/ludora-admin-service/.env`, is the default local source for `LUDORA_DATABASE_URL` and `PGSSLMODE`.

## Workload Role Grants

Review grants whenever a patch creates, replaces, or adds columns to a table or
view, or introduces a sequence. Review them for application changes that need
new access to existing objects too. Inventory the SQL the affected workload
actually runs, including background jobs and failure paths.

| Role | Workload |
| --- | --- |
| `ludora_public_api` | Public catalog, offers, search, SEO export, events, and the contact and counter writes |
| `ludora_admin_api` | Admin routes, maintenance commands, and Admin-side discovery watchdog recording |
| `ludora_background` | Discovery, the continuous updater, and the store-item schedule |

- Grant only the needed operations on named, schema-qualified objects to the
  roles that use them. Review schema `USAGE` and, for views, the exposed columns
  and whether the caller needs access to the underlying relations. An ordinary
  view with `security_invoker` enabled checks the caller's grants on those
  relations. [PostgreSQL CREATE VIEW](https://www.postgresql.org/docs/16/sql-createview.html).
- Table-level privileges apply to columns added later. Column-scoped privileges
  apply only to the named columns. Check whether new columns should be visible
  under existing table grants and whether current queries need an explicit grant
  on a new column. Narrow a broader grant when a new column must stay private.
- For `ON CONFLICT`, check `SELECT` on the named conflict keys and columns read
  in the action or predicates, plus `UPDATE` on columns assigned by
  `DO UPDATE`. Check `SELECT` on columns used by `RETURNING`. Row-locking
  selects such as `FOR UPDATE SKIP LOCKED` also require `UPDATE` on at least
  one column of each locked table. [PostgreSQL INSERT](https://www.postgresql.org/docs/16/sql-insert.html)
  and [SELECT](https://www.postgresql.org/docs/16/sql-select.html).
- Grant sequence `USAGE` for a serial or other `nextval` column default. Use the
  actual sequence name, which may survive a table rename. For an identity
  column, automatic generation is covered by the insert. Check sequence
  privileges separately for direct calls. [PostgreSQL sequence functions](https://www.postgresql.org/docs/16/functions-sequence.html).
- Put grant changes in the focused incremental patch for the change and follow
  the approval gate below. Use explicit grants on affected objects. Avoid
  schema-wide grants, blanket default privileges, and grants to `PUBLIC`.
  See the [workload role patch](../patches/20261124_002_create_database_workload_roles.sql)
  for examples.

## Required Approval Gate

Before applying any DDL or DML:

1. Open the exact patch file.
2. Paste the exact SQL statements that will run.
3. Ask for explicit approval to execute that SQL.
4. Wait for approval before running any command that can change the database.

Approval for creating or editing a patch file is not approval to execute it.

## Preferred Execution Path

Use the admin service Node runtime and its checked-in `pg` dependency. This path does not require `psql` to be installed or `LUDORA_DATABASE_URL` to be set globally in PowerShell.

Use the approved migration connection for schema and grant changes. If the
Admin URL uses a workload login, supply the migration URL to the patch process
through `LUDORA_DATABASE_URL` and keep the saved service credentials intact.

From `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service`:

```powershell
$patch = Resolve-Path ..\database\patches\YYYYMMDD_NNN_short_description.sql

@'
import fs from 'node:fs';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ quiet: true });

const patchPath = process.argv[2];
if (!patchPath) {
  throw new Error('Patch path argument is required');
}

if (!process.env.LUDORA_DATABASE_URL) {
  throw new Error('LUDORA_DATABASE_URL is required in ludora-admin-service/.env');
}

const sql = fs.readFileSync(patchPath, 'utf8');
const client = new pg.Client({
  connectionString: process.env.LUDORA_DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'no-verify' ? { rejectUnauthorized: false } : undefined
});

await client.connect();
try {
  await client.query(sql);
  console.log(`Applied database patch: ${patchPath}`);
} finally {
  await client.end();
}
'@ | node --input-type=module - $patch
```

Replace `YYYYMMDD_NNN_short_description.sql` with the approved patch filename.

## Optional `psql` Path

Use `psql` only when it is installed and the correct environment variables are already loaded in the shell. Do not make this the default path on this workstation.

From `C:\PROJECTS\ludora\ludora-admin`:

```powershell
psql "$env:LUDORA_DATABASE_URL" -f .\database\patches\YYYYMMDD_NNN_short_description.sql
```

If `psql` is not found, use the preferred Node `pg` path above.

## Verification

After applying the patch, run read-only verification that matches the patch. For a new table, verify columns and indexes:

```powershell
@'
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ quiet: true });

const tableName = process.argv[2];
if (!tableName) {
  throw new Error('Table name argument is required');
}

const client = new pg.Client({
  connectionString: process.env.LUDORA_DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'no-verify' ? { rejectUnauthorized: false } : undefined
});

await client.connect();
try {
  const columns = await client.query(
    "select column_name, data_type, is_nullable, column_default " +
    "from information_schema.columns " +
    "where table_schema = current_schema() and table_name = $1 " +
    "order by ordinal_position",
    [tableName]
  );
  const indexes = await client.query(
    "select indexname " +
    "from pg_indexes " +
    "where schemaname = current_schema() and tablename = $1 " +
    "order by indexname",
    [tableName]
  );
  console.log(JSON.stringify({ columns: columns.rows, indexes: indexes.rows }, null, 2));
} finally {
  await client.end();
}
'@ | node --input-type=module - contact_form_submissions
```

Use table-specific verification when the patch changes existing columns, data, constraints, views, or functions.

### Verify workload role access

Use read-only PostgreSQL privilege checks on the affected roles for both
required and forbidden access. Use `has_database_privilege`,
`has_schema_privilege`, `has_table_privilege`, `has_column_privilege`, and
`has_sequence_privilege` as appropriate.
`has_any_column_privilege` detects access from either table or column grants
when checking whether a role must have zero access for a given operation.
These checks account for effective access, including inherited privileges and
grants to `PUBLIC`. [PostgreSQL privilege inquiry functions](https://www.postgresql.org/docs/16/functions-info.html).

For example, each result should be true for the public contact grants.

```sql
SELECT
    has_column_privilege('ludora_public_api', 'public.contact_form_submissions', 'email', 'INSERT')
        AS can_submit_email,
    has_column_privilege('ludora_public_api', 'public.contact_form_submissions', 'id', 'SELECT')
        AS can_return_id,
    has_sequence_privilege('ludora_public_api', 'public.contact_form_submissions_id_seq', 'USAGE')
        AS can_allocate_id,
    NOT has_column_privilege('ludora_public_api', 'public.contact_form_submissions', 'email', 'SELECT')
        AS email_read_is_denied,
    NOT has_table_privilege('ludora_public_api', 'public.contact_form_submissions', 'DELETE')
        AS delete_is_denied;
```

Check the affected workflow as the workload role, including conflict, locking,
and error paths where applicable. Use an approved test environment for
workflow checks that write data. Use read-only production checks unless the
exact write commands have explicit approval.

## Failure Handling

- If `LUDORA_DATABASE_URL` is missing, stop and load or fix `ludora-admin/ludora-admin-service/.env`. Do not scan unrelated env files unless the user asks.
- If `psql` is missing, use the preferred Node `pg` path. Do not spend time searching for another local PostgreSQL client.
- If a patch partially fails, capture the error output, stop, and inspect database state with read-only queries before proposing a corrective incremental patch.
- Do not apply `database/schema.sql` as a recovery step.
