# Apply Database Patches Runbook

Use this runbook for every Ludora database patch. The goal is to avoid ad hoc SQL execution paths and make approval, execution, and verification repeatable.

## Source Of Truth

- Patch files live in `ludora-admin/database/patches/`.
- Patch filenames use `YYYYMMDD_NNN_short_description.sql`.
- `ludora-admin/database/schema.sql` is a snapshot for review and bootstrap only. Do not apply it to an existing shared or live database.
- The admin service environment file, `ludora-admin/ludora-admin-service/.env`, is the default local source for `LUDORA_DATABASE_URL` and `PGSSLMODE`.

## Required Approval Gate

Before applying any DDL or DML:

1. Open the exact patch file.
2. Paste the exact SQL statements that will run.
3. Ask for explicit approval to execute that SQL.
4. Wait for approval before running any command that can change the database.

Approval for creating or editing a patch file is not approval to execute it.

## Preferred Execution Path

Use the admin service Node runtime and its checked-in `pg` dependency. This path does not require `psql` to be installed or `LUDORA_DATABASE_URL` to be set globally in PowerShell.

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

## Failure Handling

- If `LUDORA_DATABASE_URL` is missing, stop and load or fix `ludora-admin/ludora-admin-service/.env`. Do not scan unrelated env files unless the user asks.
- If `psql` is missing, use the preferred Node `pg` path. Do not spend time searching for another local PostgreSQL client.
- If a patch partially fails, capture the error output, stop, and inspect database state with read-only queries before proposing a corrective incremental patch.
- Do not apply `database/schema.sql` as a recovery step.
