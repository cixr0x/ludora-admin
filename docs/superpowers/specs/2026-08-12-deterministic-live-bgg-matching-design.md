# Deterministic Live BGG Matching Design

## Goal

Restore deterministic live BoardGameGeek search as an explicit fallback between the existing BGG cache lookup and AI BGG matching. The automated matching order becomes:

1. existing Ludora items;
2. existing BGG cache;
3. deterministic live BGG search;
4. AI BGG matching.

Each stage runs only when the preceding stage has no accepted match. This change corrects incomplete or stale cache misses without using AI when live BGG can establish a high-confidence deterministic match.

## Approved Decisions

- Existing Ludora item matching remains the first stage.
- The existing BGG match cache remains the second stage and never becomes authoritative merely because it contains results.
- Live BGG search is reintroduced as the third stage and must bypass cached search results.
- A live BGG result is accepted only when the existing deterministic score is at least `0.90`.
- A single weak live search result is not accepted merely because it is the only result.
- Deterministic matching does not compare covers. Cross-language identification and cover comparison remain responsibilities of the AI matcher.
- A deterministic live no-match continues to AI.
- A transient live BGG search or BGG Thing-fetch failure is traced and continues to AI.
- Live search results are written to the existing BGG cache through the cached BGG client.
- The manual `Match AI` action remains AI-only and bypasses local, cache, and deterministic live-search stages.
- No database schema, route, UI, discovery, CodexAPI, or AI configuration change is required.

## Approaches Considered

### Add automatic refresh inside the BGG cache client

This would make a cache miss or weak cache result trigger an upstream request internally. It was rejected because callers could no longer distinguish cache access from live BGG access, tracing would be less explicit, and unrelated cache consumers could acquire new network behavior.

### Restore the complete historical translation and BGG-search pipeline

This would restore deterministic translated-title searches in addition to live BGG search. It was rejected because translation, Spanish-to-English identification, and cover comparison now belong to the AI matcher. Restoring translation would duplicate that responsibility and add latency.

### Add an explicit live-search stage to the item matching service

This is the approved approach. The matching order remains visible in one orchestrator, the existing cache and BGG clients keep their current responsibilities, and the change is limited to the automatic item-matching flow.

## Automated Matching Flow

### 1. Existing Ludora items

Run the current local catalog lookup and deterministic scoring. An accepted local match is linked immediately and prevents BGG cache, live BGG, and AI work.

### 2. Existing BGG cache

Call the current cover-aware BGG match-cache lookup with the store item title and optional image URL. Existing deterministic cache entries retain the `0.90` threshold, while previously AI-verified cover-compatible cache associations retain their current trust behavior.

An accepted cache match proceeds through the existing BGG importer and linking flow. If the cache has no accepted match, preserve its rejected candidates as evidence and continue to live BGG.

### 3. Deterministic live BGG search

Call `bggClient.searchFresh(candidate.title)`. This method bypasses cached query results and, in the production cached client, records the upstream results in the existing BGG search cache.

The matcher will:

1. deduplicate search results by positive BGG ID;
2. prioritize normalized exact-title results while preserving BGG result order within the same priority;
3. limit detailed evaluation to at most ten BGG IDs;
4. fetch the full BGG Thing record for each evaluated ID;
5. score the full record with the existing `scoreBggThing()` function;
6. mark a result accepted only when its score is at least `0.90`;
7. stop further Thing fetches when a result is accepted.

Full Thing records are required because alternate names, item type, publisher, and player counts can change the deterministic score. Search-result name similarity alone is insufficient for acceptance.

Generated live candidates identify their evidence source as `live_bgg_search`. Rejected live candidates are merged with rejected cache candidates by BGG ID and remain available to candidate staging when they meet its existing display threshold.

If no live candidate is accepted, continue to AI. If `searchFresh` is unavailable, live search fails, or a Thing fetch fails, emit a failure trace and continue to AI rather than converting the operational failure into a final no-match.

### 4. AI BGG matching

Run the current AI matcher unchanged, using the current store item name and optional image URL. Its cross-language search, cover comparison, structured response validation, positive cache write, BGG validation, import, and linking behavior remain unchanged.

When AI returns no match after the preceding stages also miss, the automatic flow records the existing final no-match outcome. AI errors retain the current processing-error behavior.

## Manual AI Matching

`ItemMatchingService.matchWithAi()` and the review-page `Match AI` button remain a separate force-AI flow. They must not call the new deterministic live-search function and must continue to make a fresh AI decision even when the store item already has an association.

This separation preserves the administrator's ability to use AI specifically to reevaluate a potentially incorrect deterministic or existing match.

