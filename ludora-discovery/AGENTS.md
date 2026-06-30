# AGENTS.md

## Discovery Package

This package is invoked by `ludora-admin-service` for normal admin operations.

Run tests from this directory with:

```powershell
python -m unittest discover -s tests -v
```

Do not start a separate discovery API unless explicitly testing `LUDORA_DISCOVERY_RUNNER=http`.

Do not run DDL or DML SQL commands without user confirmation.
