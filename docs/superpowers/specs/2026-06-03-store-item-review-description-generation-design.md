# Store Item Review Description Generation Design

## Goal

Add a Store Item Review action that helps admins generate and save a Spanish catalog description for linked items that do not already have one.

## Scope

This iteration adds a row action in the existing Store Item Review table. It uses the existing admin description generator endpoint and the existing item update endpoint. It does not add batch generation, auto-generation during discovery, or direct database writes from the UI.

## Behavior

The review API includes the source fields needed by the UI:

- `candidate_description`
- `item_description`
- `item_description_es`

The UI shows a compact button in each review row. The button is enabled only when:

- The linked item has no Spanish description.
- The row has an item id.
- The row has both the item description and the store item description.

On click, the UI sends:

- `description_1`: linked item description.
- `description_2`: store item description.
- `boardgame_name`: Spanish item name when present, otherwise the item canonical name.

When generation succeeds, the UI saves the returned `description_es` through `PATCH /items/:id` and updates the current review row so the action becomes disabled.

## Error Handling

The row action shows a loading state while generating and saving. If either the generator call or item update fails, the table stays unchanged and the page shows an error alert.
