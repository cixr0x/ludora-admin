# Database Changes

`schema.sql` is the current schema snapshot for review and bootstrap reference. Do not apply it to an existing shared or live database for routine changes.

Routine database changes must be incremental patches under `database/patches/`:

```text
database/patches/YYYYMMDD_NNN_short_description.sql
```

Each patch should contain only the statements required for that change. Apply only the relevant patch file after explicit approval for DDL or DML.

Example:

```powershell
psql "$env:LUDORA_DATABASE_URL" -f .\database\patches\20260705_005_store_item_refreshed_date.sql
```

After a patch is added, keep `schema.sql` aligned as the snapshot of the expected final schema. The snapshot is not the deployment mechanism.
