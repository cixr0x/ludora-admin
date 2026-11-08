from __future__ import annotations

import json
import posixpath
import re
import time
import unicodedata
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from queue import Empty, Queue
from threading import BoundedSemaphore, Thread
from urllib.error import HTTPError
from urllib.parse import SplitResult, quote_from_bytes, unquote, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from xml.etree import ElementTree

from ludora.cancellation import CancellationToken, OperationCancelled, raise_if_cancelled
from ludora.config import load_dotenv_values
from ludora.shopify_storefront import shopify_product_handle
from ludora.webfetch import FetchResult


SITEMAP_MISSING = "sitemap_missing"
ENV_KEY = "LUDORA_VERIFIED_UPDATE_SITEMAPS"
SNAPSHOT_TTL_SECONDS = 600
FAILURE_TTL_SECONDS = 30
MAX_CACHED_STORES = 8
MAX_DOCUMENTS = 64
MAX_DEPTH = 8
MAX_REDIRECTS = 4
MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024
MAX_DOCUMENT_ENTRIES = 50_000
MAX_PAGE_ENTRIES = 150_000
LOAD_BUDGET_SECONDS = 12.0
SOCKET_TIMEOUT_SECONDS = 3.0
CANCELLATION_POLL_SECONDS = 0.05
SITEMAP_NAMESPACE = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
HOST_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
BAD_ESCAPE = re.compile(r"%(?![a-fA-F0-9]{2})")
PERCENT_ESCAPE = re.compile(r"%([a-fA-F0-9]{2})")
_LOAD_SLOT = BoundedSemaphore()


@dataclass(frozen=True)
class _VerifiedSitemap:
    url: str
    min_urls: int


@dataclass(frozen=True)
class _PageMembership:
    paths: set[str]
    shopify_handles: set[str]


@dataclass(frozen=True)
class _CachedSnapshot:
    expires_at: float
    pages: _PageMembership | None


_DocumentIdentity = tuple[str, str, str, str]


