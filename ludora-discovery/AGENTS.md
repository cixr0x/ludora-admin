# AGENTS.md

## Fixed Local Ports

Use the fixed Codex startup command for the discovery operations API:

- Discovery service: `python scripts/dev_codex.py`
- Fixed URL: `http://127.0.0.1:8001`

Do not choose another port automatically. If port `8001` is busy, report the owning process and ask before stopping it or using a different port.

Do not run DDL or DML SQL commands without user confirmation.
