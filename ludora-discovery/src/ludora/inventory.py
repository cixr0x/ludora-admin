from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from ludora.cancellation import CancellationToken
from ludora.models import DiscoveryItemCandidateRecord
from ludora.amazon_discovery import crawl_amazon_brand_inventory, crawl_amazon_store_inventory
from ludora.product_crawler import (
    ItemCandidateProcessor,
    ItemClassifier,
    crawl_store_product_details,
    update_confirmed_store_item_details,
)
from ludora.item_classification import apply_item_classification
from ludora.trace import TraceLogger


BROWSER_FETCH_REQUIRED_PLATFORMS = {
    "godaddy_website_builder",
}


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
        include_title: bool = True,
    ) -> object | None:
        ...


def collect_store_inventory(
    store_url: str,
    store_id: int | None,
    repository: ItemCandidateRepository,
    limit: int | None = None,
    browser_sitemap_fetch_enabled: bool = False,
    item_classifier: ItemClassifier = apply_item_classification,
    item_processor: ItemCandidateProcessor | None = None,
    item_title_extractor: Callable[[DiscoveryItemCandidateRecord], str] | None = None,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
    platform: str = "",
    store_name: str = "",
) -> list[DiscoveryItemCandidateRecord]:
    normalized_platform = platform.strip().casefold()
    browser_fetch_enabled = browser_sitemap_fetch_enabled or normalized_platform in BROWSER_FETCH_REQUIRED_PLATFORMS
    if normalized_platform == "amazon":
        return crawl_amazon_store_inventory(
            store_url,
            store_id,
            repository,
            limit=limit,
            item_classifier=item_classifier,
            item_processor=item_processor,
            item_title_extractor=item_title_extractor,
            trace_logger=trace_logger,
            cancellation_token=cancellation_token,
        )
    if normalized_platform == "amazon_brand":
        return crawl_amazon_brand_inventory(
            store_url,
            store_id,
            repository,
            limit=limit,
            brand_name=store_name,
            item_classifier=item_classifier,
            item_processor=item_processor,
            item_title_extractor=item_title_extractor,
            trace_logger=trace_logger,
            cancellation_token=cancellation_token,
        )

    return crawl_store_product_details(
        store_url,
        store_id,
        repository,
        limit=limit,
        browser_sitemap_fetch_enabled=browser_fetch_enabled,
        item_classifier=item_classifier,
        item_processor=item_processor,
        trace_logger=trace_logger,
        cancellation_token=cancellation_token,
    )


def update_confirmed_store_items(
    repository: ItemCandidateRepository,
    limit: int | None = None,
    browser_fetch_enabled: bool = False,
    cancellation_token: CancellationToken | None = None,
    job_id: int | None = None,
    run_id: str | None = None,
    store_ids: list[int] | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    return update_confirmed_store_item_details(
        repository,
        limit=limit,
        browser_fetch_enabled=browser_fetch_enabled,
        cancellation_token=cancellation_token,
        job_id=job_id,
        run_id=run_id,
        store_ids=store_ids,
    )
