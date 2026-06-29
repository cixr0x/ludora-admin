# Cancellable Discovery Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stop option for a currently running Ludora discovery operation.

**Architecture:** The discovery service owns cooperative cancellation through a per-run cancellation token. Admin-service proxies a cancel request to the discovery API, and the admin UI exposes a stop button only when the latest run is running. A cancelled run remains active while cancellation is requested and becomes `cancelled` once the worker reaches a cancellation checkpoint.

**Tech Stack:** Python `threading.Event`, existing `unittest` discovery tests, Express admin-service routes, React/MUI admin UI tests with Vitest.

---

### Task 1: Discovery Manager And API

**Files:**
- Modify: `src/ludora/operations.py`
- Modify: `src/ludora/api.py`
- Test: `tests/test_operations.py`
- Test: `tests/test_api.py`

- [ ] Add tests for `cancel_run(run_id)` returning a running run, requesting cancellation, and final status `cancelled`.
- [ ] Add tests for `POST /operations/store-discovery-runs/{runId}/cancel` returning `202`, `404` for unknown runs, and `409` for non-running runs.
- [ ] Implement `CancellationToken`, `OperationCancelled`, status `cancelled`, and `cancel_run`.
- [ ] Pass cancellation tokens into default operation runners.
- [ ] Run `python -m unittest tests.test_operations tests.test_api`.

### Task 2: Discovery Work Checkpoints

**Files:**
- Modify: `src/ludora/operations.py`
- Modify: `src/ludora/collector.py`
- Modify: `src/ludora/inventory.py`
- Modify: `src/ludora/product_crawler.py`
- Test: existing focused tests

- [ ] Add optional `cancellation_token` parameters to long-running loops.
- [ ] Call `raise_if_cancelled()` between search queries, inventory candidates, update rows, and embedding rows.
- [ ] Run focused discovery tests.

### Task 3: Admin-Service Proxy

**Files:**
- Modify: `ludora-admin-service/src/discoveryOperationsClient.ts`
- Modify: `ludora-admin-service/src/routes/operations.ts`
- Test: `ludora-admin-service/src/discoveryOperationsClient.test.ts`
- Test: `ludora-admin-service/src/app.test.ts`

- [ ] Add a client method that posts to `/operations/store-discovery-runs/{runId}/cancel`.
- [ ] Add admin route `POST /admin/operations/store-discovery-runs/:runId/cancel`.
- [ ] Preserve discovery API status errors.
- [ ] Run admin-service tests.

### Task 4: Admin UI Stop Button

**Files:**
- Modify: `ludora-admin-ui/src/api/client.ts`
- Modify: `ludora-admin-ui/src/pages/OperationsPage.tsx`
- Test: `ludora-admin-ui/src/api/client.test.ts`
- Test: `ludora-admin-ui/src/pages/OperationsPage.test.tsx`

- [ ] Add `cancelled` to run status types and a `cancelStoreDiscoveryRun(runId)` API method.
- [ ] Render a stop button when the latest run is running.
- [ ] Disable start buttons while cancelling.
- [ ] Run UI tests.

### Task 5: Verification And Runtime

**Files:**
- All changed files

- [ ] Run `python -m unittest discover -s tests` in `ludora-discovery`.
- [ ] Run `npm test` and `npm run build` in admin service/UI as applicable.
- [ ] Restart affected local services on fixed ports if tests pass.
- [ ] Confirm no SQL DDL/DML was run.
