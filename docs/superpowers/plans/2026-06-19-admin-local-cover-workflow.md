# Admin Local Cover Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-service local cover workflow that starts from a linked store item, opens GIMP, waits for an edited `.en.webp` or `.es.webp`, uploads to S3, and updates the linked item's `image_url` or `image_url_es`.

**Architecture:** Add a focused admin-service workflow module with dependency injection for filesystem, process, S3, and database seams. Add admin API routes that call the workflow manager. Add an admin UI row action on linked store items that starts the workflow and reports the current state.

**Tech Stack:** Node.js, TypeScript, Express, Vitest, React, MUI, AWS SDK for JavaScript v3.

---

### Task 1: Admin-Service Workflow Unit

**Files:**
- Create: `ludora-admin-service/src/localCoverWorkflow.ts`
- Test: `ludora-admin-service/src/localCoverWorkflow.test.ts`
- Modify: `ludora-admin-service/package.json`

- [ ] **Step 1: Write failing tests for normalization and successful workflow completion**

Add tests that construct a workflow manager with fake dependencies, start a workflow for a fake store item linked to a fake item, assert the derived filenames, assert GIMP calls, trigger the fake wait-for-file completion, and assert the fake S3 upload plus database update.

- [ ] **Step 2: Add minimal workflow implementation**

Create types for `LocalCoverWorkflowState`, `LocalCoverWorkflowManager`, and injected dependencies. Implement one-active-workflow behavior, filename normalization, source download, process launch, wait-for-file callback, S3 upload, and item update.

- [ ] **Step 3: Run admin-service workflow tests**

Run `npm test -- localCoverWorkflow`.

### Task 2: Admin-Service Routes

**Files:**
- Modify: `ludora-admin-service/src/routes/discovery.ts`
- Modify: `ludora-admin-service/src/app.ts`
- Test: `ludora-admin-service/src/app.test.ts`

- [ ] **Step 1: Write failing route tests**

Add tests for `POST /admin/local-cover-workflows`, `GET /admin/local-cover-workflows/current`, missing store item, unlinked store item, and active workflow conflict.

- [ ] **Step 2: Wire routes to workflow manager**

Expose the workflow manager through app dependencies and add local workflow routes. Route code must not directly perform filesystem or S3 work.

- [ ] **Step 3: Run admin-service tests**

Run `npm test -- --run src/app.test.ts src/localCoverWorkflow.test.ts`.

### Task 3: Admin UI API Client

**Files:**
- Modify: `ludora-admin-ui/src/api/client.ts`
- Test: `ludora-admin-ui/src/api/client.test.ts`

- [ ] **Step 1: Write failing client tests**

Add tests for `startLocalCoverWorkflow(storeItemId)` and `getCurrentLocalCoverWorkflow()`.

- [ ] **Step 2: Implement client methods and types**

Add `LocalCoverWorkflow` type and API methods using the existing `fetchData` and `sendJson` helpers.

- [ ] **Step 3: Run client tests**

Run `npm test -- src/api/client.test.ts`.

### Task 4: Admin UI Row Action

**Files:**
- Modify: `ludora-admin-ui/src/pages/ItemsPage.tsx`
- Test: `ludora-admin-ui/src/pages/ItemsPage.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Assert that linked store items with `item_id` and `image_url` render a cover workflow button. Assert unlinked or image-less rows do not enable the action. Assert clicking the button calls the admin API and displays the filename.

- [ ] **Step 2: Implement row action**

Add a linked-store-item action column and a handler in `ItemsPage`. Keep the UI simple: button label, loading state, success/error alert, and current filename/path details.

- [ ] **Step 3: Run ItemsPage tests**

Run `npm test -- src/pages/ItemsPage.test.tsx`.

### Task 5: Environment and Verification

**Files:**
- Modify: `ludora-admin-service/.env` if non-secret settings are absent
- Modify: `ludora-admin/README.md` or `ludora-admin-service/README.md` if present

- [ ] **Step 1: Add non-secret local cover settings**

Set `LUDORA_COVER_S3_BUCKET=ludora`, `LUDORA_COVER_S3_PREFIX=boardgame`, `LUDORA_COVER_PUBLIC_BASE_URL=https://ludora.s3.us-east-2.amazonaws.com`, and `LUDORA_COVER_WORK_DIR=C:\Users\mcp13\OneDrive\Documentos\boardgame`.

- [ ] **Step 2: Run full verification**

Run admin-service tests and admin-ui tests. Then run a dry local workflow only if the user explicitly confirms, because the live path uploads to S3 and writes `items.image_url` or `items.image_url_es`.
