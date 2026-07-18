from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.client import HTTPException
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


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
                retry_after_seconds=_retry_after_seconds(exc.headers),
            )
        return None
    except (HTTPException, URLError, TimeoutError, ValueError):
        return None


def _retry_after_seconds(headers: Any) -> float | None:
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
