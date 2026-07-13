from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from html import unescape
from typing import Protocol
from urllib.parse import urljoin, urlparse

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.item_classification import apply_item_classification
from ludora.listing_extraction import extract_listing_candidates
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_detail_extraction import extract_product_detail_candidate
from ludora.sitemap_discovery import _looks_like_site_protection_challenge, discover_product_urls_from_sitemaps
from ludora.trace import NullTraceLogger, TraceLogger
from ludora.webfetch import FetchResult
from ludora.webfetch import fetch_html


AMAZON_STORE_PLATFORMS = {"amazon", "amazon_brand"}


class StoreItemSource(Protocol):
    store_id: int
    platform: str


class ItemCandidateRepository(Protocol):
    def item_candidate_exists(self, store_id: int | None, source_url: str) -> bool:
        ...

    def upsert_item_candidate(self, record: DiscoveryItemCandidateRecord) -> object | None:
        ...

    def list_confirmed_boardgame_item_candidates(
        self,
        limit: int | None = None,
        store_ids: list[int] | None = None,
    ) -> list[DiscoveryItemCandidateRecord]:
        ...

    def list_store_item_discovery_sources(
        self,
        *,
        store_ids: list[int] | None = None,
    ) -> list[StoreItemSource]:
        ...

    def update_item_candidate_with_change_log(
        self,
        existing_record: DiscoveryItemCandidateRecord,
        refreshed_record: DiscoveryItemCandidateRecord,
        *,
        job_id: int,
        run_id: str,
    ) -> object | None:
        ...

    def update_item_candidate_price_availability(
        self,
        existing_record: DiscoveryItemCandidateRecord,
        refreshed_record: DiscoveryItemCandidateRecord,
    ) -> object | None:
        ...

    def mark_item_candidate_inactive(
        self,
        existing_record: DiscoveryItemCandidateRecord,
        *,
        job_id: int | None = None,
        run_id: str | None = None,
    ) -> object | None:
        ...


class ItemCandidateProcessor(Protocol):
    def process_candidate(self, candidate_id: int, record: DiscoveryItemCandidateRecord) -> None:
        ...


ItemClassifier = Callable[[DiscoveryItemCandidateRecord], DiscoveryItemCandidateRecord]


class ProductPageRemovedError(RuntimeError):
    pass


class StoreItemUpdateRecords(list[DiscoveryItemCandidateRecord]):
    def __init__(self, records: list[DiscoveryItemCandidateRecord] | None = None, *, updated_items: int = 0):
        super().__init__(records or [])
        self.updated_items = updated_items


