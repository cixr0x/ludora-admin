from __future__ import annotations

import json
import os
import re
import unicodedata
from html import unescape
from pathlib import Path
from urllib.parse import urlparse

from ludora.trace import TraceLogger
from ludora.webfetch import FetchResult


class BrowserFetchUnavailable(RuntimeError):
    pass


class AmazonStoreSearchIncomplete(RuntimeError):
    pass


AMAZON_STORE_SCROLL_WAIT_MS = 750
AMAZON_STORE_STABLE_SCROLL_ROUNDS = 3
AMAZON_STORE_LOAD_MORE_TIMEOUT_MS = 15_000
AMAZON_STORE_MAX_STALLED_LOAD_MORE_CLICKS = 4
AMAZON_STORE_BATCH_COOLDOWN_MS = 5_000
AMAZON_STORE_STALLED_LOAD_MORE_BACKOFF_MS = 10_000


def fetch_sitemap_text_with_browser(url: str, timeout_ms: int = 30_000) -> FetchResult | None:
    return fetch_text_with_browser(url, timeout_ms=timeout_ms)


class BrowserTextFetcher:
    def __init__(self, timeout_ms: int = 30_000, trace_logger: TraceLogger | None = None) -> None:
        self.timeout_ms = timeout_ms
        self.trace_logger = trace_logger
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None
        self._playwright_error = Exception
        self._playwright_timeout_error = Exception

    def __enter__(self) -> BrowserTextFetcher:
        try:
            from playwright.sync_api import Error as PlaywrightError
            from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
            from playwright.sync_api import sync_playwright
        except ImportError as exc:  # pragma: no cover - depends on local environment.
            raise BrowserFetchUnavailable("Playwright is not installed. Install discovery dependencies first.") from exc

        self._playwright_error = PlaywrightError
        self._playwright_timeout_error = PlaywrightTimeoutError
        self._playwright = sync_playwright().start()
        chrome_path = _chrome_executable_path()
        self._browser = self._playwright.chromium.launch(
            executable_path=chrome_path,
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        self._context = self._browser.new_context(
            locale="es-MX",
            user_agent=_browser_user_agent(chrome_path),
            viewport={"width": 1365, "height": 900},
            extra_http_headers={"Accept-Language": "es-MX,es;q=0.9,en;q=0.8"},
        )
        self._context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined});")
        self._page = self._context.new_page()
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        if self._browser is not None:
            self._browser.close()
        if self._playwright is not None:
            self._playwright.stop()

    def fetch(self, url: str) -> FetchResult | None:
        page = self._context.new_page() if self._context is not None else self._page
        close_page_after_fetch = self._context is not None
        if page is None:
            raise BrowserFetchUnavailable("Browser fetcher has not been started.")

        try:
            response = _navigate_past_reload_challenge(page, url, timeout_ms=self.timeout_ms)
            if response is None:
                return FetchResult(url=page.url, text=page.content())
            if _is_xml_response(response):
                return FetchResult(
                    url=response.url,
                    text=response.text(),
                    status_code=int(getattr(response, "status", 200)),
                )
            _wait_for_rendered_html(
                page,
                url,
                timeout_ms=self.timeout_ms,
                timeout_error=self._playwright_timeout_error,
            )
            rendered_html = page.content()
            if _is_amazon_store_search_url(page.url or url):
                rendered_html, embedded_asin_count = _append_embedded_amazon_store_asin_links(rendered_html)
                if embedded_asin_count == 0:
                    _load_all_amazon_store_search_results(
                        page,
                        timeout_ms=self.timeout_ms,
                        timeout_error=self._playwright_timeout_error,
                    )
                    rendered_html = page.content()
            return FetchResult(
                url=page.url,
                text=rendered_html,
                status_code=int(getattr(response, "status", 200)),
            )
        except (
            AmazonStoreSearchIncomplete,
            self._playwright_error,
            self._playwright_timeout_error,
            OSError,
            ValueError,
        ) as exc:
            if self.trace_logger is not None:
                self.trace_logger.log(
                    "browser_fetch.failed",
                    error=str(exc),
                    error_type=type(exc).__name__,
                    final_url=getattr(page, "url", ""),
                    timeout_ms=self.timeout_ms,
                    url=url,
                )
            return None
        finally:
            if close_page_after_fetch:
                page.close()


def fetch_text_with_browser(url: str, timeout_ms: int = 30_000) -> FetchResult | None:
    with BrowserTextFetcher(timeout_ms=timeout_ms) as fetcher:
        return fetcher.fetch(url)


