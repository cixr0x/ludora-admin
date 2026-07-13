from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlparse

from ludora.listing_extraction import _collapse_text, _extract_availability, _extract_price
from ludora.models import DiscoveryItemCandidateRecord, ItemCandidateType


PLAYER_RANGE_RE = re.compile(
    r"(?:jugadores?\s*:?\s*)?(?:de\s+)?(\d+)\s*(?:-|–|a)\s*(\d+)\s*jugadores?",
    re.IGNORECASE,
)
PLAYER_LABEL_RE = re.compile(r"jugadores?\s*:?\s*(\d+)\s*(?:-|–|a)\s*(\d+)", re.IGNORECASE)
MINUTES_RANGE_RE = re.compile(r"(\d+)\s*(?:-|–|a)\s*(\d+)\s*min", re.IGNORECASE)
MINUTES_SINGLE_RE = re.compile(r"(\d+)\s*min", re.IGNORECASE)
AGE_RE = re.compile(r"(?:edad|años|anos)\D{0,12}(\d+)\s*\+?", re.IGNORECASE)
PUBLISHER_RE = re.compile(r"(?:editorial|publisher)\s*:?\s*(.+)", re.IGNORECASE)
ENGLISH_LANGUAGE_RE = re.compile(r"\b(?:english|ingles)\b", re.IGNORECASE)
SPANISH_LANGUAGE_RE = re.compile(r"\b(?:spanish|espanol|castellano)\b", re.IGNORECASE)
HIGHLIGHTS_LABEL_RE = re.compile(r"\bhighlights?\s*:", re.IGNORECASE)
LANGUAGE_LABEL_RE = re.compile(r"\b(?:idioma|language)\s*:", re.IGNORECASE)
LANGUAGE_SNIPPET_STOPS = (
    " Añadir ",
    " Producto añadido",
    " Entrega ",
    " Productos Relacionados",
    " Related Products",
    " Menu ",
    " Menú ",
    " Contacto ",
)
MENU_CART_CLASSES = {
    "elementor-menu-cart",
    "elementor-menu-cart__toggle",
    "elementor-menu-cart__toggle_button",
    "widget_shopping_cart_content",
}
PRODUCT_IMAGE_CONTAINER_CLASSES = {
    "elementor-widget-woocommerce-product-images",
    "woocommerce-product-gallery",
    "woocommerce-product-gallery__image",
}
PRODUCT_IMAGE_CLASSES = {
    "wp-post-image",
}
VISIBLE_DESCRIPTION_STOP_PREFIXES = (
    "copyright",
    "aviso de privacidad",
    "powered by",
    "this website uses cookies",
    "we use cookies",
    "you may also like",
    "related products",
    "productos relacionados",
)
VISIBLE_DESCRIPTION_NOISE = {
    "add to cart",
    "agregar al carrito",
    "almost gone",
    "all products",
    "inicio",
    "more",
    "quantity",
    "tienda",
}
VISIBLE_DESCRIPTION_FACT_PREFIXES = (
    "duracion",
    "edad",
    "editorial",
    "idioma",
    "jugadores",
    "language",
    "players",
    "publisher",
)
VOID_LIKE_TAGS = {
    "area",
    "base",
    "br",
    "circle",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "path",
    "rect",
    "source",
    "track",
    "wbr",
}


@dataclass(frozen=True)
class LanguageDetection:
    language: str = ""
    source: str = ""
    evidence: str = ""


