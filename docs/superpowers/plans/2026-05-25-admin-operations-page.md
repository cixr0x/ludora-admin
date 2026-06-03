# Admin Operations Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Operations page to admin that starts store discovery through the discovery API.

**Architecture:** Admin-service owns the browser-facing proxy and hides the discovery service URL from the UI. The UI gets a compact MUI page with one operation control and polling for active runs.

**Tech Stack:** Node.js, TypeScript, Express, React, Vite, MUI.

---

## Files

- Create `ludora-admin-service/src/discoveryOperationsClient.ts`.
- Create `ludora-admin-service/src/routes/operations.ts`.
- Modify `ludora-admin-service/src/config.ts`, `src/server.ts`, `src/app.ts`, tests, and `.env.example`.
- Modify `ludora-admin-ui/src/api/client.ts`, `src/components/AdminLayout.tsx`, `src/App.tsx`, and tests.
- Create `ludora-admin-ui/src/pages/OperationsPage.tsx` and `OperationsPage.test.tsx`.

## Tasks

- [ ] Write admin-service tests for proxy start/latest/run-id endpoints and conflict propagation.
- [ ] Implement the discovery operations client, config value, and operations router.
- [ ] Write UI tests for Operations navigation and `Run Store Discovery`.
- [ ] Implement the Operations sidebar item, page, client calls, disabled running state, status display, and polling.
- [ ] Run backend and frontend tests/builds, then validate in the browser with discovery/admin/UI dev servers.
