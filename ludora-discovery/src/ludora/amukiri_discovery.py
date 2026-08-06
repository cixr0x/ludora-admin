from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Callable
from html.parser import HTMLParser
from urllib.parse import unquote, urlencode, urljoin, urlparse

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.filtering import canonical_domain
from ludora.item_classification import apply_item_classification
from ludora.listing_extraction import extract_listing_candidates
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import (
    ItemCandidateProcessor,
    ItemCandidateRepository,
    ItemClassifier,
    BeforeProductRequest,
    crawl_listing_candidates,
)
from ludora.product_detail_extraction import extract_product_detail_candidate
from ludora.trace import NullTraceLogger, TraceLogger
from ludora.webfetch import FetchResult, fetch_html, fetch_with_transient_retries


AMUKIRI_STORE_DOMAINS = {"amukiri.mx"}
AMUKIRI_CATALOG_PATH = "/tienda"
AMUKIRI_PRODUCT_PATH = "/detalles/product/"
AMUKIRI_PAGINATION_RE = re.compile(r"P(?:á|a)gina\s+(\d+)\s*/\s*(\d+)", re.IGNORECASE)
AMUKIRI_TOTAL_PRODUCTS_RE = re.compile(r"\b(\d{1,6})\s+productos\b", re.IGNORECASE)
AMUKIRI_LISTING_PRICE_RE = re.compile(r"MX\$\s*([0-9][0-9,.]*)", re.IGNORECASE)
AMUKIRI_LISTING_PRICE_SUFFIX_RE = re.compile(
    r"(?:\s+MX\$\s*[0-9][0-9,.]*)+\s*$",
    re.IGNORECASE,
)
AMUKIRI_UNAVAILABLE_SUFFIX_RE = re.compile(
    r"\s+(?:No disponible en este momento|Currently unavailable)\s*$",
    re.IGNORECASE,
)
CatalogFetcher = Callable[[str], FetchResult | None]


def is_amukiri_store_url(store_url: str) -> bool:
    return canonical_domain(store_url) in AMUKIRI_STORE_DOMAINS


