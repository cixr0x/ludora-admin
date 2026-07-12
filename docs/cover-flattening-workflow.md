# Automatic Cover Flattening Workflow

The admin application provides an automatic **Flatten cover** action alongside the existing manual/GIMP cover workflow.

## Entry points

- A store item can start flattening only when it has both an image URL and a linked item.
- An item can start flattening from `image_url` or `image_url_es`. When both exist, the dialog asks which source to use.

## Workflow

1. The admin service downloads the source image into an ephemeral workflow directory.
2. It runs `python -m ludora.box_silhouette`, using the configured discovery Python and package directory.
3. The authenticated dialog displays the one candidate produced for a two-face perspective or both candidates produced for a three-face perspective.
4. The administrator selects a candidate and chooses `image_url` or `image_url_es` as the destination.
5. The service converts the selected candidate to WebP and progressively reduces quality and dimensions until it is strictly smaller than 100 KB.
6. It uploads the file with an immutable, content-hashed S3 key, updates the selected item image field, and removes the temporary workflow directory.
7. Cancel removes the temporary workflow. Unfinished workflows expire after 30 minutes and are cleaned up when the next workflow request is processed.

Candidates are served through authenticated admin-service endpoints. Local filesystem paths are never returned to the UI. Workflows are intentionally ephemeral and require no database schema changes.

## Configuration

The workflow reuses the existing cover S3 configuration:

- `LUDORA_COVER_PUBLIC_BASE_URL`
- `LUDORA_COVER_S3_BUCKET`
- `LUDORA_COVER_S3_PREFIX`
- `LUDORA_COVER_S3_REGION`

It also uses:

- `LUDORA_DISCOVERY_PACKAGE_DIR`
- `LUDORA_DISCOVERY_PYTHON`
- `LUDORA_COVER_FLATTENING_WORK_DIR` (defaults to the operating system temporary directory)

## Admin-service endpoints

- `POST /admin/cover-flattening-workflows/store-items`
- `POST /admin/cover-flattening-workflows/items`
- `GET /admin/cover-flattening-workflows/:workflowId/candidates/:candidateIndex`
- `POST /admin/cover-flattening-workflows/:workflowId/accept`
- `DELETE /admin/cover-flattening-workflows/:workflowId`