## Component Boundaries

### Item matching service

`itemMatchingService.ts` remains the orchestrator. `generateBggMatches()` will insert a focused internal live-search helper after cache evaluation and before `generateAiBggMatch()`.

The helper consumes the current discovery candidate, configured BGG client, and trace logger. It returns generated BGG match candidates using the existing `GeneratedMatchCandidate` shape. It does not import items, link store items, write final no-match state, call AI, or access the database directly.

### BGG client and cache

The existing `BggClient.searchFresh()` and `createCachedBggClient()` behavior are reused. The item matcher must not call ordinary `search()` for this stage because that method may return the same incomplete cached query results already examined by the preceding cache stage.

The production cached client remains responsible for persisting fresh BGG search results. No second cache-writing implementation is added to the item matcher.

### Deterministic scorer

The current `scoreBggThing()` function and `AUTO_MATCH_SCORE_THRESHOLD = 0.90` remain the single scoring and acceptance policy. No image score, language translation score, or special AI-derived boost is introduced into deterministic live matching.

## Merge and Selection Semantics

Cache, live, and AI candidates are merged by BGG ID through the current merge behavior:

- an accepted candidate replaces a rejected candidate for the same BGG ID;
- when acceptance state is equal, the higher score wins;
- final candidates remain sorted by descending score.

An accepted cache result returns before live search. An accepted live result returns before AI. Rejected cache and live candidates are retained only as evidence; they cannot block the AI fallback.

## Failure Semantics

- Local match failure behavior remains unchanged.
- BGG cache lookup failure behavior remains unchanged.
- Missing BGG client or missing `searchFresh`: trace live search as unavailable and continue to AI.
- Live BGG search error: trace a sanitized failure and continue to AI.
- Live BGG Thing-fetch error: trace the failed stage and continue to AI.
- Live BGG no-match: trace successful completion with no accepted candidate and continue to AI.
- AI no-match: record the existing normal final no-match state.
- AI transport, validation, cache, import, or linking failure: retain the current processing-error behavior.

The matcher must distinguish a deterministic no-match from a deterministic operational failure in traces, even though both proceed to AI.

## Observability

The existing trace sequence gains explicit live-stage events between cache and AI:

- `item_matcher.bgg_live_search.start` with candidate ID and query;
- `item_matcher.bgg_live_search.completed` with result count, evaluated count, accepted status, and accepted BGG ID when present;
- `item_matcher.bgg_live_search.failed` with candidate ID and sanitized error;
- existing or equivalent BGG Thing-fetch start/completion events for evaluated candidates.

The overall observable order is:

```text
item_matcher.local_match.*
item_matcher.bgg_cache.*
item_matcher.bgg_live_search.*
item_matcher.ai_match.*
```

The AI events are absent when live matching succeeds. Complete prompts and unrelated product payload are not added to logs.

## Testing

Focused item-matching tests will prove:

- an accepted local item skips BGG cache, live BGG, and AI;
- an accepted BGG cache result skips live BGG and AI;
- an incomplete or non-accepted cache can be corrected by `searchFresh`;
- an accepted live result is imported and linked without an AI call;
- live search uses `searchFresh` and never ordinary `search`;
- live results are deduplicated, exact-title prioritized, and capped at ten Thing evaluations;
- full BGG Thing details, including alternate names and type conflicts, determine the score;
- a score below `0.90` falls through to AI;
- a live no-match falls through to AI;
- a live search error falls through to AI;
- a Thing-fetch error falls through to AI;
- rejected cache and live candidates merge by BGG ID without blocking AI;
- trace events prove cache then live then AI ordering;
- `generateMatchCandidates()` stages qualifying deterministic evidence without changing its existing linking semantics;
- manual `matchWithAi()` never calls deterministic live search, including when the store item is already linked.

Cached BGG client tests continue to prove that `searchFresh()` bypasses cached query results and records returned upstream results. No live BGG, AI, database, or production request is required by automated tests.

Required verification is the focused item-matching and cached-client test suites followed by the admin-service production build. Broader safe tests may be run as a regression gate.

## Scope and Deployment Impact

Expected implementation files are limited to:

- `ludora-admin-service/src/itemMatching/itemMatchingService.ts`;
- `ludora-admin-service/src/itemMatching/itemMatchingService.test.ts`;
- existing cached-client tests only if an uncovered cache-write assertion is required.

No DDL or DML patch is needed. Deployment requires only the admin-service. The admin UI, discovery package, database schema, CodexAPI, model selection, prompt, and manual AI route remain unchanged.
