# Batch Boardgame Classification Design

## Goal

Extend the Store Items table batch mode so an admin can select multiple unconfirmed store items and either confirm them as boardgames or confirm them as not boardgames.

## Current Behavior

The table already supports single-row boardgame decisions. Marking a row as boardgame calls the existing confirm endpoint, which may also run matching. Marking a row as not boardgame uses the existing store item update endpoint with `is_boardgame=false` and `is_boardgame_confirmed=true`.

Batch mode currently adds a selection column and sequentially confirms selected rows as boardgames.

## Design

Keep the change in the admin UI. Batch boardgame confirmation will continue to call `adminApi.confirmItemCandidateBoardgame(id)`. Batch not-boardgame confirmation will reuse the same state transition as the single-row not-boardgame action by calling `adminApi.updateItemCandidate(id, { ...candidate, is_boardgame: false, is_boardgame_confirmed: true })`.

The batch toolbar will show two actions while batch mode is enabled:

- `Confirm selected boardgames`
- `Mark selected not boardgames`

Both actions process selected rows sequentially, update rows as each request succeeds, remove successful rows from the selected set, keep failures selected, show progress, and refresh the current table query after the loop completes.

## Error Handling

Partial failure behavior remains unchanged. The UI counts successful and failed items, shows a success message when at least one row succeeds, and shows an error alert when any row fails.

## Testing

Add a React Testing Library test that enters batch mode, selects two unconfirmed store items, clicks `Mark selected not boardgames`, and verifies both selected rows are PATCHed with `is_boardgame=false` and `is_boardgame_confirmed=true`.

No database schema or data changes are required.
