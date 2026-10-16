from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from ipaddress import ip_address
from urllib.parse import ParseResult, parse_qs, unquote, urljoin, urlparse, urlunparse
from xml.etree import ElementTree

from ludora.filtering import canonical_domain
from ludora.models import DiscoveryItemCandidateRecord


SITEMAP_NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9"
NON_PRODUCT_SEGMENTS = {
    "account", "admin", "api", "authentication", "blog", "brand", "brands", "cart", "category", "categories",
    "checkout", "collection", "collections", "contact", "contacto", "content", "customer", "customers",
    "login", "logout", "my-account", "order", "page", "pages", "privacy-policy", "registration", "search", "send_email",
    "tag", "tags", "terms-and-conditions", "wishlist",
}
NON_PRODUCT_SUFFIXES = (".xml", ".xml.gz", ".txt", ".json", ".js", ".css", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".pdf")
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
PRODUCT_LINK_CLASSES = {"product-image", "product-name", "product-title"}
NON_PRODUCT_LINK_CLASSES = {"category", "product-category", "brand", "btn", "button", "add-to-cart", "quick-view"}
NON_PRODUCT_CONTEXT_CLASSES = NON_PRODUCT_LINK_CLASSES | {
    "navigation", "nav", "menu", "action", "actions", "product-action", "product-actions", "product-brand",
}
ACTION_TITLES = {"comprar", "comprar ahora", "agregar al carrito", "añadir al carrito", "add to cart", "quick view", "ver más"}
HOST_LABEL_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", re.IGNORECASE)


def jumpseller_sitemap_product_urls(text: str, sitemap_url: str, store_url: str) -> list[str]:
    """Read the Jumpseller product priority from each direct urlset entry."""
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError:
        return []
    if root.tag == "urlset":
        namespace = ""
    elif root.tag == f"{{{SITEMAP_NAMESPACE}}}urlset":
        namespace = f"{{{SITEMAP_NAMESPACE}}}"
    else:
        return []

    urls: list[str] = []
    for entry in root.findall(namespace + "url"):
        locations = entry.findall(namespace + "loc")
        priorities = entry.findall(namespace + "priority")
        if len(locations) != 1 or len(priorities) != 1 or len(locations[0]) or len(priorities[0]):
            continue
        try:
            product_priority = float(priorities[0].text or "") == 0.8
        except ValueError:
            continue
        if not product_priority:
            continue
        url = _product_url(locations[0].text or "", sitemap_url, store_url, require_absolute=True)
        if url is not None:
            urls.append(url)
    return list(dict.fromkeys(urls))


def _valid_http_authority(parsed: ParseResult) -> bool:
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.netloc.endswith(":")):
        return False
    if parsed.port not in {None, 80, 443}:
        return False
    hostname = parsed.hostname
    if ":" in hostname:
        try:
            ip_address(hostname)
        except ValueError:
            return False
        return True
    try:
        # One terminal DNS root dot is valid; empty labels elsewhere are not.
        hostname = hostname.encode("idna").decode("ascii").removesuffix(".")
    except UnicodeError:
        return False
    return len(hostname) <= 253 and all(HOST_LABEL_RE.fullmatch(label) for label in hostname.split("."))


def _product_url(value: str, base_url: str, store_url: str, *, require_absolute: bool = False) -> str | None:
    value = html.unescape(value).strip()
    if not value or value.startswith(("#", "?")) or "\\" in value:
        return None
    if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in value):
        return None
    try:
        reference = urlparse(value)
        if reference.scheme:
            if not _valid_http_authority(reference):
                return None
        elif require_absolute:
            return None
        elif value.startswith("//") and not _valid_http_authority(reference._replace(scheme=urlparse(base_url).scheme)):
            return None
        parsed = urlparse(urljoin(base_url, value))
        store = urlparse(store_url)
        if not _valid_http_authority(parsed) or not _valid_http_authority(store):
            return None
        if canonical_domain(parsed.geturl()) != canonical_domain(store_url):
            return None
        path = unquote(parsed.path).casefold()
        if "\\" in path or any(ord(character) < 32 or ord(character) == 127 for character in path):
            return None
        segments = set(path.strip("/").split("/"))
        if not path.strip("/") or segments & (NON_PRODUCT_SEGMENTS | {".", ".."}) or path.endswith(NON_PRODUCT_SUFFIXES):
            return None
        if {key.casefold() for key in parse_qs(parsed.query, keep_blank_values=True)} & {"add-to-cart", "add_to_cart", "action"}:
            return None
        return urlunparse(parsed._replace(params="", query="", fragment=""))
    except ValueError:
        return None


