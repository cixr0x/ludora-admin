from __future__ import annotations

import html
import re
from collections.abc import Callable, Mapping
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from urllib.parse import quote, urlencode, urljoin, urlparse, urlunparse

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.filtering import canonical_domain
from ludora.item_classification import apply_item_classification
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import (
    BeforeProductRequest,
    ItemCandidateProcessor,
    ItemCandidateRepository,
    ItemClassifier,
    crawl_listing_candidates,
)
from ludora.product_detail_extraction import extract_product_detail_candidate
from ludora.trace import NullTraceLogger, TraceLogger
from ludora.webfetch import FetchResult, fetch_html, fetch_with_transient_retries


DEMON_STORE_DOMAINS = {"demonjuegosdemesa.com"}
DEMON_CATALOG_PAGE_SIZE = 100
DEMON_BROWSER_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36"
    ),
}
CatalogFetcher = Callable[[str], FetchResult | None]


def is_demon_store_url(store_url: str) -> bool:
    return canonical_domain(store_url) in DEMON_STORE_DOMAINS


def demon_request_headers(_url: str) -> Mapping[str, str]:
    return dict(DEMON_BROWSER_HEADERS)


def crawl_demon_inventory(
    store_url: str,
    store_id: int | None,
    repository: ItemCandidateRepository,
    *,
    limit: int | None = None,
    item_classifier: ItemClassifier = apply_item_classification,
    item_processor: ItemCandidateProcessor | None = None,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
    catalog_fetcher: CatalogFetcher | None = None,
    catalog_page_size: int = DEMON_CATALOG_PAGE_SIZE,
    before_product_request: BeforeProductRequest | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    raise_if_cancelled(cancellation_token)
    trace = trace_logger or NullTraceLogger()
    trace.log(
        "demon_inventory.crawl.start",
        store_id=store_id,
        store_url=store_url,
    )
    listing_candidates = discover_demon_listing_candidates(
        store_url,
        store_id,
        limit=limit,
        fetcher=catalog_fetcher,
        page_size=catalog_page_size,
        trace_logger=trace,
        cancellation_token=cancellation_token,
    )
    records = crawl_listing_candidates(
        listing_candidates,
        repository,
        source_listing_url=demon_catalog_page_url(store_url, 1, page_size=catalog_page_size),
        item_classifier=item_classifier,
        item_processor=item_processor,
        item_candidate_enricher=_merge_demon_catalog_details,
        item_detail_extractor=extract_demon_product_detail_candidate,
        request_headers_provider=demon_request_headers,
        trace_logger=trace,
        cancellation_token=cancellation_token,
        before_product_request=before_product_request,
    )
    trace.log(
        "demon_inventory.crawl.completed",
        catalog_item_count=len(listing_candidates),
        record_count=len(records),
        store_id=store_id,
        store_url=store_url,
    )
    return records


def discover_demon_listing_candidates(
    store_url: str,
    store_id: int | None,
    *,
    limit: int | None = None,
    fetcher: CatalogFetcher | None = None,
    page_size: int = DEMON_CATALOG_PAGE_SIZE,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    if page_size < 1:
        raise ValueError("Demon catalog page size must be positive")
    if limit is not None and limit < 1:
        return []

    trace = trace_logger or NullTraceLogger()
    catalog_fetcher = fetcher or _fetch_demon_catalog_page
    candidates: list[DiscoveryItemCandidateRecord] = []
    seen_urls: set[str] = set()
    skipped_invalid_items = 0
    expected_total_pages: int | None = None
    page_number = 1

    while expected_total_pages is None or page_number <= expected_total_pages:
        raise_if_cancelled(cancellation_token)
        page_url = demon_catalog_page_url(store_url, page_number, page_size=page_size)
        trace.log(
            "demon_inventory.catalog_fetch.start",
            page_number=page_number,
            page_size=page_size,
            source_url=page_url,
            store_id=store_id,
        )
        fetched = fetch_with_transient_retries(
            page_url,
            catalog_fetcher,
            trace_event="demon_inventory.catalog_fetch.http_error",
            trace_logger=trace,
            trace_fields={"page_number": page_number, "page_size": page_size, "store_id": store_id},
            cancellation_token=cancellation_token,
            ambiguous_failure_attempts=3,
        )
        if fetched is None or fetched.status_code >= 400:
            status_suffix = f" (HTTP {fetched.status_code})" if fetched is not None else ""
            raise RuntimeError(f"Failed to fetch Demon catalog page: {page_url}{status_suffix}")

        parser = _DemonCatalogParser(fetched.url, store_id)
        parser.feed(fetched.text)
        page_candidates = parser.records
        page_card_count = parser.card_count
        total_pages = _demon_total_pages(fetched.text, fetched.url)
        if expected_total_pages is None:
            expected_total_pages = total_pages
        elif total_pages != expected_total_pages:
            raise RuntimeError("Demon catalog pagination changed during discovery")
        if page_number < expected_total_pages and page_card_count != page_size:
            raise RuntimeError(
                "Demon catalog completeness check failed: "
                f"page {page_number} expected {page_size} products but found {page_card_count}"
            )
        if page_card_count == 0:
            raise RuntimeError(f"Demon catalog returned no products on page {page_number}")

        for invalid_item in parser.invalid_items:
            skipped_invalid_items += 1
            trace.log(
                "demon_inventory.catalog_product.invalid",
                **invalid_item,
                page_number=page_number,
                source_url=_normalized_product_url(fetched.url, str(invalid_item.get("href") or "")),
                store_id=store_id,
            )

        trace.log(
            "demon_inventory.catalog_fetch.completed",
            invalid_item_count=len(parser.invalid_items),
            item_count=page_card_count,
            page_number=page_number,
            source_url=fetched.url,
            status_code=fetched.status_code,
            store_id=store_id,
            total_pages=total_pages,
        )
        for candidate in page_candidates:
            normalized_url = candidate.source_url.casefold()
            if normalized_url in seen_urls:
                raise RuntimeError(
                    "Demon catalog completeness check failed: duplicate product URL across pages: "
                    f"{candidate.source_url}"
                )
            seen_urls.add(normalized_url)
            candidates.append(candidate)
            if limit is not None and len(candidates) >= limit:
                _log_demon_discovery_completed(
                    trace,
                    candidate_count=len(candidates),
                    limited=True,
                    skipped_invalid_items=skipped_invalid_items,
                    store_id=store_id,
                    total_pages=expected_total_pages,
                )
                return candidates
        page_number += 1

    if not candidates:
        raise RuntimeError("Demon catalog returned no valid products")
    _log_demon_discovery_completed(
        trace,
        candidate_count=len(candidates),
        limited=False,
        skipped_invalid_items=skipped_invalid_items,
        store_id=store_id,
        total_pages=expected_total_pages,
    )
    return candidates


def demon_catalog_page_url(store_url: str, page_number: int, *, page_size: int = DEMON_CATALOG_PAGE_SIZE) -> str:
    if page_number < 1:
        raise ValueError("Demon catalog page number must be positive")
    if page_size < 1:
        raise ValueError("Demon catalog page size must be positive")
    return f"{store_url.rstrip('/')}/?{urlencode({'scpp': page_size, 'spage': page_number})}"


def extract_demon_product_detail_candidate(
    page_html: str,
    product_url: str,
    store_id: int | None,
    source_listing_url: str,
) -> DiscoveryItemCandidateRecord:
    parser = _DemonProductMicrodataParser()
    parser.feed(page_html)
    microdata = parser.product
    title = _clean_text(microdata.get("name", ""))
    if not title:
        raise RuntimeError(f"Demon product microdata was not found: {product_url}")

    record = extract_product_detail_candidate(page_html, product_url, store_id, source_listing_url)
    if record is None:
        record = DiscoveryItemCandidateRecord(store_id=store_id, source_url=product_url, title=title)

    record.title = title
    record.original_title = title
    description = _clean_text(microdata.get("description", ""))
    if description:
        record.description = description
    image_url = _clean_text(microdata.get("image", ""))
    if image_url:
        record.image_url = urljoin(product_url, image_url)
    sku = _clean_text(microdata.get("sku", ""))
    if sku:
        record.store_sku = sku

    price = _decimal_text(microdata.get("price", ""))
    if price:
        record.price = price
        record.raw_price = f"${price}"
        record.price_source = "demon_product_microdata"
    currency = _clean_text(microdata.get("pricecurrency", "")).upper()
    if currency:
        record.currency = currency
    availability = _schema_availability(microdata.get("availability", ""))
    if availability != "unknown":
        record.availability = availability
        record.availability_source = "demon_product_microdata"
    record.raw_payload["demon_product_microdata"] = dict(microdata)
    return record


def _fetch_demon_catalog_page(url: str) -> FetchResult | None:
    return fetch_html(url, headers=DEMON_BROWSER_HEADERS, include_http_error_status=True)


def _demon_total_pages(page_html: str, source_url: str) -> int:
    page_numbers = [int(value) for value in re.findall(r"(?:[?&]|&amp;)spage=(\d+)", page_html)]
    if not page_numbers:
        raise RuntimeError(f"Demon catalog pagination was not found: {source_url}")
    total_pages = max(page_numbers)
    if total_pages < 1:
        raise RuntimeError(f"Demon catalog returned invalid pagination: {source_url}")
    return total_pages


def _normalized_product_url(base_url: str, href: str) -> str:
    parsed = urlparse(urljoin(base_url, href))
    encoded_path = quote(parsed.path, safe="/%:@-._~!$&'()*+,;=")
    return urlunparse((parsed.scheme, parsed.netloc, encoded_path, "", "", ""))


def _decimal_text(value: object) -> str:
    if value in (None, "") or isinstance(value, bool):
        return ""
    normalized = re.sub(r"[^0-9.,-]", "", str(value)).replace(",", "")
    try:
        decimal_value = Decimal(normalized)
    except (InvalidOperation, ValueError):
        return ""
    if not decimal_value.is_finite() or decimal_value < 0:
        return ""
    return format(decimal_value.quantize(Decimal("0.01")), "f")


def _schema_availability(value: object) -> str:
    normalized = str(value or "").strip().casefold().rstrip("/").rsplit("/", 1)[-1]
    if normalized in {"instock", "limitedavailability", "onlineonly", "preorder"}:
        return "available"
    if normalized in {"outofstock", "discontinued", "soldout"}:
        return "out_of_stock"
    return "unknown"


def _clean_text(value: object) -> str:
    text = str(value or "")
    return " ".join(html.unescape(html.unescape(text)).split())


def _merge_demon_catalog_details(
    detail_candidate: DiscoveryItemCandidateRecord,
    listing_candidate: DiscoveryItemCandidateRecord,
) -> DiscoveryItemCandidateRecord:
    if not detail_candidate.store_sku:
        detail_candidate.store_sku = listing_candidate.store_sku
    detail_candidate.raw_payload = {
        **listing_candidate.raw_payload,
        **detail_candidate.raw_payload,
    }
    return detail_candidate


def _log_demon_discovery_completed(
    trace: TraceLogger,
    *,
    candidate_count: int,
    limited: bool,
    skipped_invalid_items: int,
    store_id: int | None,
    total_pages: int | None,
) -> None:
    trace.log(
        "demon_inventory.catalog_discovery.completed",
        candidate_count=candidate_count,
        limited=limited,
        skipped_invalid_items=skipped_invalid_items,
        store_id=store_id,
        total_pages=total_pages,
    )


class _DemonCatalogParser(HTMLParser):
    def __init__(self, base_url: str, store_id: int | None):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.store_id = store_id
        self.records: list[DiscoveryItemCandidateRecord] = []
        self.card_count = 0
        self.invalid_items: list[dict[str, str]] = []
        self._item_depth = 0
        self._div_classes: list[set[str]] = []
        self._item: dict[str, object] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized_tag = tag.casefold()
        attr = {name.casefold(): value or "" for name, value in attrs}
        classes = set(attr.get("class", "").casefold().split())
        if normalized_tag == "div":
            if self._item is None and "wb-store-item" in classes:
                self._item = {
                    "availability": False,
                    "href": "",
                    "item_id": attr.get("data-item-id", "").strip(),
                    "price": [],
                    "title": [],
                }
                self._item_depth = 1
                self._div_classes = [classes]
                return
            if self._item is not None:
                self._item_depth += 1
                self._div_classes.append(classes)
                return
        if self._item is None:
            return
        if normalized_tag == "a" and self._inside_div_class("wb-store-name"):
            href = attr.get("href", "").strip()
            if href:
                self._item["href"] = href
        if normalized_tag == "button" and classes.intersection(
            {"wb-store-item-add-to-cart", "wb-store-item-buy-now"}
        ):
            self._item["availability"] = True

    def handle_endtag(self, tag: str) -> None:
        if self._item is None or tag.casefold() != "div":
            return
        self._item_depth -= 1
        if self._div_classes:
            self._div_classes.pop()
        if self._item_depth == 0:
            self._finish_item()

    def handle_data(self, data: str) -> None:
        if self._item is None:
            return
        text = _clean_text(data)
        if not text:
            return
        if self._inside_div_class("wb-store-name"):
            self._item["title"].append(text)
        elif self._inside_div_class("wb-store-price"):
            self._item["price"].append(text)

    def _inside_div_class(self, class_name: str) -> bool:
        return any(class_name in classes for classes in self._div_classes)

    def _finish_item(self) -> None:
        assert self._item is not None
        self.card_count += 1
        title = _clean_text(" ".join(self._item["title"]))
        href = str(self._item["href"])
        if not title or not href:
            self.invalid_items.append(
                {
                    "href": href,
                    "item_id": str(self._item["item_id"]),
                    "reason": "missing_title" if not title else "missing_url",
                }
            )
            self._item = None
            self._item_depth = 0
            self._div_classes = []
            return
        raw_price = _clean_text(" ".join(self._item["price"]))
        price = _decimal_text(raw_price)
        source_url = _normalized_product_url(self.base_url, href)
        self.records.append(
            DiscoveryItemCandidateRecord(
                store_id=self.store_id,
                source_url=source_url,
                source_listing_url=self.base_url,
                title=title,
                raw_price=raw_price,
                price=price,
                price_source="demon_catalog" if price else "none",
                availability="available" if self._item["availability"] else "out_of_stock",
                availability_source="demon_catalog",
                raw_payload={
                    "demon_catalog": {
                        "item_id": self._item["item_id"],
                    }
                },
            )
        )
        self._item = None
        self._item_depth = 0
        self._div_classes = []


class _DemonProductMicrodataParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.product: dict[str, str] = {}
        self._product_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized_tag = tag.casefold()
        attr = {name.casefold(): value or "" for name, value in attrs}
        item_type = attr.get("itemtype", "").casefold().rstrip("/")
        if self._product_depth == 0 and normalized_tag == "div" and item_type.endswith("schema.org/product"):
            self._product_depth = 1
        elif self._product_depth > 0 and normalized_tag == "div":
            self._product_depth += 1
        if self._product_depth == 0:
            return
        item_property = attr.get("itemprop", "").strip().casefold()
        if not item_property:
            return
        value = attr.get("content", "") or attr.get("href", "")
        if value and item_property not in self.product:
            self.product[item_property] = value

    def handle_endtag(self, tag: str) -> None:
        if self._product_depth > 0 and tag.casefold() == "div":
            self._product_depth -= 1
