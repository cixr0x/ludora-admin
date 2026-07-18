from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.client import HTTPException
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.trace import NullTraceLogger, TraceLogger


TRANSIENT_FETCH_STATUS_CODES = {429, 502, 503, 504}
DEFAULT_FETCH_MAX_ATTEMPTS = 3
DEFAULT_FETCH_RETRY_BASE_SECONDS = 1.0
DEFAULT_FETCH_RETRY_MAX_SECONDS = 300.0


@dataclass(frozen=True)
class FetchResult:
    url: str
    text: str
    status_code: int = 200
    retry_after_seconds: float | None = None


def fetch_html(
    url: str,
    timeout: int = 20,
    *,
    include_http_error_status: bool = False,
) -> FetchResult | None:
    request = Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml",
            "User-Agent": "LudoraStoreCollector/0.1 (+https://example.local/ludora)",
        },
        method="GET",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            content_type = response.headers.get("content-type", "")
            if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
                return None
            charset = response.headers.get_content_charset() or "utf-8"
            body = response.read().decode(charset, errors="replace")
            return FetchResult(
                url=response.geturl(),
                text=body,
                status_code=int(getattr(response, "status", 200)),
            )
    except HTTPError as exc:
        if include_http_error_status:
            return FetchResult(
                url=exc.geturl() or url,
                text="",
                status_code=int(exc.code),
                retry_after_seconds=retry_after_seconds_from_headers(exc.headers),
            )
        return None
    except (HTTPException, URLError, TimeoutError, ValueError):
        return None


def fetch_with_transient_retries(
    url: str,
    fetcher: Callable[[str], FetchResult | None],
    *,
    trace_event: str,
    trace_logger: TraceLogger | None = None,
    trace_fields: Mapping[str, object] | None = None,
    cancellation_token: CancellationToken | None = None,
    ambiguous_failure_attempts: int = 1,
    max_attempts: int = DEFAULT_FETCH_MAX_ATTEMPTS,
) -> FetchResult | None:
    trace = trace_logger or NullTraceLogger()
    resolved_trace_fields = dict(trace_fields or {})
    resolved_max_attempts = max(1, max_attempts)
    resolved_ambiguous_attempts = min(resolved_max_attempts, max(1, ambiguous_failure_attempts))

    for attempt in range(1, resolved_max_attempts + 1):
        raise_if_cancelled(cancellation_token)
        fetched = fetcher(url)
        if fetched is None:
            if attempt < resolved_ambiguous_attempts:
                continue
            return None
        if fetched.status_code not in TRANSIENT_FETCH_STATUS_CODES:
            if fetched.status_code >= 400:
                _log_http_error(
                    trace,
                    trace_event,
                    resolved_trace_fields,
                    attempt=attempt,
                    max_attempts=resolved_max_attempts,
                    fetched=fetched,
                    retry_in_seconds=0.0,
                    source_url=url,
                    will_retry=False,
                )
            return fetched

        will_retry = attempt < resolved_max_attempts
        retry_in_seconds = _fetch_retry_delay_seconds(fetched, attempt) if will_retry else 0.0
        _log_http_error(
            trace,
            trace_event,
            resolved_trace_fields,
            attempt=attempt,
            max_attempts=resolved_max_attempts,
            fetched=fetched,
            retry_in_seconds=retry_in_seconds,
            source_url=url,
            will_retry=will_retry,
        )
        if not will_retry:
            return fetched
        _wait_for_fetch_retry(retry_in_seconds, cancellation_token)

    return None


def retry_after_seconds_from_headers(headers: Any) -> float | None:
    if headers is None:
        return None
    value = str(headers.get("retry-after", "")).strip()
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        retry_at = parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=timezone.utc)
    return max(0.0, (retry_at - datetime.now(timezone.utc)).total_seconds())


def _fetch_retry_delay_seconds(fetched: FetchResult, attempt: int) -> float:
    if fetched.retry_after_seconds is not None:
        return min(DEFAULT_FETCH_RETRY_MAX_SECONDS, max(0.0, fetched.retry_after_seconds))
    return min(DEFAULT_FETCH_RETRY_MAX_SECONDS, DEFAULT_FETCH_RETRY_BASE_SECONDS * (2 ** (attempt - 1)))


def _wait_for_fetch_retry(
    delay_seconds: float,
    cancellation_token: CancellationToken | None,
) -> None:
    deadline = time.monotonic() + max(0.0, delay_seconds)
    while True:
        raise_if_cancelled(cancellation_token)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(1.0, remaining))


def _log_http_error(
    trace: TraceLogger,
    event: str,
    trace_fields: Mapping[str, object],
    *,
    attempt: int,
    max_attempts: int,
    fetched: FetchResult,
    retry_in_seconds: float,
    source_url: str,
    will_retry: bool,
) -> None:
    fields = dict(trace_fields)
    fields.update(
        attempt=attempt,
        max_attempts=max_attempts,
        retry_after_seconds=fetched.retry_after_seconds,
        retry_in_seconds=retry_in_seconds,
        source_url=source_url,
        status_code=fetched.status_code,
        will_retry=will_retry,
    )
    trace.log(event, **fields)
