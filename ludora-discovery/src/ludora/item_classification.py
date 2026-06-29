from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

from ludora.models import DiscoveryItemCandidateRecord


ClassificationCategory = Literal["LIKELY_BOARDGAME", "LIKELY_EXPANSION", "UNCERTAIN", "LIKELY_NON_BOARDGAME"]
AUTO_CONFIRM_NON_BOARDGAME_CONFIDENCE_THRESHOLD = 0.6


BOARDGAME_TERMS = (
    "board game",
    "boardgame",
    "juego de mesa",
    "juegos de mesa",
    "family game",
    "familiar",
    "familiares",
    "party game",
    "estrategia",
    "cooperativo",
    "jugadores",
    "turnos",
)

EXPANSION_TERMS = (
    "expansion",
    "ampliacion",
    "expande",
    "requiere el juego base",
    "requires base game",
)

NON_BOARDGAME_TERMS = (
    "paint",
    "pintura",
    "acrilica",
    "acrilico",
    "brush",
    "pincel",
    "glue",
    "pegamento",
    "hobby color",
    "sleeve",
    "sleeves",
    "protectores",
    "deck box",
    "binder",
    "dados",
    "dice set",
    "miniature",
    "miniatura",
    "terrain",
    "warhammer",
    "magic the gathering",
    "pokemon tcg",
    "yu-gi-oh",
    "booster",
    "single card",
)

KNOWN_BOARDGAME_PUBLISHERS = (
    "devir",
    "asmodee",
    "libellud",
    "horrible guild",
    "fantasy flight",
    "z-man",
    "days of wonder",
    "maldito",
)


@dataclass(frozen=True)
class ClassificationResult:
    category: ClassificationCategory
    confidence: float
    reasons: list[str]


def classify_item_candidate(record: DiscoveryItemCandidateRecord) -> ClassificationResult:
    evidence = _evidence_text(record)
    normalized = _normalize(evidence)
    reasons: list[str] = []
    positive_score = 0.0
    negative_score = 0.0

    if record.min_players or record.max_players:
        positive_score += 0.35
        reasons.append("player count found")
    if record.min_minutes or record.max_minutes:
        positive_score += 0.2
        reasons.append("play time found")
    if record.min_age:
        positive_score += 0.15
        reasons.append("minimum age found")

    boardgame_terms = _matched_terms(normalized, BOARDGAME_TERMS)
    if boardgame_terms:
        positive_score += min(0.45, 0.15 * len(boardgame_terms))
        reasons.append(f"boardgame terms found: {', '.join(boardgame_terms[:3])}")

    publisher = _normalize(record.publisher)
    if publisher and any(known in publisher for known in KNOWN_BOARDGAME_PUBLISHERS):
        positive_score += 0.3
        reasons.append("known boardgame publisher found")

    expansion_terms = _matched_terms(normalized, EXPANSION_TERMS)
    if expansion_terms:
        positive_score += 0.3
        reasons.append(f"expansion terms found: {', '.join(expansion_terms[:3])}")
        return ClassificationResult("LIKELY_EXPANSION", _confidence(0.75 + positive_score / 4), reasons)

    negative_terms = _matched_terms(normalized, NON_BOARDGAME_TERMS)
    if negative_terms:
        negative_score += min(0.85, 0.25 * len(negative_terms))
        reasons.append(f"non-boardgame terms found: {', '.join(negative_terms[:3])}")

    if positive_score >= 0.5:
        return ClassificationResult("LIKELY_BOARDGAME", _confidence(0.65 + positive_score / 3), reasons)

    if negative_score >= 0.5:
        return ClassificationResult("LIKELY_NON_BOARDGAME", _confidence(0.65 + negative_score / 3), reasons)

    if positive_score > 0:
        return ClassificationResult("LIKELY_BOARDGAME", _confidence(0.55 + positive_score / 4), reasons)

    return ClassificationResult("UNCERTAIN", 0.5, reasons or ["insufficient classification evidence"])


def apply_item_classification(record: DiscoveryItemCandidateRecord) -> DiscoveryItemCandidateRecord:
    result = classify_item_candidate(record)
    record.is_boardgame = result.category in {"LIKELY_BOARDGAME", "LIKELY_EXPANSION"}
    record.is_boardgame_confirmed = should_auto_confirm_classification(result)
    record.category_confidence = result.confidence
    record.classification_reasons = [f"heuristic classifier: {reason}" for reason in result.reasons]
    return record


def should_auto_confirm_classification(result: ClassificationResult) -> bool:
    return (
        result.category == "LIKELY_NON_BOARDGAME"
        and result.confidence > AUTO_CONFIRM_NON_BOARDGAME_CONFIDENCE_THRESHOLD
    )


def _evidence_text(record: DiscoveryItemCandidateRecord) -> str:
    raw_values: list[str] = _structured_raw_payload_values(record.raw_payload)
    return " ".join(
        [
            record.title,
            record.publisher,
            record.description,
            record.item_type,
            " ".join(raw_values),
        ]
    )


def _structured_raw_payload_values(raw_payload: dict[str, object]) -> list[str]:
    json_ld = raw_payload.get("json_ld")
    if not json_ld:
        return []
    return [_stringify_raw_value(json_ld)]


def _stringify_raw_value(value: object) -> str:
    if isinstance(value, dict):
        return " ".join(_stringify_raw_value(item) for item in value.values())
    if isinstance(value, list):
        return " ".join(_stringify_raw_value(item) for item in value)
    return str(value)


def _matched_terms(text: str, terms: tuple[str, ...]) -> list[str]:
    matches: list[str] = []
    for term in terms:
        normalized_term = _normalize(term)
        pattern = rf"(^|\W){re.escape(normalized_term)}($|\W)"
        if re.search(pattern, text):
            matches.append(term)
    return matches


def _normalize(value: str) -> str:
    without_accents = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return " ".join(without_accents.casefold().split())


def _confidence(value: float) -> float:
    return round(max(0.0, min(0.99, value)), 2)
