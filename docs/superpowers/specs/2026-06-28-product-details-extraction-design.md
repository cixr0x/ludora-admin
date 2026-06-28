# Product Details Extraction Design

## Goal

Add an admin-side product details extraction process that uses the configured AI endpoint to extract player counts, play duration, and minimum age from store product descriptions. Use it when manually creating an item from a store item candidate with no BGG match, and expose the same process for existing manually created products through a candidate-scoped admin endpoint.

## Scope

This iteration lives in `ludora-admin-service`. It adds a reusable extraction service, an OpenAI-backed client, route wiring for manual item creation, and an explicit admin endpoint for rerunning extraction from an existing store item candidate. It does not add database schema, crawler-time enrichment, background queues, or admin UI controls.

## Extracted Fields

The process extracts these nullable integer fields:

- `minPlayers`
- `maxPlayers`
- `minMinutes`
- `maxMinutes`
- `minAge`

Existing non-null values from `store_items` win over AI output. AI values fill only missing fields. Invalid ranges are normalized conservatively: negative values, zero players, zero minutes, and inconsistent min/max pairs are discarded rather than corrected by invention.

## Service Shape

Add a `productDetailsExtraction` module with:

- `ProductDetailsExtractionRequest`: title, description, raw payload text, source URL, and any existing detail values.
- `ProductDetailsExtractionResult`: merged detail values, raw extracted detail values, metadata, model, and prompt version.
- `ProductDetailsExtractionService.extract(request)`: pure extraction and normalization.
- `ProductDetailsEnrichmentService.enrichCandidate(candidateId, options)`: loads a `store_items` row, extracts missing details, writes merged values back to `store_items`, and optionally writes the same values to the linked `items` row.

This keeps the AI call independent from item creation. Manual creation can use the extractor before inserting the item, while existing products can call enrichment against the original linked candidate.

## AI Client

Production admin-service creates the extractor only when `OPENAI_API_KEY` is configured, reusing `OPENAI_BASE_URL` and the current OpenAI model configuration used by translation and description generation.

The OpenAI client uses Responses structured JSON output. The prompt asks for facts explicitly stated in the product description or raw payload and instructs the model to return `null` when a value is absent or ambiguous.

The response schema contains the extracted detail fields plus metadata:

- confidence
- evidence snippets
- warnings

The service never trusts the model output directly; it parses and normalizes every numeric field before returning a result.

## Manual Create Flow

`POST /discovery/listings/:id/create-item` changes as follows:

1. Load the store item candidate and validate the existing title, URL, and store requirements.
2. If any target detail field is missing and the extractor is configured, call the extraction process using the candidate title, description, raw payload, and existing detail values.
3. Update `store_items` with the merged detail values.
4. Insert the new `items` row using the same merged detail values.
5. Continue publisher, relationship, taxonomy copy, and candidate linking behavior as today.

If the extractor is not configured, manual creation keeps the current behavior and uses candidate values as-is. If the extractor is configured and the AI call fails, the request fails so the admin does not unknowingly create another incomplete no-BGG item.

## Existing Product Enrichment

Add `POST /admin/discovery/item-candidates/:id/product-details` for rerunning the process against an existing store item candidate. The endpoint:

- Loads the candidate by ID.
- Extracts and merges missing detail values from the candidate evidence.
- Saves merged values back to `store_items`.
- If `store_items.item_id` is present, updates the linked `items` row with the same merged values.
- Returns the updated candidate and extraction metadata.

This endpoint is enough for existing products created with no BGG match because those products remain linked through `store_items.item_id`. Batch enrichment is out of scope for this iteration, but the service boundary is reusable by a batch operation without duplicating extraction logic.

If a batch operation is added later, its intended filter is candidates where `store_items.item_id is not null`, `store_items.matched_bgg_id is null`, and at least one target detail field is missing on either `store_items` or the linked `items` row.

## Error Handling

When `OPENAI_API_KEY` is missing, the explicit enrichment endpoint returns `503`. Manual create does not return `503`; it preserves current behavior because product details extraction is an enhancement, not a hard dependency unless configured.

When extraction returns no usable values, the service still succeeds and records metadata warnings in the response. It does not overwrite existing values with null.

When the AI request fails or returns invalid structured JSON, the service raises an error. The route returns the existing JSON error shape.

## Testing

Use test-first changes:

- OpenAI client tests for structured output parsing, scalar normalization, and invalid values.
- Service tests showing existing values win, missing values are filled, and invalid ranges are discarded.
- Route tests showing manual create updates both `store_items` and the new `items` row with extracted values.
- Route tests showing the explicit enrichment endpoint updates both the candidate and linked item for an existing no-BGG product.
- Route tests showing manual create falls back when no extractor is injected, while explicit enrichment returns `503` when unavailable.
