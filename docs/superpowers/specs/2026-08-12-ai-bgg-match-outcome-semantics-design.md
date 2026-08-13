# AI BGG Match Outcome Semantics Design

## Goal

Make every successfully completed AI item-matching decision resolve to either a match or no match. Return an error only when execution fails, not when the AI's evidence is insufficient or internally inconsistent.

## Scope

This change applies to the AI BGG decision service and the item matcher's post-decision BGG identity validation. It preserves the existing CodexAPI request, strict response field types, BGG correction search, cache, import, and linking flows. It requires no database change.

## Outcome Contract

The matcher has three internal outcomes:

1. `matched`: the AI claims a match and the existing BGG validation confirms a positive BGG ID and matching title.
2. `not_found`: the AI reports no match, its claimed match is semantically unusable, or its claimed BGG identity cannot be validated.
3. Error: execution cannot complete because a dependency or operation throws, or the structured AI response cannot be parsed and type-checked.

The public manual AI endpoint continues to expose only `matched` and `not_found` as successful responses. Automated matching continues to use its existing no-match persistence behavior.

## AI Decision Normalization

After the client parses a structurally valid response:

- `matchFound: false` returns `null` regardless of identity or assessment fields left in the response.
- `matchFound: true` returns a match candidate only when all existing positive-match requirements hold: positive integer `bggId`, non-empty `matchedName`, non-empty `bggUrl`, `nameAssessment: MATCH`, and no `coverAssessment: CONFLICT`.
- A positive decision that fails any of those semantic requirements returns `null` rather than throwing.
- Confidence must remain a finite number from zero through one because this is enforced as part of structured response parsing. A response that cannot satisfy the structured contract remains an execution error.

This removes the cross-field no-match consistency exception. Identity fields from a negative decision are ignored and never reach caching or import.

## BGG Identity Validation

For a positive AI candidate, retain the existing validation sequence:

1. Fetch the returned BGG ID.
2. Confirm that the fetched ID and title match the AI identity.
3. If they do not, run the existing fresh exact-title correction search.
4. Accept a unique corrected identity only after fetching and validating it.

If the sequence completes without a validated identity, return `not_found`. Do not write the AI match cache, import a BGG item, or link the store item.

If a BGG request or search throws, preserve the exception as an execution error. This distinguishes negative evidence from an unavailable execution dependency.

## Tracing and Persistence

Expected negative outcomes use the existing `item_matcher.ai_match.no_match` path. Add a concise reason field or preceding validation trace where needed so operators can distinguish:

- an explicit AI no-match;
- an AI decision downgraded by semantic checks;
- an unvalidated BGG identity.

Do not emit `item_matcher.ai_match.failed` for those cases. Continue emitting failure traces for thrown execution errors.

Automatic matching must use the existing no-match update and must not set `processing_error`. Manual matching must return `{ status: 'not_found' }` and preserve any current item association.

## Error Boundary

Errors remain appropriate for:

- CodexAPI request failures;
- invalid JSON or a response that violates required field types or enums;
- thrown BGG fetch or search failures;
- cache write failures;
- import failures;
- database or linking failures;
- unexpected programming exceptions.

An incorrect, contradictory, low-quality, nonexistent, or unverified AI match is not an execution error. It is `not_found`.

## Tests

Regression coverage will prove that:

- every structurally valid negative decision returns `null`, including cover conflicts and leftover identity fields;
- semantically invalid positive decisions return `null` instead of throwing;
- structurally malformed responses and rejected client calls still throw;
- an unresolved or title-mismatched BGG identity returns `not_found` without cache, import, link, or processing-error writes;
- thrown BGG, cache, import, and database operations remain errors;
- traces classify expected negative outcomes as no-match and genuine exceptions as failures;
- focused tests, the serialized full Vitest suite, and the TypeScript build pass.

## Non-Goals

- Changing the AI provider or model.
- Changing the deterministic local, cached BGG, or fresh BGG stages.
- Adding a database status or schema patch.
- Caching negative AI decisions.
- Importing or linking any identity that has not passed BGG validation.
