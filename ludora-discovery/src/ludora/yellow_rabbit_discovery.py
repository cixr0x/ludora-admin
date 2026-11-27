from __future__ import annotations

import re
from collections.abc import Callable
from html.parser import HTMLParser
from urllib.parse import SplitResult, parse_qs, quote, unquote, urldefrag, urljoin, urlsplit

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.trace import NullTraceLogger, TraceLogger
from ludora.webfetch import FetchResult, fetch_with_transient_retries


YELLOW_RABBIT_ORIGIN = "https://yellowrabbit.mx"
YELLOW_RABBIT_HOSTS = {"yellowrabbit.mx", "www.yellowrabbit.mx"}
YELLOW_RABBIT_LISTINGS = ("/collections/juegos-de-mesa-1", "/collections/types?q=Board%20Game")
MAX_LISTING_PAGES = 500
PRODUCT_PATH = re.compile(r"/(?:collections/[^/]+/)?products/([^/]+)/?")
TRACE_PREFIX = "inventory.yellow_rabbit_listing"


class _ListingParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.product_links: list[str] = []
        self.page_links: list[tuple[str, bool]] = []
        self.grid_depth = 0
        self._pagination_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = (attributes.get("class") or "").split()
        if tag == "ul" and (self.grid_depth or attributes.get("id") == "main-collection-product-grid"):
            self.grid_depth += 1
        if tag == "div" and (self._pagination_depth or "pagination_collection" in classes):
            self._pagination_depth += 1
        href = (attributes.get("href") or "").strip()
        explicit_next = tag in {"link", "a"} and "next" in (attributes.get("rel") or "").casefold().split()
        if explicit_next or (tag == "a" and self._pagination_depth and {"item", "link"}.issubset(classes)):
            self.page_links.append((href, explicit_next))
        if tag == "a" and self.grid_depth and href:
            self.product_links.append(href)

    def handle_endtag(self, tag: str) -> None:
        if tag == "ul" and self.grid_depth:
            self.grid_depth -= 1
        if tag == "div" and self._pagination_depth:
            self._pagination_depth -= 1


def is_yellow_rabbit_store_url(url: str) -> bool:
    return _store_url_parts(url) is not None


def discover_yellow_rabbit_product_urls(
    *,
    fetcher: Callable[[str], FetchResult | None],
    store_id: int | None,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
) -> list[tuple[str, str]]:
    """Return ordered (product URL, first listing page URL) pairs for both catalogs."""
    trace = trace_logger or NullTraceLogger()
    products: dict[str, str] = {}
    for listing in YELLOW_RABBIT_LISTINGS:
        page_url = YELLOW_RABBIT_ORIGIN + listing
        listing_parts = urlsplit(page_url)
        listing_query = parse_qs(listing_parts.query)
        last_advertised_page = 1
        trace.log(f"{TRACE_PREFIX}.start", source_url=page_url, store_id=store_id)
        for page_number in range(1, MAX_LISTING_PAGES + 1):
            raise_if_cancelled(cancellation_token)
            trace_fields = {"store_id": store_id, "page_number": page_number, "fetch_method": "static"}
            trace.log(f"{TRACE_PREFIX}.page_fetch.start", source_url=page_url, **trace_fields)
            fetched = fetch_with_transient_retries(
                page_url, fetcher, trace_event=f"{TRACE_PREFIX}.page_fetch.http_error",
                trace_logger=trace, trace_fields=trace_fields, cancellation_token=cancellation_token,
            )
            raise_if_cancelled(cancellation_token)
            if fetched is None or not 200 <= fetched.status_code < 300:
                status = f" (HTTP {fetched.status_code})" if fetched is not None else ""
                raise RuntimeError(f"Yellow Rabbit listing fetch failed: {page_url}{status}")
            if _listing_page_number(fetched.url, listing_parts.path, listing_query) != page_number:
                raise RuntimeError(f"Yellow Rabbit unexpected listing page URL: {page_url} resolved to {fetched.url}")

            parser = _ListingParser()
            try:
                parser.feed(fetched.text)
                parser.close()
            except (AssertionError, ValueError) as exc:
                raise RuntimeError(f"Yellow Rabbit listing HTML could not be parsed: {fetched.url}") from exc
            page_products = dict.fromkeys(
                product_url for href in parser.product_links
                if (product_url := _product_url(href, fetched.url)) is not None
            )
            if not page_products or parser.grid_depth:
                raise RuntimeError(f"Yellow Rabbit listing missing a usable product grid: {fetched.url}")
            for product_url in page_products:
                products.setdefault(product_url, fetched.url)

            next_url = None
            for href, explicit_next in parser.page_links:
                linked_url = _resolved_url(href, fetched.url)
                linked_page = _listing_page_number(linked_url, listing_parts.path, listing_query)
                if linked_page is None or (explicit_next and linked_page != page_number + 1):
                    raise RuntimeError(f"Yellow Rabbit invalid pagination link on {fetched.url}: {href!r}")
                last_advertised_page = max(last_advertised_page, linked_page)
                if linked_page == page_number + 1 and next_url is None:
                    next_url = linked_url
            if next_url is None and page_number < last_advertised_page:
                raise RuntimeError(f"Yellow Rabbit pagination missing page {page_number + 1}: {fetched.url}")
            trace.log(f"{TRACE_PREFIX}.page.completed", source_url=fetched.url, next_url=next_url,
                      page_product_count=len(page_products), product_url_count=len(products), **trace_fields)
            if next_url is None:
                break
            page_url = next_url
        else:
            raise RuntimeError(f"Yellow Rabbit listing exceeded {MAX_LISTING_PAGES} pages: {listing}")
    trace.log(f"{TRACE_PREFIX}.completed", store_id=store_id, product_url_count=len(products))
    return list(products.items())


def _store_url_parts(url: str) -> SplitResult | None:
    try:
        parsed = urlsplit(url)
        if (parsed.scheme in {"https", "http"} and parsed.hostname in YELLOW_RABBIT_HOSTS
                and parsed.username is None and parsed.password is None and parsed.port in {None, 80, 443}):
            return parsed
    except ValueError:
        pass
    return None


def _listing_page_number(url: str, path: str, listing_query: dict[str, list[str]]) -> int | None:
    parsed = _store_url_parts(url)
    if parsed is None or parsed.path.rstrip("/") != path:
        return None
    query = parse_qs(parsed.query, keep_blank_values=True)
    page = query.pop("page", ["1"])
    if query != listing_query or len(page) != 1 or not re.fullmatch(r"[1-9][0-9]{0,5}", page[0]):
        return None
    return int(page[0])


def _product_url(href: str, page_url: str) -> str | None:
    parsed = _store_url_parts(_resolved_url(href, page_url))
    match = PRODUCT_PATH.fullmatch(parsed.path) if parsed is not None else None
    if match is None:
        return None
    handle = unquote(match[1])
    if not re.fullmatch(r"[\w-]+", handle):
        return None
    return f"{YELLOW_RABBIT_ORIGIN}/products/{quote(handle)}"


def _resolved_url(href: str, page_url: str) -> str:
    try:
        return urldefrag(urljoin(page_url, href)).url if href else ""
    except ValueError:
        return ""
