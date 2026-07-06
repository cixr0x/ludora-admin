from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from ludora.models import DiscoveryItemCandidateRecord


class AdminAmazonTitleExtractor:
    def __init__(self, admin_api_url: str, *, internal_api_token: str = "", timeout_seconds: float = 60) -> None:
        self.admin_api_url = admin_api_url.rstrip("/")
        self.internal_api_token = internal_api_token.strip()
        self.timeout_seconds = timeout_seconds

    def extract_title(self, record: DiscoveryItemCandidateRecord) -> str:
        if not self.admin_api_url:
            raise RuntimeError("Admin Amazon title extractor is not configured")
        if not record.title.strip():
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
            headers=_admin_headers(self.internal_api_token),
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                game_title = _game_title_from_response(response.read().decode("utf-8", errors="replace"))
                if not game_title:
                    raise RuntimeError("Admin Amazon title extractor returned an empty game title")
                return game_title
        except HTTPError as exc:
            raise RuntimeError(_http_error_message(exc)) from exc
        except (OSError, TimeoutError, URLError) as exc:
            raise RuntimeError(f"Admin Amazon title extractor failed: {exc}") from exc
        except (ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Admin Amazon title extractor returned an invalid response: {exc}") from exc


def _admin_headers(internal_api_token: str) -> dict[str, str]:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if internal_api_token:
        headers["X-Ludora-Internal-Token"] = internal_api_token
    return headers


def _http_error_message(error: HTTPError) -> str:
    body = error.read().decode("utf-8", errors="replace")
    message = _json_error_message(body)
    if message:
        return f"Admin Amazon title extractor failed with {error.code}: {message}"
    return f"Admin Amazon title extractor failed with {error.code}: {body or error.reason}"


def _game_title_from_response(body: str) -> str:
    payload = json.loads(body)
    if not isinstance(payload, dict):
        return ""
    data = payload.get("data")
    if not isinstance(data, dict):
        return ""
    game_title = data.get("game_title")
    return str(game_title).strip() if game_title else ""


def _json_error_message(body: str) -> str:
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return ""
    if not isinstance(payload, dict):
        return ""
    error = payload.get("error")
    if not isinstance(error, dict):
        return ""
    message = error.get("message")
    return str(message) if message else ""