class UpdateSitemapChecker:
    """Trust negative membership only in a fresh, complete, enrolled snapshot."""

    def __init__(
        self,
        configuration: Mapping[int, _VerifiedSitemap],
        *,
        fetcher: Callable[[str, float], FetchResult | None] | None = None,
        clock: Callable[[], float] = time.monotonic,
        load_budget_seconds: float = LOAD_BUDGET_SECONDS,
    ) -> None:
        self._configuration = configuration
        self._clock = clock
        self._load_budget_seconds = load_budget_seconds
        self._fetcher = fetcher
        self._cache: OrderedDict[tuple[int, bool], _CachedSnapshot] = OrderedDict()

    @classmethod
    def from_environment(
        cls,
        env: Mapping[str, str],
        env_file: str | Path,
        **kwargs,
    ) -> UpdateSitemapChecker:
        raw_config = env.get(ENV_KEY)
        if raw_config is None:
            try:
                raw_config = load_dotenv_values(env_file).get(ENV_KEY, "")
            except (OSError, UnicodeError):
                raw_config = ""
        try:
            decoded = json.loads(raw_config)
        except (ValueError, RecursionError):
            decoded = None
        configuration = {}
        if isinstance(decoded, dict):
            for store_id, value in decoded.items():
                if not re.fullmatch(r"[1-9][0-9]{0,18}", store_id) or not isinstance(value, dict):
                    continue
                url = value.get("url")
                min_urls = value.get("min_urls")
                if (
                    isinstance(url, str)
                    and _document_url(url) is not None
                    and type(min_urls) is int
                    and 1 <= min_urls <= MAX_PAGE_ENTRIES
                ):
                    configuration[int(store_id)] = _VerifiedSitemap(url, min_urls)
        return cls(configuration, **kwargs)

    def is_missing(
        self,
        store_id: int | None,
        source_url: str,
        *,
        store_url: str,
        platform: str = "",
        cancellation_token: CancellationToken | None = None,
    ) -> bool:
        raise_if_cancelled(cancellation_token)
        if store_id is None:
            return False
        config = self._configuration.get(store_id)
        if config is None:
            return False
        store = _http_url(store_url)
        source = _http_url(source_url)
        root = _document_url(config.url)
        if store is None or source is None or root is None:
            return False
        store_host = _store_host(store)
        if _store_host(source) != store_host or _store_host(root) != store_host:
            return False
        shopify = platform == "shopify"
        handle = _shopify_handle(source_url) if shopify else ""
        if shopify and not handle:
            return False

        cache_key = (store_id, shopify)
        cached = self._cache.get(cache_key)
        now = self._clock()
        if cached is None or cached.expires_at <= now:
            try:
                pages = self._load_within_budget(config, store_host, shopify, cancellation_token)
            except OperationCancelled:
                raise
            except Exception:
                raise_if_cancelled(cancellation_token)
                pages = None
            ttl = SNAPSHOT_TTL_SECONDS if pages is not None else FAILURE_TTL_SECONDS
            expires_at = (now if pages is not None else self._clock()) + ttl
            cached = self._cache[cache_key] = _CachedSnapshot(expires_at, pages)
        self._cache.move_to_end(cache_key)
        if len(self._cache) > MAX_CACHED_STORES:
            self._cache.popitem(last=False)
        raise_if_cancelled(cancellation_token)
        return (
            cached.pages is not None
            and _page_path(source) not in cached.pages.paths
            and handle not in cached.pages.shopify_handles
        )

    def _load_within_budget(
        self,
        config: _VerifiedSitemap,
        store_host: str,
        shopify: bool,
        cancellation_token: CancellationToken | None,
    ) -> _PageMembership | None:
        # urllib timeouts bound socket inactivity, so response headers can
        # outlive the deadline. Allow one in-flight load per process, without
        # queuing behind a blocked transport or consuming a late result.
        deadline = self._clock() + self._load_budget_seconds
        wall_deadline = time.monotonic() + self._load_budget_seconds
        completed: Queue[_PageMembership | Exception] = Queue(maxsize=1)

        def check_budget() -> float:
            raise_if_cancelled(cancellation_token)
            remaining = min(deadline - self._clock(), wall_deadline - time.monotonic())
            if remaining <= 0:
                raise TimeoutError("Sitemap time budget exceeded")
            return remaining

        def load() -> None:
            try:
                result = self._load(config, store_host, shopify, check_budget)
            except Exception as exc:
                result = exc
            finally:
                _LOAD_SLOT.release()
            completed.put_nowait(result)

        if not _LOAD_SLOT.acquire(blocking=False):
            return None
        try:
            Thread(target=load, name="update-sitemap", daemon=True).start()
        except Exception:
            _LOAD_SLOT.release()
            raise
        while True:
            wait_seconds = check_budget()
            if cancellation_token is not None:
                wait_seconds = min(wait_seconds, CANCELLATION_POLL_SECONDS)
            try:
                result = completed.get(timeout=wait_seconds)
            except Empty:
                continue
            check_budget()
            if isinstance(result, Exception):
                raise result
            return result

    def _load(
        self,
        config: _VerifiedSitemap,
        store_host: str,
        shopify: bool,
        check_budget: Callable[[], float],
    ) -> _PageMembership:
        active: set[_DocumentIdentity] = set()
        complete: dict[_DocumentIdentity, str] = {}
        final_urls: set[_DocumentIdentity] = set()
        pages = _PageMembership(set(), set())
        shopify_nonproduct_paths: set[str] = set()
        documents = total_bytes = page_entries = 0

        def visit(url: str, depth: int) -> None:
            nonlocal documents, total_bytes, page_entries
            check_budget()
            requested_identity = _document_identity(urlsplit(url))
            if requested_identity in active:
                raise ValueError("Cyclic sitemap index")
            if complete.get(requested_identity) == url:
                return
            if requested_identity in complete or requested_identity in final_urls:
                raise ValueError("Distinct sitemap references resolved to the same document")
            if documents >= MAX_DOCUMENTS or depth > MAX_DEPTH:
                raise ValueError("Sitemap traversal limit exceeded")
            documents += 1

            fetched = self._fetch(url, check_budget) if self._fetcher is None else self._fetcher(url, check_budget())
            check_budget()
            if fetched is None or fetched.status_code != 200 or fetched.error:
                raise ValueError("Sitemap request failed")
            final = _document_url(fetched.url)
            if final is None or _store_host(final) != store_host:
                raise ValueError("Untrusted sitemap redirect")
            final_identity = _document_identity(final)
            if final_identity in active:
                raise ValueError("Cyclic sitemap redirect")
            if final_identity in complete or final_identity in final_urls:
                raise ValueError("Distinct sitemap references resolved to the same document")
            document_bytes = len(fetched.text.encode("utf-8"))
            total_bytes += document_bytes
            if document_bytes > MAX_DOCUMENT_BYTES or total_bytes > MAX_SNAPSHOT_BYTES:
                raise ValueError("Sitemap size limit exceeded")

            is_index, locations = _locations(fetched.text)
            aliases = {requested_identity, final_identity}
            active.update(aliases)
            if is_index:
                for location in locations:
                    child = _document_url(location)
                    if child is None or _store_host(child) != store_host:
                        raise ValueError("Untrusted sitemap child")
                for location in locations:
                    visit(location, depth + 1)
            else:
                page_entries += len(locations)
                if page_entries > MAX_PAGE_ENTRIES:
                    raise ValueError("Sitemap page limit exceeded")
                for location in locations:
                    page = _http_url(location)
                    if page is None or _store_host(page) != store_host:
                        raise ValueError("Untrusted sitemap page")
                    path = _page_path(page)
                    pages.paths.add(path)
                    if shopify:
                        handle = _shopify_handle(location)
                        if handle:
                            pages.shopify_handles.add(handle)
                        elif not _shopify_handle(path):
                            # A plausible product alias cannot count as another page.
                            shopify_nonproduct_paths.add(path)
            active.difference_update(aliases)
            complete[requested_identity] = url
            final_urls.add(final_identity)

        visit(config.url, depth=0)
        check_budget()
        if shopify:
            if not pages.shopify_handles:
                raise ValueError("Sitemap has no recognizable Shopify products")
            coverage = len(pages.shopify_handles) + len(shopify_nonproduct_paths)
        else:
            coverage = len(pages.paths)
        if coverage < config.min_urls:
            raise ValueError("Sitemap is below the verified coverage floor")
        return pages

    def _fetch(self, url: str, check_budget: Callable[[], float]) -> FetchResult | None:
        store_host = _store_host(urlsplit(url))
        opener = build_opener(_NoRedirectHandler())
        for _ in range(MAX_REDIRECTS + 1):
            remaining = check_budget()
            request = Request(url, headers={
                "Accept": "application/xml, text/xml, */*;q=0.1",
                "User-Agent": "LudoraBot/1.0",
            })
            try:
                with opener.open(request, timeout=min(remaining, SOCKET_TIMEOUT_SECONDS)) as response:
                    if (
                        response.status != 200
                        or response.headers.get("Content-Range") is not None
                        or response.headers.get("cf-mitigated", "").strip().lower() == "challenge"
                    ):
                        return None
                    body = bytearray()
                    while len(body) <= MAX_DOCUMENT_BYTES:
                        check_budget()
                        chunk = response.read1(min(65536, MAX_DOCUMENT_BYTES + 1 - len(body)))
                        if not chunk:
                            # read1 can report EOF without raising IncompleteRead.
                            if response.length:
                                return None
                            return FetchResult(response.url, body.decode("utf-8-sig"))
                        body.extend(chunk)
                    return None
            except HTTPError as exc:
                with exc:
                    location = exc.headers.get("Location") if exc.code in (301, 302, 303, 307, 308) else None
                if not location:
                    return None
                destination = urljoin(url, location)
                redirect = _document_url(destination)
                if redirect is None or _store_host(redirect) != store_host:
                    return None
                if urlsplit(url).scheme == "https" and redirect.scheme != "https":
                    return None
                url = destination
        return None


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # The loader validates each target and does not drain redirect bodies.
        return None


