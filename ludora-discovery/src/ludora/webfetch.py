from __future__ import annotations

import time
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.client import HTTPException
from random import uniform
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.trace import NullTraceLogger, TraceLogger


TRANSIENT_FETCH_STATUS_CODES = {429, 500, 502, 503, 504}
DEFAULT_FETCH_MAX_ATTEMPTS = 3
DEFAULT_FETCH_RETRY_BASE_SECONDS = 1.0
DEFAULT_FETCH_RETRY_MAX_SECONDS = 300.0


@dataclass(frozen=True)
class FetchResult:
    url: str
    text: str
    status_code: int = 200
    retry_after_seconds: float | None = None
    error: str | None = None
    error_type: str | None = None


@dataclass(frozen=True)
class HostThrottleWait:
    host: str
    delay_seconds: float
    reason: str


class PerHostRequestThrottle:
    def __init__(
        self,
        *,
        minimum_interval_seconds: float,
        jitter_seconds: float = 0.0,
        fallback_cooldown_seconds: float = 30.0,
        maximum_cooldown_seconds: float = DEFAULT_FETCH_RETRY_MAX_SECONDS,
        clock: Callable[[], float] | None = None,
        waiter: Callable[[float, CancellationToken | None], None] | None = None,
        jitter: Callable[[float, float], float] | None = None,
    ):
        self.minimum_interval_seconds = max(0.0, minimum_interval_seconds)
        self.jitter_seconds = max(0.0, jitter_seconds)
        self.fallback_cooldown_seconds = max(0.0, fallback_cooldown_seconds)
        self.maximum_cooldown_seconds = max(0.0, maximum_cooldown_seconds)
        self._clock = clock or time.monotonic
        self._waiter = waiter or _wait_for_fetch_retry
        self._jitter = jitter or uniform
        self._next_request_at: dict[str, float] = {}
        self._cooldown_until: dict[str, float] = {}

    def cooldown_remaining(self, url: str) -> float:
        host = _request_host(url)
        if not host:
            return 0.0
        return max(0.0, self._cooldown_until.get(host, 0.0) - self._clock())

    def start_cooldown(self, url: str, retry_after_seconds: float | None) -> float:
        host = _request_host(url)
        if not host:
            return 0.0
        requested_delay = (
            self.fallback_cooldown_seconds
            if retry_after_seconds is None
            else max(0.0, retry_after_seconds)
        )
        delay_seconds = min(self.maximum_cooldown_seconds, requested_delay)
        self._cooldown_until[host] = max(
            self._cooldown_until.get(host, 0.0),
            self._clock() + delay_seconds,
        )
        return delay_seconds

    def wait_before_request(
        self,
        url: str,
        cancellation_token: CancellationToken | None = None,
        on_wait: Callable[[HostThrottleWait], None] | None = None,
    ) -> HostThrottleWait:
        host = _request_host(url)
        if not host:
            return HostThrottleWait(host="", delay_seconds=0.0, reason="")

        now = self._clock()
        cooldown_until = self._cooldown_until.get(host, 0.0)
        paced_until = self._next_request_at.get(host, 0.0)
        ready_at = max(cooldown_until, paced_until)
        delay_seconds = max(0.0, ready_at - now)
        reason = "cooldown" if cooldown_until >= paced_until and cooldown_until > now else "pacing"
        if delay_seconds > 0.0:
            if on_wait is not None:
                on_wait(HostThrottleWait(host=host, delay_seconds=delay_seconds, reason=reason))
            self._waiter(delay_seconds, cancellation_token)

        request_started_at = self._clock()
        jitter_seconds = self._jitter(0.0, self.jitter_seconds) if self.jitter_seconds > 0.0 else 0.0
        self._next_request_at[host] = (
            request_started_at + self.minimum_interval_seconds + max(0.0, jitter_seconds)
        )
        if self._cooldown_until.get(host, 0.0) <= request_started_at:
            self._cooldown_until.pop(host, None)
        return HostThrottleWait(host=host, delay_seconds=delay_seconds, reason=reason if delay_seconds > 0.0 else "")


