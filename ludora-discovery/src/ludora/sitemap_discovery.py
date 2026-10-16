from __future__ import annotations

import html
import re
from collections.abc import Callable, Mapping
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen

from ludora.cancellation import CancellationToken, OperationCancelled, raise_if_cancelled
from ludora.filtering import canonical_domain
from ludora.jumpseller_discovery import jumpseller_sitemap_product_urls
from ludora.listing_extraction import _looks_like_product_url
from ludora.moonlight_discovery import MoonlightDiscoveryProfile, StoreDiscoveryAccessStopped, is_moonlight_store_url
from ludora.trace import TraceLogger
from ludora.webfetch import FetchResult, fetch_with_transient_retries, retry_after_seconds_from_headers


LOC_RE = re.compile(r"<loc(?:\s[^>]*)?>\s*(.*?)\s*</loc>", re.IGNORECASE | re.DOTALL)
DIRECT_PRODUCT_SITEMAP_PATHS = ("/product-sitemap.xml",)


class SiteProtectionBlocked(RuntimeError):
    pass


def discover_product_urls_from_sitemaps(
    store_url: str,
    *,
    fetcher: Callable[[str], FetchResult | None] | None = None,
    browser_fetcher: Callable[[str], FetchResult | None] | None = None,
    browser_fallback_enabled: bool = False,
    request_headers_provider: Callable[[str], Mapping[str, str]] | None = None,
    limit: int | None = None,
    trace_logger: TraceLogger | None = None,
    cancellation_token: CancellationToken | None = None,
    access_profile: MoonlightDiscoveryProfile | None = None,
    platform: str = "",
) -> list[str]:
    if access_profile is None and request_headers_provider is None and is_moonlight_store_url(store_url):
        access_profile = MoonlightDiscoveryProfile(trace_logger=trace_logger)
        request_headers_provider = access_profile.headers_for
    fetch = fetcher or (
        lambda url: fetch_sitemap_text(
            url,
            headers=request_headers_provider(url) if request_headers_provider is not None else None,
            include_http_error_status=True,
        )
    )
    browser_fetch = browser_fetcher
    if browser_fallback_enabled and browser_fetch is None:
        from ludora.browser_fetch import fetch_sitemap_text_with_browser

        browser_fetch = fetch_sitemap_text_with_browser

    root_sitemap_url = urljoin(store_url, "/sitemap.xml")
    blocked_urls: list[str] = []
    product_urls: list[str] = []
    sitemap_urls: list[str] = []
    visited_sitemaps = {root_sitemap_url}

    fetched_root = _fetch_sitemap(
        root_sitemap_url,
        fetch=fetch,
        browser_fetcher=browser_fetch,
        browser_fallback_enabled=browser_fallback_enabled,
        blocked_urls=blocked_urls,
        trace_logger=trace_logger,
        cancellation_token=cancellation_token,
        optional=False,
        access_profile=access_profile,
    )
    if fetched_root is not None:
        visited_sitemaps.add(fetched_root.url)
        product_urls.extend(_product_urls_from_text(fetched_root.text, fetched_root.url, store_url, platform=platform))
        sitemap_urls.extend(_product_sitemap_urls_from_text(fetched_root.text, fetched_root.url, store_url))
        if not sitemap_urls:
            sitemap_urls.extend(_sitemap_urls_from_text(fetched_root.text, fetched_root.url, store_url))

    sitemap_urls = _dedupe([*sitemap_urls, *_direct_product_sitemap_urls(store_url)])
    def walk_sitemaps(urls: list[str]) -> None:
        for sitemap_url in urls:
            raise_if_cancelled(cancellation_token)
            if limit is not None and len(_dedupe(product_urls)) >= limit:
                break
            if sitemap_url in visited_sitemaps:
                continue
            visited_sitemaps.add(sitemap_url)
            fetched_sitemap = _fetch_sitemap(
                sitemap_url, fetch=fetch, browser_fetcher=browser_fetch,
                browser_fallback_enabled=browser_fallback_enabled, blocked_urls=blocked_urls,
                trace_logger=trace_logger, cancellation_token=cancellation_token,
                optional=sitemap_url in _direct_product_sitemap_urls(store_url), access_profile=access_profile,
            )
            if fetched_sitemap is None:
                continue
            if _validated_sitemap_reference(fetched_sitemap.url, sitemap_url, store_url) is None:
                continue
            visited_sitemaps.add(fetched_sitemap.url)
            product_urls.extend(_product_urls_from_text(fetched_sitemap.text, fetched_sitemap.url, store_url, platform=platform))
            for nested_url in _sitemap_urls_from_text(fetched_sitemap.text, fetched_sitemap.url, store_url):
                if nested_url not in visited_sitemaps and nested_url not in urls:
                    urls.append(nested_url)
                    if trace_logger is not None:
                        trace_logger.log("inventory.sitemap_source.discovered", source_url=nested_url,
                                         discovered_from=fetched_sitemap.url, source_type="sitemap_index")

    walk_sitemaps(sitemap_urls)
    # Successful standard discovery keeps its established access order. Do not
    # reset Moonlight's observed refusal sequence with an unrelated optional read.
    if not product_urls and not (access_profile and access_profile.consecutive_refusals):
        robots_url = urljoin(store_url, "/robots.txt")
        try:
            robots = fetch_with_transient_retries(
                robots_url,
                (lambda url: access_profile.fetch(url, fetch, fetch_method="static")) if access_profile else fetch,
                trace_event="inventory.robots_fetch.http_error", trace_logger=trace_logger,
                trace_fields={"fetch_method": "static", "optional": True}, cancellation_token=cancellation_token,
            )
        except (OperationCancelled, StoreDiscoveryAccessStopped):
            raise
        except Exception:
            robots = None
        raise_if_cancelled(cancellation_token)
        if robots is not None and 200 <= robots.status_code < 400:
            robots_sources = []
            for line in robots.text.splitlines():
                directive, separator, value = line.partition(":")
                if not separator or directive.strip().casefold() != "sitemap":
                    continue
                value = value.split("#", 1)[0].strip()
                # robots.txt directives specify absolute URLs; relative entries
                # and malformed authorities must not become accidental fetches.
                if not value.casefold().startswith(("http://", "https://")):
                    continue
                source = _validated_sitemap_reference(value, robots.url, store_url)
                if source is None or source in robots_sources:
                    continue
                robots_sources.append(source)
                if trace_logger is not None:
                    trace_logger.log("inventory.sitemap_source.discovered", source_url=source,
                                     discovered_from=robots_url, source_type="robots")
            walk_sitemaps(robots_sources)

    deduped_urls = _dedupe(product_urls)
    if not deduped_urls and blocked_urls:
        raise SiteProtectionBlocked(
            "Site protection challenge blocked sitemap fetch for " + ", ".join(_dedupe(blocked_urls))
        )
    if limit is None:
        return deduped_urls
    return deduped_urls[:limit]


