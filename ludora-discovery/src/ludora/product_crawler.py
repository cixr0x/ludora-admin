from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from typing import Protocol
from urllib.parse import urljoin, urlparse

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.item_classification import apply_item_classification
from ludora.listing_extraction import extract_listing_candidates
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_detail_extraction import extract_product_detail_candidate
from ludora.sitemap_discovery import _looks_like_site_protection_challenge, discover_product_urls_from_sitemaps
from ludora.webfetch import FetchResult
from ludora.webfetch import fetch_html


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

    def update_item_candidate_with_change_log(
        self,
        existing_record: DiscoveryItemCandidateRecord,
        refreshed_record: DiscoveryItemCandidateRecord,
        *,
        job_id: int,
        run_id: str,
    ) -> object | None:
        ...


class ItemCandidateProcessor(Protocol):
    def process_candidate(self, candidate_id: int, record: DiscoveryItemCandidateRecord) -> None:
        ...


ItemClassifier = Callable[[DiscoveryItemCandidateRecord], DiscoveryItemCandidateRecord]


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
    cancellation_token: CancellationToken | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    raise_if_cancelled(cancellation_token)
    use_browser_fetch = browser_sitemap_fetch_enabled if browser_fetch_enabled is None else browser_fetch_enabled
    browser_session = None
    if use_browser_fetch and browser_fetcher is None:
        from ludora.browser_fetch import BrowserTextFetcher

        browser_session = BrowserTextFetcher()
        browser_fetcher = browser_session.__enter__().fetch

    try:
        product_urls = discover_product_urls_from_sitemaps(
            store_url,
            browser_fetcher=browser_fetcher,
            browser_fallback_enabled=use_browser_fetch,
            limit=limit,
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
            fetched_listing = fetch_html(store_url)
            if fetched_listing is None:
                return []

            source_listing_url = fetched_listing.url
            listing_candidates = extract_listing_candidates(
                html=fetched_listing.text,
                page_url=fetched_listing.url,
                store_id=store_id,
                limit=limit,
            )

        records: list[DiscoveryItemCandidateRecord] = []
        for listing_candidate in listing_candidates:
            raise_if_cancelled(cancellation_token)
            if repository.item_candidate_exists(listing_candidate.store_id, listing_candidate.source_url):
                continue

            detail_candidate = _fetch_detail_candidate(
                listing_candidate=listing_candidate,
                source_listing_url=source_listing_url,
                browser_fetcher=browser_fetcher if use_browser_fetch else None,
            )
            raise_if_cancelled(cancellation_token)
            item_classifier(detail_candidate)
            upsert_result = repository.upsert_item_candidate(detail_candidate)
            if item_processor is not None and getattr(upsert_result, "should_process", False):
                item_processor.process_candidate(int(getattr(upsert_result, "candidate_id")), detail_candidate)
            records.append(detail_candidate)
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
    browser_session = None
    if browser_fetch_enabled and browser_fetcher is None:
        from ludora.browser_fetch import BrowserTextFetcher

        browser_session = BrowserTextFetcher()
        browser_fetcher = browser_session.__enter__().fetch

    try:
        records = StoreItemUpdateRecords()
        for existing_record in repository.list_confirmed_boardgame_item_candidates(limit=limit, store_ids=store_ids):
            raise_if_cancelled(cancellation_token)
            refreshed_record = _fetch_detail_candidate(
                listing_candidate=existing_record,
                source_listing_url=existing_record.source_listing_url or existing_record.source_url,
                browser_fetcher=browser_fetcher if browser_fetch_enabled else None,
            )
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
                repository.upsert_item_candidate(refreshed_record)
            records.append(refreshed_record)
        return records
    finally:
        if browser_session is not None:
            browser_session.__exit__(None, None, None)


def _fetch_detail_candidate(
    listing_candidate: DiscoveryItemCandidateRecord,
    source_listing_url: str,
    browser_fetcher: Callable[[str], FetchResult | None] | None = None,
) -> DiscoveryItemCandidateRecord:
    fetched_detail = fetch_html(listing_candidate.source_url)
    if fetched_detail is not None and _looks_like_site_protection_challenge(fetched_detail.text):
        fetched_detail = None

    detail_candidate = (
        extract_product_detail_candidate(
            html=fetched_detail.text,
            product_url=fetched_detail.url,
            store_id=listing_candidate.store_id,
            source_listing_url=source_listing_url,
        )
        if fetched_detail is not None
        else None
    )

    if browser_fetcher is not None and (
        fetched_detail is None or _should_retry_detail_with_browser(detail_candidate, listing_candidate)
    ):
        fetched_detail = browser_fetcher(listing_candidate.source_url)
        if fetched_detail is not None and _looks_like_site_protection_challenge(fetched_detail.text):
            fetched_detail = None
        if fetched_detail is not None:
            browser_detail_candidate = extract_product_detail_candidate(
                html=fetched_detail.text,
                product_url=fetched_detail.url,
                store_id=listing_candidate.store_id,
                source_listing_url=source_listing_url,
            )
            if browser_detail_candidate is not None:
                detail_candidate = browser_detail_candidate

    if detail_candidate is None or _should_retry_detail_with_browser(detail_candidate, listing_candidate):
        listing_candidate.source_listing_url = source_listing_url
        return listing_candidate

    return _apply_listing_fallbacks(detail_candidate, listing_candidate)


def _apply_listing_fallbacks(
    detail_candidate: DiscoveryItemCandidateRecord,
    listing_candidate: DiscoveryItemCandidateRecord,
) -> DiscoveryItemCandidateRecord:
    if not detail_candidate.raw_price:
        detail_candidate.raw_price = listing_candidate.raw_price
    if not detail_candidate.price:
        detail_candidate.price = listing_candidate.price
        detail_candidate.price_source = listing_candidate.price_source
    if detail_candidate.availability == "unknown":
        detail_candidate.availability = listing_candidate.availability
        detail_candidate.availability_source = listing_candidate.availability_source
    return detail_candidate


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
    refreshed_record.is_boardgame = True
    refreshed_record.is_boardgame_confirmed = True
    refreshed_record.category_confidence = existing_record.category_confidence
    refreshed_record.classification_reasons = list(existing_record.classification_reasons)
