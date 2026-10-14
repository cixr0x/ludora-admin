"""URL-only enumeration of Nalua's complete PrestaShop catalog and sitemap aliases."""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from html.parser import HTMLParser
from urllib.parse import parse_qs, urldefrag, urljoin, urlparse

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.listing_extraction import _clean_url, is_nalua_store_url, nalua_product_id
from ludora.sitemap_discovery import _looks_like_site_protection_challenge, discover_product_urls_from_sitemaps
from ludora.trace import NullTraceLogger, TraceLogger
from ludora.webfetch import FetchResult, fetch_html, fetch_with_transient_retries


NALUA_CATALOG_PATH = "/2-inicio"
NALUA_MAX_CATALOG_PAGES = 500
CATALOG_RANGE_RE = re.compile(r"Mostrando\s+([0-9.,]+)\s*[-–—]\s*([0-9.,]+)\s+de\s+([0-9.,]+)\s+productos", re.IGNORECASE)
CATALOG_TOTAL_RE = re.compile(r"Hay\s+([0-9.,]+)\s+productos", re.IGNORECASE)


class _CatalogParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hrefs: list[str] = []
        self.next_hrefs: list[str] = []
        self.text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        attributes = {key: value or "" for key, value in attrs}
        href = attributes.get("href", "").strip()
        if href:
            self.hrefs.append(href)
        if "next" in attributes.get("rel", "").casefold().split():
            self.next_hrefs.append(href)

    def handle_data(self, data: str) -> None:
        self.text.append(data)


def discover_nalua_product_urls(
    store_url: str,
    *,
    sitemap_urls: list[str] | None = None,
    fetcher: Callable[[str], FetchResult | None] | None = None,
    browser_fetcher: Callable[[str], FetchResult | None] | None = None,
    browser_fallback_enabled: bool = False,
    request_headers_provider: Callable[[str], Mapping[str, str]] | None = None,
    limit: int | None = None,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
) -> list[str]:
    """Enumerate URLs without requesting details, classification, or persistence."""
    if not is_nalua_store_url(store_url):
        raise ValueError("Nalua catalog enumeration requires an exact Nalua store host")
    raise_if_cancelled(cancellation_token)
    if limit is not None and limit < 1:
        return []
    trace = trace_logger or NullTraceLogger()
    if sitemap_urls is None:
        sitemap_urls = discover_product_urls_from_sitemaps(
            store_url, browser_fetcher=browser_fetcher, browser_fallback_enabled=browser_fallback_enabled,
            request_headers_provider=request_headers_provider, trace_logger=trace,
            cancellation_token=cancellation_token,
        )
    fetch = fetcher or (lambda url: fetch_html(
        url, headers=request_headers_provider(url) if request_headers_provider is not None else None,
        include_http_error_status=True,
    ))
    catalog_url = urljoin(store_url, NALUA_CATALOG_PATH)
    page_url = catalog_url
    page_number = 1
    expected_total: int | None = None
    products: dict[str, str] = {}
    seen_pages: set[str] = set()
    limited = False
    trace.log("inventory.nalua_catalog.start", source_url=catalog_url, limit=limit)
    while True:
        raise_if_cancelled(cancellation_token)
        if page_number > NALUA_MAX_CATALOG_PAGES:
            raise RuntimeError(f"Nalua catalog exceeds {NALUA_MAX_CATALOG_PAGES} pages")
        if page_url in seen_pages:
            raise RuntimeError(f"Nalua catalog repeated page: {page_url}")
        seen_pages.add(page_url)
        trace.log("inventory.nalua_catalog.page_fetch.start", source_url=page_url, page_number=page_number)
        fetched = _fetch_catalog_page(page_url, fetch, browser_fetcher, browser_fallback_enabled,
                                      trace, cancellation_token)
        raise_if_cancelled(cancellation_token)
        _catalog_page_number(fetched.url, expected_page=page_number)
        parser = _CatalogParser()
        parser.feed(fetched.text)
        text = " ".join(" ".join(parser.text).split())
        ranges = {tuple(_count(value) for value in match) for match in CATALOG_RANGE_RE.findall(text)}
        if len(ranges) != 1:
            raise RuntimeError(f"Nalua catalog has missing or contradictory product counts: {page_url}")
        start, end, total = ranges.pop()
        if total < 1 or start < 1 or end < start or end > total:
            raise RuntimeError(f"Nalua catalog has malformed product range: {page_url}")
        if expected_total is None:
            expected_total = total
        if total != expected_total or any(_count(value) != total for value in CATALOG_TOTAL_RE.findall(text)):
            raise RuntimeError(f"Nalua catalog advertised total changed: {page_url}")
        page_products: dict[str, str] = {}
        for href in parser.hrefs:
            product_url = _clean_url(urljoin(fetched.url, href))
            product_id = nalua_product_id(product_url)
            if product_id is not None:
                page_products.setdefault(product_id, product_url)
        if start != len(products) + 1 or end - start + 1 != len(page_products):
            raise RuntimeError(f"Nalua catalog product range/count mismatch: {page_url}")
        if products.keys() & page_products.keys():
            raise RuntimeError(f"Nalua catalog repeated products on page: {page_url}")
        products.update(page_products)
        next_urls = list(dict.fromkeys(urldefrag(urljoin(fetched.url, href)).url for href in parser.next_hrefs))
        if len(next_urls) > 1:
            raise RuntimeError(f"Nalua catalog has contradictory next pages: {page_url}")
        next_url = next_urls[0] if next_urls else None
        if next_url is not None:
            _catalog_page_number(next_url, expected_page=page_number + 1)
            if next_url in seen_pages:
                raise RuntimeError(f"Nalua catalog repeated next page: {next_url}")
        trace.log("inventory.nalua_catalog.page.completed", source_url=page_url, page_number=page_number,
                  page_product_count=len(page_products), expected_total=expected_total,
                  enumerated_total=len(products), next_url=next_url)
        if len(products) == expected_total:
            if next_url is not None:
                raise RuntimeError(f"Nalua catalog advertises another page after its total: {page_url}")
            break
        if len(products) > expected_total or next_url is None:
            raise RuntimeError(f"Nalua catalog coverage mismatch: expected {expected_total}, enumerated {len(products)}")
        if limit is not None and len(products) >= limit:
            limited = True
            break
        page_url = next_url
        page_number += 1

    catalog_count = len(products)
    for product_url in sitemap_urls:
        raise_if_cancelled(cancellation_token)
        product_id = nalua_product_id(product_url)
        if product_id is not None:
            products.setdefault(product_id, product_url)
    result = list(products.values())
    if limit is not None:
        limited = limited or len(result) > limit
        result = result[:limit]
    trace.log("inventory.nalua_catalog.limited" if limited else "inventory.nalua_catalog.completed",
              source_url=catalog_url, page_count=page_number, expected_total=expected_total,
              enumerated_total=catalog_count, sitemap_only_count=len(products) - catalog_count,
              product_url_count=len(result), limit=limit, coverage_complete=not limited)
    return result


