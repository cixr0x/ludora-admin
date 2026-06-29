from __future__ import annotations

from typing import Protocol

from ludora.cancellation import CancellationToken
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import (
    ItemCandidateProcessor,
    ItemClassifier,
    crawl_store_product_details,
    update_confirmed_store_item_details,
)
from ludora.item_classification import apply_item_classification


class ItemCandidateRepository(Protocol):
    def item_candidate_exists(self, store_id: int | None, source_url: str) -> bool:
        ...

    def upsert_item_candidate(self, record: DiscoveryItemCandidateRecord) -> object | None:
        ...

    def list_confirmed_boardgame_item_candidates(self, limit: int | None = None) -> list[DiscoveryItemCandidateRecord]:
        ...


def collect_store_inventory(
    store_url: str,
    store_id: int | None,
    repository: ItemCandidateRepository,
    limit: int | None = None,
    browser_sitemap_fetch_enabled: bool = False,
    item_classifier: ItemClassifier = apply_item_classification,
    item_processor: ItemCandidateProcessor | None = None,
    cancellation_token: CancellationToken | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    return crawl_store_product_details(
        store_url,
        store_id,
        repository,
        limit=limit,
        browser_sitemap_fetch_enabled=browser_sitemap_fetch_enabled,
        item_classifier=item_classifier,
        item_processor=item_processor,
        cancellation_token=cancellation_token,
    )


def update_confirmed_store_items(
    repository: ItemCandidateRepository,
    limit: int | None = None,
    browser_fetch_enabled: bool = False,
    cancellation_token: CancellationToken | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    return update_confirmed_store_item_details(
        repository,
        limit=limit,
        browser_fetch_enabled=browser_fetch_enabled,
        cancellation_token=cancellation_token,
    )