class ProductDetailParser(HTMLParser):
    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.language = ""
        self.meta: dict[str, str] = {}
        self.text_nodes: list[str] = []
        self.title_parts: list[str] = []
        self.h1_parts: list[str] = []
        self.heading_parts: list[tuple[str, str]] = []
        self.json_ld_scripts: list[str] = []
        self.woocommerce_price_texts: list[str] = []
        self.woocommerce_stock_blocks: list[tuple[str, str]] = []
        self.shopify_product_text_blocks: list[str] = []
        self.product_image_urls: list[str] = []
        self.image_candidates: list[tuple[str, str]] = []
        self._ignored_text_depth = 0
        self._inside_script = False
        self._current_script_type = ""
        self._script_parts: list[str] = []
        self._current_text_tag = ""
        self._price_capture_depth = 0
        self._price_parts: list[str] = []
        self._stock_capture_depth = 0
        self._stock_parts: list[str] = []
        self._stock_classes = ""
        self._shopify_product_text_depth = 0
        self._shopify_product_text_parts: list[str] = []
        self._product_image_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = {name.casefold(): value or "" for name, value in attrs}
        normalized_tag = tag.casefold()
        class_value = attr.get("class", "")
        if self._ignored_text_depth:
            if normalized_tag not in VOID_LIKE_TAGS:
                self._ignored_text_depth += 1
            return
        if normalized_tag in {"style", "noscript"} or _is_menu_cart_container(class_value):
            self._ignored_text_depth = 1
            return
        if self._product_image_depth:
            self._product_image_depth += 1
        elif _is_product_image_container(class_value):
            self._product_image_depth = 1
        if self._price_capture_depth:
            self._price_capture_depth += 1
        elif _is_woocommerce_product_price_container(normalized_tag, class_value):
            self._price_capture_depth = 1
            self._price_parts = []
        if self._stock_capture_depth:
            self._stock_capture_depth += 1
        elif _is_woocommerce_stock_container(class_value):
            self._stock_capture_depth = 1
            self._stock_parts = []
            self._stock_classes = class_value
        if self._shopify_product_text_depth:
            self._shopify_product_text_depth += 1
        elif _is_shopify_product_text_container(class_value):
            self._shopify_product_text_depth = 1
            self._shopify_product_text_parts = []
        if normalized_tag == "html":
            self.language = attr.get("lang", "").strip()
        if normalized_tag == "meta":
            key = attr.get("property") or attr.get("name")
            content = attr.get("content", "").strip()
            if key and content:
                self.meta[key.casefold()] = content
        if self._product_image_depth and normalized_tag == "a":
            href = attr.get("href", "").strip()
            if _looks_like_image_url(href):
                self._append_product_image_url(href)
        if normalized_tag == "img":
            image_url = _image_url_from_attrs(attr)
            alt_text = attr.get("alt", "").strip()
            self._append_image_candidate(alt_text, image_url)
            if self._product_image_depth or _is_product_image_tag(class_value, attr):
                self._append_product_image_url(image_url)
        if normalized_tag == "script":
            self._inside_script = True
            self._current_script_type = attr.get("type", "").casefold()
            self._script_parts = []
        if normalized_tag in {"title", "h1", "h2", "h3"}:
            self._current_text_tag = normalized_tag

    def handle_endtag(self, tag: str) -> None:
        normalized_tag = tag.casefold()
        if self._ignored_text_depth:
            if normalized_tag not in VOID_LIKE_TAGS:
                self._ignored_text_depth -= 1
            return
        if normalized_tag == "script":
            if self._inside_script and "ld+json" in self._current_script_type:
                script = "".join(self._script_parts).strip()
                if script:
                    self.json_ld_scripts.append(script)
            self._inside_script = False
            self._current_script_type = ""
            self._script_parts = []
        if self._price_capture_depth:
            self._price_capture_depth -= 1
            if self._price_capture_depth == 0:
                text = _collapse_text(" ".join(self._price_parts))
                if text:
                    self.woocommerce_price_texts.append(text)
                self._price_parts = []
        if self._stock_capture_depth:
            self._stock_capture_depth -= 1
            if self._stock_capture_depth == 0:
                text = _collapse_text(" ".join(self._stock_parts))
                if text:
                    self.woocommerce_stock_blocks.append((self._stock_classes, text))
                self._stock_parts = []
                self._stock_classes = ""
        if self._shopify_product_text_depth:
            self._shopify_product_text_depth -= 1
            if self._shopify_product_text_depth == 0:
                text = _collapse_text(" ".join(self._shopify_product_text_parts))
                if text:
                    self.shopify_product_text_blocks.append(text)
                self._shopify_product_text_parts = []
        if self._product_image_depth:
            self._product_image_depth -= 1
        if normalized_tag == self._current_text_tag:
            self._current_text_tag = ""

    def handle_data(self, data: str) -> None:
        if self._inside_script:
            self._script_parts.append(data)
            return
        if self._ignored_text_depth:
            return
        if self._price_capture_depth:
            self._price_parts.append(data)
            return
        if self._stock_capture_depth:
            self._stock_parts.append(data)
            return
        text = _collapse_text(data)
        if not text:
            return
        if self._shopify_product_text_depth:
            self._shopify_product_text_parts.append(text)
        self.text_nodes.append(text)
        if self._current_text_tag == "title":
            self.title_parts.append(text)
        if self._current_text_tag == "h1":
            self.h1_parts.append(text)
        if self._current_text_tag in {"h1", "h2", "h3"}:
            self.heading_parts.append((self._current_text_tag, text))

    def _append_product_image_url(self, image_url: str) -> None:
        image_url = image_url.strip()
        if image_url and image_url not in self.product_image_urls:
            self.product_image_urls.append(image_url)

    def _append_image_candidate(self, alt_text: str, image_url: str) -> None:
        image_url = image_url.strip()
        if image_url and not image_url.startswith("data:") and (alt_text, image_url) not in self.image_candidates:
            self.image_candidates.append((alt_text.strip(), image_url))


