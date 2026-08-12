# Store Item Review Rejection Auto-Advance Design

## Goal

When an administrator rejects a store item from the dedicated review details view, load the next pending review exactly as the existing approval flow does. If no pending review remains, return to the Store Item Review list.

## Current Behavior and Root Cause

`ListingCandidatesPage` handles both approval and rejection through `handleSetListingStatus`. After a successful status update, the handler calls `openNextPendingReview` only when the requested status is `LISTED`. A successful `REJECTED` update therefore refreshes the data and displays the rejection message but leaves the rejected item open.

## Design

Keep navigation in the existing shared status handler. After a successful update from the review details mode, call `openNextPendingReview` for either terminal review status: `LISTED` or `REJECTED`.

The existing next-review helper remains unchanged. It requests pending reviews ordered by candidate name, ignores the current candidate and active translate-and-approve submissions, opens the first eligible review, and clears the selected candidate when no review remains.

If the status update succeeds but loading the next review fails, preserve the successful status result and show an action-specific error stating that the item was approved or rejected but the next review could not be loaded. A failed status update continues to leave the current review open and show the existing save error.

## Scope

The change is limited to the Ludora admin UI. It requires no API, admin-service, discovery, or database changes.

## Testing

Add an application-level regression test that opens a pending store item review, rejects it, and verifies that the URL and displayed details advance to the next pending review. The existing approval auto-advance test remains as coverage for the established behavior.

Run the focused regression test, the full admin UI test suite, and the production build.
