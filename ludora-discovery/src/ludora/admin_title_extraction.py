from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from ludora.models import DiscoveryItemCandidateRecord


class AdminAmazonTitleExtractor:
    def __init__(self, admin_api_url: str, *, timeout_seconds: float = 60) -> None:
        self.admin_api_url = admin_api_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def extract_title(self, record: DiscoveryItemCandidateRecord) -> str:
        if not self.admin_api_url or not record.title.strip():
            return ""

        request = Request(
            urljoin(f"{self.admin_api_url}/", "admin/ai/amazon-title-extractions"),
            data=json.dumps(
                {
                    "amazon_title": record.title,
                    "raw_payload": record.raw_payload,
                    "source_url": record.source_url,
                }
            ).encode("utf-8"),
            headers={"Accept": "application/json", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return _game_title_from_response(response.read().decode("utf-8", errors="replace"))
        except (HTTPError, OSError, TimeoutError, URLError, ValueError, json.JSONDecodeError):
            return ""


def _game_title_from_response(body: str) -> str:
    payload = json.loads(body)
    if not isinstance(payload, dict):
        return ""
    data = payload.get("data")
    if not isinstance(data, dict):
        return ""
    game_title = data.get("game_title")
    return str(game_title).strip() if game_title else ""