def crawl_store_product_details(
    store_url: str,
    store_id: int | None,
    repository: ItemCandidateRepository,
    limit: int | None = None,
    browser_sitemap_fetch_enabled: bool = False,
    browser_fetch_enabled: bool | None = None,
    browser_fetcher: Callable[[str], FetchResult | None] | None = None,
    item_classifier: ItemClassifier = apply_item_classification,
    item_processor: ItemCandidateProcessor | None = None,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    raise_if_cancelled(cancellation_token)
    use_browser_fetch = browser_sitemap_fetch_enabled if browser_fetch_enabled is None else browser_fetch_enabled
    trace = trace_logger or NullTraceLogger()
    trace.log(
        "inventory.crawl.start",
        browser_fetch_enabled=use_browser_fetch,
        store_id=store_id,
        store_url=store_url,
    )
    browser_session = None
    if use_browser_fetch and browser_fetcher is None:
        from ludora.browser_fetch import BrowserTextFetcher

        browser_session = BrowserTextFetcher(trace_logger=trace)
        browser_fetcher = browser_session.__enter__().fetch

    try:
        trace.log("inventory.sitemap_discovery.start", store_id=store_id, store_url=store_url)
        product_urls = discover_product_urls_from_sitemaps(
            store_url,
            browser_fetcher=browser_fetcher,
            browser_fallback_enabled=use_browser_fetch,
            limit=limit,
        )
        trace.log(
            "inventory.sitemap_discovery.completed",
            product_url_count=len(product_urls),
            store_id=store_id,
            store_url=store_url,
        )
        if product_urls:
            source_listing_url = urljoin(store_url, "/sitemap.xml")
            listing_candidates = [
                DiscoveryItemCandidateRecord(
                    store_id=store_id,
                    source_url=product_url,
                    source_listing_url=source_listing_url,
                    title=_title_from_url(product_url),
                )
                for product_url in product_urls
            ]
        else:
            trace.log("inventory.listing_fetch.start", source_url=store_url, store_id=store_id)
            fetched_listing = fetch_html(store_url)
            if fetched_listing is None:
                raise RuntimeError(f"Failed to fetch store listing page: {store_url}")
            trace.log("inventory.listing_fetch.completed", fetched_url=fetched_listing.url, store_id=store_id)

            source_listing_url = fetched_listing.url
            listing_candidates = extract_listing_candidates(
                html=fetched_listing.text,
                page_url=fetched_listing.url,
                store_id=store_id,
                limit=limit,
            )
            trace.log(
                "inventory.listing_extract.completed",
                listing_count=len(listing_candidates),
                source_listing_url=source_listing_url,
                store_id=store_id,
            )

        records: list[DiscoveryItemCandidateRecord] = []
        for listing_candidate in listing_candidates:
            raise_if_cancelled(cancellation_token)
            trace.log(
                "inventory.candidate.exists_check.start",
                source_url=listing_candidate.source_url,
                store_id=listing_candidate.store_id,
                title=listing_candidate.title,
            )
            if repository.item_candidate_exists(listing_candidate.store_id, listing_candidate.source_url):
                trace.log(
                    "inventory.candidate.skipped_existing",
                    source_url=listing_candidate.source_url,
                    store_id=listing_candidate.store_id,
                    title=listing_candidate.title,
                )
                continue

            trace.log(
                "inventory.candidate.detail_fetch.start",
                source_url=listing_candidate.source_url,
                store_id=listing_candidate.store_id,
                title=listing_candidate.title,
            )
            detail_candidate = _fetch_detail_candidate(
                listing_candidate=listing_candidate,
                source_listing_url=source_listing_url,
                browser_fetcher=browser_fetcher if use_browser_fetch else None,
            )
            trace.log(
                "inventory.candidate.detail_fetch.completed",
                source_url=detail_candidate.source_url,
                store_id=detail_candidate.store_id,
                title=detail_candidate.title,
            )
            raise_if_cancelled(cancellation_token)
            item_classifier(detail_candidate)
            trace.log(
                "inventory.candidate.classified",
                category_confidence=detail_candidate.category_confidence,
                is_boardgame=detail_candidate.is_boardgame,
                source_url=detail_candidate.source_url,
                store_id=detail_candidate.store_id,
                title=detail_candidate.title,
            )
            upsert_result = repository.upsert_item_candidate(detail_candidate)
            candidate_id = getattr(upsert_result, "candidate_id", None)
            trace.log(
                "inventory.candidate.upsert.completed",
                candidate_id=candidate_id,
                created=getattr(upsert_result, "created", None),
                should_process=getattr(upsert_result, "should_process", None),
                source_url=detail_candidate.source_url,
                store_id=detail_candidate.store_id,
                title=detail_candidate.title,
            )
            if item_processor is not None and getattr(upsert_result, "should_process", False):
                trace.log(
                    "inventory.candidate.process.start",
                    candidate_id=candidate_id,
                    source_url=detail_candidate.source_url,
                    store_id=detail_candidate.store_id,
                    title=detail_candidate.title,
                )
                try:
                    item_processor.process_candidate(int(getattr(upsert_result, "candidate_id")), detail_candidate)
                except Exception as exc:
                    trace.log(
                        "inventory.candidate.process.failed",
                        candidate_id=candidate_id,
                        error=str(exc),
                        source_url=detail_candidate.source_url,
                        store_id=detail_candidate.store_id,
                        title=detail_candidate.title,
                    )
                    raise
                trace.log(
                    "inventory.candidate.process.completed",
                    candidate_id=candidate_id,
                    source_url=detail_candidate.source_url,
                    store_id=detail_candidate.store_id,
                    title=detail_candidate.title,
                )
            records.append(detail_candidate)
        trace.log("inventory.crawl.completed", record_count=len(records), store_id=store_id, store_url=store_url)
        return records
    finally:
        if browser_session is not None:
            browser_session.__exit__(None, None, None)


def update_confirmed_store_item_details(
    repository: ItemCandidateRepository,
    limit: int | None = None,
    browser_fetch_enabled: bool = False,
    browser_fetcher: Callable[[str], FetchResult | None] | None = None,
    cancellation_token: CancellationToken | None = None,
    job_id: int | None = None,
    run_id: str | None = None,
    store_ids: list[int] | None = None,
) -> StoreItemUpdateRecords:
    raise_if_cancelled(cancellation_token)
    store_platforms = {
        source.store_id: source.platform.strip().casefold()
        for source in repository.list_store_item_discovery_sources(store_ids=store_ids)
    }
    browser_session = None
    if browser_fetch_enabled and browser_fetcher is None:
        from ludora.browser_fetch import BrowserTextFetcher

        browser_session = BrowserTextFetcher()
        browser_fetcher = browser_session.__enter__().fetch

    try:
        records = StoreItemUpdateRecords()
        for existing_record in repository.list_confirmed_boardgame_item_candidates(limit=limit, store_ids=store_ids):
            raise_if_cancelled(cancellation_token)
            try:
                refreshed_record = _fetch_detail_candidate(
                    listing_candidate=existing_record,
                    source_listing_url=existing_record.source_listing_url or existing_record.source_url,
                    platform=store_platforms.get(existing_record.store_id, ""),
                    browser_fetcher=browser_fetcher if browser_fetch_enabled else None,
                    detect_removed=True,
                )
            except ProductPageRemovedError:
                if run_id and job_id is None:
                    raise ValueError("job id is required to log update changes")
                update_result = repository.mark_item_candidate_inactive(
                    existing_record,
                    job_id=job_id,
                    run_id=run_id,
                )
                if getattr(update_result, "changed", False):
                    records.updated_items += 1
                existing_record.store_active = False
                records.append(existing_record)
                continue
            raise_if_cancelled(cancellation_token)
            _preserve_confirmed_item_state(refreshed_record, existing_record)
            if run_id:
                if job_id is None:
                    raise ValueError("job id is required to log update changes")
                update_result = repository.update_item_candidate_with_change_log(
                    existing_record,
                    refreshed_record,
                    job_id=job_id,
                    run_id=run_id,
                )
                if getattr(update_result, "changed", False):
                    records.updated_items += 1
            else:
                update_result = repository.update_item_candidate_price_availability(existing_record, refreshed_record)
                if getattr(update_result, "changed", False):
                    records.updated_items += 1
            records.append(refreshed_record)
        return records
    finally:
        if browser_session is not None:
            browser_session.__exit__(None, None, None)


def _fetch_detail_candidate(
    listing_candidate: DiscoveryItemCandidateRecord,
    source_listing_url: str,
    platform: str = "",
    browser_fetcher: Callable[[str], FetchResult | None] | None = None,
    detect_removed: bool = False,
) -> DiscoveryItemCandidateRecord:
    fetched_detail = _fetch_static_product_detail(
        listing_candidate.source_url,
        detect_removed=detect_removed,
    )
    _raise_if_product_page_removed(fetched_detail, listing_candidate.source_url, detect_removed=detect_removed)
    static_fetch_failed = fetched_detail is None
    if fetched_detail is not None and _looks_like_site_protection_challenge(fetched_detail.text):
        fetched_detail = None
        static_fetch_failed = True

    detail_candidate = (
        _extract_refresh_detail_candidate(
            fetched_detail=fetched_detail,
            listing_candidate=listing_candidate,
            source_listing_url=source_listing_url,
            platform=platform,
        )
        if fetched_detail is not None
        else None
    )

    if browser_fetcher is not None and (
        fetched_detail is None or _should_retry_detail_with_browser(detail_candidate, listing_candidate)
    ):
        fetched_detail = browser_fetcher(listing_candidate.source_url)
        _raise_if_product_page_removed(fetched_detail, listing_candidate.source_url, detect_removed=detect_removed)
        if fetched_detail is not None and fetched_detail.status_code >= 400:
            fetched_detail = None
        if fetched_detail is not None and _looks_like_site_protection_challenge(fetched_detail.text):
            fetched_detail = None
        if fetched_detail is not None:
            browser_detail_candidate = _extract_refresh_detail_candidate(
                fetched_detail=fetched_detail,
                listing_candidate=listing_candidate,
                source_listing_url=source_listing_url,
                platform=platform,
            )
            if browser_detail_candidate is not None:
                detail_candidate = browser_detail_candidate
                static_fetch_failed = False

    if static_fetch_failed and fetched_detail is None:
        raise RuntimeError(f"Failed to fetch product detail page: {listing_candidate.source_url}")

    if detail_candidate is None or _should_retry_detail_with_browser(detail_candidate, listing_candidate):
        listing_candidate.source_listing_url = source_listing_url
        return listing_candidate

    return _apply_listing_fallbacks(detail_candidate, listing_candidate)


def _extract_refresh_detail_candidate(
    *,
    fetched_detail: FetchResult,
    listing_candidate: DiscoveryItemCandidateRecord,
    source_listing_url: str,
    platform: str,
) -> DiscoveryItemCandidateRecord | None:
    if platform.strip().casefold() in AMAZON_STORE_PLATFORMS:
        # Imported lazily because amazon_discovery reuses the repository and processor
        # protocols defined in this module.
        from ludora.amazon_discovery import _extract_amazon_detail_candidate

        return _extract_amazon_detail_candidate(
            html=fetched_detail.text,
            product_url=listing_candidate.source_url,
            store_id=listing_candidate.store_id,
            source_listing_url=source_listing_url,
            search_title=listing_candidate.title,
        )

    return extract_product_detail_candidate(
        html=fetched_detail.text,
        product_url=fetched_detail.url,
        store_id=listing_candidate.store_id,
        source_listing_url=source_listing_url,
    )


def _fetch_static_product_detail(source_url: str, *, detect_removed: bool) -> FetchResult | None:
    if not detect_removed:
        return fetch_html(source_url)

    fetched_detail = fetch_html(source_url, include_http_error_status=True)
    if fetched_detail is None:
        fetched_detail = fetch_html(source_url, include_http_error_status=True)
    return fetched_detail


def _raise_if_product_page_removed(
    fetched_detail: FetchResult | None,
    source_url: str,
    *,
    detect_removed: bool,
) -> None:
    if not detect_removed or fetched_detail is None:
        return
    if fetched_detail.status_code in {404, 410}:
        reason = f"HTTP {fetched_detail.status_code}"
    elif _looks_like_removed_product_page(fetched_detail.text):
        reason = "an explicit not-found page"
    else:
        return
    raise ProductPageRemovedError(f"Product detail page returned {reason}: {source_url}")


def _looks_like_removed_product_page(html: str) -> bool:
    headings = re.findall(r"<(?:title|h1)\b[^>]*>(.*?)</(?:title|h1)>", html, flags=re.IGNORECASE | re.DOTALL)
    normalized_headings = []
    for heading in headings:
        text = re.sub(r"<[^>]+>", " ", unescape(heading))
        normalized = unicodedata.normalize("NFKD", text.casefold()).encode("ascii", "ignore").decode("ascii")
        normalized_headings.append(" ".join(normalized.split()))

    not_found_phrases = (
        "page not found",
        "product not found",
        "pagina no encontrada",
        "producto no encontrado",
        "this page does not exist",
        "esta pagina no existe",
        "product is no longer available",
        "producto ya no esta disponible",
    )
    return any(
        heading in {"404", "410"} or any(phrase in heading for phrase in not_found_phrases)
        for heading in normalized_headings
    )


def _apply_listing_fallbacks(
    detail_candidate: DiscoveryItemCandidateRecord,
    listing_candidate: DiscoveryItemCandidateRecord,
) -> DiscoveryItemCandidateRecord:
    preserve_listing_price = not _is_amazon_without_direct_buy_option(detail_candidate)
    if preserve_listing_price and not detail_candidate.raw_price:
        detail_candidate.raw_price = listing_candidate.raw_price
    if preserve_listing_price and not detail_candidate.price:
        detail_candidate.price = listing_candidate.price
        detail_candidate.price_source = listing_candidate.price_source
    if detail_candidate.availability == "unknown":
        detail_candidate.availability = listing_candidate.availability
        detail_candidate.availability_source = listing_candidate.availability_source
    return detail_candidate


def _is_amazon_without_direct_buy_option(record: DiscoveryItemCandidateRecord) -> bool:
    amazon_payload = record.raw_payload.get("amazon")
    return (
        record.availability == "out_of_stock"
        and isinstance(amazon_payload, dict)
        and amazon_payload.get("has_add_to_cart") is False
        and amazon_payload.get("has_buy_now") is False
    )


def _should_retry_detail_with_browser(
    detail_candidate: DiscoveryItemCandidateRecord | None,
    listing_candidate: DiscoveryItemCandidateRecord,
) -> bool:
    if detail_candidate is None:
        return True

    title = detail_candidate.title.strip()
    if not title:
        return True
    if "website uses cookies" in title.casefold():
        return True

    listing_tokens = _significant_listing_tokens(listing_candidate)
    detail_tokens = _significant_text_tokens(title)
    return bool(listing_tokens and detail_tokens and listing_tokens.isdisjoint(detail_tokens))


def _significant_listing_tokens(listing_candidate: DiscoveryItemCandidateRecord) -> set[str]:
    path_slug = urlparse(listing_candidate.source_url).path.rstrip("/").rsplit("/", 1)[-1]
    return _significant_text_tokens(f"{listing_candidate.title} {path_slug}")


def _significant_text_tokens(value: str) -> set[str]:
    normalized = unicodedata.normalize("NFKD", value.casefold()).encode("ascii", "ignore").decode("ascii")
    ignored = {
        "product",
        "products",
        "producto",
        "productos",
        "tienda",
        "ols",
        "www",
        "com",
        "mx",
        "xn",
        "para",
        "con",
        "the",
    }
    return {token for token in re.findall(r"[a-z0-9]+", normalized) if len(token) >= 3 and token not in ignored}


def _title_from_url(product_url: str) -> str:
    path = urlparse(product_url).path.rstrip("/")
    slug = path.rsplit("/", 1)[-1]
    return " ".join(part for part in slug.replace("-", " ").split() if part)


def _preserve_confirmed_item_state(
    refreshed_record: DiscoveryItemCandidateRecord,
    existing_record: DiscoveryItemCandidateRecord,
) -> None:
    refreshed_record.store_id = existing_record.store_id
    refreshed_record.source_url = existing_record.source_url
    refreshed_record.store_item_id = existing_record.store_item_id
    refreshed_record.item_id = existing_record.item_id
    refreshed_record.listing_status = existing_record.listing_status
    refreshed_record.store_active = existing_record.store_active
    refreshed_record.is_boardgame = True
    refreshed_record.is_boardgame_confirmed = True
    refreshed_record.category_confidence = existing_record.category_confidence
    refreshed_record.classification_reasons = list(existing_record.classification_reasons)
