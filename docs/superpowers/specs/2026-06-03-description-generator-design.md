# Description Generator Service Design

## Goal

Add an admin-side description generator that produces a polished Spanish catalog description from a BoardGameGeek-style description, a store item description, and the board game name.

## Scope

This iteration adds a backend admin API endpoint and reusable service in `ludora-admin-service`. It does not automatically write generated text into `items.description_es`, add a queue, or add admin UI controls.

## Service Shape

The service accepts:

- `boardgameName`
- `description1`
- `description2`

`description1` is expected to be the more factual or BGG-style source. `description2` is expected to be the store item source with more ambience, setting, or commercial tone. The service does not require those exact origins so it can be reused by future admin workflows.

The response contains:

- `descriptionEs`
- `metadata`
- `model`
- `promptVersion`

## Generation Rules

The generated copy must:

- Be written only in Spanish.
- Blend factual gameplay details with the setting and ambience of the store source.
- Avoid inventing facts, rules, components, player counts, awards, or availability details not present in the inputs.
- Use an approachable Ludora discovery voice for catalog display.
- Return plain text only. Do not use Markdown, raw HTML, headings, bullets, numbered lists, links, or emphasis markers.
- Fit in 2 to 4 short paragraphs.

## Admin API

Admin-service exposes `POST /admin/description-generations` for internal admin callers. It accepts snake_case HTTP fields and returns the generated Spanish description, metadata, model, and prompt version. When `OPENAI_API_KEY` is not configured, the endpoint returns `503`.

## OpenAI Client

Production admin-service creates an OpenAI-backed description generator only when `OPENAI_API_KEY` is configured. The generator uses the same OpenAI model configuration as the current translation tooling for this first iteration.

The client uses structured JSON output so downstream code does not parse free-form prose.
