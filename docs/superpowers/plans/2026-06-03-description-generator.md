# Description Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development while implementing. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable admin-service description generator endpoint backed by OpenAI structured output.

**Architecture:** Admin-service owns the generator prompt, client abstraction, OpenAI-backed implementation, and route. Tests use fake generator clients and avoid live OpenAI requests.

**Tech Stack:** Express/TypeScript, OpenAI Responses API structured outputs, Vitest.

---

### Task 1: Service Contract

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/descriptionGeneration/descriptionGenerationService.ts`
- Test: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/descriptionGeneration/descriptionGenerationService.test.ts`

- [x] Add tests for request normalization and model/prompt metadata.
- [x] Implement the generator service contract and defaults.
- [x] Run focused service tests.

### Task 2: OpenAI Client

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/descriptionGeneration/descriptionGenerationPrompts.ts`
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/descriptionGeneration/openAiDescriptionGenerationClient.ts`
- Test: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/descriptionGeneration/openAiDescriptionGenerationClient.test.ts`

- [x] Add parser tests for structured output normalization.
- [x] Implement prompts and OpenAI structured JSON client.
- [x] Run focused client tests.

### Task 3: Admin Endpoint

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/routes/descriptionGeneration.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/app.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/server.ts`
- Test: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/app.test.ts`

- [x] Add endpoint tests for success, missing service, and invalid input.
- [x] Expose `POST /admin/description-generations` with snake_case HTTP fields.
- [x] Wire the optional production generator into the app.
- [x] Run admin-service tests and build.
