# Discovery Operations API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local discovery API that can start and inspect store discovery runs.

**Architecture:** Add a focused operation runner around the existing collector and a standard-library HTTP API that delegates to an in-memory run manager. The API keeps process state in memory for MVP and persists discovery results through the existing repository.

**Tech Stack:** Python 3.10+, standard-library `http.server`, existing `psycopg` persistence.

---

## Files

- Create `src/ludora/operations.py` for run state, manager, and store discovery runner.
- Create `src/ludora/api.py` for HTTP routing and server startup.
- Modify `pyproject.toml` to add the `ludora-discovery-api` script.
- Create `tests/test_operations.py` and `tests/test_api.py`.
- Update `README.md` with the API command and endpoints.

## Tasks

- [ ] Write tests for `run_store_discovery` resolving config, opening the repository, calling `collect_stores`, returning summary counts, and closing the connection.
- [ ] Implement `StoreDiscoveryRunResult`, `StoreDiscoveryRun`, `StoreDiscoveryRunManager`, and `run_store_discovery`.
- [ ] Write API routing tests for health, starting a run, fetching a run, latest run, 404, and active-run conflict.
- [ ] Implement `api.py` with JSON responses and `ludora-discovery-api`.
- [ ] Update docs and run `python -m unittest discover -s tests`.
