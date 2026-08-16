from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from decimal import Decimal, InvalidOperation
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.filtering import canonical_domain
from ludora.item_classification import apply_item_classification
from ludora.listing_extraction import ListingLinkParser
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import (
    BeforeProductRequest,
    ItemCandidateProcessor,
    ItemCandidateRepository,
    ItemClassifier,
    crawl_listing_candidates,
)
from ludora.trace import NullTraceLogger, TraceLogger
from ludora.webfetch import FetchResult, fetch_html, fetch_with_transient_retries, retry_after_seconds_from_headers


DIA_D_STORE_DOMAINS = {"diadejuegos.mx"}
DIA_D_SITEMAP_PATH = "/mapa%20del%20sitio"
DIA_D_CATALOG_API_PATH = "/module/diadjuegoscms/ajax"
DIA_D_CATALOG_PAGE_SIZE = 100
DIA_D_BROWSER_HEADERS = {
    "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36"
    ),
}
PageFetcher = Callable[[str], FetchResult | None]
CatalogFetcher = Callable[[str, Mapping[str, str]], FetchResult | None]


def is_dia_d_store_url(store_url: str) -> bool:
    return canonical_domain(store_url) in DIA_D_STORE_DOMAINS


def crawl_dia_d_inventory(
    store_url: str,
    store_id: int | None,
    repository: ItemCandidateRepository,
    *,
    limit: int | None = None,
    item_classifier: ItemClassifier = apply_item_classification,
    item_processor: ItemCandidateProcessor | None = None,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
    sitemap_fetcher: PageFetcher | None = None,
    catalog_fetcher: CatalogFetcher | None = None,
    catalog_page_size: int = DIA_D_CATALOG_PAGE_SIZE,
    before_product_request: BeforeProductRequest | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    raise_if_cancelled(cancellation_token)
    trace = trace_logger or NullTraceLogger()
    trace.log(
        "dia_d_inventory.crawl.start",
        catalog_api_url=urljoin(store_url, DIA_D_CATALOG_API_PATH),
        store_id=store_id,
        store_url=store_url,
    )
    listing_candidates = discover_dia_d_listing_candidates(
        store_url,
        store_id,
        limit=limit,
        sitemap_fetcher=sitemap_fetcher,
        catalog_fetcher=catalog_fetcher,
        page_size=catalog_page_size,
        trace_logger=trace,
        cancellation_token=cancellation_token,
    )
    records = crawl_listing_candidates(
        listing_candidates,
        repository,
        source_listing_url=urljoin(store_url, DIA_D_CATALOG_API_PATH),
        item_classifier=item_classifier,
        item_processor=item_processor,
        item_candidate_enricher=_merge_dia_d_catalog_details,
        trace_logger=trace,
        cancellation_token=cancellation_token,
        before_product_request=before_product_request,
    )
    trace.log(
        "dia_d_inventory.crawl.completed",
        catalog_item_count=len(listing_candidates),
        record_count=len(records),
        store_id=store_id,
        store_url=store_url,
    )
    return records


def discover_dia_d_listing_candidates(
    store_url: str,
    store_id: int | None,
    *,
    limit: int | None = None,
    sitemap_fetcher: PageFetcher | None = None,
    catalog_fetcher: CatalogFetcher | None = None,
    page_size: int = DIA_D_CATALOG_PAGE_SIZE,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    if page_size < 1:
        raise ValueError("DIA-D catalog page size must be positive")
    if limit is not None and limit < 1:
        return []

    trace = trace_logger or NullTraceLogger()
    page_fetcher = sitemap_fetcher or _fetch_dia_d_page
    api_fetcher = catalog_fetcher or fetch_dia_d_catalog_page
    sitemap_url = urljoin(store_url, DIA_D_SITEMAP_PATH)
    trace.log(
        "dia_d_inventory.sitemap_fetch.start",
        source_url=sitemap_url,
        store_id=store_id,
    )
    fetched_sitemap = fetch_with_transient_retries(
        sitemap_url,
        page_fetcher,
        trace_event="dia_d_inventory.sitemap_fetch.http_error",
        trace_logger=trace,
        trace_fields={"store_id": store_id},
        cancellation_token=cancellation_token,
        ambiguous_failure_attempts=3,
    )
    if fetched_sitemap is None or fetched_sitemap.status_code >= 400:
        status_suffix = f" (HTTP {fetched_sitemap.status_code})" if fetched_sitemap is not None else ""
        raise RuntimeError(f"Failed to fetch DIA-D sitemap page: {sitemap_url}{status_suffix}")

    categories = _dia_d_categories(fetched_sitemap.text, fetched_sitemap.url, store_url)
    if not categories:
        raise RuntimeError(f"DIA-D sitemap returned no catalog categories: {fetched_sitemap.url}")
    trace.log(
        "dia_d_inventory.sitemap_fetch.completed",
        category_count=len(categories),
        source_url=fetched_sitemap.url,
        status_code=fetched_sitemap.status_code,
        store_id=store_id,
    )

    catalog_api_url = urljoin(store_url, DIA_D_CATALOG_API_PATH)
    candidates: list[DiscoveryItemCandidateRecord] = []
    seen_product_ids: set[str] = set()
    for category_id, category_url in categories:
        page_number = 1
        expected_total: int | None = None
        category_new_items = 0
        category_duplicate_items = 0
        while expected_total is None or (page_number - 1) * page_size < expected_total:
            raise_if_cancelled(cancellation_token)
            fields = dia_d_catalog_request_fields(category_id, page_number, page_size)
            trace.log(
                "dia_d_inventory.catalog_fetch.start",
                category_id=category_id,
                page_number=page_number,
                page_size=page_size,
                source_url=catalog_api_url,
                store_id=store_id,
            )
            fetched_page = fetch_with_transient_retries(
                catalog_api_url,
                lambda url: api_fetcher(url, fields),
                trace_event="dia_d_inventory.catalog_fetch.http_error",
                trace_logger=trace,
                trace_fields={
                    "category_id": category_id,
                    "page_number": page_number,
                    "page_size": page_size,
                    "store_id": store_id,
                },
                cancellation_token=cancellation_token,
                ambiguous_failure_attempts=3,
            )
            if fetched_page is None or fetched_page.status_code >= 400:
                status_suffix = f" (HTTP {fetched_page.status_code})" if fetched_page is not None else ""
                raise RuntimeError(
                    f"Failed to fetch DIA-D catalog category {category_id} page {page_number}{status_suffix}"
                )

            payload = _parse_dia_d_catalog_payload(fetched_page.text, category_id, page_number)
            total = payload["total"]
            items = payload["items"]
            if expected_total is None:
                expected_total = total
            elif total != expected_total:
                raise RuntimeError(f"DIA-D category {category_id} total changed during discovery")
            expected_page_items = min(page_size, max(0, expected_total - ((page_number - 1) * page_size)))
            if len(items) != expected_page_items:
                raise RuntimeError(
                    "DIA-D catalog completeness check failed: "
                    f"category {category_id} page {page_number} expected {expected_page_items} "
                    f"products but found {len(items)}"
                )

            page_new_items = 0
            page_duplicate_items = 0
            for raw_product in items:
                candidate, product_id = _dia_d_product_candidate(
                    raw_product,
                    store_url,
                    store_id,
                    category_url,
                )
                if product_id in seen_product_ids:
                    page_duplicate_items += 1
                    category_duplicate_items += 1
                    continue
                seen_product_ids.add(product_id)
                candidates.append(candidate)
                page_new_items += 1
                category_new_items += 1
                if limit is not None and len(candidates) >= limit:
                    _log_dia_d_discovery_completed(
                        trace,
                        candidate_count=len(candidates),
                        category_count=len(categories),
                        limited=True,
                        store_id=store_id,
                    )
                    return candidates
            trace.log(
                "dia_d_inventory.catalog_fetch.completed",
                category_id=category_id,
                duplicate_item_count=page_duplicate_items,
                item_count=len(items),
                new_item_count=page_new_items,
                page_number=page_number,
                source_url=fetched_page.url,
                status_code=fetched_page.status_code,
                store_id=store_id,
                total=expected_total,
            )
            page_number += 1
        trace.log(
            "dia_d_inventory.category.completed",
            category_id=category_id,
            duplicate_item_count=category_duplicate_items,
            new_item_count=category_new_items,
            store_id=store_id,
            total=expected_total,
        )

    if not candidates:
        raise RuntimeError("DIA-D catalog returned no unique products")
    _log_dia_d_discovery_completed(
        trace,
        candidate_count=len(candidates),
        category_count=len(categories),
        limited=False,
        store_id=store_id,
    )
    return candidates


def dia_d_catalog_request_fields(category_id: int, page_number: int, page_size: int) -> dict[str, str]:
    if category_id < 1 or page_number < 1 or page_size < 1:
        raise ValueError("DIA-D catalog request values must be positive")
    return {
        "action": "productCategory",
        "ctrl": "category",
        "id": str(category_id),
        "search": "",
        "order": "product.position.desc",
        "filters": "",
        "pageNumber": str(page_number),
        "pageSize": str(page_size),
    }


def fetch_dia_d_catalog_page(
    url: str,
    fields: Mapping[str, str],
    timeout: int = 20,
) -> FetchResult | None:
    request = Request(
        url,
        data=urlencode(dict(fields)).encode("utf-8"),
        headers={
            **DIA_D_BROWSER_HEADERS,
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
        },
        method="POST",
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
    except (ConnectionResetError, HTTPException, URLError, TimeoutError, ValueError) as exc:
        return FetchResult(
            url=url,
            text="",
            status_code=0,
            error=str(exc),
            error_type=type(exc).__name__,
        )


def _fetch_dia_d_page(url: str) -> FetchResult | None:
    return fetch_html(url, headers=DIA_D_BROWSER_HEADERS, include_http_error_status=True)


def _dia_d_categories(page_html: str, page_url: str, store_url: str) -> list[tuple[int, str]]:
    parser = ListingLinkParser(page_url)
    parser.feed(page_html)
    store_domain = canonical_domain(store_url)
    categories: list[tuple[int, str]] = []
    seen_ids: set[int] = set()
    for event_type, href, _title in parser.events:
        if event_type != "link" or canonical_domain(href) != store_domain:
            continue
        path = urlparse(href).path.rstrip("/")
        if "/catalogo/" not in path.casefold():
            continue
        suffix = path.rsplit("-", 1)[-1]
        if not suffix.isdigit():
            continue
        category_id = int(suffix)
        if category_id < 1 or category_id in seen_ids:
            continue
        seen_ids.add(category_id)
        categories.append((category_id, urlunparse(urlparse(href)._replace(query="", fragment=""))))
    return categories


def _parse_dia_d_catalog_payload(text: str, category_id: int, page_number: int) -> dict[str, object]:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"DIA-D category {category_id} page {page_number} returned invalid JSON"
        ) from exc
    if not isinstance(payload, dict) or payload.get("status") is not True:
        raise RuntimeError(f"DIA-D category {category_id} page {page_number} was unavailable")
    items = payload.get("items")
    if not isinstance(items, list):
        raise RuntimeError(f"DIA-D category {category_id} page {page_number} returned invalid items")
    total = _non_negative_int(payload.get("total"))
    if total is None:
        raise RuntimeError(f"DIA-D category {category_id} page {page_number} returned an invalid total")
    return {"items": items, "total": total}


def _dia_d_product_candidate(
    raw_product: object,
    store_url: str,
    store_id: int | None,
    category_url: str,
) -> tuple[DiscoveryItemCandidateRecord, str]:
    if not isinstance(raw_product, dict):
        raise RuntimeError("DIA-D catalog returned a non-object product")
    product_id = _text(raw_product.get("id_product"))
    title = _text(raw_product.get("name"))
    source_url = _clean_dia_d_product_url(_text(raw_product.get("link")))
    if not product_id or not title or not source_url:
        raise RuntimeError("DIA-D catalog returned a product without id, name, or link")
    if canonical_domain(source_url) != canonical_domain(store_url):
        raise RuntimeError(f"DIA-D catalog returned an off-domain product URL: {source_url}")
    path_name = urlparse(source_url).path.rsplit("/", 1)[-1].casefold()
    if not path_name.startswith(f"{product_id.casefold()}-") or not path_name.endswith(".html"):
        raise RuntimeError(f"DIA-D catalog returned an invalid product URL for id {product_id}: {source_url}")

    price = _decimal_text(raw_product.get("price_amount"))
    stock = _decimal_value(raw_product.get("stock"))
    availability = "unknown" if stock is None else ("available" if stock > 0 else "out_of_stock")
    reference = _text(raw_product.get("reference"))
    image_url = _text(raw_product.get("cover"))
    return (
        DiscoveryItemCandidateRecord(
            store_id=store_id,
            source_url=source_url,
            source_listing_url=category_url,
            title=title,
            description=_text(raw_product.get("description_short")),
            image_url=image_url,
            raw_price=f"${price}" if price else "",
            price=price,
            price_source="dia_d_catalog_api" if price else "none",
            currency="MXN",
            availability=availability,
            availability_source="dia_d_catalog_api" if availability != "unknown" else "none",
            raw_payload={
                "dia_d_catalog": {
                    "category_id": _text(raw_product.get("id_category_default")),
                    "cover": image_url,
                    "id_product": product_id,
                    "reference": reference,
                    "stock": _text(raw_product.get("stock")),
                }
            },
        ),
        product_id,
    )


def _clean_dia_d_product_url(value: str) -> str:
    if not value:
        return ""
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))


