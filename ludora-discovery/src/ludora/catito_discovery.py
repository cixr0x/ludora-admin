from __future__ import annotations

import json
from collections.abc import Callable
from decimal import Decimal, InvalidOperation
from http.client import HTTPException
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urljoin
from urllib.request import Request, urlopen

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.filtering import canonical_domain
from ludora.item_classification import apply_item_classification
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import (
    ItemCandidateProcessor,
    ItemCandidateRepository,
    ItemClassifier,
    crawl_listing_candidates,
)
from ludora.trace import NullTraceLogger, TraceLogger
from ludora.webfetch import FetchResult, fetch_with_transient_retries, retry_after_seconds_from_headers


CATITO_STORE_DOMAINS = {"catitogames.com"}
CATITO_CATALOG_API_URL = "https://api.catitogames.com/products/search"
DEFAULT_CATITO_CATALOG_PAGE_SIZE = 100
CatalogFetcher = Callable[[str], FetchResult | None]


def is_catito_store_url(store_url: str) -> bool:
    return canonical_domain(store_url) in CATITO_STORE_DOMAINS


def crawl_catito_inventory(
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
    catalog_page_size: int = DEFAULT_CATITO_CATALOG_PAGE_SIZE,
) -> list[DiscoveryItemCandidateRecord]:
    raise_if_cancelled(cancellation_token)
    trace = trace_logger or NullTraceLogger()
    trace.log(
        "catito_inventory.crawl.start",
        catalog_api_url=CATITO_CATALOG_API_URL,
        store_id=store_id,
        store_url=store_url,
    )
    listing_candidates = discover_catito_listing_candidates(
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
        source_listing_url=CATITO_CATALOG_API_URL,
        item_classifier=item_classifier,
        item_processor=item_processor,
        item_candidate_enricher=_merge_catito_catalog_details,
        trace_logger=trace,
        cancellation_token=cancellation_token,
    )
    trace.log(
        "catito_inventory.crawl.completed",
        catalog_item_count=len(listing_candidates),
        record_count=len(records),
        store_id=store_id,
        store_url=store_url,
    )
    return records


def discover_catito_listing_candidates(
    store_url: str,
    store_id: int | None,
    *,
    limit: int | None = None,
    fetcher: CatalogFetcher | None = None,
    page_size: int = DEFAULT_CATITO_CATALOG_PAGE_SIZE,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    if page_size < 1:
        raise ValueError("Catito catalog page size must be positive")
    if limit is not None and limit < 1:
        return []

    trace = trace_logger or NullTraceLogger()
    catalog_fetcher = fetcher or fetch_catito_catalog_page
    candidates: list[DiscoveryItemCandidateRecord] = []
    seen_slugs: set[str] = set()
    expected_total_elements: int | None = None
    expected_total_pages: int | None = None
    page_number = 0

    while expected_total_pages is None or page_number < expected_total_pages:
        raise_if_cancelled(cancellation_token)
        page_url = catito_catalog_page_url(page_number, page_size=page_size)
        trace.log(
            "catito_inventory.catalog_fetch.start",
            page_number=page_number,
            page_size=page_size,
            source_url=page_url,
            store_id=store_id,
        )
        fetched = fetch_with_transient_retries(
            page_url,
            catalog_fetcher,
            trace_event="catito_inventory.catalog_fetch.http_error",
            trace_logger=trace,
            trace_fields={"page_number": page_number, "page_size": page_size, "store_id": store_id},
            cancellation_token=cancellation_token,
            ambiguous_failure_attempts=3,
        )
        if fetched is None or fetched.status_code >= 400:
            status_suffix = f" (HTTP {fetched.status_code})" if fetched is not None else ""
            raise RuntimeError(f"Failed to fetch Catito catalog page: {page_url}{status_suffix}")

        payload = _parse_catalog_payload(fetched.text, page_url)
        content = payload["content"]
        response_page = payload["number"]
        total_pages = payload["totalPages"]
        total_elements = payload["totalElements"]
        if response_page != page_number:
            raise RuntimeError(
                f"Catito catalog returned page {response_page} while page {page_number} was requested"
            )
        if expected_total_pages is None:
            expected_total_pages = total_pages
            expected_total_elements = total_elements
            if expected_total_pages < 1 or expected_total_elements < 1 or not content:
                raise RuntimeError("Catito catalog returned no products")
        elif total_pages != expected_total_pages or total_elements != expected_total_elements:
            raise RuntimeError("Catito catalog pagination totals changed during discovery")

        trace.log(
            "catito_inventory.catalog_fetch.completed",
            item_count=len(content),
            page_number=page_number,
            source_url=fetched.url,
            status_code=fetched.status_code,
            store_id=store_id,
            total_elements=total_elements,
            total_pages=total_pages,
        )
        for raw_product in content:
            candidate = _catito_product_candidate(raw_product, store_url, store_id, fetched.url)
            if candidate is None:
                trace.log(
                    "catito_inventory.catalog_product.invalid",
                    page_number=page_number,
                    product_id=_text(raw_product.get("id")) if isinstance(raw_product, dict) else "",
                    store_id=store_id,
                )
                continue
            slug = candidate.source_url.rstrip("/").rsplit("/", 1)[-1].casefold()
            if slug in seen_slugs:
                trace.log(
                    "catito_inventory.catalog_product.duplicate",
                    page_number=page_number,
                    source_url=candidate.source_url,
                    store_id=store_id,
                )
                continue
            seen_slugs.add(slug)
            candidates.append(candidate)
            if limit is not None and len(candidates) >= limit:
                trace.log(
                    "catito_inventory.catalog_discovery.completed",
                    candidate_count=len(candidates),
                    limited=True,
                    store_id=store_id,
                    total_elements=expected_total_elements,
                    total_pages=expected_total_pages,
                )
                return candidates
        page_number += 1

    if expected_total_elements is None or len(candidates) != expected_total_elements:
        raise RuntimeError(
            "Catito catalog completeness check failed: "
            f"expected {expected_total_elements or 0} products but found {len(candidates)} unique valid slugs"
        )
    trace.log(
        "catito_inventory.catalog_discovery.completed",
        candidate_count=len(candidates),
        limited=False,
        store_id=store_id,
        total_elements=expected_total_elements,
        total_pages=expected_total_pages,
    )
    return candidates


def catito_catalog_page_url(page_number: int, *, page_size: int = DEFAULT_CATITO_CATALOG_PAGE_SIZE) -> str:
    return f"{CATITO_CATALOG_API_URL}?{urlencode({'_page': page_number, '_size': page_size})}"


def fetch_catito_catalog_page(url: str, timeout: int = 20) -> FetchResult | None:
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "Accept-Language": "es-MX,es;q=0.9",
            "User-Agent": "LudoraStoreCollector/0.1 (+https://example.local/ludora)",
        },
        method="GET",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return FetchResult(
                url=response.geturl(),
                text=response.read().decode(charset, errors="replace"),
                status_code=int(getattr(response, "status", 200)),
            )
    except HTTPError as exc:
        return FetchResult(
            url=exc.geturl() or url,
            text="",
            status_code=int(exc.code),
            retry_after_seconds=retry_after_seconds_from_headers(exc.headers),
        )
    except (HTTPException, URLError, TimeoutError, ValueError):
        return None


