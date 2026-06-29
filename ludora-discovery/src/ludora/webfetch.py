from __future__ import annotations

from dataclasses import dataclass
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class FetchResult:
    url: str
    text: str


def fetch_html(url: str, timeout: int = 20) -> FetchResult | None:
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
            return FetchResult(url=response.geturl(), text=body)
    except (HTTPError, HTTPException, URLError, TimeoutError, ValueError):
        return None
