from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ludora.models import SearchResult


BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"


class BraveApiError(RuntimeError):
    pass


class BraveSearchClient:
    def __init__(self, api_key: str, timeout: int = 30):
        self.api_key = api_key
        self.timeout = timeout

    def search(self, query: str, count: int = 20, offset: int = 0) -> list[SearchResult]:
        params = {
            "q": query,
            "count": str(count),
            "offset": str(offset),
            "country": "mx",
            "search_lang": "es",
            "ui_lang": "es-MX",
            "spellcheck": "1",
            "extra_snippets": "true",
        }
        request = Request(
            f"{BRAVE_WEB_SEARCH_URL}?{urlencode(params)}",
            headers={
                "Accept": "application/json",
                "X-Subscription-Token": self.api_key,
            },
            method="GET",
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise BraveApiError(f"Brave API HTTP {exc.code}: {body}") from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise BraveApiError(f"Brave API request failed: {exc}") from exc

        return parse_brave_results(payload, query=query)


def parse_brave_results(payload: dict, query: str) -> list[SearchResult]:
    raw_results = payload.get("web", {}).get("results", [])
    results: list[SearchResult] = []
    for raw in raw_results:
        url = str(raw.get("url") or "").strip()
        if not url:
            continue
        description_parts = [str(raw.get("description") or "").strip()]
        description_parts.extend(str(snippet).strip() for snippet in raw.get("extra_snippets", []) if snippet)
        results.append(
            SearchResult(
                title=str(raw.get("title") or raw.get("name") or "").strip(),
                url=url,
                description=" ".join(part for part in description_parts if part),
                query=query,
            )
        )
    return results
