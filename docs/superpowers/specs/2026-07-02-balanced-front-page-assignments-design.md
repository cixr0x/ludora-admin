# Balanced Front Page Assignments Design

## Goal

Add a second front page assignment algorithm that keeps the existing random assignment path available while producing more balanced homepage category coverage.

## Current Behavior

The admin service currently exposes `POST /front-page-categories/random-item-assignments`. It clears and rebuilds `front_page_category_items` by walking front page categories through thirty-two cycles and randomly selecting one eligible game per category slot. Eligibility is limited to `active_item` rows with `has_approved_listing = true` and `is_expansion = false`.

The current algorithm can overfill broad categories because each category independently chooses random matching games. A game that matches both a broad category such as `Card Game` and a narrower category such as `Video Game Based` has no category-balancing preference.

## Proposed Behavior

Add a new balanced random assignment flow without changing the existing random flow.

The new flow randomly orders eligible games first. For each eligible game, it finds every matching front page category across all supported front page category types:

- `category`, through `item_categories`
- `family`, through `item_families`
- `mechanic`, through `item_mechanics`

For each matching category, the algorithm computes how many currently unassigned eligible games still match that category. It assigns the game to the matching category with the smallest remaining unassigned eligible pool. Ties are broken randomly so repeated runs still vary.

Only one front page category assignment is created per game. Expansions are excluded, and only `active_item` rows with approved listings are eligible.

## API Design

Keep the existing endpoint unchanged:

- `POST /front-page-categories/random-item-assignments`

Add a new endpoint:

- `POST /front-page-categories/balanced-random-item-assignments`

Both endpoints return the same response shape:

```json
{
  "data": {
    "assigned_count": 0,
    "skipped_count": 0,
    "replaced_count": 0,
    "removed_count": 0
  }
}
```

`assigned_count` is the number of inserted or updated assignments. `skipped_count` is the number of randomly considered eligible games that had no matching front page category. `replaced_count` is the number of assignments present before the run. `removed_count` is the number of stale previous assignments removed after the new run.

## Admin UI Design

Keep the existing `Assign Random Games` button. Add a separate `Assign Balanced Games` button on the Front Page Categories admin page.

The new button calls the new endpoint and displays a distinct success or error message. It uses the existing loading state style and is disabled while an assignment run is in progress or when there are no front page categories loaded.

## Data Flow

The balanced SQL runs as a single database mutation query from the admin service:

1. Count existing `front_page_category_items`.
2. Build the set of eligible `active_item` games ordered by `random()`.
3. Recursively process each game in random order.
4. For the current game, find matching front page categories across category, family, and mechanic metadata.
5. For each matching category, count unassigned eligible games that still match it.
6. Choose the category with the smallest remaining count, with random tie-breaking.
7. Assign the current game to that category with an `item_order` based on the selected category's current assignment count plus one.
8. Upsert selected assignments into `front_page_category_items`.
9. Delete previous assignments for games not selected by this run.
10. Return assignment counts.

## Error Handling

The new endpoint follows the current route pattern: database errors are passed to Express error middleware. The UI catches failures and shows a clear assignment error without changing category rows.

## Testing

Admin service tests will verify that the new endpoint:

- Calls a separate SQL statement from the existing random endpoint.
- Keeps the old endpoint unchanged.
- Uses `active_item`.
- Requires `has_approved_listing = true`.
- Excludes `is_expansion = false`.
- Matches all front page category types through `item_categories`, `item_families`, and `item_mechanics`.
- Orders eligible games randomly before assignment.
- Chooses the matching category with the fewest remaining unassigned eligible games.
- Upserts into and deletes stale rows from `front_page_category_items`.

Admin UI tests will verify that:

- The API client posts to `/front-page-categories/balanced-random-item-assignments`.
- The Front Page Categories page renders the new button.
- Clicking it shows the balanced assignment success message.
- The existing random assignment button still calls the existing endpoint.
