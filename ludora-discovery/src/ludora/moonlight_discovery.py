"""Validated HTTP identity and bounded access interruption for Moonlight discovery."""
from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from pathlib import Path
from urllib.parse import urlparse

from ludora.config import load_dotenv_values
from ludora.supervised_browser import BrowserFetchFailed
from ludora.trace import NullTraceLogger, TraceLogger
from ludora.webfetch import FetchResult


# Plain HTTP with this deployed Chromium identity was validated on 2026-10-11.
# Override it after validating a newer identity; never append the collector tag.
DEFAULT_MOONLIGHT_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/149.0.7827.55 Safari/537.36"
)
MOONLIGHT_CONNECTION_REFUSAL_LIMIT = 3


def resolve_moonlight_user_agent(
    env: Mapping[str, str] | None = None, dotenv_path: str | Path = ".env",
) -> str:
    current_env = env if env is not None else os.environ
    return (
        current_env.get("LUDORA_MOONLIGHT_USER_AGENT", "").strip()
        or load_dotenv_values(dotenv_path).get("LUDORA_MOONLIGHT_USER_AGENT", "").strip()
        or DEFAULT_MOONLIGHT_USER_AGENT
    )


def is_moonlight_store_url(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").casefold()
    except ValueError:
        return False
    return host in {"moonlightgamestore.com", "www.moonlightgamestore.com"}


class StoreDiscoveryAccessStopped(RuntimeError):
    """Coverage was interrupted; the existing job failure path must retain progress."""


class MoonlightDiscoveryProfile:
    def __init__(self, *, user_agent: str | None = None, trace_logger: TraceLogger | None = None):
        self.user_agent = user_agent.strip() if user_agent and user_agent.strip() else resolve_moonlight_user_agent()
        self.trace = trace_logger or NullTraceLogger()
        self.consecutive_refusals = 0
        self.last_fetch_refused = False

    def headers_for(self, target_url: str, method: str = "GET") -> Mapping[str, str]:
        return {"User-Agent": self.user_agent} if is_moonlight_store_url(target_url) else {}

    def fetch(
        self,
        url: str,
        fetcher: Callable[[str], FetchResult | None],
        *,
        fetch_method: str,
        failure_fetcher: Callable[[str], FetchResult | None] | None = None,
    ) -> FetchResult | None:
        try:
            fetched = fetcher(url)
        except BrowserFetchFailed as exc:
            self._observe(url, None, fetch_method=fetch_method, error=str(exc), error_type=type(exc).__name__)
            if self.last_fetch_refused:
                return None
            raise
        owner = getattr(failure_fetcher or fetcher, "__self__", None)
        failure = getattr(owner, "last_failure", None) if fetched is None else None
        self._observe(
            url, fetched, fetch_method=fetch_method,
            error=str(failure.get("error") or "") if isinstance(failure, Mapping) else "",
            error_type=str(failure.get("error_type") or "") if isinstance(failure, Mapping) else "",
        )
        return fetched

    def _observe(
        self, url: str, fetched: FetchResult | None, *, fetch_method: str,
        error: str = "", error_type: str = "",
    ) -> None:
        self.last_fetch_refused = False
        if not is_moonlight_store_url(url):
            return
        status_code = fetched.status_code if fetched is not None else None
        if status_code == 403:
            self._stop(url, fetch_method, "HTTP 403", status_code=status_code)
        if fetched is not None:
            error, error_type = fetched.error or "", fetched.error_type or ""
        normalized_error = error.casefold()
        self.last_fetch_refused = (
            error_type == "ConnectionRefusedError"
            or "connection refused" in normalized_error
            or "err_connection_refused" in normalized_error
            or "winerror 10061" in normalized_error
        )
        if self.last_fetch_refused:
            self.consecutive_refusals += 1
            self.trace.log("inventory.access.connection_refused", source_url=url, fetch_method=fetch_method,
                           consecutive_refusals=self.consecutive_refusals, error=error, error_type=error_type)
            if self.consecutive_refusals >= MOONLIGHT_CONNECTION_REFUSAL_LIMIT:
                self._stop(url, fetch_method, f"{self.consecutive_refusals} consecutive connection refusals")
        elif fetched is not None and 200 <= fetched.status_code < 400 and not fetched.error:
            self.consecutive_refusals = 0

    def _stop(self, url: str, fetch_method: str, reason: str, *, status_code: int | None = None) -> None:
        message = f"Moonlight discovery coverage interrupted by {reason}: {url}"
        self.trace.log("inventory.access.stopped", source_url=url, fetch_method=fetch_method,
                       consecutive_refusals=self.consecutive_refusals, status_code=status_code,
                       error=message, error_type="StoreDiscoveryAccessStopped")
        raise StoreDiscoveryAccessStopped(message)
