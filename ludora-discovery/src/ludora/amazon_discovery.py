from __future__ import annotations

import random
import re
import time
import unicodedata
from collections.abc import Callable, Iterable
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.item_classification import apply_item_classification
from ludora.listing_extraction import _collapse_text, _extract_price
from ludora.models import DiscoveryItemCandidateRecord, ItemCandidateType
from ludora.product_crawler import ItemCandidateProcessor, ItemCandidateRepository, ItemClassifier
from ludora.trace import NullTraceLogger, TraceLogger
from ludora.webfetch import FetchResult


DEFAULT_AMAZON_STORE_SEARCH_TERMS = ("jue",)
DEFAULT_AMAZON_BRAND_MAX_PAGES = 5
DEFAULT_AMAZON_SEARCH_FETCH_ATTEMPTS = 3
DEFAULT_AMAZON_DETAIL_FETCH_ATTEMPTS = 3
DEFAULT_AMAZON_THROTTLE_BACKOFF_SECONDS = 60.0
DEFAULT_AMAZON_THROTTLE_JITTER_FRACTION = 0.2
DEFAULT_AMAZON_EXHAUSTED_COOLDOWN_SECONDS = 300.0
ItemTitleExtractor = Callable[[DiscoveryItemCandidateRecord], str]
ASIN_RE = re.compile(r"/(?:dp|gp/product)/([A-Z0-9]{10})(?:[/?#]|$)", re.IGNORECASE)
GENERIC_LINK_TEXT = {
    "",
    "comprar",
    "mas informacion",
    "opciones",
    "ver mas",
    "ver opciones",
    "view options",
}
SPANISH_LANGUAGE_TERMS = {"espanol", "spanish", "castellano"}
ENGLISH_LANGUAGE_TERMS = {"english", "ingles"}
VOID_LIKE_TAGS = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
}


class AmazonDetailFetchError(RuntimeError):
    def __init__(self, source_url: str, *, saw_response: bool) -> None:
        self.source_url = source_url
        self.saw_response = saw_response
        qualifier = "valid " if saw_response else ""
        super().__init__(f"Failed to fetch {qualifier}Amazon product detail page: {source_url}")


def build_amazon_store_search_url(store_url: str, term: str) -> str:
    parsed = urlparse(store_url)
    page_id = _store_page_id(parsed.path)
    if not page_id:
        raise ValueError("Amazon store URL must include /stores/.../page/{page_id}")
    return urlunparse(
        (
            parsed.scheme or "https",
            parsed.netloc,
            f"/stores/page/{page_id}/search",
            "",
            urlencode({"terms": term}),
            "",
        )
    )


def crawl_amazon_store_inventory(
    store_url: str,
    store_id: int | None,
    repository: ItemCandidateRepository,
    limit: int | None = None,
    search_terms: Iterable[str] = DEFAULT_AMAZON_STORE_SEARCH_TERMS,
    browser_fetcher: Callable[[str], FetchResult | None] | None = None,
    item_classifier: ItemClassifier = apply_item_classification,
    item_processor: ItemCandidateProcessor | None = None,
    item_title_extractor: ItemTitleExtractor | None = None,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
    delay_seconds: float = 1.0,
) -> list[DiscoveryItemCandidateRecord]:
    search_urls = [
        build_amazon_store_search_url(store_url, str(raw_term).strip())
        for raw_term in search_terms
        if str(raw_term).strip()
    ]
    return _crawl_amazon_search_inventory(
        search_urls,
        store_id,
        repository,
        browser_fetcher=browser_fetcher,
        item_classifier=item_classifier,
        item_processor=item_processor,
        item_title_extractor=item_title_extractor,
        trace_logger=trace_logger,
        cancellation_token=cancellation_token,
        delay_seconds=delay_seconds,
        limit=limit,
        require_nonempty_first_search_page=True,
    )


def crawl_amazon_brand_inventory(
    brand_search_url: str,
    store_id: int | None,
    repository: ItemCandidateRepository,
    *,
    brand_name: str,
    limit: int | None = None,
    browser_fetcher: Callable[[str], FetchResult | None] | None = None,
    item_classifier: ItemClassifier = apply_item_classification,
    item_processor: ItemCandidateProcessor | None = None,
    item_title_extractor: ItemTitleExtractor | None = None,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
    delay_seconds: float = 1.0,
    max_pages: int = DEFAULT_AMAZON_BRAND_MAX_PAGES,
) -> list[DiscoveryItemCandidateRecord]:
    if not brand_name.strip():
        raise ValueError("Amazon brand crawl requires a brand name")
    return _crawl_amazon_search_inventory(
        [brand_search_url],
        store_id,
        repository,
        browser_fetcher=browser_fetcher,
        item_classifier=item_classifier,
        item_processor=item_processor,
        item_title_extractor=item_title_extractor,
        trace_logger=trace_logger,
        cancellation_token=cancellation_token,
        delay_seconds=delay_seconds,
        limit=limit,
        expected_brand_name=brand_name,
        max_search_pages=max(1, max_pages),
    )