def fetch_html(
    url: str,
    timeout: int = 20,
    *,
    headers: Mapping[str, str] | None = None,
    include_http_error_status: bool = False,
) -> FetchResult | None:
    request_headers = {
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
        "User-Agent": (
            "LudoraStoreCollector/1.0 "
            "(+https://admin.ludora.bobbycrimson.com/crawler)"
        ),
    }
    request_headers.update(headers or {})
    request = Request(
        url,
        headers=request_headers,
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
    except (HTTPException, URLError, TimeoutError, ValueError) as exc:
        if include_http_error_status:
            return FetchResult(
                url=url,
                text="",
                status_code=0,
                error=str(exc),
                error_type=type(exc).__name__,
            )
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
    trace_attempts: bool = False,
    immediate_return_status_codes: Collection[int] = (),
) -> FetchResult | None:
    trace = trace_logger or NullTraceLogger()
    resolved_trace_fields = dict(trace_fields or {})
    resolved_max_attempts = max(1, max_attempts)
    resolved_ambiguous_attempts = min(resolved_max_attempts, max(1, ambiguous_failure_attempts))

    for attempt in range(1, resolved_max_attempts + 1):
        raise_if_cancelled(cancellation_token)
        attempt_started_at = time.monotonic()
        fetched = fetcher(url)
        attempt_elapsed_ms = int((time.monotonic() - attempt_started_at) * 1000)
        if fetched is None or fetched.error:
            will_retry = attempt < resolved_ambiguous_attempts
            if trace_attempts:
                error = fetched.error if fetched is not None else "No response was returned"
                error_type = fetched.error_type if fetched is not None else "NoResponse"
                trace.log(
                    _related_trace_event(trace_event, "attempt.failed"),
                    **resolved_trace_fields,
                    attempt=attempt,
                    attempt_elapsed_ms=attempt_elapsed_ms,
                    error=error,
                    error_type=error_type,
                    max_attempts=resolved_max_attempts,
                    message=f"Fetch failed: {error}",
                    source_url=url,
                    will_retry=will_retry,
                )
            if will_retry:
                if trace_attempts:
                    _log_retry_scheduled(
                        trace,
                        trace_event,
                        resolved_trace_fields,
                        attempt=attempt,
                        max_attempts=resolved_max_attempts,
                        retry_in_seconds=0.0,
                        source_url=url,
                    )
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
                    include_message=trace_attempts,
                )
            return fetched

        if fetched.status_code in immediate_return_status_codes:
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
                include_message=trace_attempts,
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
            include_message=trace_attempts,
        )
        if not will_retry:
            return fetched
        if trace_attempts:
            _log_retry_scheduled(
                trace,
                trace_event,
                resolved_trace_fields,
                attempt=attempt,
                max_attempts=resolved_max_attempts,
                retry_in_seconds=retry_in_seconds,
                source_url=url,
            )
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
    include_message: bool,
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
    if include_message:
        fields["message"] = f"Product detail returned HTTP {fetched.status_code}"
    trace.log(event, **fields)


def _log_retry_scheduled(
    trace: TraceLogger,
    event: str,
    trace_fields: Mapping[str, object],
    *,
    attempt: int,
    max_attempts: int,
    retry_in_seconds: float,
    source_url: str,
) -> None:
    fields = dict(trace_fields)
    fields.update(
        attempt=attempt,
        max_attempts=max_attempts,
        message=f"Retrying product detail in {retry_in_seconds:g} seconds",
        next_attempt=attempt + 1,
        retry_in_seconds=retry_in_seconds,
        source_url=source_url,
    )
    trace.log(_related_trace_event(event, "retry.scheduled"), **fields)


def _related_trace_event(event: str, suffix: str) -> str:
    prefix = event.removesuffix(".http_error")
    return f"{prefix}.{suffix}"


def _request_host(url: str) -> str:
    return (urlparse(url).hostname or "").strip().casefold()
