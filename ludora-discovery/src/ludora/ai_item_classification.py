from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ludora.item_classification import ClassificationResult, should_auto_confirm_classification
from ludora.models import DiscoveryItemCandidateRecord


DEFAULT_OPENAI_BASE_URL = "http://127.0.0.1:3001/v1"
ALLOWED_CLASSIFICATIONS = {"LIKELY_BOARDGAME", "LIKELY_NON_BOARDGAME"}
CLASSIFICATION_ALIASES = {
    "LIKELY_BOARD_GAME": "LIKELY_BOARDGAME",
    "LIKELY_NON_BOARD_GAME": "LIKELY_NON_BOARDGAME",
}

SYSTEM_PROMPT = """
You classify store product payloads for a board-game catalog.
Use the raw product payload and extracted fields only. Decide whether the product itself is a board-game catalog item.
Classify standalone board games and board-game expansions as LIKELY_BOARDGAME.
Board-game expansions include products described as expansions or ampliaciones, products that add content to a base game, and products whose payload says the product requires a base game.
Do not reject board-game expansions only because they are not playable without the base game.
Accessories, sleeves, dice, paints, replacement parts, food, events, boosters, TCG singles, and unrelated merchandise are non-boardgames.
Return JSON only with:
- classification: LIKELY_BOARDGAME or LIKELY_NON_BOARDGAME
- confidence: number from 0 to 100
- reasoning: short explanation grounded in the payload
""".strip()


class OpenAIItemClassifier:
    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = DEFAULT_OPENAI_BASE_URL,
        timeout_seconds: float = 60,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def classify(self, record: DiscoveryItemCandidateRecord) -> ClassificationResult:
        payload = self._request_classification(record)
        classification_payload = _parse_classification_payload(payload)
        classification = _normalize_classification(classification_payload.get("classification"))
        if classification not in ALLOWED_CLASSIFICATIONS:
            raise RuntimeError(f"AI item classifier returned invalid classification: {classification!r}")

        confidence = classification_payload.get("confidence")
        if not isinstance(confidence, int | float) or confidence < 0 or confidence > 100:
            raise RuntimeError(f"AI item classifier returned invalid confidence: {confidence!r}")

        reasoning = classification_payload.get("reasoning")
        if not isinstance(reasoning, str) or not reasoning.strip():
            raise RuntimeError("AI item classifier returned invalid reasoning")

        return ClassificationResult(
            classification,
            round(float(confidence) / 100, 2),
            [f"AI classifier: {reasoning.strip()}"],
        )

    def apply_item_classification(self, record: DiscoveryItemCandidateRecord) -> DiscoveryItemCandidateRecord:
        result = self.classify(record)
        record.is_boardgame = result.category == "LIKELY_BOARDGAME"
        record.is_boardgame_confirmed = should_auto_confirm_classification(result)
        record.category_confidence = result.confidence
        record.classification_reasons = result.reasons
        return record

    def _request_classification(self, record: DiscoveryItemCandidateRecord) -> dict[str, object]:
        request = Request(
            f"{self.base_url}/responses",
            data=json.dumps(_request_payload(self.model, record)).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            message = _read_http_error_message(exc)
            raise RuntimeError(f"AI item classifier request failed with HTTP {exc.code}: {message}") from exc
        except URLError as exc:
            raise RuntimeError(f"AI item classifier request failed: {exc.reason}") from exc
        except OSError as exc:
            raise RuntimeError(f"AI item classifier request failed: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise RuntimeError("AI item classifier returned invalid JSON response") from exc


def _request_payload(model: str, record: DiscoveryItemCandidateRecord) -> dict[str, object]:
    return {
        "model": model,
        "input": [
            {
                "role": "system",
                "content": SYSTEM_PROMPT,
            },
            {
                "role": "user",
                "content": json.dumps(_record_payload(record), ensure_ascii=False, sort_keys=True),
            },
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "item_boardgame_classification",
                "strict": True,
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "classification": {
                            "type": "string",
                            "enum": sorted(ALLOWED_CLASSIFICATIONS),
                        },
                        "confidence": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 100,
                        },
                        "reasoning": {
                            "type": "string",
                        },
                    },
                    "required": ["classification", "confidence", "reasoning"],
                },
            },
        },
    }


def _normalize_classification(classification: object) -> object:
    if not isinstance(classification, str):
        return classification
    return CLASSIFICATION_ALIASES.get(classification.strip().upper(), classification)


def _record_payload(record: DiscoveryItemCandidateRecord) -> dict[str, object]:
    return {
        "store_id": record.store_id,
        "source_url": record.source_url,
        "source_listing_url": record.source_listing_url,
        "title": record.title,
        "publisher": record.publisher,
        "description": record.description,
        "item_type": record.item_type,
        "min_players": record.min_players,
        "max_players": record.max_players,
        "min_minutes": record.min_minutes,
        "max_minutes": record.max_minutes,
        "min_age": record.min_age,
        "language": record.language,
        "image_url": record.image_url,
        "raw_price": record.raw_price,
        "price": record.price,
        "currency": record.currency,
        "availability": record.availability,
        "store_sku": record.store_sku,
        "raw_payload": record.raw_payload,
    }


def _parse_classification_payload(response_payload: dict[str, object]) -> dict[str, object]:
    output_text = response_payload.get("output_text")
    if isinstance(output_text, str):
        try:
            parsed = json.loads(output_text)
        except json.JSONDecodeError as exc:
            raise RuntimeError("AI item classifier returned invalid classification JSON") from exc
        if isinstance(parsed, dict):
            return parsed
        raise RuntimeError("AI item classifier returned non-object classification JSON")

    extracted = _extract_output_text(response_payload)
    if extracted:
        try:
            parsed = json.loads(extracted)
        except json.JSONDecodeError as exc:
            raise RuntimeError("AI item classifier returned invalid classification JSON") from exc
        if isinstance(parsed, dict):
            return parsed

    raise RuntimeError("AI item classifier response did not include output_text")


def _extract_output_text(response_payload: dict[str, object]) -> str:
    output = response_payload.get("output")
    if not isinstance(output, list):
        return ""

    for item in output:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for content_item in content:
            if not isinstance(content_item, dict):
                continue
            text = content_item.get("text")
            if isinstance(text, str) and text.strip():
                return text
    return ""


def _read_http_error_message(exc: HTTPError) -> str:
    try:
        body = exc.read().decode("utf-8").strip()
    except OSError:
        body = ""
    return body or exc.reason or "request failed"