def _crawl_amazon_search_inventory(
    search_urls: Iterable[str],
    store_id: int | None,
    repository: ItemCandidateRepository,
    *,
    browser_fetcher: Callable[[str], FetchResult | None] | None = None,
    item_classifier: ItemClassifier = apply_item_classification,
    item_processor: ItemCandidateProcessor | None = None,
    item_title_extractor: ItemTitleExtractor | None = None,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
    delay_seconds: float = 1.0,
    limit: int | None = None,
    expected_brand_name: str = "",
    max_search_pages: int = 1,
    require_nonempty_first_search_page: bool = False,
) -> list[DiscoveryItemCandidateRecord]:
    raise_if_cancelled(cancellation_token)
    trace = trace_logger or NullTraceLogger()
    trace.log(
        "amazon_inventory.crawl.start",
        max_search_pages=max_search_pages,
        store_id=store_id,
    )
    browser_session = None
    if browser_fetcher is None:
        from ludora.browser_fetch import BrowserTextFetcher

        browser_session = BrowserTextFetcher(trace_logger=trace)
        browser_fetcher = browser_session.__enter__().fetch

    records: list[DiscoveryItemCandidateRecord] = []
    detail_failures: list[AmazonDetailFetchError] = []
    seen_asins: set[str] = set()
    try:
        for raw_search_url in search_urls:
            raise_if_cancelled(cancellation_token)
            first_search_url = str(raw_search_url).strip()
            if not first_search_url:
                continue
            for page_number in range(1, max_search_pages + 1):
                raise_if_cancelled(cancellation_token)
                search_url = first_search_url if page_number == 1 else _amazon_search_page_url(first_search_url, page_number)
                trace.log("amazon_inventory.search_fetch.start", page_number=page_number, search_url=search_url, store_id=store_id)
                fetched_listing, listing_candidates = _fetch_valid_amazon_listing_page(
                    search_url,
                    browser_fetcher,
                    trace=trace,
                    store_id=store_id,
                    cancellation_token=cancellation_token,
                    retry_delay_seconds=max(0.0, delay_seconds),
                    require_candidates=require_nonempty_first_search_page and page_number == 1,
                )
                listing_url = fetched_listing.url or search_url
                trace.log(
                    "amazon_inventory.search_extract.completed",
                    listing_count=len(listing_candidates),
                    page_number=page_number,
                    search_url=listing_url,
                    status_code=fetched_listing.status_code,
                    store_id=store_id,
                )
                if not listing_candidates:
                    break
                for listing_candidate in listing_candidates:
                    raise_if_cancelled(cancellation_token)
                    asin = listing_candidate.store_sku
                    if asin in seen_asins:
                        continue
                    seen_asins.add(asin)
                    if repository.item_candidate_exists(listing_candidate.store_id, listing_candidate.source_url):
                        trace.log(
                            "amazon_inventory.candidate.skipped_existing",
                            source_url=listing_candidate.source_url,
                            store_id=listing_candidate.store_id,
                            title=listing_candidate.title,
                        )
                        continue

                    trace.log(
                        "amazon_inventory.candidate.detail_fetch.start",
                        source_url=listing_candidate.source_url,
                        store_id=listing_candidate.store_id,
                        title=listing_candidate.title,
                    )
                    try:
                        fetched_detail = _fetch_valid_amazon_detail_page(
                            listing_candidate.source_url,
                            browser_fetcher,
                            trace=trace,
                            store_id=store_id,
                            cancellation_token=cancellation_token,
                            retry_delay_seconds=max(0.0, delay_seconds),
                            require_brand_byline=bool(expected_brand_name),
                        )
                    except AmazonDetailFetchError as exc:
                        detail_failures.append(exc)
                        resume_in_seconds = (
                            _jittered_delay_seconds(
                                DEFAULT_AMAZON_EXHAUSTED_COOLDOWN_SECONDS,
                                DEFAULT_AMAZON_THROTTLE_JITTER_FRACTION,
                            )
                            if delay_seconds > 0
                            else 0.0
                        )
                        trace.log(
                            "amazon_inventory.candidate.detail_fetch.exhausted",
                            attempts=DEFAULT_AMAZON_DETAIL_FETCH_ATTEMPTS,
                            error=str(exc),
                            resume_in_seconds=resume_in_seconds,
                            source_url=listing_candidate.source_url,
                            store_id=listing_candidate.store_id,
                            title=listing_candidate.title,
                        )
                        if resume_in_seconds > 0:
                            _wait_for_amazon_retry(resume_in_seconds, cancellation_token)
                        continue
                    detail_candidate = _extract_amazon_detail_candidate(
                        html=fetched_detail.text,
                        product_url=listing_candidate.source_url,
                        store_id=store_id,
                        source_listing_url=listing_url,
                        search_title=listing_candidate.title,
                    )
                    trace.log(
                        "amazon_inventory.candidate.detail_fetch.completed",
                        source_url=detail_candidate.source_url,
                        store_id=detail_candidate.store_id,
                        title=detail_candidate.title,
                    )

                    if expected_brand_name and not _amazon_brand_matches(detail_candidate, expected_brand_name):
                        trace.log(
                            "amazon_inventory.candidate.skipped_brand_mismatch",
                            actual_brand=_amazon_brand(detail_candidate),
                            expected_brand=expected_brand_name,
                            source_url=detail_candidate.source_url,
                            store_id=detail_candidate.store_id,
                            title=detail_candidate.title,
                        )
                        continue

                    raise_if_cancelled(cancellation_token)
                    _apply_item_title_extractor(detail_candidate, item_title_extractor)
                    item_classifier(detail_candidate)
                    upsert_result = repository.upsert_item_candidate(detail_candidate)
                    candidate_id = getattr(upsert_result, "candidate_id", None)
                    trace.log(
                        "amazon_inventory.candidate.upsert.completed",
                        candidate_id=candidate_id,
                        created=getattr(upsert_result, "created", None),
                        should_process=getattr(upsert_result, "should_process", None),
                        source_url=detail_candidate.source_url,
                        store_id=detail_candidate.store_id,
                        title=detail_candidate.title,
                    )
                    if item_processor is not None and getattr(upsert_result, "should_process", False):
                        trace.log(
                            "amazon_inventory.candidate.process.start",
                            candidate_id=candidate_id,
                            source_url=detail_candidate.source_url,
                            store_id=detail_candidate.store_id,
                            title=detail_candidate.title,
                        )
                        try:
                            item_processor.process_candidate(int(getattr(upsert_result, "candidate_id")), detail_candidate)
                        except Exception as exc:
                            trace.log(
                                "amazon_inventory.candidate.process.failed",
                                candidate_id=candidate_id,
                                error=str(exc),
                                source_url=detail_candidate.source_url,
                                store_id=detail_candidate.store_id,
                                title=detail_candidate.title,
                            )
                            raise
                        trace.log(
                            "amazon_inventory.candidate.process.completed",
                            candidate_id=candidate_id,
                            source_url=detail_candidate.source_url,
                            store_id=detail_candidate.store_id,
                            title=detail_candidate.title,
                        )
                    records.append(detail_candidate)
                    if limit is not None and len(records) >= limit:
                        _raise_amazon_detail_failures(detail_failures, records=records, store_id=store_id, trace=trace)
                        return records
                    if delay_seconds > 0:
                        _wait_for_amazon_retry(delay_seconds, cancellation_token)
                if limit is not None and len(records) >= limit:
                    _raise_amazon_detail_failures(detail_failures, records=records, store_id=store_id, trace=trace)
                    return records
        _raise_amazon_detail_failures(detail_failures, records=records, store_id=store_id, trace=trace)
        return records
    finally:
        if browser_session is not None:
            browser_session.__exit__(None, None, None)