def _count(value: str) -> int:
    if re.fullmatch(r"[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,3}(?:\.[0-9]{3})+", value) is None:
        raise RuntimeError(f"Nalua catalog has malformed product count: {value}")
    return int(value.replace(",", "").replace(".", ""))


def _catalog_page_number(url: str, *, expected_page: int) -> int:
    try:
        parsed = urlparse(url)
        query = parse_qs(parsed.query, keep_blank_values=True)
        values = query.get("page", ["1"])
        valid = (is_nalua_store_url(url) and parsed.scheme in {"http", "https"}
                 and not parsed.username and not parsed.password and parsed.port in {None, 80, 443}
                 and parsed.path == NALUA_CATALOG_PATH and set(query) <= {"page"}
                 and len(values) == 1 and values[0].isascii() and values[0].isdigit())
        number = int(values[0]) if valid else 0
        if number != expected_page:
            raise ValueError("unexpected page")
        return number
    except ValueError as exc:
        raise RuntimeError(f"Nalua catalog has invalid page sequence or URL: {url}") from exc


def _fetch_catalog_page(url, fetcher, browser_fetcher, browser_enabled, trace, token):
    for method, fetch in [("static", fetcher), ("browser", browser_fetcher if browser_enabled else None)]:
        if fetch is None:
            continue
        fetched = fetch_with_transient_retries(
            url, fetch, trace_event="inventory.nalua_catalog.page_fetch.http_error", trace_logger=trace,
            trace_fields={"fetch_method": method}, cancellation_token=token,
        )
        if fetched is not None and 200 <= fetched.status_code < 400 and not _looks_like_site_protection_challenge(fetched.text):
            return fetched
    raise RuntimeError(f"Nalua catalog page fetch failed: {url}")
