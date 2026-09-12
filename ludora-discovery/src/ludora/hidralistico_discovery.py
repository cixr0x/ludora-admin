from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any
from urllib.parse import urlencode, urljoin, urlparse, urlunparse

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.filtering import canonical_domain
from ludora.models import DiscoveryItemCandidateRecord
from ludora.trace import NullTraceLogger, TraceLogger
from ludora.webfetch import FetchResult, fetch_with_transient_retries


HIDRALISTICO_STORE_DOMAINS = {"hidralistico.com.mx"}
HIDRALISTICO_CATEGORY_SLUG = "juegos-de-mesa"
HIDRALISTICO_CATEGORY_SEARCH = "Juegos de mesa"
HIDRALISTICO_STORE_API_PRODUCTS_PATH = "/wp-json/wc/store/v1/products"
HIDRALISTICO_STORE_API_CATEGORIES_PATH = "/wp-json/wc/store/v1/products/categories"
HIDRALISTICO_STORE_API_PAGE_SIZE = 100
HIDRALISTICO_STORE_API_MAX_CATEGORY_PAGES = 100
StoreApiFetcher = Callable[[str], FetchResult | None]
BeforeStoreApiRequest = Callable[[str], None]


class HidralisticoStoreApiFallback(RuntimeError):
    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


def is_hidralistico_store_url(store_url: str) -> bool:
    return canonical_domain(store_url) in HIDRALISTICO_STORE_DOMAINS


