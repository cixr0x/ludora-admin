# Admin Local Cover Workflow Design

## Goal

Add an admin-driven workflow for converting a linked store item's Spanish box image into a flat WebP cover with only the GIMP edit left manual.

## Scope

The workflow starts from a linked store item in the admin item details page. The store item must have an `item_id` and an `image_url`. The admin service owns the local workflow because it already has catalog context, database access, and a local Node process that can open GIMP, watch disk, upload to S3, and update the item.

The workflow does not run in `ludora-discovery`.

## User Flow

1. Admin opens an item details page.
2. Admin clicks a cover workflow button on a linked store item row.
3. Admin service loads the store item and linked item, verifies that they are linked, and derives a normalized filename from `normalized_name_es`, then `normalized_name`, then `canonical_name_es`, then `canonical_name`.
4. Admin service downloads the store item image to `C:\Users\mcp13\OneDrive\Documentos\boardgame\<name>.source.<ext>`.
5. Admin service opens GIMP with the downloaded source image.
6. Admin edits the image in GIMP and exports the final WebP into either `C:\Users\mcp13\OneDrive\Documentos\boardgame\<name>.en.webp` or `C:\Users\mcp13\OneDrive\Documentos\boardgame\<name>.es.webp`.
7. Admin service detects that file, uploads it to `s3://ludora/boardgame/<filename>`, and sets content type `image/webp`.
8. Admin service writes the public URL to `items.image_url` for `.en.webp` or `items.image_url_es` for `.es.webp`, overwriting any existing value in that field.

## Architecture

The admin UI adds a row action to the linked store items table. The UI calls a new admin-service endpoint and displays the returned workflow state.

The admin service adds a local cover workflow module. It owns filename normalization, image download, GIMP launch, filesystem polling, S3 upload, and the item update. The service supports one active workflow at a time for v1; a second start request returns `409`.

The service reads these settings from environment variables, with local defaults for non-secret values:

- `LUDORA_COVER_WORK_DIR`: defaults to `C:\Users\mcp13\OneDrive\Documentos\boardgame`
- `LUDORA_COVER_S3_BUCKET`: defaults to `ludora`
- `LUDORA_COVER_S3_PREFIX`: defaults to `boardgame`
- `LUDORA_COVER_S3_REGION`: defaults to `us-east-2`
- `LUDORA_COVER_PUBLIC_BASE_URL`: defaults to `https://ludora.s3.us-east-2.amazonaws.com`
- `LUDORA_COVER_GIMP_PATH`: defaults to `gimp-3.exe`
- AWS credentials: loaded through the AWS SDK standard chain from env files or environment

## API

`POST /admin/local-cover-workflows`

Request:

```json
{
  "store_item_id": 123
}
```

Response:

```json
{
  "data": {
    "workflow_id": "cover-123-77",
    "status": "waiting_for_edit",
    "store_item_id": 123,
    "item_id": 77,
    "filename": "dontgetgot.es.webp",
    "source_path": "C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.source.jpg",
    "expected_path": "C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.es.webp",
    "expected_paths": [
      "C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.en.webp",
      "C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.es.webp"
    ],
    "public_url": "https://ludora.s3.us-east-2.amazonaws.com/boardgame/dontgetgot.es.webp",
    "target_field": null
  }
}
```

`GET /admin/local-cover-workflows/current`

Returns the current active workflow or `null`.

## Error Handling

The endpoint returns `400` if the store item has no linked item or no image URL, `404` if the store item is missing, and `409` if another workflow is active. Background failures are stored in the active workflow state with `status = "failed"` and an error message. Completed workflows have `status = "completed"` and keep the final public URL.

## Testing

Admin-service tests cover filename normalization, workflow start validation, conflict behavior, and the background completion path using injected fake downloader, uploader, opener, and polling dependencies.

Admin UI tests cover rendering the button only for linked store items with images and calling the new API when clicked.
