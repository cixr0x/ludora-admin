from __future__ import annotations

import json
import re
import time
import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, replace
from decimal import Decimal
from urllib.parse import unquote, urlencode, urlparse

from ludora.database import ClaimedStoreItemUpdate, DiscoveryRepository
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import TransientProductFetchError
from ludora.trace import NullTraceLogger, TraceLogger
from ludora.webfetch import FetchResult, PerHostRequestThrottle, fetch_json


CHOCITA_DOMAIN = "chocitajuegos.com"
CHOCITA_ORIGIN = f"https://{CHOCITA_DOMAIN}"
PRODUCTS_ENDPOINT = f"{CHOCITA_ORIGIN}/wp-json/wc/store/v1/products"
BATCH_SIZE = 100
CACHE_TTL_SECONDS = 600.0
MINIMUM_BATCH_INTERVAL_SECONDS = 15.0
MAXIMUM_BATCH_URL_BYTES = 8_000
MAXIMUM_PRICE = Decimal("9999999999.99")  # Existing numeric(12, 2) storage.


@dataclass(frozen=True)
class _BatchEntry:
    fetched_at: float
    batch_id: str
    request_url: str
    batch_size: int
    values: dict[str, str] | None = None
    error: str = ""


class ChocitaBatchRefresher:
    """One worker session's bounded, consume-once public API refresh cache."""

    def __init__(
        self,
        repository: DiscoveryRepository,
        *,
        fetcher: Callable[[str], FetchResult | None] | None = None,
        clock: Callable[[], float] | None = None,
        waiter: Callable[[float], None] | None = None,
    ) -> None:
        self.repository = repository
        self._fetcher = fetcher or (lambda url: fetch_json(url, include_http_error_status=True))
        self._clock = clock or time.monotonic
        self._waiter = waiter or time.sleep
        self._throttle = PerHostRequestThrottle(
            minimum_interval_seconds=MINIMUM_BATCH_INTERVAL_SECONDS,
            clock=self._clock,
            waiter=lambda seconds, _token: self._waiter(seconds),
        )
        self._cache: dict[tuple[int, int, str], _BatchEntry] = {}

    @staticmethod
    def supports(claim: ClaimedStoreItemUpdate) -> bool:
        return (
            claim.platform == "woocommerce"
            and claim.canonical_domain == CHOCITA_DOMAIN
            and claim.record.store_id is not None
            and claim.record.store_item_id is not None
            and _is_chocita_origin(claim.record.source_url)
        )

    def refresh(
        self,
        claim: ClaimedStoreItemUpdate,
        *,
        trace_logger: TraceLogger | None = None,
    ) -> DiscoveryItemCandidateRecord:
        if not self.supports(claim):
            raise ValueError("Chocita batch refresh requires the confirmed WooCommerce store and HTTPS origin")
        trace = trace_logger or NullTraceLogger()
        record = claim.record
        self._expire_cache()
        key = (record.store_id, record.store_item_id, record.source_url)
        cache_hit = key in self._cache
        try:
            if not cache_hit:
                self._cache.clear()
                self._fetch_batch(claim, trace)
            entry = self._cache.pop(key, None)
            if entry is None:
                raise RuntimeError("Chocita claimed product has no unique eligible batch source URL")
            age_seconds = max(0.0, self._clock() - entry.fetched_at)
            trace_fields = {
                "source_url": record.source_url,
                "fetch_method": "woocommerce_store_api",
                "batch_id": entry.batch_id,
                "batch_request_url": entry.request_url,
                "batch_size": entry.batch_size,
                "cache_hit": cache_hit,
                "snapshot_age_seconds": age_seconds,
            }
            if entry.error or entry.values is None:
                trace.log("item_update.item.woocommerce_batch.rejected", **trace_fields, error=entry.error)
                raise RuntimeError(entry.error)
            trace.log("item_update.item.woocommerce_batch.refreshed", **trace_fields, **entry.values)
            return replace(record, **entry.values)
        except Exception as exc:
            trace.log(
                "item_update.item.woocommerce_batch.failed",
                source_url=record.source_url,
                fetch_method="woocommerce_store_api",
                error=str(exc),
                status_code=getattr(exc, "status_code", None),
                retry_after_seconds=getattr(exc, "retry_after_seconds", None),
            )
            raise

    def _expire_cache(self) -> None:
        now = self._clock()
        self._cache = {
            key: entry for key, entry in self._cache.items()
            if now - entry.fetched_at < CACHE_TTL_SECONDS
        }

    def _fetch_batch(self, claim: ClaimedStoreItemUpdate, trace: TraceLogger) -> None:
        record = claim.record
        targets = self.repository.list_store_item_update_batch_targets(
            store_id=record.store_id,
            claimed_store_item_id=record.store_item_id,
            limit=BATCH_SIZE,
        )
        # Start every snapshot with the current claim. A source excluded by the
        # repository's uniqueness/eligibility check must not be refreshed.
        current_target = (record.store_item_id, record.source_url)
        if current_target not in targets:
            raise RuntimeError("Chocita claimed product has no unique eligible batch source URL")
        ordered = [current_target, *(target for target in targets if target != current_target)]
        chosen: list[tuple[int, str]] = []
        slugs: list[str] = []
        seen_urls: set[str] = set()
        request_url = ""
        for target_id, source_url in ordered[:BATCH_SIZE]:
            try:
                slug = _product_slug(source_url)
            except ValueError:
                if (target_id, source_url) == current_target:
                    raise RuntimeError("Chocita claimed product has an unsupported source URL")
                continue
            if source_url in seen_urls:
                raise RuntimeError("Chocita batch contains duplicate source URLs")
            candidate_url = _batch_url([*slugs, slug])
            if len(candidate_url.encode("utf-8")) > MAXIMUM_BATCH_URL_BYTES:
                if not chosen:
                    raise RuntimeError("Chocita product slug exceeds the batch request URL limit")
                break
            chosen.append((target_id, source_url))
            slugs.append(slug)
            seen_urls.add(source_url)
            request_url = candidate_url

        # A single request shares data across future individual claims. Never
        # walk catalog pages or retry inline while holding this item's lease.
        self._throttle.wait_before_request(request_url)
        started_at = self._clock()
        batch_id = str(uuid.uuid4())
        trace.log(
            "item_update.item.woocommerce_batch.started",
            source_url=record.source_url,
            fetch_method="woocommerce_store_api",
            batch_id=batch_id,
            batch_request_url=request_url,
            batch_size=len(chosen),
        )
        fetched = self._fetcher(request_url)
        if fetched is None or fetched.status_code != 200:
            status_code = fetched.status_code if fetched is not None else None
            self._cache.clear()
            raise TransientProductFetchError(
                f"Chocita WooCommerce batch request failed (HTTP {status_code or 'unknown'})",
                status_code=status_code,
                retry_after_seconds=fetched.retry_after_seconds if fetched is not None else None,
                error_type=fetched.error_type if fetched is not None else None,
            )
        response_url = urlparse(fetched.url)
        if not _is_chocita_origin(fetched.url) or response_url.path != urlparse(PRODUCTS_ENDPOINT).path:
            self._cache.clear()
            raise RuntimeError("Chocita WooCommerce API response redirected outside the expected endpoint")
        try:
            payload = json.loads(fetched.text)
        except (ValueError, TypeError) as exc:
            self._cache.clear()
            raise RuntimeError("Chocita WooCommerce API returned invalid JSON") from exc
        if not isinstance(payload, list) or len(payload) > BATCH_SIZE:
            self._cache.clear()
            raise RuntimeError("Chocita WooCommerce API returned an invalid product batch")

        urls = Counter(value.get("permalink") for value in payload if isinstance(value, dict) and isinstance(value.get("permalink"), str))
        ids = Counter(value.get("id") for value in payload if isinstance(value, dict) and type(value.get("id")) is int)
        by_url = {value["permalink"]: value for value in payload if isinstance(value, dict) and isinstance(value.get("permalink"), str)}
        # Replace, rather than grow, the cache; at most one <=100 target batch
        # survives, and its TTL starts before the HTTP request was made.
        self._cache.clear()
        for target_id, source_url in chosen:
            value = by_url.get(source_url)
            normalized = None
            error = ""
            if value is None:
                error = f"Chocita API product is missing for exact source URL: {source_url}"
            elif urls[source_url] != 1 or (type(value.get("id")) is int and ids[value["id"]] != 1):
                error = f"Chocita API returned duplicate product identity for: {source_url}"
            else:
                try:
                    normalized = _normalize_product(value)
                except ValueError as exc:
                    error = f"Chocita API product is unsupported for {source_url}: {exc}"
            self._cache[(record.store_id, target_id, source_url)] = _BatchEntry(
                fetched_at=started_at,
                batch_id=batch_id,
                request_url=request_url,
                batch_size=len(chosen),
                values=normalized,
                error=error,
            )
        self._expire_cache()