def discover_hidralistico_listing_candidates(
    store_url: str,
    store_id: int | None,
    *,
    fetcher: StoreApiFetcher,
    limit: int | None = None,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
    before_request: BeforeStoreApiRequest | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    trace = trace_logger or NullTraceLogger()
    exact_categories: dict[str, dict[str, Any]] = {}
    seen_category_payloads: set[str] = set()
    for category_page_number in range(1, HIDRALISTICO_STORE_API_MAX_CATEGORY_PAGES + 1):
        category_api_url = _store_api_url(
            store_url,
            HIDRALISTICO_STORE_API_CATEGORIES_PATH,
            search=HIDRALISTICO_CATEGORY_SEARCH,
            page=category_page_number,
            per_page=HIDRALISTICO_STORE_API_PAGE_SIZE,
        )
        trace.log(
            "inventory.hidralistico_store_api.category_fetch.start",
            category_slug=HIDRALISTICO_CATEGORY_SLUG,
            page_number=category_page_number,
            page_size=HIDRALISTICO_STORE_API_PAGE_SIZE,
            source_url=category_api_url,
            store_id=store_id,
        )
        categories = _fetch_json_list(
            category_api_url,
            fetcher=fetcher,
            failure_reason="category_fetch_failed",
            incompatible_reason="category_response_incompatible",
            trace_event="inventory.hidralistico_store_api.category_fetch.http_error",
            trace_logger=trace,
            cancellation_token=cancellation_token,
            store_id=store_id,
            before_request=before_request,
        )
        new_category_count = 0
        for category in categories:
            category_payload = json.dumps(category, sort_keys=True, separators=(",", ":"))
            if category_payload in seen_category_payloads:
                continue
            seen_category_payloads.add(category_payload)
            new_category_count += 1
            if not isinstance(category, dict):
                continue
            normalized_slug = str(category.get("slug", "")).strip().casefold()
            if normalized_slug == HIDRALISTICO_CATEGORY_SLUG:
                category_identity = json.dumps(
                    [category.get("id"), normalized_slug],
                    sort_keys=True,
                    separators=(",", ":"),
                )
                exact_categories[category_identity] = category
        trace.log(
            "inventory.hidralistico_store_api.category_fetch.completed",
            exact_category_count=len(exact_categories),
            new_category_count=new_category_count,
            page_number=category_page_number,
            returned_category_count=len(categories),
            store_id=store_id,
        )
        if len(categories) < HIDRALISTICO_STORE_API_PAGE_SIZE:
            break
        if new_category_count == 0:
            raise HidralisticoStoreApiFallback(
                "category_pagination_stalled",
                f"Store API category page {category_page_number} returned no new categories",
            )
    else:
        raise HidralisticoStoreApiFallback(
            "category_pagination_exhausted",
            "Store API category pagination exceeded the safety limit",
        )

    if not exact_categories:
        raise HidralisticoStoreApiFallback(
            "category_not_found",
            f"Store API did not return the exact category slug {HIDRALISTICO_CATEGORY_SLUG}",
        )
    if len(exact_categories) != 1:
        raise HidralisticoStoreApiFallback(
            "category_ambiguous",
            f"Store API returned multiple categories for exact slug {HIDRALISTICO_CATEGORY_SLUG}",
        )
    category_id = next(iter(exact_categories.values())).get("id")
    if isinstance(category_id, bool) or not isinstance(category_id, int) or category_id <= 0:
        raise HidralisticoStoreApiFallback(
            "category_response_incompatible",
            f"Store API category {HIDRALISTICO_CATEGORY_SLUG} has no valid numeric id",
        )
    trace.log(
        "inventory.hidralistico_store_api.category_selected",
        category_id=category_id,
        category_slug=HIDRALISTICO_CATEGORY_SLUG,
        store_id=store_id,
    )

    candidates: list[DiscoveryItemCandidateRecord] = []
    seen_urls: set[str] = set()
    page_number = 1
    while limit is None or len(candidates) < max(0, limit):
        raise_if_cancelled(cancellation_token)
        page_url = _store_api_url(
            store_url,
            HIDRALISTICO_STORE_API_PRODUCTS_PATH,
            category=category_id,
            page=page_number,
            per_page=HIDRALISTICO_STORE_API_PAGE_SIZE,
        )
        trace.log(
            "inventory.hidralistico_store_api.products_fetch.start",
            category_id=category_id,
            page_number=page_number,
            page_size=HIDRALISTICO_STORE_API_PAGE_SIZE,
            source_url=page_url,
            store_id=store_id,
        )
        products = _fetch_json_list(
            page_url,
            fetcher=fetcher,
            failure_reason="products_fetch_failed",
            incompatible_reason="products_response_incompatible",
            trace_event="inventory.hidralistico_store_api.products_fetch.http_error",
            trace_logger=trace,
            cancellation_token=cancellation_token,
            store_id=store_id,
            before_request=before_request,
        )
        added_on_page = 0
        for product in products:
            candidate = _candidate_from_store_api_product(
                product,
                page_url=page_url,
                store_url=store_url,
                store_id=store_id,
            )
            if candidate is None or candidate.source_url in seen_urls:
                continue
            seen_urls.add(candidate.source_url)
            candidates.append(candidate)
            added_on_page += 1
            if limit is not None and len(candidates) >= max(0, limit):
                break
        trace.log(
            "inventory.hidralistico_store_api.products_fetch.completed",
            category_id=category_id,
            new_product_count=added_on_page,
            page_number=page_number,
            returned_product_count=len(products),
            store_id=store_id,
        )
        if len(products) < HIDRALISTICO_STORE_API_PAGE_SIZE:
            break
        if added_on_page == 0:
            raise HidralisticoStoreApiFallback(
                "product_pagination_stalled",
                f"Store API product page {page_number} returned no new compatible products",
            )
        page_number += 1

    if not candidates:
        raise HidralisticoStoreApiFallback(
            "category_products_empty",
            f"Store API category {HIDRALISTICO_CATEGORY_SLUG} returned no products",
        )
    trace.log(
        "inventory.hidralistico_store_api.completed",
        category_id=category_id,
        product_count=len(candidates),
        store_id=store_id,
    )
    return candidates


def _fetch_json_list(
    url: str,
    *,
    fetcher: StoreApiFetcher,
    failure_reason: str,
    incompatible_reason: str,
    trace_event: str,
    trace_logger: TraceLogger,
    cancellation_token: CancellationToken | None,
    store_id: int | None,
    before_request: BeforeStoreApiRequest | None,
) -> list[Any]:
    def fetch_attempt(target_url: str) -> FetchResult | None:
        if before_request is not None:
            before_request(target_url)
        return fetcher(target_url)

    fetched = fetch_with_transient_retries(
        url,
        fetch_attempt,
        trace_event=trace_event,
        trace_logger=trace_logger,
        trace_fields={"store_id": store_id},
        cancellation_token=cancellation_token,
    )
    if fetched is None or fetched.status_code >= 400:
        status_suffix = f" (HTTP {fetched.status_code})" if fetched is not None else ""
        raise HidralisticoStoreApiFallback(
            failure_reason,
            f"Store API request failed: {url}{status_suffix}",
        )
    try:
        payload = json.loads(fetched.text)
    except (TypeError, ValueError) as exc:
        raise HidralisticoStoreApiFallback(
            incompatible_reason,
            f"Store API returned invalid JSON: {url}",
        ) from exc
    if not isinstance(payload, list):
        raise HidralisticoStoreApiFallback(
            incompatible_reason,
            f"Store API returned an incompatible response: {url}",
        )
    return payload


def _candidate_from_store_api_product(
    product: Any,
    *,
    page_url: str,
    store_url: str,
    store_id: int | None,
) -> DiscoveryItemCandidateRecord | None:
    if not isinstance(product, dict):
        return None
    product_url = _clean_product_url(urljoin(store_url, str(product.get("permalink", "")).strip()))
    if not product_url or canonical_domain(product_url) != canonical_domain(store_url):
        return None
    title = str(product.get("name", "")).strip()
    if not title:
        return None
    return DiscoveryItemCandidateRecord(
        store_id=store_id,
        source_url=product_url,
        source_listing_url=page_url,
        title=title,
        raw_payload={"hidralistico_store_api": product},
    )


def _store_api_url(store_url: str, path: str, **query: object) -> str:
    return f"{urljoin(store_url, path)}?{urlencode(query)}"


def _clean_product_url(url: str) -> str:
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))
