# External Cover Image Optimization Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an apply-only admin Operations subpage that runs the existing external cover image optimizer.

**Architecture:** The admin service gets a small operations endpoint that wraps the existing optimizer with injected dependencies. The admin UI gets a new Operations route, navigation item, API client method, and summary rendering for the returned optimizer result.

**Tech Stack:** Express 5, TypeScript, Vitest, React 19, MUI, Testing Library.

---

### Task 1: Service Endpoint

**Files:**
- Modify: `ludora-admin-service/src/app.ts`
- Modify: `ludora-admin-service/src/routes/operations.ts`
- Modify: `ludora-admin-service/src/server.ts`
- Test: `ludora-admin-service/src/app.test.ts`

- [ ] Write a failing app test that posts to `/admin/operations/external-cover-image-optimizations`, expects status `202`, and verifies the injected optimizer receives `{ apply: true }`.
- [ ] Add an optional `externalCoverImageOptimizer` app dependency with a `run(options)` method.
- [ ] Add the route inside `createOperationsRouter`; return `404` when the optimizer dependency is not configured.
- [ ] Wire production `server.ts` to create node optimizer dependencies and call `optimizeExternalCoverImages(database, dependencies, options)`.
- [ ] Run the focused service test and then the service test suite.

### Task 2: UI API Client

**Files:**
- Modify: `ludora-admin-ui/src/api/client.ts`
- Test: `ludora-admin-ui/src/api/client.test.ts`

- [ ] Write a failing client test that calls `adminApi.optimizeExternalCoverImages()` and expects a credentialed `POST` request to `/admin/operations/external-cover-image-optimizations`.
- [ ] Add optimizer result types matching the service response shape.
- [ ] Add `optimizeExternalCoverImages` to `adminApi`.
- [ ] Run the focused UI client test.

### Task 3: Operations UI

**Files:**
- Modify: `ludora-admin-ui/src/components/AdminLayout.tsx`
- Modify: `ludora-admin-ui/src/App.tsx`
- Modify: `ludora-admin-ui/src/pages/OperationsPage.tsx`
- Test: `ludora-admin-ui/src/App.test.tsx`
- Test: `ludora-admin-ui/src/pages/OperationsPage.test.tsx`

- [ ] Write failing tests for the new navigation link and hash route.
- [ ] Write a failing OperationsPage test that clicks `Optimize External Cover Images`, posts once, and renders summary counts and failures.
- [ ] Add `operations-image-optimization` to the section union, section list, route switch, and Operations navigation children.
- [ ] Extend `OperationPageMode` and render the image optimization card only for that mode.
- [ ] Keep the page apply-only with no dry-run control and no SQL confirmation dialog.
- [ ] Run focused UI tests and then the UI test suite/build.

### Task 4: Final Verification

**Files:**
- No additional files.

- [ ] Run `npm test` and `npm run build` in `ludora-admin-service`.
- [ ] Run `npm test` and `npm run build` in `ludora-admin-ui`.
- [ ] Check `git status --short`.
- [ ] Commit and push only the task changes from the `ludora-admin` repository.