def _navigate_past_reload_challenge(page, url: str, *, timeout_ms: int):
    response = None
    for attempt in range(3):
        response = page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        text = page.content()
        if not _looks_like_reload_challenge(text):
            return response
        if attempt < 2:
            page.wait_for_timeout(6_000)
    return response


def _looks_like_reload_challenge(text: str) -> bool:
    normalized = " ".join(text.casefold().split())
    has_reload_loop = "window.location.reload" in normalized or "location.reload" in normalized
    has_challenge_title = (
        "<title>one moment" in normalized
        or "<title>un momento" in normalized
        or "<title>just a moment" in normalized
    )
    return has_reload_loop and has_challenge_title


def _is_xml_response(response) -> bool:
    content_type = str(response.headers.get("content-type", "")).casefold()
    return "xml" in content_type and "html" not in content_type


def _is_amazon_store_search_url(url: str) -> bool:
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").casefold()
    path = parsed.path.rstrip("/").casefold()
    is_amazon_host = bool(re.search(r"(^|\.)amazon\.", hostname))
    return is_amazon_host and bool(re.fullmatch(r"/stores/page/[^/]+/search", path))


def _append_embedded_amazon_store_asin_links(html: str) -> tuple[str, int]:
    decoded_html = unescape(html)
    asin_lists: list[list[str]] = []
    for match in re.finditer(r'"ASINList"\s*:\s*(\[[^\]]*\])', decoded_html):
        try:
            raw_asins = json.loads(match.group(1))
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(raw_asins, list):
            continue
        unique_asins: list[str] = []
        seen_asins: set[str] = set()
        for raw_asin in raw_asins:
            asin = str(raw_asin).strip().upper()
            if not re.fullmatch(r"[A-Z0-9]{10}", asin) or asin in seen_asins:
                continue
            seen_asins.add(asin)
            unique_asins.append(asin)
        if unique_asins:
            asin_lists.append(unique_asins)

    if not asin_lists:
        return html, 0

    asins = max(asin_lists, key=len)
    links = "".join(
        f'<a data-ludora-amazon-store-asin="{asin}" href="/dp/{asin}"></a>'
        for asin in asins
    )
    container = f'<div data-ludora-amazon-store-asins="true" hidden>{links}</div>'
    body_end_index = html.casefold().rfind("</body>")
    if body_end_index < 0:
        return html + container, len(asins)
    return html[:body_end_index] + container + html[body_end_index:], len(asins)


