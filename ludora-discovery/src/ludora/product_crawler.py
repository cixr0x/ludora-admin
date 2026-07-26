from __future__ import annotations

import random
import re
import unicodedata
from collections.abc import Callable, Collection, Mapping
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
from ludora.webfetch import (
    TRANSIENT_FETCH_STATUS_CODES,
    FetchResult,
    HostThrottleWait,
    PerHostRequestThrottle,
    fetch_html,
    fetch_with_transient_retries,
)


AMAZON_STORE_PLATFORMS = {"amazon", "amazon_brand"}
SHOPIFY_STORE_PLATFORMS = {"shopify"}
SHOPIFY_UPDATE_MIN_INTERVAL_SECONDS = 2.0
SHOPIFY_UPDATE_JITTER_SECONDS = 1.0
SHOPIFY_UPDATE_FALLBACK_COOLDOWN_SECONDS = 30.0
ASCII_LIGATURE_TRANSLATION = str.maketrans({"æ": "ae", "œ": "oe", "ß": "ss"})
GENERIC_TITLE_MATCH_TOKENS = {
    "base",
    "board",
    "card",
    "cards",
    "combo",
    "edicion",
    "edition",
    "expansion",
    "game",
    "juego",
    "pack",
    "standard",
}


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
        include_title: bool = True,
    ) -> object | None:
        ...

    def update_item_candidate_price_availability(
        self,
        existing_record: DiscoveryItemCandidateRecord,
        refreshed_record: DiscoveryItemCandidateRecord,
        *,
        include_title: bool = True,
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

    def update_store_item_update_progress(
        self,
        *,
        job_id: int,
        scanned_items: int,
        updated_items: int,
    ) -> None:
        ...


class ItemCandidateProcessor(Protocol):
    def process_candidate(self, candidate_id: int, record: DiscoveryItemCandidateRecord) -> None:
        ...


ItemClassifier = Callable[[DiscoveryItemCandidateRecord], DiscoveryItemCandidateRecord]
ItemTitleExtractor = Callable[[DiscoveryItemCandidateRecord], str]
ItemCandidateEnricher = Callable[
    [DiscoveryItemCandidateRecord, DiscoveryItemCandidateRecord],
    DiscoveryItemCandidateRecord,
]


class ProductPageRemovedError(RuntimeError):
    pass


class TransientProductFetchError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        retry_after_seconds: float | None = None,
        status_code: int | None = None,
    ):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds
        self.status_code = status_code


class ProductDetailRejectedError(RuntimeError):
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
            trace_logger=trace,
            cancellation_token=cancellation_token,
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
            fetched_listing = fetch_with_transient_retries(
                store_url,
                lambda url: fetch_html(url, include_http_error_status=True),
                trace_event="inventory.listing_fetch.http_error",
                trace_logger=trace,
                trace_fields={"fetch_method": "static", "store_id": store_id},
                cancellation_token=cancellation_token,
            )
            listing_failure_status_code = (
                fetched_listing.status_code
                if fetched_listing is not None and fetched_listing.status_code >= 400
                else None
            )
            if listing_failure_status_code is not None:
                fetched_listing = None
            if fetched_listing is None:
                status_suffix = (
                    f" (HTTP {listing_failure_status_code})" if listing_failure_status_code is not None else ""
                )
                raise RuntimeError(f"Failed to fetch store listing page: {store_url}{status_suffix}")
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

        records = crawl_listing_candidates(
            listing_candidates,
            repository,
            source_listing_url=source_listing_url,
            browser_fetcher=browser_fetcher if use_browser_fetch else None,
            item_classifier=item_classifier,
            item_processor=item_processor,
            trace_logger=trace,
            cancellation_token=cancellation_token,
        )
        trace.log("inventory.crawl.completed", record_count=len(records), store_id=store_id, store_url=store_url)
        return records
    finally:
        if browser_session is not None:
            browser_session.__exit__(None, None, None)


