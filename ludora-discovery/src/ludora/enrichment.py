from __future__ import annotations

import re
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse, urlunparse

from ludora.filtering import canonical_domain, normalize_text
from ludora.models import SiteMetadata


CITY_STATE_PAIRS = [
    ("Aguascalientes", "Aguascalientes", ("aguascalientes",)),
    ("Cancún", "Quintana Roo", ("cancun", "cancún")),
    ("Ciudad de México", "Ciudad de México", ("ciudad de mexico", "cdmx", "mexico city")),
    ("Guadalajara", "Jalisco", ("guadalajara",)),
    ("León", "Guanajuato", ("leon", "león")),
    ("Mérida", "Yucatán", ("merida", "mérida")),
    ("Monterrey", "Nuevo León", ("monterrey",)),
    ("Puebla", "Puebla", ("puebla",)),
    ("Querétaro", "Querétaro", ("queretaro", "querétaro")),
    ("Tijuana", "Baja California", ("tijuana",)),
    ("Toluca", "Estado de México", ("toluca",)),
    ("Zapopan", "Jalisco", ("zapopan",)),
]

STATE_ALIASES = [
    ("Aguascalientes", ("aguascalientes",)),
    ("Baja California", ("baja california",)),
    ("Baja California Sur", ("baja california sur",)),
    ("Campeche", ("campeche",)),
    ("Chiapas", ("chiapas",)),
    ("Chihuahua", ("chihuahua",)),
    ("Ciudad de México", ("ciudad de mexico", "cdmx")),
    ("Coahuila", ("coahuila",)),
    ("Colima", ("colima",)),
    ("Durango", ("durango",)),
    ("Estado de México", ("estado de mexico", "edomex")),
    ("Guanajuato", ("guanajuato",)),
    ("Guerrero", ("guerrero",)),
    ("Hidalgo", ("hidalgo",)),
    ("Jalisco", ("jalisco",)),
    ("Michoacán", ("michoacan", "michoacán")),
    ("Morelos", ("morelos",)),
    ("Nayarit", ("nayarit",)),
    ("Nuevo León", ("nuevo leon", "nuevo león")),
    ("Oaxaca", ("oaxaca",)),
    ("Puebla", ("puebla",)),
    ("Querétaro", ("queretaro", "querétaro")),
    ("Quintana Roo", ("quintana roo",)),
    ("San Luis Potosí", ("san luis potosi", "san luis potosí")),
    ("Sinaloa", ("sinaloa",)),
    ("Sonora", ("sonora",)),
    ("Tabasco", ("tabasco",)),
    ("Tamaulipas", ("tamaulipas",)),
    ("Tlaxcala", ("tlaxcala",)),
    ("Veracruz", ("veracruz",)),
    ("Yucatán", ("yucatan", "yucatán")),
    ("Zacatecas", ("zacatecas",)),
]

ENRICHMENT_PATH_KEYWORDS = (
    "contact",
    "contacto",
    "nosotros",
    "about",
    "ubicacion",
    "ubicaciones",
    "sucursales",
    "tiendas",
)


class MetadataParser(HTMLParser):
    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.meta: dict[str, str] = {}
        self.icons: list[str] = []
        self.links: list[str] = []
        self.text_parts: list[str] = []
        self.title_parts: list[str] = []
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = {name.casefold(): value or "" for name, value in attrs}
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = attr.get("property") or attr.get("name") or attr.get("itemprop")
            content = attr.get("content", "").strip()
            if key and content:
                self.meta[key.casefold()] = content
        elif tag == "link":
            rel = attr.get("rel", "").casefold()
            href = attr.get("href", "").strip()
            if href and "icon" in rel:
                self.icons.append(urljoin(self.base_url, href))
        elif tag == "a":
            href = attr.get("href", "").strip()
            if href:
                self.links.append(urljoin(self.base_url, href))

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if not text:
            return
        self.text_parts.append(text)
        if self._in_title:
            self.title_parts.append(text)