def fetch_sitemap_text(
    url: str,
    timeout: int = 20,
    *,
    headers: Mapping[str, str] | None = None,
    include_http_error_status: bool = False,
) -> FetchResult | None:
    request_headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
        "User-Agent": (
            "LudoraStoreCollector/1.0 "
            "(+https://admin.ludora.bobbycrimson.com/crawler)"
        ),
    }
    request_headers.update(headers or {})
    request = Request(
        url,
        headers=request_headers,
        method="GET",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            body = response.read().decode(charset, errors="replace")
            return FetchResult(url=response.geturl(), text=body)
    except HTTPError as exc:
        if include_http_error_status:
            return FetchResult(
                url=exc.geturl() or url,
                text="",
                status_code=int(exc.code),
                retry_after_seconds=retry_after_seconds_from_headers(exc.headers),
            )
        return None
    except (HTTPException, URLError, TimeoutError, ValueError) as exc:
        if include_http_error_status:
            return FetchResult(url=url, text="", status_code=0, error=str(exc), error_type=type(exc).__name__)
        return None


def _fetch_sitemap(
    url: str,
    *,
    fetch: Callable[[str], FetchResult | None],
    browser_fetcher: Callable[[str], FetchResult | None] | None,
    browser_fallback_enabled: bool,
    blocked_urls: list[str],
    trace_logger: TraceLogger | None,
    cancellation_token: CancellationToken | None,
    optional: bool,
    access_profile: MoonlightDiscoveryProfile | None = None,
) -> FetchResult | None:
    fetched = fetch_with_transient_retries(
        url,
        (lambda target: access_profile.fetch(target, fetch, fetch_method="static")) if access_profile else fetch,
        trace_event="inventory.sitemap_fetch.http_error",
        trace_logger=trace_logger,
        trace_fields={"fetch_method": "static", "optional": optional},
        cancellation_token=cancellation_token,
    )
    if fetched is not None and fetched.status_code >= 400:
        fetched = None
    if fetched is not None and not _looks_like_site_protection_challenge(fetched.text):
        return fetched
    if fetched is not None:
        blocked_urls.append(fetched.url)

    if not browser_fallback_enabled or browser_fetcher is None:
        return None

    browser_fetched = fetch_with_transient_retries(
        url,
        (lambda target: access_profile.fetch(target, browser_fetcher, fetch_method="browser"))
        if access_profile else browser_fetcher,
        trace_event="inventory.sitemap_fetch.http_error",
        trace_logger=trace_logger,
        trace_fields={"fetch_method": "browser", "optional": optional},
        cancellation_token=cancellation_token,
    )
    if browser_fetched is not None and browser_fetched.status_code >= 400:
        browser_fetched = None
    if browser_fetched is None:
        return None
    if _looks_like_site_protection_challenge(browser_fetched.text):
        blocked_urls.append(browser_fetched.url)
        return None
    return browser_fetched


def _product_sitemap_urls_from_text(text: str, base_url: str, store_url: str) -> list[str]:
    return _sitemap_urls_from_text(text, base_url, store_url, product_only=True)


def _sitemap_urls_from_text(
    text: str,
    base_url: str,
    store_url: str,
    *,
    product_only: bool = False,
) -> list[str]:
    if "<sitemap" not in text.casefold():
        return []

    urls: list[str] = []
    for loc in _loc_values(text):
        sitemap_url = _validated_sitemap_reference(loc, base_url, store_url)
        if sitemap_url is None:
            continue
        normalized = sitemap_url.casefold()
        if "sitemap" not in normalized and not urlparse(sitemap_url).path.casefold().endswith((".xml", ".xml.gz")):
            continue
        if product_only and "product" not in normalized:
            continue
        urls.append(sitemap_url)
    return _dedupe(urls)


def _validated_sitemap_reference(value: str, base_url: str, store_url: str) -> str | None:
    if not value or any(character.isspace() for character in value):
        return None
    try:
        url = urljoin(base_url, value)
        parsed = urlparse(url)
        store = urlparse(store_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            return None
        if parsed.port not in {None, 80, 443} or store.port not in {None, 80, 443}:
            return None
        if canonical_domain(url) != canonical_domain(store_url):
            return None
        return urlunparse(parsed._replace(fragment=""))
    except ValueError:
        return None


def _direct_product_sitemap_urls(store_url: str) -> list[str]:
    return [urljoin(store_url, path) for path in DIRECT_PRODUCT_SITEMAP_PATHS]


def _product_urls_from_text(text: str, sitemap_url: str, store_url: str, *, platform: str = "") -> list[str]:
    if platform.strip().casefold() == "jumpseller":
        return jumpseller_sitemap_product_urls(text, sitemap_url, store_url)
    store_domain = canonical_domain(store_url)
    urls: list[str] = []
    for loc in _loc_values(text):
        product_url = _clean_url(urljoin(sitemap_url, loc))
        if canonical_domain(product_url) != store_domain:
            continue
        if not _looks_like_product_url(product_url):
            continue
        urls.append(product_url)
    return _dedupe(urls)


def _loc_values(text: str) -> list[str]:
    values: list[str] = []
    for match in LOC_RE.finditer(text):
        value = match.group(1).strip()
        if value.startswith("<![CDATA[") and value.endswith("]]>"):
            value = value.removeprefix("<![CDATA[").removesuffix("]]>").strip()
        values.append(html.unescape(value))
    return values


def _clean_url(url: str) -> str:
    parsed = urlparse(url)
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))


def _looks_like_site_protection_challenge(text: str) -> bool:
    normalized = " ".join(text.casefold().split())
    if "<loc" in normalized:
        return False
    has_reload_loop = "window.location.reload" in normalized or "location.reload" in normalized
    has_challenge_title = (
        "<title>one moment" in normalized
        or "<title>un momento" in normalized
        or "<title>just a moment" in normalized
    )
    return has_reload_loop and has_challenge_title


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        output.append(value)
    return output