def crawl_listing_candidates(
    listing_candidates: list[DiscoveryItemCandidateRecord],
    repository: ItemCandidateRepository,
    *,
    source_listing_url: str,
    browser_fetcher: Callable[[str], FetchResult | None] | None = None,
    item_classifier: ItemClassifier = apply_item_classification,
    item_processor: ItemCandidateProcessor | None = None,
    item_candidate_enricher: ItemCandidateEnricher | None = None,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    trace = trace_logger or NullTraceLogger()
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
        try:
            detail_candidate = _fetch_detail_candidate(
                listing_candidate=listing_candidate,
                source_listing_url=listing_candidate.source_listing_url or source_listing_url,
                browser_fetcher=browser_fetcher,
                trace_logger=trace,
                cancellation_token=cancellation_token,
            )
        except ProductDetailRejectedError:
            continue
        if item_candidate_enricher is not None:
            detail_candidate = item_candidate_enricher(detail_candidate, listing_candidate)
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
    return records


def update_confirmed_store_item_details(
    repository: ItemCandidateRepository,
    limit: int | None = None,
    browser_fetch_enabled: bool = False,
    browser_fetcher: Callable[[str], FetchResult | None] | None = None,
    cancellation_token: CancellationToken | None = None,
    job_id: int | None = None,
    run_id: str | None = None,
    store_ids: list[int] | None = None,
    item_title_extractor: ItemTitleExtractor | None = None,
    trace_logger: TraceLogger | None = None,
    shopify_throttle: PerHostRequestThrottle | None = None,
) -> StoreItemUpdateRecords:
    raise_if_cancelled(cancellation_token)
    trace = trace_logger or NullTraceLogger()
    store_sources = repository.list_store_item_discovery_sources(store_ids=store_ids)
    store_platforms = {
        source.store_id: source.platform.strip().casefold()
        for source in store_sources
    }
    store_names = {
        source.store_id: str(getattr(source, "store_name", "")).strip() or f"Store {source.store_id}"
        for source in store_sources
    }
    resolved_shopify_throttle = shopify_throttle or PerHostRequestThrottle(
        minimum_interval_seconds=SHOPIFY_UPDATE_MIN_INTERVAL_SECONDS,
        jitter_seconds=SHOPIFY_UPDATE_JITTER_SECONDS,
        fallback_cooldown_seconds=SHOPIFY_UPDATE_FALLBACK_COOLDOWN_SECONDS,
    )
    browser_session = None
    if browser_fetch_enabled and browser_fetcher is None:
        from ludora.browser_fetch import BrowserTextFetcher

        browser_session = BrowserTextFetcher(trace_logger=trace)
        browser_fetcher = browser_session.__enter__().fetch

    try:
        records = StoreItemUpdateRecords()
        update_candidates = list(
            repository.list_confirmed_boardgame_item_candidates(limit=limit, store_ids=store_ids)
        )
        trace.log(
            "item_update.candidates.loaded",
            browser_fetch_enabled=browser_fetch_enabled,
            candidate_count=len(update_candidates),
            message=f"Loaded {len(update_candidates)} store items to update",
            selected_store_ids=store_ids or [],
        )
        # The repository returns candidates oldest-first by refreshed_date. Keep
        # the older half ahead of the newer half while varying order within each.
        older_pool_size = (len(update_candidates) + 1) // 2
        older_candidates = update_candidates[:older_pool_size]
        newer_candidates = update_candidates[older_pool_size:]
        random.shuffle(older_candidates)
        random.shuffle(newer_candidates)
        update_candidates = [*older_candidates, *newer_candidates]
        trace.log(
            "item_update.pools.prepared",
            message=(
                f"Prepared normal update pool with {len(older_candidates)} older and "
                f"{len(newer_candidates)} newer items"
            ),
            newer_items=len(newer_candidates),
            older_items=len(older_candidates),
            total_items=len(update_candidates),
        )

        cooldown_candidates: list[DiscoveryItemCandidateRecord] = []
        retry_candidates: list[DiscoveryItemCandidateRecord] = []
        # Later pool entries reference lists populated during the earlier passes.
        candidate_pools = (
            ("normal", update_candidates, True),
            ("cooldown", cooldown_candidates, True),
            ("retry", retry_candidates, False),
        )
        for pool_name, candidate_pool, defer_transient_failures in candidate_pools:
            trace.log(
                "item_update.pool.started",
                item_count=len(candidate_pool),
                message=f"Starting {pool_name} pool with {len(candidate_pool)} items",
                pool=pool_name,
            )
            for item_index, existing_record in enumerate(candidate_pool, start=1):
                raise_if_cancelled(cancellation_token)
                platform = store_platforms.get(existing_record.store_id, "").strip().casefold()
                item_trace_fields = _store_item_trace_fields(
                    existing_record,
                    platform=platform,
                    store_name=store_names.get(existing_record.store_id, f"Store {existing_record.store_id}"),
                    pool=pool_name,
                    pool_item_count=len(candidate_pool),
                    pool_item_index=item_index,
                )
                if platform in SHOPIFY_STORE_PLATFORMS and pool_name == "normal":
                    cooldown_remaining = resolved_shopify_throttle.cooldown_remaining(existing_record.source_url)
                    if cooldown_remaining > 0.0:
                        cooldown_candidates.append(existing_record)
                        trace.log(
                            "item_update.item.cooldown.deferred",
                            **item_trace_fields,
                            cooldown_remaining_seconds=cooldown_remaining,
                            cooldown_pool_size=len(cooldown_candidates),
                            message=(
                                f"Shopify host is cooling down for {cooldown_remaining:g} more seconds; "
                                "processing other stores first"
                            ),
                        )
                        continue
                request_waiter: Callable[[str], None] | None = None
                if platform in SHOPIFY_STORE_PLATFORMS:
                    request_waiter = lambda url: _wait_for_shopify_update_request(
                        resolved_shopify_throttle,
                        url,
                        trace=trace,
                        trace_fields=item_trace_fields,
                        cancellation_token=cancellation_token,
                    )
                trace.log(
                    "item_update.item.fetch.started",
                    **item_trace_fields,
                    message=(
                        f"Fetching product {existing_record.title or existing_record.source_url} "
                        f"from {item_trace_fields['store_name']}"
                    ),
                )
                try:
                    refreshed_record = _fetch_detail_candidate(
                        listing_candidate=existing_record,
                        source_listing_url=existing_record.source_listing_url or existing_record.source_url,
                        platform=platform,
                        browser_fetcher=browser_fetcher if browser_fetch_enabled else None,
                        detect_removed=True,
                        trace_logger=trace,
                        cancellation_token=cancellation_token,
                        before_request=request_waiter,
                    )
                except TransientProductFetchError as exc:
                    if platform in SHOPIFY_STORE_PLATFORMS and exc.status_code == 429:
                        cooldown_seconds = resolved_shopify_throttle.start_cooldown(
                            existing_record.source_url,
                            exc.retry_after_seconds,
                        )
                        trace.log(
                            "item_update.store.cooldown.started",
                            **item_trace_fields,
                            cooldown_seconds=cooldown_seconds,
                            message=(
                                f"Shopify returned HTTP 429; cooling down the host for "
                                f"{cooldown_seconds:g} seconds"
                            ),
                            retry_after_seconds=exc.retry_after_seconds,
                            status_code=exc.status_code,
                        )
                    if not defer_transient_failures:
                        trace.log(
                            "item_update.item.failed",
                            **item_trace_fields,
                            error=str(exc),
                            error_type=type(exc).__name__,
                            message=f"Product update failed in retry pool: {exc}",
                        )
                        raise
                    retry_candidates.append(existing_record)
                    trace.log(
                        "item_update.item.deferred",
                        **item_trace_fields,
                        error=str(exc),
                        error_type=type(exc).__name__,
                        message=(
                            "Shopify rate limited the product; it was moved to the retry pool "
                            "without blocking other stores"
                            if exc.status_code == 429
                            else "Product failed after fetch retries and was moved to the retry pool"
                        ),
                        retry_pool_size=len(retry_candidates),
                        status_code=exc.status_code,
                    )
                    continue
                except ProductPageRemovedError as exc:
                    if run_id and job_id is None:
                        raise ValueError("job id is required to log update changes")
                    trace.log(
                        "item_update.item.removed",
                        **item_trace_fields,
                        message=f"Product page was removed; marking the store item inactive: {exc}",
                        reason=str(exc),
                    )
                    update_result = repository.mark_item_candidate_inactive(
                        existing_record,
                        job_id=job_id,
                        run_id=run_id,
                    )
                    if getattr(update_result, "changed", False):
                        records.updated_items += 1
                    existing_record.store_active = False
                    records.append(existing_record)
                    _persist_store_item_update_progress(repository, job_id, records)
                    trace.log(
                        "item_update.item.completed",
                        **item_trace_fields,
                        changed=bool(getattr(update_result, "changed", False)),
                        message="Store item marked inactive",
                        scanned_items=len(records),
                        updated_items=records.updated_items,
                    )
                    continue
                except Exception as exc:
                    trace.log(
                        "item_update.item.failed",
                        **item_trace_fields,
                        error=str(exc),
                        error_type=type(exc).__name__,
                        message=f"Product update failed: {exc}",
                    )
                    raise
                raise_if_cancelled(cancellation_token)
                try:
                    _prepare_refreshed_titles(
                        existing_record,
                        refreshed_record,
                        platform=platform,
                        item_title_extractor=item_title_extractor,
                    )
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
                        update_result = repository.update_item_candidate_price_availability(
                            existing_record,
                            refreshed_record,
                        )
                        if getattr(update_result, "changed", False):
                            records.updated_items += 1
                    records.append(refreshed_record)
                    _persist_store_item_update_progress(repository, job_id, records)
                except Exception as exc:
                    trace.log(
                        "item_update.item.failed",
                        **item_trace_fields,
                        error=str(exc),
                        error_type=type(exc).__name__,
                        message=f"Product update failed while processing or persisting details: {exc}",
                    )
                    raise
                trace.log(
                    "item_update.item.completed",
                    **item_trace_fields,
                    changed=bool(getattr(update_result, "changed", False)),
                    message=(
                        "Store item updated"
                        if getattr(update_result, "changed", False)
                        else "Store item checked; no tracked values changed"
                    ),
                    original_title=refreshed_record.original_title,
                    resolved_title=refreshed_record.title,
                    scanned_items=len(records),
                    updated_items=records.updated_items,
                )
            trace.log(
                "item_update.pool.completed",
                item_count=len(candidate_pool),
                message=f"Completed {pool_name} pool",
                pool=pool_name,
                cooldown_pool_size=len(cooldown_candidates),
                retry_pool_size=len(retry_candidates),
                scanned_items=len(records),
                updated_items=records.updated_items,
            )
        return records
    finally:
        if browser_session is not None:
            browser_session.__exit__(None, None, None)


def _persist_store_item_update_progress(
    repository: ItemCandidateRepository,
    job_id: int | None,
    records: StoreItemUpdateRecords,
) -> None:
    if job_id is None:
        return
    repository.update_store_item_update_progress(
        job_id=job_id,
        scanned_items=len(records),
        updated_items=records.updated_items,
    )


def _wait_for_shopify_update_request(
    throttle: PerHostRequestThrottle,
    source_url: str,
    *,
    trace: TraceLogger,
    trace_fields: Mapping[str, object],
    cancellation_token: CancellationToken | None,
) -> None:
    def log_wait(wait: HostThrottleWait) -> None:
        wait_label = "rate-limit cooldown" if wait.reason == "cooldown" else "request pacing"
        trace.log(
            "item_update.store.throttle.wait",
            **dict(trace_fields),
            host=wait.host,
            message=f"Waiting {wait.delay_seconds:g} seconds for Shopify {wait_label}",
            reason=wait.reason,
            wait_seconds=wait.delay_seconds,
        )

    throttle.wait_before_request(
        source_url,
        cancellation_token,
        on_wait=log_wait,
    )


def _fetch_detail_candidate(
    listing_candidate: DiscoveryItemCandidateRecord,
    source_listing_url: str,
    platform: str = "",
    browser_fetcher: Callable[[str], FetchResult | None] | None = None,
    detect_removed: bool = False,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
    before_request: Callable[[str], None] | None = None,
) -> DiscoveryItemCandidateRecord:
    trace = trace_logger or NullTraceLogger()
    amazon_detail_request = platform.strip().casefold() in AMAZON_STORE_PLATFORMS
    shopify_update_request = detect_removed and platform.strip().casefold() in SHOPIFY_STORE_PLATFORMS
    amazon_detail_validation_failed = False
    fetched_detail = _fetch_static_product_detail(
        listing_candidate.source_url,
        detect_removed=detect_removed,
        trace_logger=trace,
        trace_fields=(
            {
                "platform": platform,
                "store_id": listing_candidate.store_id,
                "store_item_id": listing_candidate.store_item_id,
                "store_item_title": listing_candidate.title,
            }
            if detect_removed
            else None
        ),
        cancellation_token=cancellation_token,
        before_request=before_request,
        immediate_return_status_codes={429} if shopify_update_request else (),
    )
    _raise_if_product_page_removed(fetched_detail, listing_candidate.source_url, detect_removed=detect_removed)
    last_failure_status_code = (
        fetched_detail.status_code if fetched_detail is not None and fetched_detail.status_code >= 400 else None
    )
    last_failure_retry_after_seconds = (
        fetched_detail.retry_after_seconds if last_failure_status_code is not None and fetched_detail is not None else None
    )
    explicitly_throttled = shopify_update_request and last_failure_status_code == 429
    static_fetch_failed = fetched_detail is None or last_failure_status_code is not None
    if last_failure_status_code is not None:
        fetched_detail = None
    if fetched_detail is not None and _looks_like_site_protection_challenge(fetched_detail.text):
        fetched_detail = None
        static_fetch_failed = True
    if fetched_detail is not None and amazon_detail_request and not _validate_amazon_detail_fetch(
        fetched_detail,
        listing_candidate.source_url,
        fetch_method="static",
        trace=trace,
    ):
        fetched_detail = None
        static_fetch_failed = True
        amazon_detail_validation_failed = True

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

    if browser_fetcher is not None and not explicitly_throttled and (
        fetched_detail is None or _should_retry_detail_with_browser(detail_candidate, listing_candidate, platform=platform)
    ):
        trace.log(
            "item_update.item.browser_fetch.started" if detect_removed else "inventory.candidate.browser_fetch.started",
            message="Retrying product detail with browser rendering",
            platform=platform,
            source_url=listing_candidate.source_url,
            store_id=listing_candidate.store_id,
            store_item_id=listing_candidate.store_item_id,
        )
        if before_request is not None:
            before_request(listing_candidate.source_url)
        fetched_detail = browser_fetcher(listing_candidate.source_url)
        _raise_if_product_page_removed(fetched_detail, listing_candidate.source_url, detect_removed=detect_removed)
        if fetched_detail is not None and fetched_detail.status_code >= 400:
            last_failure_status_code = fetched_detail.status_code
            last_failure_retry_after_seconds = fetched_detail.retry_after_seconds
            trace.log(
                "inventory.candidate.detail_fetch.http_error",
                attempt=1,
                fetch_method="browser",
                max_attempts=1,
                retry_after_seconds=fetched_detail.retry_after_seconds,
                retry_in_seconds=0.0,
                source_url=listing_candidate.source_url,
                status_code=fetched_detail.status_code,
                will_retry=False,
            )
            fetched_detail = None
        if fetched_detail is not None and _looks_like_site_protection_challenge(fetched_detail.text):
            fetched_detail = None
        if fetched_detail is not None and amazon_detail_request and not _validate_amazon_detail_fetch(
            fetched_detail,
            listing_candidate.source_url,
            fetch_method="browser",
            trace=trace,
        ):
            fetched_detail = None
            amazon_detail_validation_failed = True
        if fetched_detail is not None:
            trace.log(
                "item_update.item.browser_fetch.completed"
                if detect_removed
                else "inventory.candidate.browser_fetch.completed",
                final_url=fetched_detail.url,
                message="Browser-rendered product detail fetched successfully",
                source_url=listing_candidate.source_url,
                status_code=fetched_detail.status_code,
                store_id=listing_candidate.store_id,
                store_item_id=listing_candidate.store_item_id,
            )
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
        status_suffix = f" (HTTP {last_failure_status_code})" if last_failure_status_code is not None else ""
        if last_failure_status_code in TRANSIENT_FETCH_STATUS_CODES or amazon_detail_validation_failed:
            raise TransientProductFetchError(
                f"Failed to fetch product detail page: {listing_candidate.source_url}{status_suffix}",
                retry_after_seconds=last_failure_retry_after_seconds,
                status_code=last_failure_status_code,
            )
        raise RuntimeError(f"Failed to fetch product detail page: {listing_candidate.source_url}{status_suffix}")

    if detail_candidate is None:
        listing_candidate.source_listing_url = source_listing_url
        return listing_candidate

    rejection_reason = _detail_rejection_reason(detail_candidate, listing_candidate, platform=platform)
    if rejection_reason:
        trace.log(
            "item_update.item.detail.rejected"
            if detect_removed
            else "inventory.candidate.detail_fetch.rejected",
            detail_sku=detail_candidate.store_sku,
            detail_title=detail_candidate.title,
            listing_sku=listing_candidate.store_sku,
            listing_title=listing_candidate.title,
            message=f"Parsed product detail was rejected: {rejection_reason}",
            reason=rejection_reason,
            source_url=listing_candidate.source_url,
        )
        raise ProductDetailRejectedError(
            f"Parsed product detail rejected ({rejection_reason}): {listing_candidate.source_url}"
        )

    return _apply_listing_fallbacks(detail_candidate, listing_candidate)


def _validate_amazon_detail_fetch(
    fetched_detail: FetchResult,
    source_url: str,
    *,
    fetch_method: str,
    trace: TraceLogger,
) -> bool:
    # Imported lazily because amazon_discovery imports the repository and
    # processor protocols defined in this module.
    from ludora.amazon_discovery import _amazon_detail_page_diagnostics, _asin_from_url

    diagnostics = _amazon_detail_page_diagnostics(
        fetched_detail,
        expected_asin=_asin_from_url(source_url),
    )
    if diagnostics["valid"]:
        return True

    trace.log(
        "inventory.candidate.detail_fetch.invalid",
        fetch_method=fetch_method,
        source_url=source_url,
        **{key: value for key, value in diagnostics.items() if key != "valid"},
    )
    return False


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


def _fetch_static_product_detail(
    source_url: str,
    *,
    detect_removed: bool,
    trace_logger: TraceLogger | None = None,
    trace_fields: Mapping[str, object] | None = None,
    cancellation_token: CancellationToken | None = None,
    before_request: Callable[[str], None] | None = None,
    immediate_return_status_codes: Collection[int] = (),
) -> FetchResult | None:
    resolved_trace_fields = {"fetch_method": "static", **dict(trace_fields or {})}

    def fetch_detail(url: str) -> FetchResult | None:
        if before_request is not None:
            before_request(url)
        return fetch_html(url, include_http_error_status=True)

    return fetch_with_transient_retries(
        source_url,
        fetch_detail,
        trace_event=(
            "item_update.item.fetch.http_error"
            if detect_removed
            else "inventory.candidate.detail_fetch.http_error"
        ),
        trace_logger=trace_logger,
        trace_fields=resolved_trace_fields,
        cancellation_token=cancellation_token,
        ambiguous_failure_attempts=2 if detect_removed else 1,
        trace_attempts=detect_removed,
        immediate_return_status_codes=immediate_return_status_codes,
    )


def _store_item_trace_fields(
    record: DiscoveryItemCandidateRecord,
    *,
    platform: str,
    store_name: str,
    pool: str,
    pool_item_count: int,
    pool_item_index: int,
) -> dict[str, object]:
    return {
        "platform": platform,
        "pool": pool,
        "pool_item_count": pool_item_count,
        "pool_item_index": pool_item_index,
        "source_url": record.source_url,
        "store_id": record.store_id,
        "store_item_id": record.store_item_id,
        "store_item_title": record.title,
        "store_name": store_name,
    }


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
        normalized = _normalize_ascii_text(text)
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
    *,
    platform: str = "",
) -> bool:
    return bool(_detail_rejection_reason(detail_candidate, listing_candidate, platform=platform))


