# Catalog image hashes

`items.image_phash` corresponds to `image_url`; `image_phash_es` corresponds to `image_url_es`. Both are nullable text, with a check permitting only lowercase 64-character hex values. `NULL` means no image, not yet computed, or failed download/decode. Catalog hash storage and the canonical algorithm remain unchanged; the local item matcher can also use these hashes as described below.

The canonical method is `phash_dct256_v1` in `ludora-discovery/src/ludora/image_phash.py`. Node sends encoded image bytes to this Python module on stdin. It uses existing OpenCV/NumPy dependencies: `IMREAD_COLOR` decoding, BGR grayscale conversion, 64x64 resize with `INTER_AREA`, float32 DCT, upper-left 16x16 coefficients, median excluding the DC coefficient, strict greater-than comparison of all 256 coefficients, row-major/MSB-first packing, and 64 lowercase hex characters. This version is not interchangeable with hashes from another library or preprocessing policy.

OpenCV applies EXIF orientation supported by its decoder and discards alpha. Metadata/orientation unsupported by that decoder is not corrected; hashes represent the resulting decoded raster. Final edited/flattened/optimized WebP bytes have already been normalized by their producing workflow. Future algorithm changes must use a new method version and recompute stored hashes.

All catalog image writers store the URL and corresponding hash in one insert/update. Empty images clear hashes. External hash errors warn and store `NULL`, preserving the existing edit/import outcome. Explicit edits recompute even when the URL is unchanged. Created items use the same source URL snapshot that was hashed; copy-cover checks that the source URL and linked item still match before writing. Local GIMP, flattened, and optimized covers hash the exact uploaded buffer. Managed output keys contain a SHA-256 content suffix, so concurrent uploads of different bytes cannot overwrite an earlier saved asset URL. The local edited file is read once; that buffer is used for both hashing and S3 upload.

## Local matching

The existing normalized-name scoring and local threshold of `0.85` are unchanged. A unique accepted strongest name wins without downloading an image. If multiple distinct items are within `0.05` inclusive of the strongest name score, images may resolve that group. If no local name is accepted, a nearest-hash query can retrieve catalog items even when their names share no tokens with the listing.

The listing query adapter downloads the encoded image once and invokes `ludora.listing_image_query_hash` once. It retains the canonical raw hash and at most two automatically flattened faces from the existing `box_silhouette` geometry routines. Flattened faces use the same `phash_dct256_v1` routine; they are temporary query variants, not new catalog assets, a new stored hash method, or a listing database column. Normalization failures retain the raw variant. Decoding is limited to 16 megapixels, detector input to 2048 pixels, flattened output to 1200 pixels, and encoded input to 25 MiB. The separate detector cap preserves the original pixels of ordinary 1500-pixel product photos; early downscaling can change silhouette classification. Query and SIFT subprocesses have 30-second timeouts; SIFT temporary files are removed in `finally`. The existing downloader has a 30-second timeout.

Automatic image selection requires all of:

- Raw query distance at most **12 of 256 bits**, or automatically flattened query distance at most **40 bits**.
- A lead of at least **8 bits** over the best observed evidence for the next distinct catalog item, including competitors outside their applicable radius.
- Existing SIFT visual score of at least **95**, comparing the chosen original catalog cover with the exact original downloaded listing bytes. Only the strongest shortlisted winner is verified.

Both default and Spanish catalog covers are compared against all query variants. Covers and variants are collapsed per item before measuring the runner-up. An ineligible raw variant cannot erase a viable normalized variant for the same item; an ineligible but closer competitor can still block automatic selection. Identical/shared covers across distinct items remain ambiguous. Missing hashes are unknown evidence. The nearest query retains the 20 closest distinct items overall plus the 20 closest with viable evidence (at most 40 items); no catalog-wide image downloads or SIFT scan occur. One comparable item can be selected without a runner-up if the distance and visual checks pass.

Selection is shared by automated matching, candidate generation, and persisted candidate listing. An image winner is the sole accepted local result even when its name score is slightly lower. `match_score` continues to hold the name score; hash similarity, distance, variant/geometry, cover field, applicable radius, thresholds, verification, runner-up/gap, outcome, selected flag and local rank live in `raw_payload.local_match` / `match_payload.local_match` and reasons. Generation orders accepted results first, then local results by their shared rank, then BGG results by score. Staged lists containing local results persist `candidate_rank`, which listing restores with safe legacy-score fallback when ranks are absent or malformed; BGG-only payloads retain their legacy shape. Low-name image candidates remain available for review. Original encoded buffers stay in memory and are never persisted in these JSON fields. Match source remains `LOCAL`.

Unresolved close names, missing images/hashes, download/decode/normalization/query/visual failures, and insufficient margins continue through the existing BGG cache, fresh BGG, and AI flow. The current type/context name policy, BGG thresholds, manual Confirm, manual Match AI, and auto-list translation/AI/image gates remain unchanged. Automatic links still undergo the separate auto-list evaluation. Routine update/discovery retry skips are preserved. Historical `NONE` records can be explicitly regenerated through `POST /admin/discovery/item-candidates/:id/match-candidates` after catalog hashes are populated, then associated through the existing manual endpoint; this change adds no UI action or bulk rematch.

These radii are provisional retrieval limits, not identity probabilities. A read-only six-item comparison recovered four cleaner pairs with existing silhouette normalization (14-36 bits); this is **not full-catalog precision/recall validation**. Reference artifacts are `.worktrees/task/matching/real-image-comparison-results.json`, `silhouette-probe-results.json`, and `normalized-hash-ranking-probe.json`. Crop, perspective, poor backgrounds, unflattened catalog images, editions and bundles can still miss or share artwork. A high SIFT score can identify artwork inside a larger product photo; it does not by itself establish equivalent edition or bundle contents.

## On-demand review comparison

Listing Candidates cover comparison also displays fingerprint similarity for the **currently displayed** catalog and store covers. It opts into `POST /admin/image-similarity` with `include_hash_similarity: true`. The original two downloads are shared by SIFT and hashing; the catalog reference is canonically hashed from its original bytes and the listing uses raw plus the existing bounded flattened variants. This pair inspection works for historical MANUAL/BGG/name-only rows without stored hashes or a backfill, and performs no database calls or writes.

Hash similarity is `100 * (256 - differing bits) / 256`, shown to two decimals. The best pair variant is labeled Raw photo or Flattened cover, with the differing-bit count; expandable details retain the raw photo score and normalization status. The best display score can use a flattened variant regardless of matching radii because this is inspection, not an automatic match decision. It is not an identity probability or a replacement for SIFT/name scores. Hash failures preserve any available SIFT result and display Unavailable; legacy responses and missing images also display Unavailable. Changed cover URLs trigger a fresh comparison and stale responses are ignored.

Default endpoint calls retain their existing request/response and do no new hashing. Review hashing keeps the existing 25 MiB input, 16 MP decode, 2048 detector input, 1200 flattened output, two-face and 30-second process limits. The 16 MP reference decode cap is configured only on the review hasher; catalog storage writers keep their prior behavior and canonical method.

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
