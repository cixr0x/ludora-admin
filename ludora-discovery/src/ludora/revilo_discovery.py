"""URL-only enumeration of Revilo's complete PrestaShop catalog and sitemap aliases."""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping

from ludora.cancellation import CancellationToken
from ludora.listing_extraction import is_revilo_store_url, revilo_product_id
from ludora.prestashop_catalog import discover_prestashop_catalog_urls
from ludora.trace import TraceLogger
from ludora.webfetch import FetchResult


REVILO_CATALOG_PATH = "/6-todos"
REVILO_MAX_CATALOG_PAGES = 500
REVILO_CATALOG_RANGE_RE = re.compile(
    r"Mostrando\s+([0-9.,]+)\s*[-–—]\s*([0-9.,]+)\s+de\s+([0-9.,]+)\s+artículo\(s\)", re.IGNORECASE,
)


def discover_revilo_product_urls(
    store_url: str,
    *,
    sitemap_urls: list[str] | None = None,
    fetcher: Callable[[str], FetchResult | None] | None = None,
    browser_fetcher: Callable[[str], FetchResult | None] | None = None,
    browser_fallback_enabled: bool = False,
    request_headers_provider: Callable[[str], Mapping[str, str]] | None = None,
    limit: int | None = None,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
) -> list[str]:
    """Enumerate URLs without requesting details, classification, or persistence."""
    return discover_prestashop_catalog_urls(
        store_url, store_name="Revilo", catalog_path=REVILO_CATALOG_PATH,
        trace_prefix="inventory.revilo_catalog", is_store_url=is_revilo_store_url,
        product_id_from_url=revilo_product_id, max_catalog_pages=REVILO_MAX_CATALOG_PAGES,
        range_pattern=REVILO_CATALOG_RANGE_RE,
        sitemap_urls=sitemap_urls, fetcher=fetcher, browser_fetcher=browser_fetcher,
        browser_fallback_enabled=browser_fallback_enabled, request_headers_provider=request_headers_provider,
        limit=limit, trace_logger=trace_logger, cancellation_token=cancellation_token,
    )