def _detail_rejection_reason(
    detail_candidate: DiscoveryItemCandidateRecord | None,
    listing_candidate: DiscoveryItemCandidateRecord,
    *,
    platform: str = "",
) -> str:
    if detail_candidate is None:
        return "missing_detail_candidate"

    title = detail_candidate.title.strip()
    if not title:
        return "missing_detail_title"
    if "website uses cookies" in title.casefold():
        return "cookie_consent_title"

    listing_sku = listing_candidate.store_sku.strip().casefold()
    detail_sku = detail_candidate.store_sku.strip().casefold()
    normalized_platform = platform.strip().casefold()
    identity_sku = listing_sku
    if normalized_platform in AMAZON_STORE_PLATFORMS and not identity_sku:
        # Amazon fetch validation already requires the ASIN from the requested URL
        # to be present in the returned page. Reuse it for title-independent identity.
        from ludora.amazon_discovery import _asin_from_url

        identity_sku = _asin_from_url(listing_candidate.source_url).casefold()

    if identity_sku and detail_sku and identity_sku != detail_sku:
        return "store_sku_mismatch"
    if (
        normalized_platform in AMAZON_STORE_PLATFORMS
        and identity_sku
        and detail_sku
        and identity_sku == detail_sku
    ):
        return ""

    listing_tokens = _significant_listing_tokens(listing_candidate)
    detail_tokens = _significant_text_tokens(title)
    if not listing_tokens or not detail_tokens:
        return ""
    meaningful_overlap = (listing_tokens & detail_tokens) - GENERIC_TITLE_MATCH_TOKENS
    return "title_mismatch" if not meaningful_overlap else ""


