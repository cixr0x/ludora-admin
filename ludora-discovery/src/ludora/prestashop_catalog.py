"""Shared URL-only traversal for explicitly configured PrestaShop store catalogs."""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from html.parser import HTMLParser
from urllib.parse import parse_qs, urldefrag, urljoin, urlparse

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.listing_extraction import _clean_url
from ludora.sitemap_discovery import _looks_like_site_protection_challenge, discover_product_urls_from_sitemaps
from ludora.trace import NullTraceLogger, TraceLogger
from ludora.webfetch import FetchResult, fetch_html, fetch_with_transient_retries


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


def discover_prestashop_catalog_urls(
    store_url: str,
    *,
    store_name: str,
    catalog_path: str,
    trace_prefix: str,
    is_store_url: Callable[[str], bool],
    product_id_from_url: Callable[[str], str | None],
    max_catalog_pages: int,
    range_pattern: re.Pattern[str] = CATALOG_RANGE_RE,
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
    if not is_store_url(store_url):
        raise ValueError(f"{store_name} catalog enumeration requires an exact {store_name} store host")
    raise_if_cancelled(cancellation_token)
    if limit is not None and limit < 1:
        return []
    trace = trace_logger or NullTraceLogger()
    catalog_url = urljoin(store_url, catalog_path)
    _catalog_page_number(catalog_url, expected_page=1, store_name=store_name,
                         catalog_path=catalog_path, is_store_url=is_store_url)
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
    page_url = catalog_url
    page_number = 1
    expected_total: int | None = None
    products: dict[str, str] = {}
    seen_pages: set[str] = set()
    limited = False
    trace.log(f"{trace_prefix}.start", source_url=catalog_url, limit=limit)
    while True:
        raise_if_cancelled(cancellation_token)
        if page_number > max_catalog_pages:
            raise RuntimeError(f"{store_name} catalog exceeds {max_catalog_pages} pages")
        if page_url in seen_pages:
            raise RuntimeError(f"{store_name} catalog repeated page: {page_url}")
        seen_pages.add(page_url)
        trace.log(f"{trace_prefix}.page_fetch.start", source_url=page_url, page_number=page_number)
        fetched = _fetch_catalog_page(page_url, fetch, browser_fetcher, browser_fallback_enabled,
                                      trace, cancellation_token, store_name, trace_prefix)
        raise_if_cancelled(cancellation_token)
        _catalog_page_number(fetched.url, expected_page=page_number, store_name=store_name,
                             catalog_path=catalog_path, is_store_url=is_store_url)
        parser = _CatalogParser()
        parser.feed(fetched.text)
        text = " ".join(" ".join(parser.text).split())
        ranges = {tuple(_count(value, store_name=store_name) for value in match) for match in range_pattern.findall(text)}
        if len(ranges) != 1:
            raise RuntimeError(f"{store_name} catalog has missing or contradictory product counts: {page_url}")
        start, end, total = ranges.pop()
        if total < 1 or start < 1 or end < start or end > total:
            raise RuntimeError(f"{store_name} catalog has malformed product range: {page_url}")
        if expected_total is None:
            expected_total = total
        if total != expected_total or any(_count(value, store_name=store_name) != total for value in CATALOG_TOTAL_RE.findall(text)):
            raise RuntimeError(f"{store_name} catalog advertised total changed: {page_url}")
        page_products: dict[str, str] = {}
        for href in parser.hrefs:
            product_url = _clean_url(urljoin(fetched.url, href))
            product_id = product_id_from_url(product_url)
            if product_id is not None:
                page_products.setdefault(product_id, product_url)
        if start != len(products) + 1 or end - start + 1 != len(page_products):
            raise RuntimeError(f"{store_name} catalog product range/count mismatch: {page_url}")
        if products.keys() & page_products.keys():
            raise RuntimeError(f"{store_name} catalog repeated products on page: {page_url}")
        products.update(page_products)
        next_urls = list(dict.fromkeys(urldefrag(urljoin(fetched.url, href)).url for href in parser.next_hrefs))
        if len(next_urls) > 1:
            raise RuntimeError(f"{store_name} catalog has contradictory next pages: {page_url}")
        next_url = next_urls[0] if next_urls else None
        if next_url is not None:
            _catalog_page_number(next_url, expected_page=page_number + 1, store_name=store_name,
                                 catalog_path=catalog_path, is_store_url=is_store_url)
            if next_url in seen_pages:
                raise RuntimeError(f"{store_name} catalog repeated next page: {next_url}")
        trace.log(f"{trace_prefix}.page.completed", source_url=page_url, page_number=page_number,
                  page_product_count=len(page_products), expected_total=expected_total,
                  enumerated_total=len(products), next_url=next_url)
        if len(products) == expected_total:
            if next_url is not None:
                raise RuntimeError(f"{store_name} catalog advertises another page after its total: {page_url}")
            break
        if len(products) > expected_total or next_url is None:
            raise RuntimeError(f"{store_name} catalog coverage mismatch: expected {expected_total}, enumerated {len(products)}")
        if limit is not None and len(products) >= limit:
            limited = True
            break
        page_url = next_url
        page_number += 1

    catalog_count = len(products)
    for product_url in sitemap_urls:
        raise_if_cancelled(cancellation_token)
        product_id = product_id_from_url(product_url)
        if product_id is not None:
            products.setdefault(product_id, product_url)
    result = list(products.values())
    if limit is not None:
        limited = limited or len(result) > limit
        result = result[:limit]
    trace.log(f"{trace_prefix}.limited" if limited else f"{trace_prefix}.completed",
              source_url=catalog_url, page_count=page_number, expected_total=expected_total,
              enumerated_total=catalog_count, sitemap_only_count=len(products) - catalog_count,
              product_url_count=len(result), limit=limit, coverage_complete=not limited)
    return result


def _count(value: str, *, store_name: str) -> int:
    if re.fullmatch(r"[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,3}(?:\.[0-9]{3})+", value) is None:
        raise RuntimeError(f"{store_name} catalog has malformed product count: {value}")
    return int(value.replace(",", "").replace(".", ""))


def _catalog_page_number(url: str, *, expected_page: int, store_name: str,
                         catalog_path: str, is_store_url: Callable[[str], bool]) -> int:
    try:
        parsed = urlparse(url)
        query = parse_qs(parsed.query, keep_blank_values=True)
        values = query.get("page", ["1"])
        valid = (is_store_url(url) and parsed.scheme in {"http", "https"}
                 and not parsed.username and not parsed.password and parsed.port in {None, 80, 443}
                 and parsed.path == catalog_path and set(query) <= {"page"}
                 and len(values) == 1 and values[0].isascii() and values[0].isdigit())
        number = int(values[0]) if valid else 0
        if number != expected_page:
            raise ValueError("unexpected page")
        return number
    except ValueError as exc:
        raise RuntimeError(f"{store_name} catalog has invalid page sequence or URL: {url}") from exc


def _fetch_catalog_page(url, fetcher, browser_fetcher, browser_enabled, trace, token, store_name, trace_prefix):
    for method, fetch in [("static", fetcher), ("browser", browser_fetcher if browser_enabled else None)]:
        if fetch is None:
            continue
        fetched = fetch_with_transient_retries(
            url, fetch, trace_event=f"{trace_prefix}.page_fetch.http_error", trace_logger=trace,
            trace_fields={"fetch_method": method}, cancellation_token=token,
        )
        if fetched is not None and 200 <= fetched.status_code < 400 and not _looks_like_site_protection_challenge(fetched.text):
            return fetched
    raise RuntimeError(f"{store_name} catalog page fetch failed: {url}")
