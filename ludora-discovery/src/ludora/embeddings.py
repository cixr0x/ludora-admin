from __future__ import annotations

import hashlib
import json
from urllib.request import Request, urlopen

from ludora.database import ItemSearchEmbeddingSource


class OpenAIEmbeddingClient:
    def __init__(self, *, api_key: str, model: str, base_url: str = "https://api.openai.com/v1") -> None:
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")

    def create_embedding(self, text: str) -> list[float]:
        body = json.dumps({"input": text, "model": self.model}).encode("utf-8")
        request = Request(
            f"{self.base_url}/embeddings",
            data=body,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        with urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))

        embedding = payload.get("data", [{}])[0].get("embedding")
        if not isinstance(embedding, list):
            raise RuntimeError("OpenAI embeddings response did not include an embedding")
        return [float(value) for value in embedding]


def build_item_embedding_text(source: ItemSearchEmbeddingSource) -> str:
    lines = [
        f"Name: {source.canonical_name}",
        f"Spanish name: {source.canonical_name_es}",
        f"Description: {source.description}",
        f"Description_es: {source.description_es}",
        f"Categories: {_join_terms(source.categories)}",
        f"Categories_es: {_join_terms(source.categories_es)}",
        f"Mechanics: {_join_terms(source.mechanics)}",
        f"Mechanics_es: {_join_terms(source.mechanics_es)}",
        f"Families: {_join_terms(source.families)}",
        f"Families_es: {_join_terms(source.families_es)}",
    ]
    derived_keywords = _derived_keywords(source)
    if derived_keywords:
        lines.append(f"Derived keywords: {_join_terms(derived_keywords)}")
    return "\n".join(lines)


def source_text_hash(source_text: str) -> str:
    return hashlib.sha256(source_text.encode("utf-8")).hexdigest()


def _join_terms(values: list[str]) -> str:
    return ", ".join(value.strip() for value in values if value.strip())


def _derived_keywords(source: ItemSearchEmbeddingSource) -> list[str]:
    terms: list[str] = []
    terms.extend(_player_keywords(source.min_players, source.max_players))
    terms.extend(_duration_keywords(source.min_minutes, source.max_minutes))
    terms.extend(_complexity_keywords(source.complexity))
    terms.extend(_age_keywords(source.min_age))
    return _dedupe_preserve_order(terms)


def _player_keywords(min_players: int | None, max_players: int | None) -> list[str]:
    if min_players is None and max_players is None:
        return []

    terms: list[str] = []
    lower = min_players if min_players is not None else max_players
    upper = max_players if max_players is not None else min_players

    if lower is not None and lower <= 1:
        terms.extend(["single player", "solo", "solitaire", "one player", "un jugador", "juego en solitario", "solitario"])
    if lower == 2 and upper == 2:
        terms.extend(["two player", "duel", "head to head", "dos jugadores", "duelo"])
    if upper is not None and upper >= 5:
        terms.extend(["large group", "many players", "group game", "grupo grande", "muchos jugadores"])
    if upper is not None and upper >= 8:
        terms.extend(["party game", "fiesta", "juego para fiestas"])

    return terms


def _duration_keywords(min_minutes: int | None, max_minutes: int | None) -> list[str]:
    if min_minutes is None and max_minutes is None:
        return []

    lower = min_minutes if min_minutes is not None else max_minutes
    upper = max_minutes if max_minutes is not None else min_minutes
    if lower is None or upper is None:
        return []

    terms: list[str] = []
    if upper < 45:
        terms.extend(["short duration", "quick game", "fast game", "juego corto", "partida rapida"])
    elif lower <= 90 and upper >= 45:
        terms.extend(["medium duration", "standard length", "duracion media", "partida media"])

    if lower > 90 or upper > 90:
        terms.extend(["long duration", "long game", "juego largo", "partida larga"])

    return terms


def _complexity_keywords(complexity: float | None) -> list[str]:
    if complexity is None:
        return []

    if complexity < 2:
        return [
            "light complexity",
            "easy to learn",
            "beginner friendly",
            "baja complejidad",
            "facil de aprender",
            "ligero",
        ]
    if complexity <= 3.5:
        return [
            "medium complexity",
            "moderate strategy",
            "intermediate",
            "complejidad media",
            "estrategia moderada",
            "intermedio",
        ]
    return [
        "high complexity",
        "heavy strategy",
        "expert game",
        "alta complejidad",
        "estrategico",
        "para expertos",
    ]


def _age_keywords(min_age: int | None) -> list[str]:
    if min_age is None:
        return []

    if min_age <= 8:
        return ["kids", "children", "family friendly", "ninos", "infantil", "familiar", "para familia"]
    if min_age <= 10:
        return ["family friendly", "families", "familiar", "para familia"]
    if min_age <= 13:
        return ["teens", "teen friendly", "adolescentes", "para adolescentes"]
    return ["adult gamers", "older players", "jugadores adultos", "publico adulto"]


def _dedupe_preserve_order(values: list[str]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = value.strip()
        if not normalized or normalized in seen:
            continue
        deduped.append(normalized)
        seen.add(normalized)
    return deduped
