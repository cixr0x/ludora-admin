# Manual AI BGG Match Design

## Goal

Add a `Match AI` action to the store-item review detail page so an administrator can deliberately rerun the AI BGG matcher for an existing store item. The action is available whether the store item has no primary catalog item or is already linked, because an existing association may be incorrect.

A successful, BGG-validated result immediately becomes the store item's primary catalog association. A no-match or failed attempt preserves the existing association unchanged.

## Approved Decisions

- The button label is `Match AI` and its busy label is `Matching...`.
- The action appears in the review detail page's `Linked item` section next to the existing `Link item` or `Change linked item` action.
- It remains available when a primary item is already linked.
- Every click makes a fresh AI request; it must not short-circuit through deterministic local matching or a BGG-cache lookup.
- The AI receives only the current store item name and optional image URL, using the existing Spanish-aware name and cover matching prompt.
- A returned BGG ID must pass the existing BGG validation before it can alter the association.
- A validated positive result is written to the existing BGG match cache.
- The existing BGG importer reuses or refreshes an existing item, or creates a new item when necessary.
- A successful result immediately replaces the current primary item association.
- No-match, validation failure, unavailable AI, import failure, and other errors leave the current association unchanged.
- No database schema change is required.

## Approaches Considered

### Reuse the existing boardgame-confirmation endpoint

This is the smallest apparent change, but it does not satisfy the requirement. The existing flow first evaluates local catalog matches and trusted BGG cache results. Either can return before AI is invoked, including returning the same incorrect association the administrator is trying to repair.

### Generate a suggestion and require a second confirmation

This adds a preview and explicit acceptance step. It is appropriate for uncertain bulk automation, but it adds unnecessary interaction to a deliberate one-item admin action whose result already passes the strict BGG validation and import pipeline.

### Dedicated force-AI endpoint with validated reassociation

This is the approved approach. It gives the button a precise contract: one fresh AI attempt, existing validation and caching, and immediate reassociation only after successful validation and import.

## User Interface

`PrimaryItemSection` on `ListingCandidatesPage` gains a review-only `Match AI` button in the `Linked item` header action group. The existing catalog-search button remains available for manual selection.

The button is rendered in both states:

- no primary item: `Match AI` and `Link item`;
- existing primary item: `Match AI` and `Change linked item`.

While the request is running, the AI button shows a progress indicator, changes its label to `Matching...`, and is disabled to prevent duplicate requests. Other association actions that could conflict with the in-flight reassociation are also disabled for that store item.

On a successful match, the page:

- updates the selected store-item record and its row in the review list;
- reloads the linked-item preview and item details;
- refreshes dependent primary/additional-item presentation as needed;
- displays a success message naming the matched catalog item.

On a valid no-match, the page shows an informational message that AI found no reliable BGG match. On an error, it shows an error message. Neither outcome removes or changes the currently displayed association.

The button is not added to bulk actions or the standard discovery detail mode in this change.

## Admin API

Add an authenticated admin-service route:

```text
POST /discovery/listings/:id/match-ai
```

The request has no product-data body. The server loads the authoritative store item by path ID, preventing the browser from supplying a different title or image URL.

The response distinguishes the two successful transport outcomes:

```json
{
  "data": {
    "candidate": {},
    "result": {
      "status": "matched",
      "item_id": 123,
      "bgg_id": 377061,
      "matched_name": "Coffee Rush"
    }
  }
}
```

```json
{
  "data": {
    "candidate": {},
    "result": {
      "status": "not_found"
    }
  }
}
```

`candidate` is the refreshed store-item record in both cases. A valid no-match is an expected result, not a transport error. Missing candidates return `404`; unavailable configuration or operational failures use the existing admin-service error handling and do not return a replacement association.

The admin UI client exposes a typed `matchItemCandidateWithAi(id)` method for this route.

## Matching Service

Extend `ItemMatchingService` with a dedicated manual-AI method. It must not call `confirmBoardgameAndMatch`, `generateLocalMatches`, or the BGG cache lookup because all three permit a non-AI short circuit.

The manual method performs this ordered flow:

1. Load the current store item, including its title, optional image URL, and existing item association.
2. Confirm that the AI matcher, BGG client, and BGG importer are configured.
3. Call the existing AI matcher exactly once with only `itemName` and `imageUrl`.
4. If AI returns no match, return `not_found` without writing match fields or changing `item_id`.
5. Validate the returned BGG ID and matched name through the existing BGG thing/fresh-search validation logic.
6. Write the validated positive association to the existing BGG match cache using the current title, canonical BGG name, and cover context.
7. Import the validated BGG ID through the existing importer.
8. Only after import succeeds, update the store item to the imported catalog item and return `matched`.

The AI request and BGG validation logic should be extracted or reused rather than duplicated, so automatic and manual AI matching enforce the same response, cover-conflict, hallucinated-ID, and cache-write rules.

The final store-item update records the same AI-validated BGG evidence used by automatic matching, while trace metadata identifies that the attempt was manually triggered from review.

## Preservation and Failure Semantics

The current primary association is the safety boundary for a manual rematch:

- AI no-match: preserve `item_id` and existing match metadata.
- AI malformed output or transport error: preserve the association and return an error.
- BGG ID or name validation failure: preserve the association and return an error.
- Cache write failure: preserve the association and return an error; do not import or link.
- Import failure: preserve the association and return an error.
- Final association failure: return an error; do not report success.

The method does not mark the store item as `NONE`, clear its item ID, or overwrite its existing match metadata merely because a manual attempt did not find a better match.

Only positive validated matches are cached. Manual matching intentionally bypasses cache reads but retains cache writes so later automatic matching can reuse the validated result.

## Observability

Use the existing request trace logger and add a manual-AI flow boundary with events for:

- manual match start;
- AI completion or no-match;
- BGG validation completion;
- positive cache write;
- import completion;
- reassociation completion;
- terminal failure.

Trace records include the store-item ID and validated BGG/item IDs where applicable. They do not include a complete prompt or unrelated product payload.

## Testing

Admin-service tests cover:

- the dedicated route validates the store-item ID and invokes the manual-AI service method;
- a store item with an existing link still causes exactly one fresh AI request;
- an empty-link store item also invokes AI;
- deterministic local matching and BGG cache lookup are not called by the manual action;
- the exact stored title and optional image URL are passed to AI, including Spanish values;
- missing image is allowed;
- a validated result is cached, imported, and linked;
- an already-imported BGG item is reused through the importer;
- no-match preserves the previous item ID and match metadata;
- AI, validation, cache, and import failures preserve the previous association;
- malformed or hallucinated BGG results cannot replace the association;
- route responses distinguish `matched` from `not_found`.

Admin UI tests cover:

- `Match AI` appears in review mode with no linked item;
- it also appears when an item is already linked;
- it is absent from the standard detail mode;
- clicking it calls the dedicated API rather than boardgame confirmation;
- the busy state prevents duplicate requests;
- success replaces and reloads the linked-item presentation;
- no-match keeps the existing item and displays informational feedback;
- failure keeps the existing item and displays error feedback.

Focused service and UI tests plus their production builds are required. No live AI, BGG, database, or production request is part of the automated test suite.

## Database and Deployment Impact

No DDL or DML patch is needed. The feature reuses the current store-item match columns, BGG caches, catalog importer, and primary association.

Deployment requires the admin-service and admin UI together. The existing loopback CodexAPI dependency and generative-AI configuration remain unchanged.
