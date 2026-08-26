# Admin AI API Flow

Admin-service is the source of truth for new Ludora AI requests. Add prompts, service logic, route wiring, and OpenAI-compatible Responses clients under `ludora-admin-service/src`, and reuse the shared CodexAPI client helpers under `ludora-admin-service/src/ai/`.

All non-embedding AI requests must use the private CodexAPI service at `http://127.0.0.1:3001/v1`. Do not add a direct OpenAI Responses or Chat Completions fallback. The OpenAI-compatible SDK is transport-only: it connects to CodexAPI and does not authorize official OpenAI generative calls. Direct OpenAI credentials and API access are allowed only for embeddings because CodexAPI does not expose an embeddings endpoint.

## Configuration

Configure the admin-service generative clients and the intentional direct discovery classifier as follows:

```text
CODEX_API_BASE_URL=http://127.0.0.1:3001/v1
CODEX_AI_MODEL=gpt-5.6-terra
CODEX_CLASSIFIER_MODEL=gpt-5.4-mini
OPENAI_API_KEY=<embeddings only>
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
LUDORA_INTERNAL_API_TOKEN=optional_shared_internal_token
```

- `CODEX_API_BASE_URL` is required for non-embedding AI and must resolve to the private loopback CodexAPI `/v1` service. It defaults to that loopback address and rejects a non-loopback target.
- `CODEX_AI_MODEL` is the shared admin-service model for translation, description generation, product-detail extraction, Amazon title extraction, store-profile detection, and AI BGG matching.
- `CODEX_CLASSIFIER_MODEL` is the model for the existing direct Python item-classifier caller. That caller uses CodexAPI directly by design; new discovery AI tasks still go through an admin-service endpoint.
- `OPENAI_API_KEY` and `OPENAI_EMBEDDING_MODEL` are embeddings-only settings. Do not configure an OpenAI key for any generative request.
- `OPENAI_BASE_URL` and `OPENAI_TRANSLATION_MODEL` are legacy compatibility aliases for the loopback CodexAPI base URL and shared Codex model respectively. They never select the official OpenAI API.
- `LUDORA_INTERNAL_API_TOKEN` is optional for normal local admin operations. When unset, admin-service generates a process-local token and passes it to the local discovery subprocess. Configure it explicitly only when another internal process must call protected admin routes. Internal callers send it as `X-Ludora-Internal-Token`.

## Current Admin AI Callers

- `POST /admin/translations`
- `POST /admin/description-generations`
- `POST /admin/discovery/item-candidates/:id/product-details`
- `POST /admin/ai/amazon-title-extractions`
- `POST /admin/store-profile-detections` (website metadata first, AI only for unresolved store fields)
- AI BGG matching after local and cached BGG candidates cannot produce an accepted match
- Auto-list evaluation after an automated store item match links a catalog item

Each non-embedding client must call the shared CodexAPI transport helper instead of constructing a direct OpenAI client or fallback. Keep request and response contracts structured with Responses JSON schema output.

## Discovery Integration

The discovery package is invoked by admin-service for normal operations. For new AI tasks needed during discovery, add an admin-service endpoint and call it from Python through the configured admin API URL. Do not add new Python OpenAI key prompts or separate key setup flows unless the architecture is being intentionally changed.

Discovery-to-admin calls are protected by the same admin auth middleware as browser routes. Python internal callers must use `LUDORA_ADMIN_API_URL` plus `LUDORA_INTERNAL_API_TOKEN`; local admin-service runs inject the token automatically. Internal call failures should raise and fail the discovery run so the operations `error` field records the cause instead of silently keeping partial or unnormalized data.

The item classifier is an existing Python operation internal that uses `CODEX_API_BASE_URL` and `CODEX_CLASSIFIER_MODEL` to call CodexAPI directly. It is an intentional exception to the admin-service route boundary, not an exception to the private-CodexAPI-only provider rule. `OPENAI_BASE_URL` and `OPENAI_CLASSIFIER_MODEL` are loopback compatibility aliases only.

Item embeddings are intentionally different. CodexAPI does not support embeddings, so embedding runs use the official OpenAI embeddings endpoint only, with `OPENAI_API_KEY` and `OPENAI_EMBEDDING_MODEL`. `CODEX_API_BASE_URL` and its legacy aliases do not apply to embeddings.

## AI BGG matcher and BGG cache/import flow

When a confirmed store item has no accepted local-catalog match, matching checks the BGG cache first. Cached AI-verified associations are accepted; ordinary cached search results still receive the normal deterministic score. Only when neither provides an accepted match does the AI BGG matcher call CodexAPI. The matcher sends only JSON text data (`itemName` and `imageUrl`): Codex opens a public cover URL during that same invocation when one is available, researches BGG, and visually compares the covers. This feature does not use generic `input_image` transport. The structured prompt requires the model to search BGG, account for Spanish-to-English titles, compare a store cover with the BGG cover when available, and return no match for a cover conflict or uncertain result.

A positive AI decision is not imported blindly. Admin-service fetches the returned BGG thing, verifies that the fetched BGG ID matches the decision, then stores an AI-verified cache association for both the store title and canonical BGG title. Future matching can reuse that association without another AI request. The normal BGG importer then uses the cached thing when available (or fetches it), upserts the canonical item and BGG metadata, and preserves the BGG taxonomy, people, publisher, alias, parent, and implementation relationships. A missing or invalid BGG validation result fails the match rather than creating an item.

## Auto-list approval flow

After automated discovery links a store item to a catalog item, admin-service first requires a generated Spanish catalog translation, represented by a non-empty `items.description_es`. If the translation is missing, auto-list evaluation returns a `SKIPPED` outcome and neither the CodexAPI request nor image-similarity comparison runs. No `auto_list_result` is stored for that skipped match.

For an eligible translated item, admin-service asks CodexAPI to compare the store cover with `items.image_url_es` (falling back to `items.image_url`) and to compare the store title with both catalog names. The request sends the store cover and catalog cover as two ordered `input_image` parts. CodexAPI securely downloads and validates the public JPEG, PNG, or WebP sources, passes both temporary files to Codex, and removes them after the request. The accompanying text labels image 1 as the store cover and image 2 as the catalog cover.

The response is strict structured JSON. It records the same-cover-artwork check, both detected cover languages, the same-language name check, a `PASS` or `NOT PASS` verdict, and reasoning in `store_items.auto_list_result`. Application code independently enforces the asymmetric cover-language rule and requires every AI check to pass. Infrastructure or malformed-response failures are stored with `status: ERROR` and a fail-closed `NOT PASS` verdict.

In parallel with the AI request, admin-service runs the existing SIFT/homography image-similarity service with the catalog cover as the reference and the store cover as the candidate. The exact score, method, diagnostics, pass/fail result, and required threshold are stored in `auto_list_result` with the AI evidence. Automatic listing requires the generated Spanish translation, an AI verdict of `PASS`, and an image-similarity score greater than or equal to `98`. A missing translation, missing image, failed comparison, score below `98`, or AI failure keeps the item out of automatic listing.

When the translation prerequisite and both evaluation gates pass, the same result update atomically changes `listing_status` from `PENDING` to `LISTED`. It never overwrites `UNLISTED`, `REJECTED`, or another non-pending status, and it verifies that the linked item has not changed before storing the decision. This automatic transition applies to the existing automated matching flow; manual review controls remain available.