def _fetch_valid_amazon_listing_page(
    search_url: str,
    browser_fetcher: Callable[[str], FetchResult | None],
    *,
    trace: TraceLogger,
    store_id: int | None,
    cancellation_token: CancellationToken | None,
    retry_delay_seconds: float,
    require_candidates: bool,
    max_attempts: int = DEFAULT_AMAZON_SEARCH_FETCH_ATTEMPTS,
) -> tuple[FetchResult, list[DiscoveryItemCandidateRecord]]:
    attempts = max(1, max_attempts)
    saw_response = False

    for attempt in range(1, attempts + 1):
        raise_if_cancelled(cancellation_token)
        fetched_listing = browser_fetcher(search_url)
        listing_candidates: list[DiscoveryItemCandidateRecord] = []
        if fetched_listing is None:
            diagnostics: dict[str, object] = {
                "final_url": "",
                "listing_count": 0,
                "page_title": "",
                "reason": "fetch_failed",
                "status_code": None,
            }
        else:
            saw_response = True
            listing_url = fetched_listing.url or search_url
            listing_candidates = _extract_amazon_listing_candidates(
                html=fetched_listing.text,
                page_url=listing_url,
                store_id=store_id,
            )
            diagnostics = _amazon_listing_page_diagnostics(
                fetched_listing,
                listing_count=len(listing_candidates),
                require_candidates=require_candidates,
            )
            if diagnostics["valid"]:
                return fetched_listing, listing_candidates

        will_retry = attempt < attempts
        retry_in_seconds = (
            _amazon_retry_delay_seconds(
                diagnostics,
                attempt=attempt,
                base_delay_seconds=retry_delay_seconds,
            )
            if will_retry
            else 0.0
        )
        trace.log(
            "amazon_inventory.search_fetch.invalid",
            attempt=attempt,
            max_attempts=attempts,
            retry_in_seconds=retry_in_seconds,
            search_url=search_url,
            store_id=store_id,
            will_retry=will_retry,
            **{key: value for key, value in diagnostics.items() if key != "valid"},
        )
        if will_retry:
            _reset_amazon_browser_context(
                browser_fetcher,
                attempt=attempt,
                source_url=search_url,
                store_id=store_id,
                trace=trace,
                trace_event_prefix="amazon_inventory.search_fetch",
            )
        if retry_in_seconds > 0:
            _wait_for_amazon_retry(retry_in_seconds, cancellation_token)

    if saw_response:
        raise RuntimeError(f"Failed to fetch valid Amazon search page: {search_url}")
    raise RuntimeError(f"Failed to fetch Amazon search page: {search_url}")


def _amazon_listing_page_diagnostics(
    fetched: FetchResult,
    *,
    listing_count: int,
    require_candidates: bool,
) -> dict[str, object]:
    html = fetched.text or ""
    title_match = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    page_title = _collapse_text(title_match.group(1)) if title_match else ""
    status_ok = 200 <= fetched.status_code < 400

    if not status_ok:
        reason = "http_status"
    elif require_candidates and listing_count == 0:
        reason = "missing_listing_candidates"
    else:
        reason = ""

    return {
        "final_url": fetched.url,
        "listing_count": listing_count,
        "page_title": page_title,
        "reason": reason,
        "status_code": fetched.status_code,
        "valid": not reason,
    }


