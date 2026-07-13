# Admin AI API Flow

Admin-service is the source of truth for new Ludora AI requests. Add prompts, service logic, route wiring, and OpenAI Responses clients under `ludora-admin-service/src`, and reuse the shared client helper at `ludora-admin-service/src/ai/openAiResponsesClient.ts`.

## Configuration

Admin AI clients read the existing admin-service environment:

```text
OPENAI_API_KEY=your_openai_or_codexapi_key
OPENAI_BASE_URL=http://127.0.0.1:3001/v1
OPENAI_TRANSLATION_MODEL=gpt-5.4-nano
LUDORA_INTERNAL_API_TOKEN=optional_shared_internal_token
```

- `OPENAI_API_KEY` enables the AI-backed admin services. If it is missing, routes that require AI return `503`.
- `OPENAI_BASE_URL` is optional. Leave it unset for the official OpenAI API. Set it to a local Codex/OpenAI-compatible `/v1` endpoint for local runs.
- `OPENAI_TRANSLATION_MODEL` is currently the shared text model setting for admin translation, description generation, product details extraction, and Amazon title extraction.
- `LUDORA_INTERNAL_API_TOKEN` is optional for normal local admin operations. When unset, admin-service generates a process-local token and passes it to the local discovery subprocess. Configure it explicitly only when another internal process must call protected admin routes. Internal callers send it as `X-Ludora-Internal-Token`.

## Current Admin AI Callers

- `POST /admin/translations`
- `POST /admin/description-generations`
- `POST /admin/discovery/item-candidates/:id/product-details`
- `POST /admin/ai/amazon-title-extractions`
- `POST /admin/store-profile-detections` (website metadata first, AI only for unresolved store fields)

Each OpenAI-backed client should call `createOpenAiResponsesClient(apiKey, { baseURL })` instead of constructing its own SDK instance. Keep request and response contracts structured with Responses JSON schema output.

## Discovery Integration

The discovery package is invoked by admin-service for normal operations. For new AI tasks needed during discovery, add an admin-service endpoint and call it from Python through the configured admin API URL. Do not add new Python OpenAI key prompts or separate key setup flows unless the architecture is being intentionally changed.

Discovery-to-admin calls are protected by the same admin auth middleware as browser routes. Python internal callers must use `LUDORA_ADMIN_API_URL` plus `LUDORA_INTERNAL_API_TOKEN`; local admin-service runs inject the token automatically. Internal call failures should raise and fail the discovery run so the operations `error` field records the cause instead of silently keeping partial or unnormalized data.

The item classifier is an existing Python operation internal that uses the same OpenAI-compatible Responses endpoint configuration: `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, and `OPENAI_CLASSIFIER_MODEL`. It is aligned with the same local-CodexAPI-vs-OpenAI endpoint flow, but it does not call through an admin-service route or the TypeScript shared helper.

Item embeddings are intentionally different. CodexAPI does not support embeddings, so embedding runs use the official OpenAI embeddings endpoint only, with `OPENAI_API_KEY` and `OPENAI_EMBEDDING_MODEL`. `OPENAI_BASE_URL` does not apply to embeddings.
