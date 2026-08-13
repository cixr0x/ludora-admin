# AI BGG Match Outcome Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every completed AI BGG matching attempt return either a validated match or no match, reserving errors for actual execution failures.

**Architecture:** Keep the CodexAPI client responsible for structural parsing and type validation. Make the AI matching service normalize structurally valid but semantically unusable decisions to `null`, then make the item matcher normalize completed BGG identity-validation misses to `null` before cache, import, or linking. Thrown dependency and persistence failures continue through the existing error path.

**Tech Stack:** TypeScript 6, Node.js, Vitest 4, existing CodexAPI Responses client and BGG client abstractions.

## Global Constraints

- Preserve the existing private CodexAPI request path and AI model configuration.
- Preserve deterministic local, cached BGG, and fresh BGG stages.
- Preserve strict JSON field, type, enum, and confidence validation.
- Never cache, import, or link an unvalidated AI identity.
- Do not change database schema or execute DDL/DML.
- Do not push or deploy unless separately requested.

---

### Task 1: Normalize Completed AI Decisions

**Files:**
- Modify: `ludora-admin-service/src/aiBggMatching/aiBggMatchingService.test.ts`
- Modify: `ludora-admin-service/src/aiBggMatching/aiBggMatchingService.ts`
- Modify: `ludora-admin-service/src/aiBggMatching/codexAiBggMatchingClient.ts`

**Interfaces:**
- Consumes: `AiBggMatchingClient.findMatch(request, { model }): Promise<AiBggMatchDecision>`.
- Produces: `AiBggMatchingService.findMatch(request): Promise<AiBggMatchFound | null>`, where all structurally valid negative or semantically unusable decisions resolve to `null`.

- [ ] **Step 1: Replace rejection assertions with failing no-match assertions**

Change the service tests so negative decisions with leftover identity/evidence fields and positive decisions with unusable semantics resolve to `null`:

```ts
it.each([
  ['a BGG id', { bggId: 13 }],
  ['a matched name', { matchedName: 'Catan' }],
  ['a BGG URL', { bggUrl: 'https://boardgamegeek.com/boardgame/13/catan' }],
  ['a BGG image URL', { bggImageUrl: 'https://cf.geekdo-images.com/catan.jpg' }],
  ['a matching name assessment', { nameAssessment: 'MATCH' as const }],
  ['a matching cover assessment', { coverAssessment: 'MATCH' as const }],
  ['a conflicting cover assessment', { coverAssessment: 'CONFLICT' as const }]
])('converts a no-match decision paired with %s to null', async (_label, overrides) => {
  const service = createAiBggMatchingService({
    findMatch: async () => decisionFixture(overrides)
  }, { model: 'gpt-5.6-terra' });

  await expect(service.findMatch({ itemName: 'Unknown game', imageUrl: null }))
    .resolves.toBeNull();
});

it.each([
  ['a conflicting cover', { coverAssessment: 'CONFLICT' as const }],
  ['a non-matching name assessment', { nameAssessment: 'NO_MATCH' as const }],
  ['a non-positive BGG id', { bggId: 0 }],
  ['a missing matched name', { matchedName: null }],
  ['a blank matched name', { matchedName: '   ' }],
  ['a missing BGG URL', { bggUrl: null }],
  ['a blank BGG URL', { bggUrl: '   ' }]
])('converts a claimed match with %s to null', async (_label, overrides) => {
  const service = createAiBggMatchingService({
    findMatch: async () => decisionFixture({
      matchFound: true,
      bggId: 13,
      matchedName: 'Catan',
      bggUrl: 'https://boardgamegeek.com/boardgame/13/catan',
      nameAssessment: 'MATCH',
      coverAssessment: 'MATCH',
      ...overrides
    })
  }, { model: 'gpt-5.6-terra' });

  await expect(service.findMatch({ itemName: 'Catan', imageUrl: null }))
    .resolves.toBeNull();
});
```

Change the client cross-field test so it proves structurally valid no-match payloads are parsed instead of rejected:

```ts
await expect(client.findMatch(
  { itemName: 'Unknown game', imageUrl: null },
  { model: 'gpt-5.6-terra' }
)).resolves.toEqual({
  ...decisionFixture(),
  ...overrides
});
```

Keep the existing table that rejects invalid field types, enums, missing fields, extra fields, and out-of-range confidence.

- [ ] **Step 2: Run the focused test and verify RED**

Run from `ludora-admin-service`:

```powershell
npm test -- src/aiBggMatching/aiBggMatchingService.test.ts
```

Expected: the new no-match assertions fail with the current consistency and positive-decision exceptions.

- [ ] **Step 3: Implement semantic normalization**

Remove `assertAiBggMatchDecisionConsistency` from the Codex client parser. In `createAiBggMatchingService`, keep confidence validation and normalize every unusable decision to `null`:

```ts
if (!decision.matchFound) {
  return null;
}

const bggId = decision.bggId;
if (
  decision.coverAssessment === 'CONFLICT' ||
  decision.nameAssessment !== 'MATCH' ||
  typeof bggId !== 'number' ||
  !Number.isInteger(bggId) ||
  bggId <= 0 ||
  !decision.matchedName ||
  !decision.bggUrl
) {
  return null;
}

return {
  ...decision,
  matchFound: true,
  bggId,
  matchedName: decision.matchedName,
  bggUrl: decision.bggUrl
};
```