def _fetch_valid_amazon_detail_page(
    source_url: str,
    browser_fetcher: Callable[[str], FetchResult | None],
    *,
    trace: TraceLogger,
    store_id: int | None,
    cancellation_token: CancellationToken | None,
    retry_delay_seconds: float,
    require_brand_byline: bool = False,
    max_attempts: int = DEFAULT_AMAZON_DETAIL_FETCH_ATTEMPTS,
) -> FetchResult:
    attempts = max(1, max_attempts)
    expected_asin = _asin_from_url(source_url)
    saw_response = False

    for attempt in range(1, attempts + 1):
        raise_if_cancelled(cancellation_token)
        fetched_detail = browser_fetcher(source_url)
        if fetched_detail is None:
            diagnostics: dict[str, object] = {
                "expected_asin": expected_asin,
                "expected_asin_present": False,
                "final_url": "",
                "page_title": "",
                "product_title_present": False,
                "reason": "fetch_failed",
                "status_code": None,
            }
            if require_brand_byline:
                diagnostics.update(
                    brand_byline="",
                    brand_byline_present=False,
                )
        else:
            saw_response = True
            diagnostics = _amazon_detail_page_diagnostics(
                fetched_detail,
                expected_asin=expected_asin,
                require_brand_byline=require_brand_byline,
            )
            if diagnostics["valid"]:
                return fetched_detail

        will_retry = attempt < attempts
        retry_in_seconds = (
            _amazon_retry_delay_seconds(
                diagnostics,
                attempt=attempt,
                base_delay_seconds=retry_delay_seconds,
            )
            if will_retry
            else 0.0
        )
        trace.log(
            "amazon_inventory.candidate.detail_fetch.invalid",
            attempt=attempt,
            max_attempts=attempts,
            retry_in_seconds=retry_in_seconds,
            source_url=source_url,
            store_id=store_id,
            will_retry=will_retry,
            **{key: value for key, value in diagnostics.items() if key != "valid"},
        )
        if will_retry:
            _reset_amazon_browser_context(
                browser_fetcher,
                attempt=attempt,
                source_url=source_url,
                store_id=store_id,
                trace=trace,
                trace_event_prefix="amazon_inventory.candidate.detail_fetch",
            )
        if retry_in_seconds > 0:
            _wait_for_amazon_retry(retry_in_seconds, cancellation_token)

    raise AmazonDetailFetchError(source_url, saw_response=saw_response)


def _reset_amazon_browser_context(
    browser_fetcher: Callable[[str], FetchResult | None],
    *,
    attempt: int,
    source_url: str,
    store_id: int | None,
    trace: TraceLogger,
    trace_event_prefix: str,
) -> bool:
    fetcher_owner = getattr(browser_fetcher, "__self__", browser_fetcher)
    reset_context = getattr(fetcher_owner, "reset_context", None)
    if not callable(reset_context):
        return False

    try:
        reset_context()
    except Exception as exc:
        trace.log(
            f"{trace_event_prefix}.context_reset.failed",
            attempt=attempt,
            error=str(exc),
            error_type=type(exc).__name__,
            source_url=source_url,
            store_id=store_id,
        )
        return False

    trace.log(
        f"{trace_event_prefix}.context_reset.completed",
        attempt=attempt,
        source_url=source_url,
        store_id=store_id,
    )
    return True


def _amazon_retry_delay_seconds(
    diagnostics: dict[str, object],
    *,
    attempt: int,
    base_delay_seconds: float,
    jitter_fraction: float = DEFAULT_AMAZON_THROTTLE_JITTER_FRACTION,
) -> float:
    base_delay = max(0.0, base_delay_seconds)
    if base_delay == 0:
        return 0.0

    status_code = diagnostics.get("status_code")
    reason = str(diagnostics.get("reason") or "")
    page_title = str(diagnostics.get("page_title") or "").casefold()
    throttled_status = isinstance(status_code, int) and (status_code == 429 or 500 <= status_code < 600)
    throttle_like_shell = reason in {"missing_listing_candidates", "missing_product_title"} and (
        not page_title or page_title in {"amazon.com.mx", "documento no encontrado"}
    )
    if throttled_status or throttle_like_shell:
        backoff = max(base_delay * attempt, DEFAULT_AMAZON_THROTTLE_BACKOFF_SECONDS * (3 ** (attempt - 1)))
        return _jittered_delay_seconds(backoff, jitter_fraction)
    return base_delay * attempt


def _jittered_delay_seconds(delay_seconds: float, jitter_fraction: float) -> float:
    bounded_delay = max(0.0, delay_seconds)
    bounded_jitter = min(1.0, max(0.0, jitter_fraction))
    return round(
        random.uniform(bounded_delay * (1.0 - bounded_jitter), bounded_delay * (1.0 + bounded_jitter)),
        3,
    )