def extract_product_detail_candidate(
    html: str,
    product_url: str,
    store_id: int | None,
    source_listing_url: str,
) -> DiscoveryItemCandidateRecord | None:
    parser = ProductDetailParser(product_url)
    parser.feed(html)

    json_ld_product = _extract_json_ld_product(parser.json_ld_scripts)
    text = " ".join(parser.text_nodes)
    title = _first_text(
        _json_text(json_ld_product, "name"),
        _visible_product_heading(parser.heading_parts),
        " ".join(parser.h1_parts),
        _strip_title_suffix(parser.meta.get("og:title", "")),
        parser.meta.get("og:title", ""),
        _strip_title_suffix(" ".join(parser.title_parts)),
        " ".join(parser.title_parts),
    )
    if not title:
        return None
    description = _first_text(
        _json_text(json_ld_product, "description"),
        _visible_product_description(title, parser.text_nodes),
        parser.meta.get("og:description", ""),
        parser.meta.get("description", ""),
    )

    offer = _first_offer(json_ld_product.get("offers")) if json_ld_product else {}
    raw_price = _json_text(offer, "price")
    price = _normalize_offer_price(raw_price)
    price_source = "json_ld_offer" if price else "none"
    if not price:
        raw_price, price, price_source = _first_price_from_texts(
            parser.woocommerce_price_texts,
            "woocommerce_product_price",
        )
    if not price:
        raw_price, price, price_source = _first_price_from_texts([text], "generic_text")

    currency = _first_text(_json_text(offer, "priceCurrency"), _detect_currency(text), "MXN")
    availability = _availability_from_schema(_json_text(offer, "availability"))
    availability_source = "json_ld_offer" if availability != "unknown" else "none"
    if availability == "unknown":
        availability, availability_source = _availability_from_stock_blocks(parser.woocommerce_stock_blocks)
    if availability == "unknown":
        _, availability = _extract_availability(text)
        availability_source = "generic_text" if availability != "unknown" else "none"

    product_details = _extract_product_details(parser.shopify_product_text_blocks)
    min_players, max_players = _extract_players(text, product_details)
    min_minutes, max_minutes = _extract_minutes(text, product_details)
    language_detection = _detect_item_language_detail(title, product_url, description, text)

    raw_payload: dict[str, object] = {
        "meta": parser.meta,
        "text": text,
    }
    if json_ld_product:
        raw_payload["json_ld"] = json_ld_product
    if product_details:
        raw_payload["product_details"] = product_details

    return DiscoveryItemCandidateRecord(
        store_id=store_id,
        source_url=product_url,
        source_listing_url=source_listing_url,
        title=title,
        publisher=_first_text(
            _publisher_from_json(json_ld_product),
            _product_detail_value(product_details, "Editorial", "Publisher"),
            _publisher_from_text_nodes(parser.text_nodes),
        ),
        description=description,
        item_type=_infer_item_type(title, product_url),
        min_players=min_players,
        max_players=max_players,
        min_minutes=min_minutes,
        max_minutes=max_minutes,
        min_age=_first_int(_product_detail_value(product_details, "Edad minima", "Edad mínima"))
        or _extract_min_age(text),
        language=language_detection.language,
        language_source=language_detection.source,
        language_evidence=language_detection.evidence,
        image_url=_resolve_url(
            product_url,
            _first_text(
                _json_image(json_ld_product),
                *parser.product_image_urls,
                _title_matched_image(parser.image_candidates, title),
                parser.meta.get("og:image", ""),
                parser.meta.get("twitter:image", ""),
                parser.meta.get("twitter:image:src", ""),
            ),
        ),
        raw_price=raw_price,
        price=price,
        price_source=price_source,
        currency=currency.upper(),
        availability=availability,
        availability_source=availability_source,
        store_sku=_json_text(json_ld_product, "sku"),
        raw_payload=raw_payload,
    )


