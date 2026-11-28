# Per-store updater Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development and focused test-first checks.

**Goal**: Schedule automatic listing refreshes evenly per store while keeping the continuous claim cheap.
**Architecture**: Keep a single schedule cursor per store. The scheduler seeds a fixed daily window and the existing worker chooses a due store, then one listing.
**Tech Stack**: PostgreSQL, TypeScript Admin service, Python Discovery.
**Spec**: The accepted per-store approach in the conversation and the operating rules below.

## Global Constraints

- Automatic schedule generation begins at 03:00 America/Mexico_City. The 23-hour slot grid is anchored at local 03:00 even after a late start. A window ends at its configured duration, and the gap before the next 03:00 has no claims.
- Use a deterministic grid based on listing count, with a stable fractional stagger by the active stores' ID order. Persist one cursor row per store. At late initialization skip elapsed slots. When already scheduled and at least a full interval behind, skip missed slots and resume at the next grid time. No random picks or catch-up bursts.
- Keep the existing updater as the default rollout mode until the incremental patch is separately approved and applied. Select the same new mode at the worker, schedule service, and monitoring entry points with one Admin setting, `LUDORA_CONTINUOUS_ITEM_UPDATE_PER_STORE` (default false).
- Never execute any database DDL/DML, including against a disposable database. Add a focused patch and align the reference schema. Apply least-privilege grants for the background role to maintain the cursor and for the Admin role to read monitoring state. Run tests only against fakes/mocks. No deploy or merge to main.
- Reuse existing item lease, claim attempt logging, per-store in-flight exclusion, cooldown, success/failure/recovery, and manual one-off item update paths. Do not refactor unrelated code.

## Review Focus

- Fixed-clock 100 and 1,000 count spacing and a 05:00 late start.
- Repeated initialization, manual requests, pre-03:00 gap, and an old-mode completion on the same date.
- Busy/disabled/cooldown store exclusion, expired schedule, and empty or fully locked candidate lists without starving other stores.
- Lease and slot advance commit or roll back together, work begins after commit, and backoff and retry ordering are retained.
- Default mode preserved and enabled mode monitor uses store slots instead of stale item schedule timestamps.

### Task 1: Wire and verify store scheduling end to end

**Files**: New focused patch under `database/patches/` dated 20261127 plus `database/schema.sql`. Admin service config, server, worker manager, schedule service, and operations monitor plus their focused tests. Discovery continuous worker and repository modules plus focused tests. Use a small dedicated module only when it removes duplication.

- [x] Add failing tests for fixed time calculation, idempotent initialization and legacy fallback, propagation of the mode to scheduler and worker, production-path deterministic claim selection, original attempt and lease semantics, and monitor summaries. Poll loop and session tests should use fake repositories. Run the focused tests to see them fail.
- [x] Create a single-row-per-store cursor (store ID PK/FK, window start/end or durable run reference, eligible listing count, deterministic phase, zero-based slot index, next due timestamp, null when exhausted) and an index on the active next due time with store ID tie-breaker. Add persisted schedule-mode discrimination to the existing run log if necessary to distinguish old and new successful runs on the same date. Align the schema snapshot and preserve the old conflict behavior on rollback. Seed all eligible store counts in a grouped read, then UPSERT only store cursors in the scheduler transaction. Reuse the prior day's still-open schedule between midnight and 02:00; do not schedule new work in the gap. Manual scheduling in the new mode should ensure the active daily window idempotently, with no reset of already-consumed slots. If outside the active window, give a clear conflict. Legacy behavior remains unchanged.
- [x] Implement the new per-store claim using the worker's normal dispatch. Check current store `update_active`, window bounds, next due time, in-flight exclusions and store cooldown; order by due time then store ID. Use the existing ordered per-store index to seek the stalest eligible listing and skip competing row locks. Prefer eligible listings with no attempt during this window, then allow retries when backoff is over and no eligible first attempt is waiting. Continue to preserve verified-sitemap enrolment and one-off behavior. Advance the cursor on a missed or empty slot without leasing, so other due stores are reachable. For an actual claim, advance the cursor and persist the item lease, attempt and worker state in the same transaction. Use SQL parameters and reuse common claim bookkeeping. Keep existing retry deadlines as item-level state, independent of the store slot grid.
- [x] Keep Operations monitor usable. In new mode derive scheduled/due/next work from store cursor rows and document the compatible counter semantics. Keep the old SQL and API shape by default. Add concise activation and rollback instructions to the existing operational doc.
- [x] Run focused tests green, all Admin and Discovery unit suites, build, diff/whitespace checks. Commit the focused changes on the isolated branch and report test evidence; the controller reviews and pushes.