def _raise_amazon_detail_failures(
    failures: list[AmazonDetailFetchError],
    *,
    records: list[DiscoveryItemCandidateRecord],
    store_id: int | None,
    trace: TraceLogger,
) -> None:
    if not failures:
        return

    failed_urls = [failure.source_url for failure in failures]
    trace.log(
        "amazon_inventory.crawl.partial_failure",
        failed_detail_pages=len(failed_urls),
        failed_source_urls=failed_urls,
        processed_items=len(records),
        store_id=store_id,
    )
    first_failure = failures[0]
    raise RuntimeError(
        f"{first_failure}. Retries were exhausted for {len(failed_urls)} product(s). "
        "Valid products were preserved and the failed products remain pending."
    )


def _wait_for_amazon_retry(
    delay_seconds: float,
    cancellation_token: CancellationToken | None,
) -> None:
    deadline = time.monotonic() + max(0.0, delay_seconds)
    while True:
        raise_if_cancelled(cancellation_token)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(1.0, remaining))


def _amazon_detail_page_diagnostics(
    fetched: FetchResult,
    *,
    expected_asin: str,
    require_brand_byline: bool = False,
) -> dict[str, object]:
    html = fetched.text or ""
    product_title_present = bool(re.search(r"\bid\s*=\s*['\"]productTitle['\"]", html, re.IGNORECASE))
    expected_asin_present = bool(
        expected_asin
        and re.search(
            rf"(?<![A-Z0-9]){re.escape(expected_asin)}(?![A-Z0-9])",
            html,
            re.IGNORECASE,
        )
    )
    final_url_asin = _asin_from_url(fetched.url)
    final_url_matches = not final_url_asin or final_url_asin.casefold() == expected_asin.casefold()
    status_ok = 200 <= fetched.status_code < 400
    brand_byline = ""
    brand_byline_value = ""
    if require_brand_byline:
        parser = _AmazonProductParser(fetched.url)
        parser.feed(html)
        brand_byline = _collapse_text(" ".join(parser.brand_byline_parts))
        brand_byline_value = _amazon_brand_from_byline(brand_byline)

    if not status_ok:
        reason = "http_status"
    elif not product_title_present:
        reason = "missing_product_title"
    elif not expected_asin_present:
        reason = "missing_expected_asin"
    elif not final_url_matches:
        reason = "redirected_asin"
    elif require_brand_byline and not brand_byline_value:
        reason = "missing_brand_byline"
    else:
        reason = ""

    diagnostics: dict[str, object] = {
        "expected_asin": expected_asin,
        "expected_asin_present": expected_asin_present,
        "final_url": fetched.url,
        "page_title": _html_page_title(html),
        "product_title_present": product_title_present,
        "reason": reason,
        "status_code": fetched.status_code,
        "valid": not reason,
    }
    if require_brand_byline:
        diagnostics.update(
            brand_byline=brand_byline,
            brand_byline_present=bool(brand_byline_value),
        )
    return diagnostics


def _html_page_title(html: str) -> str:
    match = re.search(r"<title(?:\s[^>]*)?>(.*?)</title\s*>", html, re.IGNORECASE | re.DOTALL)
    return _collapse_text(match.group(1))[:300] if match else ""


class _AmazonSearchParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self._link_href = ""
        self._link_depth = 0
        self._link_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized_tag = tag.casefold()
        if self._link_depth and normalized_tag not in VOID_LIKE_TAGS:
            self._link_depth += 1
            return
        if normalized_tag != "a":
            return
        attr = {name.casefold(): value or "" for name, value in attrs}
        href = attr.get("href", "").strip()
        if not href:
            return
        self._link_href = href
        self._link_depth = 1
        self._link_parts = []

    def handle_endtag(self, tag: str) -> None:
        if not self._link_depth or tag.casefold() in VOID_LIKE_TAGS:
            return
        self._link_depth -= 1
        if self._link_depth == 0:
            text = _collapse_text(" ".join(self._link_parts))
            self.links.append((self._link_href, text))
            self._link_href = ""
            self._link_parts = []

    def handle_data(self, data: str) -> None:
        if self._link_depth:
            self._link_parts.append(data)