def crawl_amukiri_inventory(
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
    before_product_request: BeforeProductRequest | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    raise_if_cancelled(cancellation_token)
    trace = trace_logger or NullTraceLogger()
    catalog_url = amukiri_catalog_page_url(store_url, 1)
    trace.log(
        "amukiri_inventory.crawl.start",
        catalog_url=catalog_url,
        store_id=store_id,
        store_url=store_url,
    )
    listing_candidates = discover_amukiri_listing_candidates(
        store_url,
        store_id,
        limit=limit,
        fetcher=catalog_fetcher,
        trace_logger=trace,
        cancellation_token=cancellation_token,
    )
    records = crawl_listing_candidates(
        listing_candidates,
        repository,
        source_listing_url=catalog_url,
        item_classifier=item_classifier,
        item_processor=item_processor,
        item_detail_extractor=extract_amukiri_product_detail_candidate,
        trace_logger=trace,
        cancellation_token=cancellation_token,
        before_product_request=before_product_request,
    )
    trace.log(
        "amukiri_inventory.crawl.completed",
        catalog_item_count=len(listing_candidates),
        record_count=len(records),
        store_id=store_id,
        store_url=store_url,
    )
    return records


def discover_amukiri_listing_candidates(
    store_url: str,
    store_id: int | None,
    *,
    limit: int | None = None,
    fetcher: CatalogFetcher | None = None,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    if limit is not None and limit < 1:
        return []

    trace = trace_logger or NullTraceLogger()
    catalog_fetcher = fetcher or _fetch_amukiri_catalog_page
    candidates: list[DiscoveryItemCandidateRecord] = []
    seen_urls: set[str] = set()
    expected_total_pages: int | None = None
    expected_total_products: int | None = None
    page_number = 1

    while expected_total_pages is None or page_number <= expected_total_pages:
        raise_if_cancelled(cancellation_token)
        page_url = amukiri_catalog_page_url(store_url, page_number)
        trace.log(
            "amukiri_inventory.catalog_fetch.start",
            page_number=page_number,
            source_url=page_url,
            store_id=store_id,
        )
        fetched = fetch_with_transient_retries(
            page_url,
            catalog_fetcher,
            trace_event="amukiri_inventory.catalog_fetch.http_error",
            trace_logger=trace,
            trace_fields={"page_number": page_number, "store_id": store_id},
            cancellation_token=cancellation_token,
            ambiguous_failure_attempts=3,
        )
        if fetched is None or fetched.status_code >= 400:
            status_suffix = f" (HTTP {fetched.status_code})" if fetched is not None else ""
            raise RuntimeError(f"Failed to fetch Amukiri catalog page: {page_url}{status_suffix}")

        response_page, total_pages = _amukiri_pagination(fetched.text, fetched.url)
        total_products = _amukiri_total_products(fetched.text, fetched.url)
        if response_page != page_number:
            raise RuntimeError(
                f"Amukiri catalog returned page {response_page} while page {page_number} was requested"
            )
        if expected_total_pages is None:
            expected_total_pages = total_pages
            expected_total_products = total_products
        elif total_pages != expected_total_pages or total_products != expected_total_products:
            raise RuntimeError("Amukiri catalog pagination totals changed during discovery")

        page_candidates = extract_listing_candidates(
            html=fetched.text,
            page_url=fetched.url,
            store_id=store_id,
        )
        page_candidates = [
            _normalize_amukiri_listing_candidate(candidate, fetched.url)
            for candidate in page_candidates
            if AMUKIRI_PRODUCT_PATH in urlparse(candidate.source_url).path.casefold()
        ]
        if not page_candidates:
            raise RuntimeError(f"Amukiri catalog returned no products on page {page_number}")

        trace.log(
            "amukiri_inventory.catalog_fetch.completed",
            item_count=len(page_candidates),
            page_number=page_number,
            source_url=fetched.url,
            status_code=fetched.status_code,
            store_id=store_id,
            total_pages=total_pages,
            total_products=total_products,
        )
        for candidate in page_candidates:
            normalized_url = candidate.source_url.casefold()
            if normalized_url in seen_urls:
                trace.log(
                    "amukiri_inventory.catalog_product.duplicate",
                    page_number=page_number,
                    source_url=candidate.source_url,
                    store_id=store_id,
                )
                continue
            seen_urls.add(normalized_url)
            candidates.append(candidate)
            if limit is not None and len(candidates) >= limit:
                _log_catalog_discovery_completed(
                    trace,
                    candidate_count=len(candidates),
                    limited=True,
                    store_id=store_id,
                    total_pages=expected_total_pages,
                    total_products=expected_total_products,
                )
                return candidates
        page_number += 1

    if expected_total_products is None or len(candidates) != expected_total_products:
        raise RuntimeError(
            "Amukiri catalog completeness check failed: "
            f"expected {expected_total_products or 0} products but found {len(candidates)} unique product URLs"
        )
    _log_catalog_discovery_completed(
        trace,
        candidate_count=len(candidates),
        limited=False,
        store_id=store_id,
        total_pages=expected_total_pages,
        total_products=expected_total_products,
    )
    return candidates


def amukiri_catalog_page_url(store_url: str, page_number: int) -> str:
    if page_number < 1:
        raise ValueError("Amukiri catalog page number must be positive")
    catalog_url = urljoin(store_url, AMUKIRI_CATALOG_PATH)
    if page_number == 1:
        return catalog_url
    return f"{catalog_url}?{urlencode({'ep_no': page_number})}"


def extract_amukiri_product_detail_candidate(
    html: str,
    product_url: str,
    store_id: int | None,
    source_listing_url: str,
) -> DiscoveryItemCandidateRecord | None:
    record = extract_product_detail_candidate(html, product_url, store_id, source_listing_url)
    if record is None:
        return None

    description_html = _amukiri_product_description_html(html, product_url)
    if not description_html:
        return record

    parser = _AmukiriDescriptionParser()
    parser.feed(description_html)
    description = parser.description
    if description:
        record.description = description

    characteristics = parser.characteristics
    if characteristics:
        record.raw_payload["amukiri_characteristics"] = characteristics
    players = _number_range(_characteristic(characteristics, "numero de jugadores"), maximum=99)
    if players is not None:
        record.min_players, record.max_players = players
    minutes = _number_range(_characteristic(characteristics, "duracion"), maximum=1440)
    if minutes is not None:
        record.min_minutes, record.max_minutes = minutes
    age = _single_number(_characteristic(characteristics, "edad recomendada"), maximum=99)
    if age is not None:
        record.min_age = age

    language_value = _characteristic(characteristics, "idioma")
    language = _language_code(language_value)
    if language:
        record.language = language
        record.language_source = "amukiri_characteristics"
        record.language_evidence = f"Idioma: {language_value}"
    return record


def _fetch_amukiri_catalog_page(url: str) -> FetchResult | None:
    return fetch_html(url, include_http_error_status=True)


def _amukiri_pagination(html: str, source_url: str) -> tuple[int, int]:
    match = AMUKIRI_PAGINATION_RE.search(html)
    if not match:
        raise RuntimeError(f"Amukiri catalog pagination was not found: {source_url}")
    page_number = int(match.group(1))
    total_pages = int(match.group(2))
    if page_number < 1 or total_pages < page_number:
        raise RuntimeError(f"Amukiri catalog returned invalid pagination: {source_url}")
    return page_number, total_pages


def _amukiri_total_products(html: str, source_url: str) -> int:
    match = AMUKIRI_TOTAL_PRODUCTS_RE.search(html)
    if not match:
        raise RuntimeError(f"Amukiri catalog product total was not found: {source_url}")
    total_products = int(match.group(1))
    if total_products < 1:
        raise RuntimeError(f"Amukiri catalog returned no products: {source_url}")
    return total_products


def _normalize_amukiri_listing_candidate(
    candidate: DiscoveryItemCandidateRecord,
    source_listing_url: str,
) -> DiscoveryItemCandidateRecord:
    original_title = candidate.title
    unavailable = bool(AMUKIRI_UNAVAILABLE_SUFFIX_RE.search(original_title))
    title = AMUKIRI_UNAVAILABLE_SUFFIX_RE.sub("", original_title)
    price_matches = list(AMUKIRI_LISTING_PRICE_RE.finditer(title))
    title = AMUKIRI_LISTING_PRICE_SUFFIX_RE.sub("", title).strip()
    candidate.title = title
    candidate.original_title = title
    candidate.source_listing_url = source_listing_url
    if unavailable:
        candidate.availability = "out_of_stock"
        candidate.availability_source = "amukiri_listing"
    elif price_matches:
        candidate.availability = "available"
        candidate.availability_source = "amukiri_listing"
    if price_matches:
        candidate.raw_price = price_matches[-1].group(0)
        candidate.price = price_matches[-1].group(1).replace(",", "")
        candidate.price_source = "amukiri_listing"
        candidate.currency = "MXN"
    return candidate


def _log_catalog_discovery_completed(
    trace: TraceLogger,
    *,
    candidate_count: int,
    limited: bool,
    store_id: int | None,
    total_pages: int | None,
    total_products: int | None,
) -> None:
    trace.log(
        "amukiri_inventory.catalog_discovery.completed",
        candidate_count=candidate_count,
        limited=limited,
        store_id=store_id,
        total_pages=total_pages,
        total_products=total_products,
    )


class _NuxtDataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._capturing = False
        self._parts: list[str] = []

    @property
    def text(self) -> str:
        return "".join(self._parts)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {name.casefold(): value or "" for name, value in attrs}
        if tag.casefold() == "script" and attributes.get("id") == "__NUXT_DATA__":
            self._capturing = True

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "script" and self._capturing:
            self._capturing = False

    def handle_data(self, data: str) -> None:
        if self._capturing:
            self._parts.append(data)


class _AmukiriDescriptionParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._before_table = True
        self._in_table = False
        self._in_cell = False
        self._description_parts: list[str] = []
        self._cell_parts: list[str] = []
        self._row: list[str] = []
        self._rows: list[list[str]] = []

    @property
    def description(self) -> str:
        return _collapse_text(" ".join(self._description_parts))

    @property
    def characteristics(self) -> dict[str, str]:
        values: dict[str, str] = {}
        for row in self._rows:
            if len(row) < 2:
                continue
            label = _collapse_text(row[0])
            value = _collapse_text(" ".join(row[1:]))
            normalized_label = _normalize_lookup(label)
            if normalized_label in {"caracteristicas", "descripcion"} or not value:
                continue
            values[label] = value
        return values

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized_tag = tag.casefold()
        if normalized_tag == "table":
            self._before_table = False
            self._in_table = True
        elif self._in_table and normalized_tag == "tr":
            self._row = []
        elif self._in_table and normalized_tag in {"td", "th"}:
            self._in_cell = True
            self._cell_parts = []

    def handle_endtag(self, tag: str) -> None:
        normalized_tag = tag.casefold()
        if self._in_table and normalized_tag in {"td", "th"}:
            self._row.append(_collapse_text(" ".join(self._cell_parts)))
            self._in_cell = False
            self._cell_parts = []
        elif self._in_table and normalized_tag == "tr":
            if self._row:
                self._rows.append(self._row)
            self._row = []
        elif normalized_tag == "table":
            self._in_table = False

    def handle_data(self, data: str) -> None:
        text = _collapse_text(data)
        if not text:
            return
        if self._in_cell:
            self._cell_parts.append(text)
        elif self._before_table:
            self._description_parts.append(text)


def _amukiri_product_description_html(html: str, product_url: str) -> str:
    parser = _NuxtDataParser()
    parser.feed(html)
    if not parser.text:
        return ""
    try:
        payload = json.loads(parser.text)
    except json.JSONDecodeError:
        return ""
    if not isinstance(payload, list):
        return ""

    slug = unquote(urlparse(product_url).path.rstrip("/").rsplit("/", 1)[-1]).casefold()
    for item in payload:
        if not isinstance(item, dict):
            continue
        item_slug = _nuxt_reference_text(payload, item.get("slug")).casefold()
        if item_slug != slug:
            continue
        description = _nuxt_reference_text(payload, item.get("description"))
        if description:
            return description

    fallback_descriptions = [
        value
        for value in payload
        if isinstance(value, str)
        and "<" in value
        and any(label in _normalize_lookup(value) for label in ("numero de jugadores", "edad recomendada"))
    ]
    return fallback_descriptions[0] if len(fallback_descriptions) == 1 else ""


def _nuxt_reference_text(payload: list[object], reference: object) -> str:
    if isinstance(reference, str):
        return reference.strip()
    if isinstance(reference, int) and not isinstance(reference, bool) and 0 <= reference < len(payload):
        value = payload[reference]
        return value.strip() if isinstance(value, str) else ""
    return ""


def _characteristic(characteristics: dict[str, str], normalized_label: str) -> str:
    for label, value in characteristics.items():
        if _normalize_lookup(label) == normalized_label:
            return value
    return ""


def _number_range(value: str, *, maximum: int) -> tuple[int, int] | None:
    numbers = [int(number) for number in re.findall(r"\d+", value)]
    if not numbers:
        return None
    minimum = numbers[0]
    maximum_value = numbers[1] if len(numbers) > 1 else minimum
    if minimum < 1 or maximum_value < minimum or maximum_value > maximum:
        return None
    return minimum, maximum_value


def _single_number(value: str, *, maximum: int) -> int | None:
    match = re.search(r"\d+", value)
    if not match:
        return None
    number = int(match.group(0))
    return number if 1 <= number <= maximum else None


def _language_code(value: str) -> str:
    normalized = _normalize_lookup(value)
    if "espanol" in normalized or "castellano" in normalized:
        return "es"
    if "ingles" in normalized or "english" in normalized:
        return "en"
    return ""


def _normalize_lookup(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    without_accents = "".join(character for character in decomposed if not unicodedata.combining(character))
    return _collapse_text(re.sub(r"[^a-z0-9]+", " ", without_accents))


def _collapse_text(value: str) -> str:
    return " ".join(value.split())
