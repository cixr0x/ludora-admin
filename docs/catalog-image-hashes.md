# Catalog image hashes

`items.image_phash` corresponds to `image_url`; `image_phash_es` corresponds to `image_url_es`. Both are nullable text, with a check permitting only lowercase 64-character hex values. `NULL` means no image, not yet computed, or failed download/decode. This release stores hashes; it does not change image similarity, matching, linking, or thresholds.

The canonical method is `phash_dct256_v1` in `ludora-discovery/src/ludora/image_phash.py`. Node sends encoded image bytes to this Python module on stdin. It uses existing OpenCV/NumPy dependencies: `IMREAD_COLOR` decoding, BGR grayscale conversion, 64x64 resize with `INTER_AREA`, float32 DCT, upper-left 16x16 coefficients, median excluding the DC coefficient, strict greater-than comparison of all 256 coefficients, row-major/MSB-first packing, and 64 lowercase hex characters. This version is not interchangeable with hashes from another library or preprocessing policy.

OpenCV applies EXIF orientation supported by its decoder and discards alpha. Metadata/orientation unsupported by that decoder is not corrected; hashes represent the resulting decoded raster. Final edited/flattened/optimized WebP bytes have already been normalized by their producing workflow. Future algorithm changes must use a new method version and recompute stored hashes.

All catalog image writers store the URL and corresponding hash in one insert/update. Empty images clear hashes. External hash errors warn and store `NULL`, preserving the existing edit/import outcome. Explicit edits recompute even when the URL is unchanged. Created items use the same source URL snapshot that was hashed; copy-cover checks that the source URL and linked item still match before writing. Local GIMP, flattened, and optimized covers hash the exact uploaded buffer. Managed output keys contain a SHA-256 content suffix, so concurrent uploads of different bytes cannot overwrite an earlier saved asset URL. The local edited file is read once; that buffer is used for both hashing and S3 upload.

## Rollout

1. Review `database/patches/20260928_001_add_item_image_phashes.sql` and obtain explicit approval for its exact DDL before applying it. Do not apply `schema.sql`; it is a reference snapshot.
2. Apply that patch before deploying code that writes the new columns. Deploy the matching admin-service and discovery code together. Existing hashes remain `NULL`.
3. Prepare a backfill SQL artifact using the command below. Review its exact SQL and failure report, then obtain separate DML approval before executing the artifact. No tool in this feature applies SQL.
4. Check returned IDs to identify guards that skipped changed rows; prepare fresh snapshots for those rows if needed.

## Backfill preparation

From `ludora-admin-service`:

```powershell
npm run prepare:catalog-image-hashes -- --output=artifacts/catalog-image-hashes.sql --limit=100
```

This uses the configured `LUDORA_DATABASE_URL` for one `SELECT`, closes its database connection, downloads missing covers, and writes the exact SQL plus `catalog-image-hashes.sql.json` with failures. `--refresh` recomputes existing hashes too, including external images whose bytes changed behind a stable URL. Downloads have a 25 MB limit and 30-second timeout. There is no apply mode. Failed refreshed hashes produce guarded `NULL` assignments; failed uncomputed hashes remain `NULL`. A failed hash gives exit code 1 after writing the review artifacts.

Offline preparation accepts a JSON array instead of connecting to the database:

```powershell
npm run prepare:catalog-image-hashes -- --input=snapshot.json --output=prepared.sql
```

Each row contains `id` as a decimal string, both image URLs, both existing hashes (`null` when missing), `updated_at` as the exact database text timestamp, and optionally `row_version` from `xmin::text`. `image_path` and `image_path_es` optionally supply local encoded image files; paths resolve relative to the JSON file. Without local paths, those images are downloaded. Example:

```json
[
  {
    "id": "77",
    "image_url": "https://cdn.example/game.en.webp",
    "image_url_es": "",
    "image_phash": null,
    "image_phash_es": null,
    "updated_at": "2026-09-28 12:34:56.123456+00",
    "row_version": "3481",
    "image_path": "game.en.webp"
  }
]
```

Each item gets at most one update, guarded by both original URLs/hashes, exact `updated_at`, and `xmin` when supplied. This avoids invalidating a second language update and rejects application writes that replaced content at an unchanged URL after preparation. Preserve timestamp microseconds: JavaScript Date serialization is unsuitable for this snapshot. SQL cannot detect a remote provider changing bytes without any catalog row write; prepare close to execution and refresh later when necessary. An ongoing background poller is outside this release.
