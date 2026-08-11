# Practical CodexAPI Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce clean Ludora and CodexAPI branches containing the BGG matcher and realistic runtime/service hardening, while excluding the custom immutable deployment controller.

**Architecture:** CodexAPI owns its constrained runtime and checked-in systemd unit. Ludora owns the BGG matcher and a concise production runbook that references that unit. Standard Git, npm, and systemd operations replace the abandoned custom controller.

**Tech Stack:** TypeScript, Node.js, systemd, Markdown, Vitest/Node test runner, Python unittest.

## Global Constraints

- No deployment, push, production authentication, service mutation, SQL, DDL, or DML.
- Preserve the experimental controller at `archive/immutable-codexapi-deploy-20260810`.
- Ludora practical branch starts at `b37705a`.
- CodexAPI practical branch starts at `f81de99`.
- Do not add a custom deployment controller, transaction journal, filesystem layer, release manager, or bootstrap engine.
- Port `3001` remains loopback-only.

---

### Task 1: Package the practical CodexAPI runtime

**Files:**
- Create: `deploy/codexapi.service`
- Create: `test/systemdUnit.test.ts`
- Modify: `AGENTS.md`
- Delete from practical branch: internal `2026-08-10` Superpowers design/plan/report artifacts

**Interfaces:**
- Produces: a checked-in production unit for the existing constrained runtime.
- Consumes: current CodexAPI configuration and `/health` startup attestation.

- [ ] Add a failing static test that parses the checked-in unit and requires `User=codexapi`, `Group=codexapi`, `127.0.0.1:3001`, dedicated `HOME`/`CODEX_HOME`/workspace, `NoNewPrivileges=true`, a read-only system, private temp space, no access to Ludora/admin or deployment homes, and no broad write paths.
- [ ] Run the focused test and confirm RED because the unit does not exist.
- [ ] Add the minimal unit and make the test GREEN.
- [ ] Remove internal design/report artifacts and replace migration-program AGENTS text with concise service-boundary guidance.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Commit the scoped CodexAPI changes.

### Task 2: Reduce Ludora production guidance

**Files:**
- Modify: `docs/production-deployment.md`
- Modify: `AGENTS.md`
- Test: existing runbook/deployment tests as applicable

**Interfaces:**
- Consumes: `deploy/codexapi.service` from Task 1.
- Produces: concise bootstrap, deployment, rollback, and verification instructions.

- [ ] Add or update focused documentation assertions requiring the checked-in unit path, stop-before-mutation deployment, exact approved commit, clean checkout, health/startup verification, and explicit previous-commit recovery.
- [ ] Remove the old inline CodexAPI unit and global CLI installation instructions.
- [ ] Document dedicated account/home/workspace creation and manual authentication without copying credentials.
- [ ] Keep routine deployment to fixed Git/npm/systemd commands; do not introduce a controller or automatic recovery engine.
- [ ] Update AGENTS guidance to use the concise documented procedure and preserve SQL approval rules.
- [ ] Run focused documentation/deployment tests and `git diff --check`.
- [ ] Commit the scoped Ludora changes.

### Task 3: Cross-repository verification and handoff

**Files:**
- Modify only if verification exposes a scoped defect.

**Interfaces:**
- Produces: evidence that the matcher, runtime, and service contract work together without the abandoned controller.

- [ ] Run complete CodexAPI tests, typecheck, and build.
- [ ] Run focused Ludora BGG matcher/cache tests and admin-service build.
- [ ] Run discovery admin-matcher tests and the complete discovery suite if the focused boundary passes.
- [ ] Scan both branches for `codexapi-deploy.mjs`, immutable deployment controller files, internal report artifacts, public port exposure, and official OpenAI generative fallbacks.
- [ ] Request one final read-only review focused on realistic remote-input, service-identity, and deployment-order risks.
- [ ] Report exact SHAs, tests, skipped environment-only checks, preserved archive branch, and remaining operational steps. Do not push or deploy.