def extract_site_metadata(html: str, base_url: str) -> SiteMetadata:
    parser = MetadataParser(base_url)
    parser.feed(html)

    page_text = " ".join(parser.text_parts)
    city, state = infer_location(page_text)
    return SiteMetadata(
        store_name=_best_store_name(parser),
        instagram_url=_first_social_url(parser.links, "instagram"),
        facebook_url=_first_social_url(parser.links, "facebook"),
        city=city,
        state=state,
        country="Mexico",
        store_logo=_best_logo(parser, base_url),
        page_text=page_text,
        internal_links=_internal_enrichment_links(parser.links, base_url),
    )


def merge_metadata(primary: SiteMetadata, secondary: SiteMetadata) -> SiteMetadata:
    primary.store_name = primary.store_name or secondary.store_name
    primary.instagram_url = primary.instagram_url or secondary.instagram_url
    primary.facebook_url = primary.facebook_url or secondary.facebook_url
    primary.city = primary.city or secondary.city
    primary.state = primary.state or secondary.state
    primary.store_logo = primary.store_logo or secondary.store_logo
    primary.page_text = " ".join(part for part in [primary.page_text, secondary.page_text] if part)
    for link in secondary.internal_links:
        if link not in primary.internal_links:
            primary.internal_links.append(link)
    return primary


def infer_location(text: str) -> tuple[str, str]:
    normalized = normalize_text(text)
    for city, state, aliases in CITY_STATE_PAIRS:
        if any(_contains_location_alias(normalized, alias) for alias in aliases):
            return city, state
    for state, aliases in STATE_ALIASES:
        if any(_contains_location_alias(normalized, alias) for alias in aliases):
            return "", state
    return "", ""


def _contains_location_alias(normalized_text: str, alias: str) -> bool:
    normalized_alias = normalize_text(alias)
    searchable = normalized_text
    if normalized_alias == "leon":
        searchable = searchable.replace("nuevo leon", "")
    return re.search(rf"\b{re.escape(normalized_alias)}\b", searchable) is not None


def _best_store_name(parser: MetadataParser) -> str:
    for key in ("og:site_name", "application-name", "og:title", "twitter:title"):
        value = parser.meta.get(key, "").strip()
        if value:
            return _clean_title(value)
    return _clean_title(" ".join(parser.title_parts))


def _clean_title(value: str) -> str:
    value = " ".join(value.split())
    for separator in (" | ", " - ", " – ", " — "):
        if separator in value:
            value = value.split(separator, 1)[0]
    return value.strip()


def _best_logo(parser: MetadataParser, base_url: str) -> str:
    for key in ("og:image", "twitter:image", "image"):
        value = parser.meta.get(key, "").strip()
        if value:
            return urljoin(base_url, value)
    return parser.icons[0] if parser.icons else ""


def _first_social_url(links: list[str], platform: str) -> str:
    for link in links:
        canonical = _canonical_social_url(link, platform)
        if canonical:
            return canonical
    return ""


def _canonical_social_url(url: str, platform: str) -> str:
    parsed = urlparse(url)
    host = canonical_domain(url)
    path_parts = [part for part in parsed.path.split("/") if part]
    if not path_parts:
        return ""

    if platform == "instagram" and host == "instagram.com":
        if path_parts[0].casefold() in {"p", "reel", "stories", "explore", "accounts"}:
            return ""
        return f"https://instagram.com/{path_parts[0]}"

    if platform == "facebook" and host == "facebook.com":
        if path_parts[0].casefold() in {"share", "sharer", "plugins", "events"}:
            return ""
        return f"https://facebook.com/{path_parts[0]}"

    return ""


def _internal_enrichment_links(links: list[str], base_url: str) -> list[str]:
    base_domain = canonical_domain(base_url)
    selected: list[str] = []
    seen: set[str] = set()

    for link in links:
        parsed = urlparse(link)
        if canonical_domain(link) != base_domain:
            continue
        path = parsed.path.casefold()
        if not any(keyword in path for keyword in ENRICHMENT_PATH_KEYWORDS):
            continue
        cleaned = urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))
        if cleaned not in seen:
            seen.add(cleaned)
            selected.append(cleaned)
    return selected
