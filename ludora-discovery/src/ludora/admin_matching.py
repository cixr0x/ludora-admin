from __future__ import annotations

import json
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin
from urllib.request import Request, urlopen

from ludora.models import DiscoveryItemCandidateRecord
from ludora.trace import NullTraceLogger, TraceLogger


class ProcessingErrorRepository(Protocol):
    def mark_item_candidate_processing_error(self, candidate_id: int, error: str) -> None:
        ...


class AdminItemMatcher:
    def __init__(
        self,
        admin_api_url: str,
        repository: ProcessingErrorRepository,
        *,
        internal_api_token: str = "",
        timeout_seconds: float = 180,
        trace_logger: TraceLogger | None = None,
    ) -> None:
        self.admin_api_url = admin_api_url.rstrip("/")
        self.internal_api_token = internal_api_token.strip()
        self.repository = repository
        self.timeout_seconds = timeout_seconds
        self.trace_logger = trace_logger or NullTraceLogger()

    def process_candidate(self, candidate_id: int, record: DiscoveryItemCandidateRecord) -> None:
        if not record.is_boardgame:
            self.trace_logger.log(
                "admin_matcher.skipped_non_boardgame",
                candidate_id=candidate_id,
                source_url=record.source_url,
                title=record.title,
            )
            return

        if not self.admin_api_url:
            self._fail_candidate(candidate_id, "Admin item matcher is not configured")

        url = urljoin(f"{self.admin_api_url}/", f"discovery/listings/{quote(str(candidate_id))}/confirm-boardgame")
        request = Request(
            url,
            data=json.dumps({"confirmation_source": "automated"}).encode("utf-8"),
            headers=_admin_headers(self.internal_api_token),
            method="POST",
        )
        self.trace_logger.log(
            "admin_matcher.request.start",
            candidate_id=candidate_id,
            has_internal_token=bool(self.internal_api_token),
            source_url=record.source_url,
            timeout_seconds=self.timeout_seconds,
            title=record.title,
            url=url,
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                response.read()
            self.trace_logger.log("admin_matcher.request.completed", candidate_id=candidate_id, source_url=record.source_url)
        except HTTPError as exc:
            message = _http_error_message(exc)
            self.trace_logger.log(
                "admin_matcher.request.failed",
                candidate_id=candidate_id,
                error=message,
                source_url=record.source_url,
                status_code=exc.code,
            )
            self._fail_candidate(candidate_id, message)
        except (OSError, TimeoutError, URLError, ValueError) as exc:
            self.trace_logger.log(
                "admin_matcher.request.failed",
                candidate_id=candidate_id,
                error=str(exc),
                source_url=record.source_url,
            )
            self._fail_candidate(candidate_id, f"Admin item matcher failed: {exc}")

    def _fail_candidate(self, candidate_id: int, message: str) -> None:
        self.repository.mark_item_candidate_processing_error(candidate_id, message)
        raise RuntimeError(message)


def _admin_headers(internal_api_token: str) -> dict[str, str]:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if internal_api_token:
        headers["X-Ludora-Internal-Token"] = internal_api_token
    return headers


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