class _AmazonProductParser(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.title_parts: list[str] = []
        self.brand_byline_parts: list[str] = []
        self.h1_parts: list[str] = []
        self.html_title_parts: list[str] = []
        self.availability_parts: list[str] = []
        self.price_texts: list[str] = []
        self.bullets: list[str] = []
        self.product_details: dict[str, str] = {}
        self.image_url = ""
        self.has_add_to_cart = False
        self.has_buy_now = False
        self.text_nodes: list[str] = []
        self._ignored_depth = 0
        self._title_depth = 0
        self._brand_byline_depth = 0
        self._h1_depth = 0
        self._html_title_depth = 0
        self._availability_depth = 0
        self._price_depth = 0
        self._price_parts: list[str] = []
        self._feature_bullets_depth = 0
        self._bullet_depth = 0
        self._bullet_parts: list[str] = []
        self._inside_row = False
        self._row_cells: list[tuple[str, str]] = []
        self._cell_depth = 0
        self._cell_tag = ""
        self._cell_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized_tag = tag.casefold()
        if self._ignored_depth:
            if normalized_tag not in VOID_LIKE_TAGS:
                self._ignored_depth += 1
            return
        if normalized_tag in {"script", "style", "noscript"}:
            self._ignored_depth = 1
            return

        attr = {name.casefold(): value or "" for name, value in attrs}
        id_value = attr.get("id", "").casefold()
        class_tokens = _class_tokens(attr.get("class", ""))
        is_disabled = any(name.casefold() == "disabled" for name, _value in attrs)

        if id_value == "add-to-cart-button" and not is_disabled:
            self.has_add_to_cart = True
        if id_value == "buy-now-button" and not is_disabled:
            self.has_buy_now = True

        self._extend_active_captures(normalized_tag)
        if id_value == "producttitle":
            self._title_depth = 1
        if id_value == "bylineinfo":
            self._brand_byline_depth = 1
        if normalized_tag == "h1":
            self._h1_depth = 1
        if normalized_tag == "title":
            self._html_title_depth = 1
        if id_value == "availability":
            self._availability_depth = 1
        if "a-offscreen" in class_tokens:
            self._price_depth = 1
            self._price_parts = []
        if id_value == "feature-bullets":
            self._feature_bullets_depth = 1
        if self._feature_bullets_depth and normalized_tag == "li" and not self._bullet_depth:
            self._bullet_depth = 1
            self._bullet_parts = []
        if normalized_tag == "tr":
            self._inside_row = True
            self._row_cells = []
        if self._inside_row and normalized_tag in {"th", "td"} and not self._cell_depth:
            self._cell_depth = 1
            self._cell_tag = normalized_tag
            self._cell_parts = []

        if normalized_tag == "img" and id_value == "landingimage":
            self.image_url = _first_text(
                attr.get("data-old-hires", ""),
                attr.get("data-a-hires", ""),
                attr.get("data-src", ""),
                attr.get("src", ""),
                self.image_url,
            )

    def handle_endtag(self, tag: str) -> None:
        normalized_tag = tag.casefold()
        if self._ignored_depth:
            if normalized_tag not in VOID_LIKE_TAGS:
                self._ignored_depth -= 1
            return
        if self._cell_depth and normalized_tag not in VOID_LIKE_TAGS:
            self._cell_depth -= 1
            if self._cell_depth == 0:
                text = _collapse_text(" ".join(self._cell_parts))
                if text:
                    self._row_cells.append((self._cell_tag, text))
                self._cell_tag = ""
                self._cell_parts = []
        if normalized_tag == "tr" and self._inside_row:
            self._append_detail_row()
            self._inside_row = False
            self._row_cells = []
        if self._price_depth and normalized_tag not in VOID_LIKE_TAGS:
            self._price_depth -= 1
            if self._price_depth == 0:
                text = _collapse_text(" ".join(self._price_parts))
                if text:
                    self.price_texts.append(text)
                self._price_parts = []
        if self._bullet_depth and normalized_tag not in VOID_LIKE_TAGS:
            self._bullet_depth -= 1
            if self._bullet_depth == 0:
                text = _collapse_text(" ".join(self._bullet_parts))
                if text:
                    self.bullets.append(text)
                self._bullet_parts = []
        self._close_active_captures(normalized_tag)

    def handle_data(self, data: str) -> None:
        text = _collapse_text(data)
        if not text or self._ignored_depth:
            return
        self.text_nodes.append(text)
        if self._title_depth:
            self.title_parts.append(text)
        if self._brand_byline_depth:
            self.brand_byline_parts.append(text)
        if self._h1_depth:
            self.h1_parts.append(text)
        if self._html_title_depth:
            self.html_title_parts.append(text)
        if self._availability_depth:
            self.availability_parts.append(text)
        if self._price_depth:
            self._price_parts.append(text)
        if self._bullet_depth:
            self._bullet_parts.append(text)
        if self._cell_depth:
            self._cell_parts.append(text)

    def _extend_active_captures(self, tag: str) -> None:
        if tag in VOID_LIKE_TAGS:
            return
        if self._title_depth:
            self._title_depth += 1
        if self._brand_byline_depth:
            self._brand_byline_depth += 1
        if self._h1_depth:
            self._h1_depth += 1
        if self._html_title_depth:
            self._html_title_depth += 1
        if self._availability_depth:
            self._availability_depth += 1
        if self._price_depth:
            self._price_depth += 1
        if self._feature_bullets_depth:
            self._feature_bullets_depth += 1
        if self._bullet_depth:
            self._bullet_depth += 1
        if self._cell_depth:
            self._cell_depth += 1

    def _close_active_captures(self, tag: str) -> None:
        if tag in VOID_LIKE_TAGS:
            return
        if self._title_depth:
            self._title_depth -= 1
        if self._brand_byline_depth:
            self._brand_byline_depth -= 1
        if self._h1_depth:
            self._h1_depth -= 1
        if self._html_title_depth:
            self._html_title_depth -= 1
        if self._availability_depth:
            self._availability_depth -= 1
        if self._feature_bullets_depth:
            self._feature_bullets_depth -= 1

    def _append_detail_row(self) -> None:
        if len(self._row_cells) < 2:
            return
        label = _collapse_text(self._row_cells[0][1]).strip(" :")
        value = _collapse_text(" ".join(cell_text for _tag, cell_text in self._row_cells[1:])).strip()
        if label and value and label not in self.product_details:
            self.product_details[label] = value


def _extract_amazon_listing_candidates(
    *,
    html: str,
    page_url: str,
    store_id: int | None,
) -> list[DiscoveryItemCandidateRecord]:
    parser = _AmazonSearchParser()
    parser.feed(html)
    candidates_by_asin: dict[str, DiscoveryItemCandidateRecord] = {}
    for href, link_text in parser.links:
        absolute_url = urljoin(page_url, href)
        asin = _asin_from_url(absolute_url)
        if not asin:
            continue
        canonical_url = _canonical_product_url(absolute_url, asin)
        title = _collapse_text(link_text)
        if _is_generic_link_text(title):
            title = ""
        existing = candidates_by_asin.get(asin)
        if existing is not None:
            if title and not existing.title:
                existing.title = title
            continue
        candidates_by_asin[asin] = DiscoveryItemCandidateRecord(
            store_id=store_id,
            source_url=canonical_url,
            source_listing_url=page_url,
            title=title,
            store_sku=asin,
            raw_payload={"amazon": {"asin": asin, "search_title": title}},
        )
    return list(candidates_by_asin.values())


def _extract_amazon_detail_candidate(
    *,
    html: str,
    product_url: str,
    store_id: int | None,
    source_listing_url: str,
    search_title: str,
) -> DiscoveryItemCandidateRecord:
    parser = _AmazonProductParser(product_url)
    parser.feed(html)
    asin = _asin_from_url(product_url) or _detail_value(parser.product_details, "ASIN")
    canonical_url = _canonical_product_url(product_url, asin) if asin else product_url
    title = _first_text(
        " ".join(parser.title_parts),
        search_title,
        _strip_title_suffix(" ".join(parser.h1_parts)),
        _strip_title_suffix(" ".join(parser.html_title_parts)),
    )
    description = _collapse_text(" ".join(parser.bullets))
    raw_price, price, price_source = _first_price(parser.price_texts)
    has_direct_buy_option = parser.has_add_to_cart or parser.has_buy_now
    availability = "available" if has_direct_buy_option else "out_of_stock"
    if not has_direct_buy_option:
        raw_price, price, price_source = "", "", "none"
    language, language_source, language_evidence = _detect_language(
        title,
        canonical_url,
        description,
        parser.product_details,
    )
    min_players, max_players = _parse_players(
        _detail_value(
            parser.product_details,
            "Cantidad de jugadores",
            "Numero de jugadores",
            "Number of players",
            "Players",
        )
    )
    min_minutes, max_minutes = _parse_minutes(
        _detail_value(
            parser.product_details,
            "Tiempo de juego estimado",
            "Tiempo de juego",
            "Duracion",
            "Playing time",
            "Play time",
        )
    )
    min_age = _parse_min_age(
        _detail_value(
            parser.product_details,
            "Edad minima recomendada por el fabricante",
            "Edad minima recomendada",
            "Manufacturer recommended age",
            "Edad",
        )
    )
    brand_byline = _collapse_text(" ".join(parser.brand_byline_parts))
    brand = _amazon_brand_from_byline(brand_byline)
    details_brand = _detail_value(parser.product_details, "Marca", "Nombre de la marca", "Brand")
    manufacturer = _detail_value(parser.product_details, "Fabricante", "Manufacturer")
    raw_payload: dict[str, object] = {
        "amazon": {
            "asin": asin,
            "availability_text": _collapse_text(" ".join(parser.availability_parts)),
            "brand": brand,
            "brand_byline": brand_byline,
            "bullets": parser.bullets,
            "details_brand": details_brand,
            "has_add_to_cart": parser.has_add_to_cart,
            "has_buy_now": parser.has_buy_now,
            "product_title": title,
            "product_details": parser.product_details,
            "search_title": search_title,
        }
    }

    return DiscoveryItemCandidateRecord(
        store_id=store_id,
        source_url=canonical_url,
        source_listing_url=source_listing_url,
        title=title,
        publisher=_first_text(manufacturer, brand, details_brand),
        description=description,
        item_type=_infer_item_type(title, canonical_url),
        min_players=min_players,
        max_players=max_players,
        min_minutes=min_minutes,
        max_minutes=max_minutes,
        min_age=min_age,
        language=language,
        language_source=language_source,
        language_evidence=language_evidence,
        image_url=urljoin(canonical_url, parser.image_url) if parser.image_url else "",
        raw_price=raw_price,
        price=price,
        price_source=price_source,
        currency="MXN",
        availability=availability,
        availability_source="amazon_detail" if availability != "unknown" else "none",
        store_sku=asin,
        raw_payload=raw_payload,
    )


def _apply_item_title_extractor(
    record: DiscoveryItemCandidateRecord,
    item_title_extractor: ItemTitleExtractor | None,
) -> None:
    if item_title_extractor is None:
        return
    extracted_title = item_title_extractor(record).strip()
    if not extracted_title or extracted_title == record.title:
        return
    amazon_payload = record.raw_payload.get("amazon")
    if isinstance(amazon_payload, dict):
        amazon_payload["product_title"] = record.title
        amazon_payload["extracted_game_title"] = extracted_title
    record.title = extracted_title
    record.item_type = _infer_item_type(record.title, record.source_url)


def _amazon_brand_matches(record: DiscoveryItemCandidateRecord, expected_brand_name: str) -> bool:
    expected = _normalize_words(expected_brand_name)
    if not expected:
        return False
    actual = _normalize_words(_amazon_brand(record))
    return actual == expected


def _amazon_brand(record: DiscoveryItemCandidateRecord) -> str:
    amazon_payload = record.raw_payload.get("amazon")
    if not isinstance(amazon_payload, dict):
        return ""
    brand = amazon_payload.get("brand")
    if isinstance(brand, str) and brand.strip():
        return brand
    brand_byline = amazon_payload.get("brand_byline")
    if isinstance(brand_byline, str):
        return _amazon_brand_from_byline(brand_byline)
    return ""


def _amazon_brand_from_byline(value: str) -> str:
    byline = _collapse_text(value)
    if not byline:
        return ""

    for pattern in (
        r"^(?:marca|brand)\s*:\s*(.+)$",
        r"^visita\s+la\s+tienda\s+de\s+(.+)$",
        r"^visit\s+the\s+(.+?)\s+store$",
    ):
        match = re.fullmatch(pattern, byline, re.IGNORECASE)
        if match:
            return _collapse_text(match.group(1))
    return byline


def _amazon_search_page_url(search_url: str, page_number: int) -> str:
    parsed = urlparse(search_url)
    query_pairs = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key != "page"]
    query_pairs.append(("page", str(page_number)))
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, urlencode(query_pairs), parsed.fragment))


