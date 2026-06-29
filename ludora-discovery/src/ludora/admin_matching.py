from __future__ import annotations

import json
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin
from urllib.request import Request, urlopen

from ludora.models import DiscoveryItemCandidateRecord


class ProcessingErrorRepository(Protocol):
    def mark_item_candidate_processing_error(self, candidate_id: int, error: str) -> None:
        ...


class AdminItemMatcher:
    def __init__(
        self,
        admin_api_url: str,
        repository: ProcessingErrorRepository,
        *,
        timeout_seconds: float = 60,
    ) -> None:
        self.admin_api_url = admin_api_url.rstrip("/")
        self.repository = repository
        self.timeout_seconds = timeout_seconds

    def process_candidate(self, candidate_id: int, record: DiscoveryItemCandidateRecord) -> None:
        if not record.is_boardgame:
            return

        if not self.admin_api_url:
            self.repository.mark_item_candidate_processing_error(candidate_id, "Admin item matcher is not configured")
            return

        request = Request(
            urljoin(f"{self.admin_api_url}/", f"discovery/listings/{quote(str(candidate_id))}/confirm-boardgame"),
            data=json.dumps({"confirmation_source": "automated"}).encode("utf-8"),
            headers={"Accept": "application/json", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                response.read()
        except HTTPError as exc:
            self.repository.mark_item_candidate_processing_error(candidate_id, _http_error_message(exc))
        except (OSError, TimeoutError, URLError, ValueError) as exc:
            self.repository.mark_item_candidate_processing_error(candidate_id, f"Admin item matcher failed: {exc}")


def _http_error_message(error: HTTPError) -> str:
    body = error.read().decode("utf-8", errors="replace")
    message = _json_error_message(body)
    if message:
        return f"Admin item matcher failed with {error.code}: {message}"
    return f"Admin item matcher failed with {error.code}: {body or error.reason}"


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