def _load_all_amazon_store_search_results(page, *, timeout_ms: int, timeout_error) -> None:
    max_rounds = max(1, min(50, timeout_ms // AMAZON_STORE_SCROLL_WAIT_MS))
    previous_product_count = -1
    previous_scroll_height = -1
    stable_rounds = 0
    stalled_load_more_clicks = 0
    last_product_count = 0
    last_load_more_button_present = False

    for _ in range(max_rounds):
        snapshot = page.evaluate(
            r"""
            () => {
              const asinPattern = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i;
              const asins = new Set();
              for (const link of document.querySelectorAll('a[href]')) {
                const match = link.href.match(asinPattern);
                if (match) asins.add(match[1].toUpperCase());
              }

              const normalize = value => (value || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim()
                .toLowerCase();
              const loadMoreButton = Array.from(document.querySelectorAll('button')).find(button => {
                const label = normalize(button.innerText || button.getAttribute('aria-label'));
                return label === 'mostrar mas' || label === 'show more';
              });
              const loadMoreButtonPresent = Boolean(
                loadMoreButton && loadMoreButton.getClientRects().length > 0
              );
              const loadMoreButtonEnabled = Boolean(
                loadMoreButtonPresent
                && !loadMoreButton.disabled
                && loadMoreButton.getAttribute('aria-disabled') !== 'true'
              );
              const scrollHeight = document.documentElement.scrollHeight;
              if (loadMoreButtonEnabled) {
                loadMoreButton.scrollIntoView({ block: 'center' });
                loadMoreButton.click();
              } else {
                window.scrollTo(0, scrollHeight);
              }
              return {
                loadMoreButtonClicked: loadMoreButtonEnabled,
                loadMoreButtonPresent,
                productCount: asins.size,
                scrollHeight,
              };
            }
            """
        )
        product_count = int(snapshot.get("productCount", 0))
        scroll_height = int(snapshot.get("scrollHeight", 0))
        load_more_button_clicked = bool(snapshot.get("loadMoreButtonClicked", False))
        load_more_button_present = bool(snapshot.get("loadMoreButtonPresent", False))
        last_product_count = product_count
        last_load_more_button_present = load_more_button_present

        if product_count == previous_product_count and scroll_height == previous_scroll_height:
            stable_rounds += 1
        else:
            stable_rounds = 0

        if not load_more_button_present and stable_rounds >= AMAZON_STORE_STABLE_SCROLL_ROUNDS:
            break

        previous_product_count = product_count
        previous_scroll_height = scroll_height
        if load_more_button_clicked:
            try:
                page.wait_for_function(
                    r"""
                    previousProductCount => {
                      const asinPattern = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i;
                      const asins = new Set();
                      for (const link of document.querySelectorAll('a[href]')) {
                        const match = link.href.match(asinPattern);
                        if (match) asins.add(match[1].toUpperCase());
                      }
                      return asins.size > previousProductCount;
                    }
                    """,
                    arg=product_count,
                    timeout=min(timeout_ms, AMAZON_STORE_LOAD_MORE_TIMEOUT_MS),
                )
                stalled_load_more_clicks = 0
                page.wait_for_timeout(AMAZON_STORE_BATCH_COOLDOWN_MS)
            except timeout_error:
                stalled_load_more_clicks += 1
                if stalled_load_more_clicks >= AMAZON_STORE_MAX_STALLED_LOAD_MORE_CLICKS:
                    raise AmazonStoreSearchIncomplete(
                        "Amazon storefront search stopped advancing while the load-more button remained visible "
                        f"(loaded {product_count} unique products)"
                    )
                page.wait_for_timeout(
                    AMAZON_STORE_STALLED_LOAD_MORE_BACKOFF_MS * stalled_load_more_clicks
                )
        else:
            page.wait_for_timeout(AMAZON_STORE_SCROLL_WAIT_MS)
    else:
        reason = "load-more button remained visible" if last_load_more_button_present else "results never stabilized"
        raise AmazonStoreSearchIncomplete(
            f"Amazon storefront search did not finish loading all products: {reason} "
            f"(loaded {last_product_count} unique products)"
        )


def _wait_for_rendered_html(page, url: str, *, timeout_ms: int, timeout_error) -> None:
    try:
        page.wait_for_load_state("load", timeout=timeout_ms)
    except timeout_error:
        pass

    tokens = _significant_url_tokens(url)
    if not tokens:
        return

    try:
        page.wait_for_function(
            """
            tokens => {
              const rawText = document.body && document.body.innerText || '';
              const normalizedText = rawText
                .normalize('NFD')
                .replace(/[\\u0300-\\u036f]/g, '')
                .toLowerCase();
              const words = new Set((normalizedText.match(/[a-z0-9]+/g) || []));
              const hasProductMarker = /\\$\\s*[0-9]/.test(rawText)
                || words.has('cart')
                || words.has('carrito')
                || words.has('agotado')
                || (words.has('sold') && words.has('out'));
              return hasProductMarker && (tokens.length === 0 || tokens.some(token => words.has(token)));
            }
            """,
            arg=tokens,
            timeout=min(timeout_ms, 8_000),
        )
    except timeout_error:
        pass


def _significant_url_tokens(url: str) -> list[str]:
    slug = urlparse(url).path.rstrip("/").rsplit("/", 1)[-1]
    normalized = unicodedata.normalize("NFKD", slug.casefold()).encode("ascii", "ignore").decode("ascii")
    ignored = {
        "and",
        "com",
        "con",
        "de",
        "del",
        "edicion",
        "el",
        "en",
        "espanol",
        "for",
        "la",
        "las",
        "los",
        "mx",
        "ols",
        "para",
        "product",
        "products",
        "producto",
        "productos",
        "the",
        "tienda",
        "with",
        "www",
        "xn",
    }
    return [token for token in re.findall(r"[a-z0-9]+", normalized) if len(token) >= 4 and token not in ignored]


def _chrome_executable_path() -> str | None:
    configured_path = os.environ.get("LUDORA_BROWSER_EXECUTABLE_PATH", "").strip()
    if configured_path:
        return configured_path

    candidates = [
        Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


def _browser_user_agent(chrome_path: str | None) -> str:
    configured_user_agent = os.environ.get("LUDORA_BROWSER_USER_AGENT", "").strip()
    if configured_user_agent:
        return configured_user_agent

    version = _chrome_version_from_installation(chrome_path) or "125.0.0.0"
    return (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        f"Chrome/{version} Safari/537.36"
    )


def _chrome_version_from_installation(chrome_path: str | None) -> str | None:
    if not chrome_path:
        return None

    chrome_directory = Path(chrome_path).parent
    versions: list[tuple[tuple[int, ...], str]] = []
    for child in chrome_directory.iterdir():
        if not child.is_dir() or not re.fullmatch(r"\d+(?:\.\d+){1,3}", child.name):
            continue
        versions.append((tuple(int(part) for part in child.name.split(".")), child.name))
    if not versions:
        return None
    return max(versions, key=lambda item: item[0])[1]