def _extract_json_ld_product(scripts: list[str]) -> dict[str, Any]:
    for script in scripts:
        try:
            parsed = json.loads(script)
        except json.JSONDecodeError:
            continue
        product = _find_product(parsed)
        if product:
            return product
    return {}


def _find_product(value: Any) -> dict[str, Any]:
    if isinstance(value, list):
        for item in value:
            product = _find_product(item)
            if product:
                return product
        return {}
    if not isinstance(value, dict):
        return {}
    type_value = value.get("@type")
    types = [type_value] if isinstance(type_value, str) else type_value if isinstance(type_value, list) else []
    if any(str(item).casefold() == "product" for item in types):
        return value
    main_entity = value.get("mainEntity")
    if main_entity:
        product = _find_product(main_entity)
        if product:
            return product
    graph = value.get("@graph")
    if graph:
        return _find_product(graph)
    return {}


def _first_offer(value: Any) -> dict[str, Any]:
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                return item
        return {}
    if isinstance(value, dict):
        return value
    return {}


def _json_text(source: dict[str, Any], key: str) -> str:
    value = source.get(key) if source else ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value)
    return ""


def _is_menu_cart_container(class_value: str) -> bool:
    classes = _class_tokens(class_value)
    return bool(classes.intersection(MENU_CART_CLASSES))


def _is_product_image_container(class_value: str) -> bool:
    classes = _class_tokens(class_value)
    return bool(classes.intersection(PRODUCT_IMAGE_CONTAINER_CLASSES))


def _is_product_image_tag(class_value: str, attrs: dict[str, str]) -> bool:
    classes = _class_tokens(class_value)
    itemprop = attrs.get("itemprop", "").casefold()
    return bool(classes.intersection(PRODUCT_IMAGE_CLASSES)) or itemprop == "image"


def _is_woocommerce_product_price_container(tag: str, class_value: str) -> bool:
    classes = _class_tokens(class_value)
    return "elementor-widget-woocommerce-product-price" in classes or (tag == "p" and "price" in classes)


def _is_woocommerce_stock_container(class_value: str) -> bool:
    return "stock" in _class_tokens(class_value)


def _is_shopify_product_text_container(class_value: str) -> bool:
    return "product__text" in _class_tokens(class_value)


def _class_tokens(class_value: str) -> set[str]:
    return {token.strip().casefold() for token in class_value.split() if token.strip()}


