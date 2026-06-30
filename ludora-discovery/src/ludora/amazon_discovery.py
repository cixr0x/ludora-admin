from __future__ import annotations

import re
import time
import unicodedata
from collections.abc import Callable, Iterable
from html.parser import HTMLParser
from urllib.parse import urlencode, urljoin, urlparse, urlunparse

from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.item_classification import apply_item_classification
from ludora.listing_extraction import _collapse_text, _extract_availability, _extract_price
from ludora.models import DiscoveryItemCandidateRecord, ItemCandidateType
from ludora.product_crawler import ItemCandidateProcessor, ItemCandidateRepository, ItemClassifier
from ludora.webfetch import FetchResult


DEFAULT_AMAZON_STORE_SEARCH_TERMS = ("jue",)
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
    cancellation_token: CancellationToken | None = None,
    delay_seconds: float = 1.0,
) -> list[DiscoveryItemCandidateRecord]:
    raise_if_cancelled(cancellation_token)
    browser_session = None
    if browser_fetcher is None:
        from ludora.browser_fetch import BrowserTextFetcher

        browser_session = BrowserTextFetcher()
        browser_fetcher = browser_session.__enter__().fetch

    records: list[DiscoveryItemCandidateRecord] = []
    seen_asins: set[str] = set()
    try:
        for raw_term in search_terms:
            raise_if_cancelled(cancellation_token)
            term = str(raw_term).strip()
            if not term:
                continue
            search_url = build_amazon_store_search_url(store_url, term)
            fetched_listing = browser_fetcher(search_url)
            if fetched_listing is None:
                continue
            listing_url = fetched_listing.url or search_url
            listing_candidates = _extract_amazon_listing_candidates(
                html=fetched_listing.text,
                page_url=listing_url,
                store_id=store_id,
            )
            for listing_candidate in listing_candidates:
                raise_if_cancelled(cancellation_token)
                asin = listing_candidate.store_sku
                if asin in seen_asins:
                    continue
                seen_asins.add(asin)
                if repository.item_candidate_exists(listing_candidate.store_id, listing_candidate.source_url):
                    continue

                fetched_detail = browser_fetcher(listing_candidate.source_url)
                if fetched_detail is not None:
                    detail_candidate = _extract_amazon_detail_candidate(
                        html=fetched_detail.text,
                        product_url=listing_candidate.source_url,
                        store_id=store_id,
                        source_listing_url=listing_url,
                        search_title=listing_candidate.title,
                    )
                else:
                    detail_candidate = listing_candidate
                    detail_candidate.raw_payload = {
                        "amazon": {
                            "asin": asin,
                            "search_title": listing_candidate.title,
                        }
                    }

                raise_if_cancelled(cancellation_token)
                _apply_item_title_extractor(detail_candidate, item_title_extractor)
                item_classifier(detail_candidate)
                upsert_result = repository.upsert_item_candidate(detail_candidate)
                if item_processor is not None and getattr(upsert_result, "should_process", False):
                    item_processor.process_candidate(int(getattr(upsert_result, "candidate_id")), detail_candidate)
                records.append(detail_candidate)
                if limit is not None and len(records) >= limit:
                    return records
                if delay_seconds > 0:
                    time.sleep(delay_seconds)
        return records
    finally:
        if browser_session is not None:
            browser_session.__exit__(None, None, None)


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
        self.h1_parts: list[str] = []
        self.html_title_parts: list[str] = []
        self.availability_parts: list[str] = []
        self.price_texts: list[str] = []
        self.bullets: list[str] = []
        self.product_details: dict[str, str] = {}
        self.image_url = ""
        self.text_nodes: list[str] = []
        self._ignored_depth = 0
        self._title_depth = 0
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

        self._extend_active_captures(normalized_tag)
        if id_value == "producttitle":
            self._title_depth = 1
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
    availability_text = _availability_text(parser)
    _, availability = _extract_availability(availability_text)
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
    raw_payload: dict[str, object] = {
        "amazon": {
            "asin": asin,
            "bullets": parser.bullets,
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
        publisher=_first_text(
            _detail_value(parser.product_details, "Fabricante", "Manufacturer"),
            _detail_value(parser.product_details, "Marca", "Nombre de la marca", "Brand"),
        ),
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


def _availability_text(parser: _AmazonProductParser) -> str:
    value = _collapse_text(" ".join(parser.availability_parts))
    if "{" in value:
        value = value.split("{", 1)[0]
    return _collapse_text(value)


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