def _parse_catalog_payload(text: str, source_url: str) -> dict[str, Any]:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Catito catalog returned invalid JSON: {source_url}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("content"), list):
        raise RuntimeError(f"Catito catalog returned an invalid response shape: {source_url}")
    for field_name in ("number", "totalPages", "totalElements"):
        value = payload.get(field_name)
        if isinstance(value, bool) or not isinstance(value, int):
            raise RuntimeError(f"Catito catalog response is missing integer {field_name}: {source_url}")
    return payload


def _catito_product_candidate(
    raw_product: object,
    store_url: str,
    store_id: int | None,
    source_listing_url: str,
) -> DiscoveryItemCandidateRecord | None:
    if not isinstance(raw_product, dict):
        return None
    title = _text(raw_product.get("name"))
    slug = _text(raw_product.get("slug")).strip("/")
    if not title or not slug:
        return None

    price = _decimal_text(raw_product.get("price"))
    availability = _catalog_availability(raw_product)
    return DiscoveryItemCandidateRecord(
        store_id=store_id,
        source_url=urljoin(store_url, f"/product/{quote(slug, safe='-._~')}"),
        source_listing_url=source_listing_url,
        title=title,
        publisher=_text(raw_product.get("brand")),
        description=_text(raw_product.get("longDescription")) or _text(raw_product.get("shortDescription")),
        image_url=_text(raw_product.get("imageUrl")),
        raw_price=price,
        price=price,
        price_source="catito_catalog_api" if price else "none",
        currency="MXN",
        availability=availability,
        availability_source="catito_catalog_api" if availability != "unknown" else "none",
        store_sku=_text(raw_product.get("id")),
        raw_payload={"catito_catalog": raw_product},
    )


def _merge_catito_catalog_details(
    detail_candidate: DiscoveryItemCandidateRecord,
    listing_candidate: DiscoveryItemCandidateRecord,
) -> DiscoveryItemCandidateRecord:
    for field_name in ("publisher", "description", "image_url", "store_sku"):
        if not getattr(detail_candidate, field_name):
            setattr(detail_candidate, field_name, getattr(listing_candidate, field_name))
    catalog_payload = listing_candidate.raw_payload.get("catito_catalog")
    if isinstance(catalog_payload, dict):
        detail_candidate.raw_payload["catito_catalog"] = catalog_payload
    return detail_candidate


def _catalog_availability(product: dict[str, Any]) -> str:
    available_online = product.get("availableOnline")
    stock = product.get("stock")
    if available_online is False:
        return "out_of_stock"
    if isinstance(stock, (int, float)) and not isinstance(stock, bool):
        return "available" if stock > 0 and available_online is not False else "out_of_stock"
    return "available" if available_online is True else "unknown"


def _decimal_text(value: object) -> str:
    if value in (None, "") or isinstance(value, bool):
        return ""
    try:
        decimal_value = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return ""
    if not decimal_value.is_finite() or decimal_value < 0:
        return ""
    return format(decimal_value.normalize(), "f")


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""
