from __future__ import annotations

from dataclasses import dataclass
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class FetchResult:
    url: str
    text: str
    status_code: int = 200


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
        if include_http_error_status and exc.code in {404, 410}:
            return FetchResult(
                url=exc.geturl() or url,
                text="",
                status_code=int(exc.code),
            )
        return None
    except (HTTPException, URLError, TimeoutError, ValueError):
        return None
