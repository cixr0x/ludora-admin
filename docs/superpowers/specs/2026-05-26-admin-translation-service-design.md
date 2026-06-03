# Admin Translation Service Design

## Goal

Add a generic admin-side translation service that can translate board game titles, descriptions, mechanics, categories, families, and BGG search-query variants.

## Scope

This iteration adds the reusable backend service, a small admin API endpoint, and its first automated consumer: BGG search-query generation during item matching. It does not add admin UI translation screens, batch queues, manual glossary editing, or automatic metadata import translations.

## Service Shape

The service accepts:

- `text`
- `sourceLanguage`
- `targetLanguage`
- `purpose`
- optional `sourceType`, `sourceId`, and `sourceField`

Supported purposes start with:

- `BGG_SEARCH_QUERY`
- `ITEM_TITLE`
- `ITEM_DESCRIPTION`
- `CATEGORY_NAME`
- `MECHANIC_NAME`
- `FAMILY_NAME`
- `DISPLAY_TEXT`
- `ADMIN_ASSIST`

The response contains:

- `translatedText`
- `alternates`
- `metadata`
- `model`
- `promptVersion`
- cache flag

## Storage

`translation_jobs` stores cacheable translation results. The cache key is `source_text_hash + source_language + target_language + purpose + model + prompt_version`. Rows also store source object metadata when available, status, error message, translated text, alternates, and structured metadata.

## Admin API

Admin-service exposes `POST /admin/translations` for internal admin callers. It accepts snake_case HTTP fields and returns the translated text, alternates, metadata, model, prompt version, and cache flag. When `OPENAI_API_KEY` is not configured, the endpoint returns `503` instead of attempting a live translation.

## OpenAI Client

Production admin-service creates an OpenAI-backed translation client only when `OPENAI_API_KEY` is configured. The default model is configurable with `OPENAI_TRANSLATION_MODEL` and defaults to `gpt-5.4-nano`.

The client uses structured JSON output so downstream code does not parse free-form prose.

## First Consumer

The item matcher uses the service only for BGG search-query recall. It searches BGG with:

1. The original candidate title.
2. The translated title.
3. Alternate search queries returned by the translation service.

Translation output never approves a match. It only helps discover BGG candidates that the conservative matcher still scores and stages for admin review.
