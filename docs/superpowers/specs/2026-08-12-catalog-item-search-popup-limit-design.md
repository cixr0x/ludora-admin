# Catalog Item Search Popup Limit Design

## Goal

Increase the catalog-item result limit from 20 to 50 in every admin popup used to link or associate a store item with catalog items.

## Current Behavior and Root Cause

The admin UI has two independent catalog-item search implementations with separate constants fixed at 20 results:

- `CatalogItemSearchDialog` in `ListingCandidatesPage` serves both the primary-item link/change popup and the additional-item popup.
- `ItemAssociationDialog` in `OfferReviewPage` serves association from the Store Item Review table.

Each implementation requests page zero from `GET /items` with the catalog-name filter, ascending canonical-name sorting, and its local 20-result page size. The API supports a page size of 50, so the restriction originates entirely in the UI constants.

## Design

Create a shared UI constant named `CATALOG_ITEM_SEARCH_LIMIT` with the value `50` in `ludora-admin-ui/src/components/catalogItemSearch.ts`. Import and use that constant in both popup implementations.

All three popup flows will therefore request `page_size=50` while retaining their existing query text, debounce, filtering, exclusions, sorting, scrolling, item selection, loading state, empty state, and error handling.

## Scope

The affected popup flows are:

1. Link or change a store item's primary catalog item from store item details or review details.
2. Add an additional catalog item from store item details or review details.
3. Associate a store item with an existing catalog item from the Store Item Review table.

The main Items table remains unchanged. It already uses 100-row pages with infinite scrolling. No admin-service, discovery, public application, or database changes are required.

## Testing

Update the existing popup integration tests to assert that each affected flow sends `page_size=50`:

- The primary-item link/change popup test.
- The additional-item popup test.
- The Store Item Review table association-popup test.

The review-table test will continue verifying that all returned results are rendered, using a 50-item response instead of the current 20-item response. Run the focused tests for `ListingCandidatesPage` and `OfferReviewPage`, the complete admin UI test suite, and the production build.