def _merge_dia_d_catalog_details(
    detail_candidate: DiscoveryItemCandidateRecord,
    listing_candidate: DiscoveryItemCandidateRecord,
) -> DiscoveryItemCandidateRecord:
    catalog = listing_candidate.raw_payload.get("dia_d_catalog")
    if isinstance(catalog, dict):
        if not detail_candidate.store_sku:
            detail_candidate.store_sku = _text(catalog.get("reference"))
    if not detail_candidate.description:
        detail_candidate.description = listing_candidate.description
    if not detail_candidate.image_url:
        detail_candidate.image_url = listing_candidate.image_url
    if listing_candidate.price:
        detail_candidate.raw_price = listing_candidate.raw_price
        detail_candidate.price = listing_candidate.price
        detail_candidate.price_source = listing_candidate.price_source
        detail_candidate.currency = listing_candidate.currency
    if listing_candidate.availability != "unknown":
        detail_candidate.availability = listing_candidate.availability
        detail_candidate.availability_source = listing_candidate.availability_source
    detail_candidate.raw_payload = {
        **listing_candidate.raw_payload,
        **detail_candidate.raw_payload,
    }
    return detail_candidate


def _non_negative_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _decimal_value(value: object) -> Decimal | None:
    if value in (None, "") or isinstance(value, bool):
        return None
    try:
        decimal_value = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return decimal_value if decimal_value.is_finite() else None


def _decimal_text(value: object) -> str:
    decimal_value = _decimal_value(value)
    if decimal_value is None or decimal_value < 0:
        return ""
    return format(decimal_value.quantize(Decimal("0.01")), "f")


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else str(value).strip() if value is not None else ""


def _log_dia_d_discovery_completed(
    trace: TraceLogger,
    *,
    candidate_count: int,
    category_count: int,
    limited: bool,
    store_id: int | None,
) -> None:
    trace.log(
        "dia_d_inventory.catalog_discovery.completed",
        candidate_count=candidate_count,
        category_count=category_count,
        limited=limited,
        store_id=store_id,
    )