def _image_url_from_attrs(attrs: dict[str, str]) -> str:
    for key in ("data-large_image", "data-src", "data-lazy-src", "src"):
        value = attrs.get(key, "").strip()
        if value and not value.startswith("data:"):
            return value
    return _largest_srcset_url(attrs.get("srcset", ""))


def _largest_srcset_url(srcset: str) -> str:
    best_url = ""
    best_width = -1
    for part in srcset.split(","):
        pieces = part.strip().split()
        if not pieces:
            continue
        url = pieces[0]
        width = 0
        if len(pieces) > 1 and pieces[1].endswith("w"):
            try:
                width = int(pieces[1][:-1])
            except ValueError:
                width = 0
        if width > best_width:
            best_url = url
            best_width = width
    return best_url


def _looks_like_image_url(value: str) -> bool:
    if not value or value.startswith("#") or value.startswith("data:"):
        return False
    path = urlparse(value).path.casefold()
    return path.endswith((".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"))


def _title_matched_image(image_candidates: list[tuple[str, str]], title: str) -> str:
    normalized_title = _normalize_match_text(title)
    if not normalized_title:
        return ""
    for alt_text, image_url in image_candidates:
        normalized_alt = _normalize_match_text(alt_text)
        if not normalized_alt:
            continue
        if normalized_alt == normalized_title or normalized_alt in normalized_title or normalized_title in normalized_alt:
            return image_url
    return ""


def _visible_product_description(title: str, text_nodes: list[str]) -> str:
    title_index = _visible_title_index(title, text_nodes)
    if title_index < 0:
        return ""

    parts: list[str] = []
    for text in text_nodes[title_index + 1 :]:
        normalized = _normalize_match_text(text)
        if _is_visible_description_stop(normalized):
            break
        if _is_visible_description_noise(text, normalized):
            continue
        parts.append(text)
        if len(" ".join(parts)) >= 900:
            break
    return _collapse_text(" ".join(parts))


def _visible_title_index(title: str, text_nodes: list[str]) -> int:
    normalized_title = _normalize_match_text(title)
    if not normalized_title:
        return -1
    for index, text in enumerate(text_nodes):
        if _normalize_match_text(text) == normalized_title:
            return index
    return -1


def _is_visible_description_stop(normalized_text: str) -> bool:
    return any(normalized_text.startswith(prefix) for prefix in VISIBLE_DESCRIPTION_STOP_PREFIXES)


def _is_visible_description_noise(text: str, normalized_text: str) -> bool:
    if not normalized_text:
        return True
    if normalized_text in VISIBLE_DESCRIPTION_NOISE:
        return True
    if any(normalized_text.startswith(f"{prefix} ") or normalized_text.startswith(f"{prefix}:") for prefix in VISIBLE_DESCRIPTION_FACT_PREFIXES):
        return True
    _, price = _extract_price(text)
    if price:
        return True
    _, availability = _extract_availability(text)
    return availability != "unknown" and len(normalized_text.split()) <= 5