@dataclass
class _CardLink:
    url: str
    product_link: bool
    title_link: bool
    text: list[str] = field(default_factory=list)
    image_titles: list[str] = field(default_factory=list)


class _ProductCardParser(HTMLParser):
    def __init__(self, page_url: str, store_url: str):
        super().__init__(convert_charrefs=True)
        self.page_url = page_url
        self.store_url = store_url
        self.cards: list[list[_CardLink]] = []
        self.stack: list[tuple[str, bool]] = []
        self.card_depth: int | None = None
        self.links: list[_CardLink] = []
        self.current_link: _CardLink | None = None
        self.link_depth: int | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = {name: value or "" for name, value in attrs}
        classes = set(attr.get("class", "").casefold().split())
        if tag == "img" and self.current_link is not None:
            self.current_link.product_link = True
            self.current_link.image_titles.append(attr.get("alt", ""))
        if tag in VOID_TAGS:
            return
        excluded_context = bool(
            classes & NON_PRODUCT_CONTEXT_CLASSES
            or tag in {"nav", "header", "footer", "form", "button"}
            or attr.get("role", "").casefold() in {"navigation", "button"}
            or (self.stack and self.stack[-1][1])
        )
        self.stack.append((tag, excluded_context))
        depth = len(self.stack) - 1
        if self.card_depth is None and "product-block" in classes:
            self.card_depth = depth
            self.links = []
        if tag != "a" or self.card_depth is None:
            return
        self.current_link = None
        self.link_depth = depth
        if excluded_context:
            return
        url = _product_url(attr.get("href", ""), self.page_url, self.store_url)
        if url is None:
            return
        heading = any(tag in {"h1", "h2", "h3", "h4", "h5", "h6"} for tag, _ in self.stack[self.card_depth + 1:])
        title_link = heading or bool(classes & {"product-name", "product-title"})
        self.current_link = _CardLink(url, heading or bool(classes & PRODUCT_LINK_CLASSES), title_link)
        self.links.append(self.current_link)

    def handle_endtag(self, tag: str) -> None:
        for depth in range(len(self.stack) - 1, -1, -1):
            if self.stack[depth][0] == tag:
                break
        else:
            return
        if self.link_depth is not None and depth <= self.link_depth:
            self.current_link = None
            self.link_depth = None
        if self.card_depth is not None and depth <= self.card_depth:
            self.cards.append(self.links)
            self.card_depth = None
            self.links = []
        del self.stack[depth:]

    def handle_data(self, data: str) -> None:
        if self.current_link is not None:
            self.current_link.text.append(data)


def extract_jumpseller_listing_candidates(
    html: str,
    page_url: str,
    store_id: int | None,
    limit: int | None = None,
    *,
    store_url: str | None = None,
) -> list[DiscoveryItemCandidateRecord]:
    parser = _ProductCardParser(page_url, store_url or page_url)
    parser.feed(html)
    parser.close()
    records: list[DiscoveryItemCandidateRecord] = []
    seen: set[str] = set()
    for card in parser.cards:
        links_by_url: dict[str, list[_CardLink]] = {}
        for link in card:
            if link.product_link:
                links_by_url.setdefault(link.url, []).append(link)
        for url, links in links_by_url.items():
            if limit is not None and len(records) >= limit:
                return records
            if url in seen:
                continue
            # Image links can contain promotion badges; only name/heading links
            # supply text titles. Image alt remains the full-name fallback.
            titles = [" ".join(" ".join(link.text).split()) for link in links if link.title_link]
            titles = [title for title in titles if title and title.casefold() not in ACTION_TITLES]
            image_titles = [" ".join(title.split()) for link in links for title in link.image_titles if title.strip()]
            image_titles = [title for title in image_titles if title.casefold() not in ACTION_TITLES]
            title = next(iter(titles), "")
            if image_titles and (not title or title.endswith(("..", "…"))):
                title = image_titles[0]
            if not title:
                continue
            seen.add(url)
            records.append(DiscoveryItemCandidateRecord(
                store_id=store_id, source_url=url, title=title, source_listing_url=page_url,
            ))
    return records
