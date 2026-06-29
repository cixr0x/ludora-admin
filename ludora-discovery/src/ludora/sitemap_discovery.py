from __future__ import annotations

import html
import re
from collections.abc import Callable
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen

from ludora.filtering import canonical_domain
from ludora.listing_extraction import _looks_like_product_url
from ludora.webfetch import FetchResult


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
    limit: int | None = None,
) -> list[str]:
    fetch = fetcher or fetch_sitemap_text
    browser_fetch = browser_fetcher
    if browser_fallback_enabled and browser_fetch is None:
        from ludora.browser_fetch import fetch_sitemap_text_with_browser

        browser_fetch = fetch_sitemap_text_with_browser

    root_sitemap_url = urljoin(store_url, "/sitemap.xml")
    blocked_urls: list[str] = []
    product_urls: list[str] = []
    sitemap_urls: list[str] = []

    fetched_root = _fetch_sitemap(
        root_sitemap_url,
        fetch=fetch,
        browser_fetcher=browser_fetch,
        browser_fallback_enabled=browser_fallback_enabled,
        blocked_urls=blocked_urls,
    )
    if fetched_root is not None:
        product_urls.extend(_product_urls_from_text(fetched_root.text, fetched_root.url, store_url))
        sitemap_urls.extend(_product_sitemap_urls_from_text(fetched_root.text, fetched_root.url, store_url))
        if not sitemap_urls:
            sitemap_urls.extend(_sitemap_urls_from_text(fetched_root.text, fetched_root.url, store_url))

    sitemap_urls = _dedupe([*sitemap_urls, *_direct_product_sitemap_urls(store_url)])
    for sitemap_url in sitemap_urls:
        if limit is not None and len(product_urls) >= limit:
            break
        fetched_sitemap = _fetch_sitemap(
            sitemap_url,
            fetch=fetch,
            browser_fetcher=browser_fetch,
            browser_fallback_enabled=browser_fallback_enabled,
            blocked_urls=blocked_urls,
        )
        if fetched_sitemap is None:
            continue
        product_urls.extend(_product_urls_from_text(fetched_sitemap.text, fetched_sitemap.url, store_url))
        for nested_sitemap_url in _sitemap_urls_from_text(fetched_sitemap.text, fetched_sitemap.url, store_url):
            if nested_sitemap_url not in sitemap_urls:
                sitemap_urls.append(nested_sitemap_url)

    deduped_urls = _dedupe(product_urls)
    if not deduped_urls and blocked_urls:
        raise SiteProtectionBlocked(
            "Site protection challenge blocked sitemap fetch for " + ", ".join(_dedupe(blocked_urls))
        )
    if limit is None:
        return deduped_urls
    return deduped_urls[:limit]


def fetch_sitemap_text(url: str, timeout: int = 20) -> FetchResult | None:
    request = Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
        },
        method="GET",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            body = response.read().decode(charset, errors="replace")
            return FetchResult(url=response.geturl(), text=body)
    except (HTTPError, HTTPException, URLError, TimeoutError, ValueError):
        return None


def _fetch_sitemap(
    url: str,
    *,
    fetch: Callable[[str], FetchResult | None],
    browser_fetcher: Callable[[str], FetchResult | None] | None,
    browser_fallback_enabled: bool,
    blocked_urls: list[str],
) -> FetchResult | None:
    fetched = fetch(url)
    if fetched is not None and not _looks_like_site_protection_challenge(fetched.text):
        return fetched
    if fetched is not None:
        blocked_urls.append(fetched.url)

    if not browser_fallback_enabled or browser_fetcher is None:
        return None

    browser_fetched = browser_fetcher(url)
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

    store_domain = canonical_domain(store_url)
    urls: list[str] = []
    for loc in _loc_values(text):
        sitemap_url = urljoin(base_url, loc)
        normalized = sitemap_url.casefold()
        if canonical_domain(sitemap_url) != store_domain:
            continue
        if "sitemap" not in normalized:
            continue
        if product_only and "product" not in normalized:
            continue
        urls.append(sitemap_url)
    return _dedupe(urls)


def _direct_product_sitemap_urls(store_url: str) -> list[str]:
    return [urljoin(store_url, path) for path in DIRECT_PRODUCT_SITEMAP_PATHS]


def _product_urls_from_text(text: str, sitemap_url: str, store_url: str) -> list[str]:
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