Delete the obsolete cross-field assertion function and its import. Keep `parseAiBggMatchDecision` responsible for untrusted structural validation.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npm test -- src/aiBggMatching/aiBggMatchingService.test.ts
```

Expected: all AI BGG matching service and client tests pass, including structural failure coverage.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- ludora-admin-service/src/aiBggMatching/aiBggMatchingService.test.ts ludora-admin-service/src/aiBggMatching/aiBggMatchingService.ts ludora-admin-service/src/aiBggMatching/codexAiBggMatchingClient.ts
git commit -m "fix: normalize AI BGG decisions to no match"
```

### Task 2: Normalize Unvalidated BGG Identities

**Files:**
- Modify: `ludora-admin-service/src/itemMatching/itemMatchingService.test.ts`
- Modify: `ludora-admin-service/src/itemMatching/itemMatchingService.ts`

**Interfaces:**
- Consumes: a positive `AiBggMatchFound` and the existing `BggClient.fetchThing`, `searchFresh`, and `search` methods.
- Produces: `GeneratedMatchCandidate | null`; completed validation misses produce `null`, while thrown dependencies still reject.

- [ ] **Step 1: Add failing automated and manual no-match regressions**

Update the existing unresolved-ID and mismatched-title tests to require no processing error, no cache/import/link, and the existing no-match persistence update:

```ts
expect(processingErrorUpdate(updates)).toBeUndefined();
expect(cache.recordAiMatch).not.toHaveBeenCalled();
expect(importer.importBggId).not.toHaveBeenCalled();
expect(linkUpdate(updates)).toBeUndefined();
expect(updates.some((query) =>
  normalizeSql(query.sql).includes("match_source = 'none'")
)).toBe(true);
```

Add a manual regression proving an unresolved AI identity returns `not_found` and preserves the current association:

```ts
const result = await service.matchWithAi?.(42);

expect(result).toEqual({ status: 'not_found' });
expect(cache.recordAiMatch).not.toHaveBeenCalled();
expect(importer.importBggId).not.toHaveBeenCalled();
expect(updates).toEqual([]);
```

Update trace coverage so a completed validation miss emits `item_matcher.ai_match.no_match` with `reason: 'bgg_identity_unvalidated'` or `reason: 'bgg_name_mismatch'`, does not emit `item_matcher.ai_match.failed`, and retains the preceding `item_matcher.ai_match.validation.completed` evidence.

Keep or add a rejected `fetchThing` test proving a thrown BGG exception still emits `item_matcher.ai_match.failed` and follows the processing-error path.

- [ ] **Step 2: Run the focused item matcher test and verify RED**

Run:

```powershell
npm test -- src/itemMatching/itemMatchingService.test.ts
```

Expected: unresolved and mismatched BGG identities still produce processing errors or rejected manual requests, so the new no-match assertions fail.

- [ ] **Step 3: Return no match after completed validation misses**

Replace the validation exceptions in `generateAiBggMatch` with traced `null` outcomes:

```ts
if (!thing || !idValidated) {
  traceLog(traceLogger, 'item_matcher.ai_match.no_match', {
    candidate_id: candidate.id,
    reason: 'bgg_identity_unvalidated'
  });
  return null;
}
if (!nameValidated) {
  traceLog(traceLogger, 'item_matcher.ai_match.no_match', {
    candidate_id: candidate.id,
    reason: 'bgg_name_mismatch'
  });
  return null;
}
```

Add `reason: 'ai_decision_not_accepted'` to the existing no-match trace emitted when the AI matching service returns `null`. Do not catch or convert exceptions from `fetchThing`, `searchFresh`, cache writes, imports, or database operations.

- [ ] **Step 4: Run focused matcher tests and verify GREEN**

Run:

```powershell
npm test -- src/aiBggMatching/aiBggMatchingService.test.ts src/itemMatching/itemMatchingService.test.ts src/aiBggMatching/aiBggMatchingCanary.test.ts
```

Expected: all focused tests pass; completed negative outcomes avoid failure traces and genuine thrown operations retain them.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- ludora-admin-service/src/itemMatching/itemMatchingService.test.ts ludora-admin-service/src/itemMatching/itemMatchingService.ts
git commit -m "fix: treat unvalidated AI BGG identities as no match"
```

### Task 3: Full Verification

**Files:**
- Verify: `ludora-admin-service`

**Interfaces:**
- Consumes: the completed Task 1 and Task 2 commits.
- Produces: fresh test and TypeScript build evidence for handoff.

- [ ] **Step 1: Run the serialized full Vitest suite**

Run from `ludora-admin-service`:

```powershell
npm test -- --maxWorkers=1
```

Expected: all test files and tests pass with zero failures.

- [ ] **Step 2: Run the TypeScript build**

Run:

```powershell
npm run build
```

Expected: TypeScript exits successfully with no compiler errors.

- [ ] **Step 3: Inspect the final diff and repository state**

Run:

```powershell
git diff HEAD~2 --check
git status --short
git log -n 4 --oneline
```

Expected: no whitespace errors, no unrelated changes, and the design, plan, and two implementation commits are visible. Any unrelated pre-existing worktree changes must remain untouched and be reported.
