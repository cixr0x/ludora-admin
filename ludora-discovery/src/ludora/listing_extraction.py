from __future__ import annotations

import re
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse, urlunparse

from ludora.filtering import canonical_domain
from ludora.models import DiscoveryItemCandidateRecord


PRODUCT_PATH_MARKERS = (
    "/product/",
    "/products/",
    "/producto/",
    "/productos/",
    "/juego/",
    "/juegos/",
)

PRICE_RE = re.compile(
    r"(?:\$\s*([0-9][0-9,.]*)|([0-9][0-9,.]*)\s*mxn|mxn\s*([0-9][0-9,.]*))",
    re.IGNORECASE,
)


class ListingLinkParser(HTMLParser):
    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.events: list[tuple[str, str, str]] = []
        self._current_href = ""
        self._current_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        attr = {name.casefold(): value or "" for name, value in attrs}
        href = attr.get("href", "").strip()
        if href:
            self._current_href = urljoin(self.base_url, href)
            self._current_text = []

    def handle_endtag(self, tag: str) -> None:
        if tag != "a" or not self._current_href:
            return
        title = _collapse_text(" ".join(self._current_text))
        if title:
            self.events.append(("link", self._current_href, title))
        self._current_href = ""
        self._current_text = []

    def handle_data(self, data: str) -> None:
        text = _collapse_text(data)
        if not text:
            return
        if self._current_href:
            self._current_text.append(text)
            return
        self.events.append(("text", "", text))


def extract_listing_candidates(
    html: str,
    page_url: str,
    store_id: int | None,
    limit: int | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    parser = ListingLinkParser(page_url)
    parser.feed(html)

    records: list[DiscoveryItemCandidateRecord] = []
    seen: set[tuple[str, str]] = set()
    page_domain = canonical_domain(page_url)

    for index, (event_type, href, title) in enumerate(parser.events):
        if limit is not None and len(records) >= limit:
            break
        if event_type != "link":
            continue
        if canonical_domain(href) != page_domain:
            continue
        if not _looks_like_product_url(href):
            continue

        source_url = _clean_url(href)
        key = (source_url, title.casefold())
        if key in seen:
            continue
        seen.add(key)

        context = _nearby_text(parser.events, index)
        raw_price, parsed_price = _extract_price(context)
        _, parsed_availability = _extract_availability(context)

        records.append(
            DiscoveryItemCandidateRecord(
                store_id=store_id,
                source_url=source_url,
                title=title,
                raw_price=raw_price,
                price=parsed_price,
                price_source="listing_context" if parsed_price else "none",
                availability=parsed_availability,
                availability_source="listing_context" if parsed_availability != "unknown" else "none",
            )
        )

    return records


def _nearby_text(events: list[tuple[str, str, str]], link_index: int) -> str:
    text_parts: list[str] = []
    for event_type, _, text in reversed(events[max(0, link_index - 3) : link_index]):
        if event_type == "link":
            break
        text_parts.insert(0, text)
    for event_type, _, text in events[link_index + 1 : link_index + 8]:
        if event_type == "link":
            break
        text_parts.append(text)
    return " ".join(text_parts)


def _looks_like_product_url(url: str) -> bool:
    path = urlparse(url).path.casefold()
    return any(marker in path for marker in PRODUCT_PATH_MARKERS)


def _clean_url(url: str) -> str:
    parsed = urlparse(url)
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))


def _extract_price(text: str) -> tuple[str, str]:
    match = PRICE_RE.search(text)
    if not match:
        return "", ""
    raw = match.group(0).strip()
    value = next(group for group in match.groups() if group)
    normalized = value.replace(",", "").strip()
    if "." not in normalized:
        normalized = f"{normalized}.00"
    return raw, normalized


def _extract_availability(text: str) -> tuple[str, str]:
    normalized = text.casefold()
    if any(term in normalized for term in ("agotado", "sin stock", "no disponible")):
        return text, "out_of_stock"
    if any(term in normalized for term in ("disponible", "en stock", "agregar al carrito", "comprar")):
        return text, "available"
    return "", "unknown"


def _collapse_text(value: str) -> str:
    return " ".join(value.split())