def _http_url(value: str) -> SplitResult | None:
    if (
        not value or len(value) > 2048 or "\\" in value
        or BAD_ESCAPE.search(value)
        or any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        return None
    try:
        parts = urlsplit(value)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username is not None:
            return None
        port = 443 if parts.scheme == "https" else 80
        if parts.netloc.endswith(":") or parts.port not in (None, port):
            return None
        host = _ascii_hostname(parts)
        if not all(HOST_LABEL.fullmatch(label) for label in host.split(".")):
            return None
        unquote(parts.path, errors="strict")
        return parts
    except (ValueError, UnicodeError):
        return None


def _document_url(value: str) -> SplitResult | None:
    return _http_url(value) if "#" not in value else None


def _store_host(parts: SplitResult) -> str:
    return _ascii_hostname(parts).removeprefix("www.")


def _ascii_hostname(parts: SplitResult) -> str:
    return parts.hostname.encode("idna").decode("ascii").lower().removesuffix(".")


def _document_identity(parts: SplitResult) -> _DocumentIdentity:
    # Validation permits only the default port for the scheme. Omit it here
    # while preserving path case and query parameters that can select pages.
    return (
        parts.scheme,
        _ascii_hostname(parts),
        _normalize_uri_escapes(parts.path or "/"),
        _normalize_uri_escapes(parts.query),
    )


def _normalize_uri_escapes(component: str) -> str:
    # quote_from_bytes leaves RFC 3986 unreserved bytes literal and emits
    # uppercase escapes for the rest, including encoded separators.
    return PERCENT_ESCAPE.sub(
        lambda match: quote_from_bytes(bytes.fromhex(match[1]), safe=""),
        component,
    )


def _shopify_handle(url: str) -> str:
    try:
        return unicodedata.normalize("NFC", shopify_product_handle(url)).casefold()
    except ValueError:
        return ""


def _page_path(parts: SplitResult) -> str:
    # Collapse plausible aliases toward presence, even when a store might
    # distinguish them. The updater needs stronger evidence for absence.
    path = unicodedata.normalize("NFC", unquote(parts.path)).casefold()
    return posixpath.normpath("/" + path.lstrip("/"))


def _locations(text: str) -> tuple[bool, list[str]]:
    if "<!DOCTYPE" in text or "<!ENTITY" in text:
        raise ValueError("Sitemap declarations are unsupported")
    root = ElementTree.fromstring(text)
    namespace = SITEMAP_NAMESPACE if root.tag.startswith(SITEMAP_NAMESPACE) else ""
    is_index = root.tag == namespace + "sitemapindex"
    if not is_index and root.tag != namespace + "urlset":
        raise ValueError("Unrecognized sitemap root")
    if not 1 <= len(root) <= MAX_DOCUMENT_ENTRIES:
        raise ValueError("Empty or oversized sitemap")
    entry_tag = namespace + ("sitemap" if is_index else "url")
    locations = []
    for entry in root:
        locs = entry.findall(namespace + "loc")
        if entry.tag != entry_tag or len(locs) != 1 or len(locs[0]):
            raise ValueError("Malformed sitemap entry")
        location = (locs[0].text or "").strip()
        if not location:
            raise ValueError("Empty sitemap location")
        locations.append(location)
    return is_index, locations