def _is_chocita_origin(url: str) -> bool:
    try:
        parsed = urlparse(url)
        return parsed.scheme == "https" and parsed.netloc == CHOCITA_DOMAIN
    except ValueError:
        return False


def _product_slug(url: str) -> str:
    parsed = urlparse(url)
    if not _is_chocita_origin(url) or parsed.query or parsed.fragment:
        raise ValueError("unsupported product origin or URL parameters")
    match = re.fullmatch(r"/juego/([^/]+)/", parsed.path)
    if match is None:
        raise ValueError("unsupported product path")
    slug = unquote(match.group(1))
    if not slug or any(char in slug for char in "/,?#"):
        raise ValueError("unsupported product slug")
    return slug


def _batch_url(slugs: list[str]) -> str:
    return PRODUCTS_ENDPOINT + "?" + urlencode({
        "slug": ",".join(slugs),
        "per_page": BATCH_SIZE,
        "_fields": "id,permalink,type,prices,is_in_stock,is_purchasable",
    })


def _normalize_product(value: dict[str, object]) -> dict[str, str]:
    if type(value.get("id")) is not int or value["id"] <= 0:
        raise ValueError("invalid product ID")
    if value.get("type") != "simple":
        raise ValueError("only simple products are supported")
    prices = value.get("prices")
    if not isinstance(prices, dict) or "price_range" not in prices or prices["price_range"] is not None:
        raise ValueError("missing or ranged price")
    minor_unit = prices.get("currency_minor_unit")
    raw_price = prices.get("price")
    if type(minor_unit) is not int or not 0 <= minor_unit <= 2:
        raise ValueError("unsupported currency minor unit")
    if prices.get("currency_code") != "MXN":
        raise ValueError("unexpected currency")
    if not isinstance(raw_price, str) or re.fullmatch(r"[0-9]{1,12}", raw_price) is None:
        raise ValueError("invalid current price")
    amount = Decimal(raw_price).scaleb(-minor_unit)
    if amount <= 0 or amount > MAXIMUM_PRICE:
        raise ValueError("price is outside the supported range")
    if type(value.get("is_in_stock")) is not bool or value.get("is_purchasable") is not True:
        raise ValueError("missing stock or unsupported purchase state")
    price = format(amount, "f")
    if "." in price:
        price = price.rstrip("0").rstrip(".")
    return {
        "price": price,
        "raw_price": raw_price,
        "price_source": "woocommerce_store_api",
        "currency": "MXN",
        "availability": "available" if value["is_in_stock"] else "out_of_stock",
        "availability_source": "woocommerce_store_api",
    }