def _store_page_id(path: str) -> str:
    match = re.search(r"/stores/(?:[^/]+/)?page/([^/?#]+)", path)
    return match.group(1) if match else ""


def _asin_from_url(url: str) -> str:
    match = ASIN_RE.search(urlparse(url).path)
    return match.group(1).upper() if match else ""


def _canonical_product_url(url: str, asin: str) -> str:
    parsed = urlparse(url)
    return urlunparse((parsed.scheme or "https", parsed.netloc, f"/dp/{asin.upper()}", "", "", ""))


def _is_generic_link_text(value: str) -> bool:
    normalized = _normalize_words(value)
    return normalized in GENERIC_LINK_TEXT or len(normalized) <= 2


def _class_tokens(value: str) -> set[str]:
    return {token.strip().casefold() for token in value.split() if token.strip()}


def _first_price(values: list[str]) -> tuple[str, str, str]:
    for value in values:
        raw_price, price = _extract_price(value)
        if price:
            return re.sub(r"\$\s+", "$", raw_price), price, "amazon_detail"
    return "", "", "none"


def _detail_value(product_details: dict[str, str], *labels: str) -> str:
    normalized_details = {_normalize_words(label): value for label, value in product_details.items()}
    for label in labels:
        value = normalized_details.get(_normalize_words(label), "")
        if value:
            return value
    return ""