def _significant_listing_tokens(listing_candidate: DiscoveryItemCandidateRecord) -> set[str]:
    path_slug = urlparse(listing_candidate.source_url).path.rstrip("/").rsplit("/", 1)[-1]
    source_title = listing_candidate.original_title or listing_candidate.title
    return _significant_text_tokens(f"{source_title} {path_slug}")


def _significant_text_tokens(value: str) -> set[str]:
    normalized = _normalize_ascii_text(value)
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


def _normalize_ascii_text(value: str) -> str:
    casefolded = value.casefold().translate(ASCII_LIGATURE_TRANSLATION)
    return unicodedata.normalize("NFKD", casefolded).encode("ascii", "ignore").decode("ascii")


def _title_from_url(product_url: str) -> str:
    path = urlparse(product_url).path.rstrip("/")
    slug = path.rsplit("/", 1)[-1]
    return " ".join(part for part in slug.replace("-", " ").split() if part)


def _prepare_refreshed_titles(
    existing_record: DiscoveryItemCandidateRecord,
    refreshed_record: DiscoveryItemCandidateRecord,
    *,
    platform: str,
    item_title_extractor: ItemTitleExtractor | None,
) -> None:
    source_title = (refreshed_record.original_title or refreshed_record.title).strip()
    existing_source_title = (existing_record.original_title or existing_record.title).strip()
    refreshed_record.original_title = source_title

    if source_title == existing_source_title:
        refreshed_record.title = existing_record.title
        return

    if platform.strip().casefold() not in AMAZON_STORE_PLATFORMS:
        refreshed_record.title = source_title
        return

    if item_title_extractor is None:
        raise RuntimeError("Amazon title extractor is required when the original product title changes")

    # Imported lazily because amazon_discovery imports the protocols in this module.
    from ludora.amazon_discovery import _apply_item_title_extractor

    refreshed_record.title = source_title
    _apply_item_title_extractor(refreshed_record, item_title_extractor)


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