def _normalize_match_text(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    without_accents = "".join(character for character in decomposed if not unicodedata.combining(character))
    return " ".join(re.sub(r"[^a-z0-9]+", " ", without_accents).split())


def _visible_product_heading(heading_parts: list[tuple[str, str]]) -> str:
    h1 = _first_text(*(text for tag, text in heading_parts if tag == "h1"))
    if h1:
        return h1
    return _first_text(*(text for tag, text in heading_parts if tag == "h2"))


def _strip_title_suffix(value: str) -> str:
    normalized = _collapse_text(value)
    if not normalized:
        return ""
    for separator in (" | ", " - "):
        if separator in normalized:
            return normalized.split(separator, 1)[0].strip()
    return ""


def _first_price_from_texts(values: list[str], source: str) -> tuple[str, str, str]:
    for value in values:
        raw_price, price = _extract_price(value)
        if price:
            return _normalize_raw_price(raw_price), price, source
    return "", "", "none"


def _normalize_raw_price(value: str) -> str:
    return re.sub(r"\$\s+", "$", value)


def _availability_from_stock_blocks(stock_blocks: list[tuple[str, str]]) -> tuple[str, str]:
    for class_value, text in stock_blocks:
        classes = _class_tokens(class_value)
        if "out-of-stock" in classes or "outofstock" in classes:
            return "out_of_stock", "woocommerce_stock"
        if "in-stock" in classes or "instock" in classes:
            return "available", "woocommerce_stock"
        _, availability = _extract_availability(text)
        if availability != "unknown":
            return availability, "woocommerce_stock"
    return "unknown", "none"


def _publisher_from_json(product: dict[str, Any]) -> str:
    for key in ("publisher", "brand", "manufacturer"):
        value = product.get(key) if product else None
        if isinstance(value, dict):
            name = _json_text(value, "name")
            if name:
                return name
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _publisher_from_text_nodes(text_nodes: list[str]) -> str:
    for text in text_nodes:
        match = PUBLISHER_RE.search(text)
        if match:
            return match.group(1).strip()
    return ""


def _extract_product_details(product_text_blocks: list[str]) -> dict[str, str]:
    details: dict[str, str] = {}
    for text in product_text_blocks:
        if ":" not in text:
            continue
        label, value = text.split(":", 1)
        label = _normalize_product_detail_label(label)
        if label:
            details[label] = _collapse_text(value)
    return details


def _normalize_product_detail_label(value: str) -> str:
    return _collapse_text(value).strip(" :")


def _product_detail_value(product_details: dict[str, str], *labels: str) -> str:
    if not product_details:
        return ""
    values_by_label = {_normalize_match_text(label): value for label, value in product_details.items()}
    for label in labels:
        value = values_by_label.get(_normalize_match_text(label), "")
        if value:
            return value
    return ""


def _first_int(value: str) -> int | None:
    match = re.search(r"\d+", value)
    return int(match.group(0)) if match else None


def _json_image(product: dict[str, Any]) -> str:
    image = product.get("image") if product else None
    if isinstance(image, str):
        return image
    if isinstance(image, list):
        for item in image:
            if isinstance(item, str):
                return item
            if isinstance(item, dict):
                url = _json_text(item, "url")
                if url:
                    return url
    if isinstance(image, dict):
        return _json_text(image, "url")
    return ""


def _resolve_url(base_url: str, value: str) -> str:
    return urljoin(base_url, value) if value else ""


def _first_text(*values: str) -> str:
    for value in values:
        normalized = _collapse_text(value)
        if normalized:
            return normalized
    return ""


def _detect_item_language(title: str, product_url: str, description: str, page_text: str) -> str:
    return _detect_item_language_detail(title, product_url, description, page_text).language


def _detect_item_language_detail(title: str, product_url: str, description: str, page_text: str) -> LanguageDetection:
    for source, value in (("title", title), ("source_url", product_url)):
        language = _language_from_text(value)
        if language:
            return LanguageDetection(language=language, source=source, evidence=_collapse_text(value))

    scoped_detection = _detect_product_scoped_language(page_text)
    if scoped_detection.language:
        return scoped_detection

    for source, value in (("description", description), ("page_text", page_text)):
        language = _language_from_text(value)
        if language:
            return LanguageDetection(language=language, source=source, evidence=_language_evidence(value))

    return LanguageDetection()


def _detect_product_scoped_language(page_text: str) -> LanguageDetection:
    text = _collapse_text(page_text)
    for source, label_re in (("product_highlights", HIGHLIGHTS_LABEL_RE), ("product_language_label", LANGUAGE_LABEL_RE)):
        for match in label_re.finditer(text):
            evidence = _bounded_language_snippet(text, match.start())
            language = _language_from_text(evidence)
            if language:
                return LanguageDetection(language=language, source=source, evidence=evidence)
    return LanguageDetection()


def _bounded_language_snippet(text: str, start: int) -> str:
    end = min(len(text), start + 220)
    for stop in LANGUAGE_SNIPPET_STOPS:
        stop_index = text.find(stop, start + 1, end)
        if stop_index >= 0:
            end = min(end, stop_index)
    return _collapse_text(text[start:end])


def _language_evidence(value: str) -> str:
    text = _collapse_text(value)
    normalized = _normalize_language_text(text)
    for term in ("english", "ingles", "spanish", "espanol", "castellano"):
        index = normalized.find(term)
        if index >= 0:
            return _collapse_text(text[max(0, index - 80) : min(len(text), index + 120)])
    return text[:200]


def _language_from_text(value: str) -> str:
    normalized = _normalize_language_text(value)
    has_english = bool(ENGLISH_LANGUAGE_RE.search(normalized))
    has_spanish = bool(SPANISH_LANGUAGE_RE.search(normalized))
    if has_english == has_spanish:
        return ""
    return "en" if has_english else "es"


def _normalize_language_text(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    return "".join(character for character in decomposed if not unicodedata.combining(character))


def _normalize_offer_price(raw_price: str) -> str:
    if not raw_price:
        return ""
    normalized = raw_price.replace(",", "").strip()
    return normalized


def _detect_currency(text: str) -> str:
    if "mxn" in text.casefold():
        return "MXN"
    return ""


def _availability_from_schema(value: str) -> str:
    normalized = value.casefold()
    if "instock" in normalized or "in_stock" in normalized:
        return "available"
    if "outofstock" in normalized or "soldout" in normalized or "out_of_stock" in normalized:
        return "out_of_stock"
    return "unknown"


def _extract_players(text: str, product_details: dict[str, str] | None = None) -> tuple[int | None, int | None]:
    match = PLAYER_RANGE_RE.search(text) or PLAYER_LABEL_RE.search(text)
    if match:
        return int(match.group(1)), int(match.group(2))

    details = product_details or {}
    min_players = _first_int(
        _product_detail_value(
            details,
            "N min jugadores",
            "Nº min jugadores",
            "N° min jugadores",
            "No min jugadores",
            "Numero min jugadores",
            "Número min jugadores",
            "Min jugadores",
            "Jugadores minimos",
            "Jugadores mínimos",
        )
    )
    max_players = _first_int(
        _product_detail_value(
            details,
            "N max jugadores",
            "Nº max jugadores",
            "N° max jugadores",
            "No max jugadores",
            "Numero max jugadores",
            "Número max jugadores",
            "Max jugadores",
            "Jugadores maximos",
            "Jugadores máximos",
        )
    )
    return min_players, max_players


def _extract_minutes(text: str, product_details: dict[str, str] | None = None) -> tuple[int | None, int | None]:
    range_match = MINUTES_RANGE_RE.search(text)
    if range_match:
        return int(range_match.group(1)), int(range_match.group(2))
    single_match = MINUTES_SINGLE_RE.search(text)
    if single_match:
        minutes = int(single_match.group(1))
        return minutes, minutes

    details = product_details or {}
    min_minutes = _first_int(
        _product_detail_value(
            details,
            "Tiempo min partida (min)",
            "Tiempo minimo partida (min)",
            "Tiempo mínimo partida (min)",
            "Duracion min",
            "Duración min",
            "Minutos min",
        )
    )
    max_minutes = _first_int(
        _product_detail_value(
            details,
            "Tiempo max partida (min)",
            "Tiempo maximo partida (min)",
            "Tiempo máximo partida (min)",
            "Duracion max",
            "Duración max",
            "Minutos max",
        )
    )
    return min_minutes, max_minutes


def _extract_min_age(text: str) -> int | None:
    match = AGE_RE.search(text)
    return int(match.group(1)) if match else None


def _infer_item_type(title: str, product_url: str) -> ItemCandidateType:
    value = f"{title} {product_url}".casefold()
    if any(term in value for term in ("expansion", "expansión", "expansiones")):
        return "expansion"
    return "unknown"