def _parse_players(value: str) -> tuple[int | None, int | None]:
    if not value:
        return None, None
    normalized = _normalize_range_text(value)
    range_match = re.search(r"(\d+)\s*(?:-|a|to|hasta)\s*(\d+)", normalized)
    if range_match:
        return int(range_match.group(1)), int(range_match.group(2))
    single_match = re.search(r"\d+", normalized)
    if single_match:
        players = int(single_match.group(0))
        return players, players
    return None, None


def _parse_minutes(value: str) -> tuple[int | None, int | None]:
    if not value:
        return None, None
    normalized = _normalize_range_text(value)
    range_match = re.search(r"(\d+)\s*(?:-|a|to|hasta)\s*(\d+)", normalized)
    if range_match:
        return int(range_match.group(1)), int(range_match.group(2))
    single_match = re.search(r"\d+", normalized)
    if single_match:
        minutes = int(single_match.group(0))
        return minutes, minutes
    return None, None


def _parse_min_age(value: str) -> int | None:
    if not value:
        return None
    match = re.search(r"\d+", value)
    if not match:
        return None
    age = int(match.group(0))
    normalized = _normalize_words(value)
    if "mes" in normalized or "month" in normalized or (age > 30 and "ano" not in normalized and "year" not in normalized):
        return max(1, round(age / 12))
    return age


def _detect_language(
    title: str,
    product_url: str,
    description: str,
    product_details: dict[str, str],
) -> tuple[str, str, str]:
    evidence_sources = [
        ("title", title),
        ("source_url", product_url),
        ("description", description),
        ("product_details", " ".join(product_details.values())),
    ]
    for source, value in evidence_sources:
        normalized = _normalize_words(value)
        has_spanish = any(term in normalized for term in SPANISH_LANGUAGE_TERMS)
        has_english = any(term in normalized for term in ENGLISH_LANGUAGE_TERMS)
        if has_spanish != has_english:
            return ("es" if has_spanish else "en", source, _collapse_text(value))
    return "", "", ""


def _infer_item_type(title: str, product_url: str) -> ItemCandidateType:
    normalized = _normalize_words(f"{title} {product_url}")
    if any(term in normalized for term in ("expansion", "expansion", "ampliacion")):
        return "expansion"
    return "unknown"


def _strip_title_suffix(value: str) -> str:
    value = _collapse_text(value)
    for separator in (" | ", " - "):
        if separator in value:
            return value.split(separator, 1)[0].strip()
    return value


def _first_text(*values: str) -> str:
    for value in values:
        text = _collapse_text(value)
        if text:
            return text
    return ""


def _normalize_range_text(value: str) -> str:
    return _normalize_words(value.replace("\u2013", "-").replace("\u2014", "-"))


def _normalize_words(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    without_accents = "".join(character for character in decomposed if not unicodedata.combining(character))
    return " ".join(re.sub(r"[^a-z0-9-]+", " ", without_accents).split())
