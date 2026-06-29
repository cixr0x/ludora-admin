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
    return "\n".join(
        [
            f"Name: {source.canonical_name}",
            f"Spanish name: {source.canonical_name_es}",
            f"Description: {source.description}",
            f"Description_es: {source.description_es}",
            f"Categories: {_join_terms(source.categories)}",
            f"Mechanics: {_join_terms(source.mechanics)}",
            f"Families: {_join_terms(source.families)}",
        ]
    )


def source_text_hash(source_text: str) -> str:
    return hashlib.sha256(source_text.encode("utf-8")).hexdigest()


def _join_terms(values: list[str]) -> str:
    return ", ".join(value.strip() for value in values if value.strip())
