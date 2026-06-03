# Clean Stores Item Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a clean Stores admin page and a per-store item discovery operation.

**Architecture:** Discovery exposes a one-store item discovery run endpoint. Admin service lists/updates clean stores and proxies item discovery requests after resolving the clean store row. Admin UI adds a Stores table/form screen with a run button in the form.

**Tech Stack:** Python `unittest` and standard-library HTTP server in `ludora-discovery`; Node/Express/Vitest in `ludora-admin-service`; React/MUI/Vitest Testing Library in `ludora-admin-ui`.

---

## Task 1: Discovery One-Store Item Discovery Operation

**Files:**
- Modify `C:/PROJECTS/ludora/ludora-discovery/src/ludora/operations.py`
- Modify `C:/PROJECTS/ludora/ludora-discovery/src/ludora/api.py`
- Test `C:/PROJECTS/ludora/ludora-discovery/tests/test_operations.py`
- Test `C:/PROJECTS/ludora/ludora-discovery/tests/test_api.py`

- [ ] Add failing tests for `start_item_discovery(store_id, website_url)` and `POST /operations/stores/:storeId/item-discovery-runs`.
- [ ] Implement `ItemDiscoveryRunResult`, item runner, manager method, route parsing, and JSON body handling.
- [ ] Run `python -m unittest tests.test_operations tests.test_api -v`.

## Task 2: Admin Service Clean Stores And Operation Proxy

**Files:**
- Modify `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/routes/discovery.ts`
- Modify `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/routes/operations.ts`
- Modify `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/discoveryOperationsClient.ts`
- Modify `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/app.ts`
- Test `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/app.test.ts`
- Test `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/discoveryOperationsClient.test.ts`

- [ ] Add failing tests for `GET /stores`, `PATCH /stores/:id`, and `POST /admin/operations/stores/:storeId/item-discovery-runs`.
- [ ] Add failing client test for discovery API item discovery request.
- [ ] Implement clean store select/update helpers and operation proxy.
- [ ] Run `npm test` in `ludora-admin-service`.

## Task 3: Admin UI Stores Page

**Files:**
- Create `C:/PROJECTS/ludora/ludora-admin/ludora-admin-ui/src/pages/StoresPage.tsx`
- Create `C:/PROJECTS/ludora/ludora-admin/ludora-admin-ui/src/pages/StoresPage.test.tsx`
- Modify `C:/PROJECTS/ludora/ludora-admin/ludora-admin-ui/src/api/client.ts`
- Modify `C:/PROJECTS/ludora/ludora-admin/ludora-admin-ui/src/api/client.test.ts`
- Modify `C:/PROJECTS/ludora/ludora-admin/ludora-admin-ui/src/App.tsx`
- Modify `C:/PROJECTS/ludora/ludora-admin/ludora-admin-ui/src/App.test.tsx`
- Modify `C:/PROJECTS/ludora/ludora-admin/ludora-admin-ui/src/components/AdminLayout.tsx`

- [ ] Add failing UI tests for Stores navigation, table render, edit form save, and run item discovery action.
- [ ] Implement API client methods.
- [ ] Implement navigation and Stores page.
- [ ] Run `npm test` in `ludora-admin-ui`.

## Task 4: Verification

- [ ] Run `python -m unittest discover -s tests -v` in `ludora-discovery`.
- [ ] Run `npm test` and `npm run build` in `ludora-admin-service`.
- [ ] Run `npm test` and `npm run build` in `ludora-admin-ui`.
- [ ] Use the browser to smoke test the Stores page if local servers are running.
