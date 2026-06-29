from __future__ import annotations

import re
import unicodedata
from urllib.parse import urlparse

from ludora.models import CandidateDecision, SearchResult


BLOCKED_DOMAINS = {
    "amazon.com",
    "amazon.com.mx",
    "boardgamegeek.com",
    "ebay.com",
    "eventbrite.com",
    "facebook.com",
    "foursquare.com",
    "google.com",
    "instagram.com",
    "liverpool.com.mx",
    "maps.google.com",
    "mercadolibre.com",
    "mercadolibre.com.mx",
    "meetup.com",
    "pinterest.com",
    "reddit.com",
    "sanborns.com.mx",
    "sears.com.mx",
    "temu.com",
    "tiktok.com",
    "tripadvisor.com",
    "twitter.com",
    "walmart.com.mx",
    "wikipedia.org",
    "x.com",
    "youtube.com",
}

BOARDGAME_TERMS = {
    "board game",
    "boardgame",
    "calabozos",
    "cartas coleccionables",
    "cartas intercambiables",
    "carcassonne",
    "catan",
    "d&d",
    "dungeons",
    "dungeons and dragons",
    "eurogame",
    "juego de cartas",
    "juego de mesa",
    "juegos de cartas",
    "juegos de mesa",
    "juegos de rol",
    "juegos de tablero",
    "juegos familiares",
    "juegos tcg",
    "magic the gathering",
    "meeple",
    "miniaturas",
    "mtg",
    "pokemon tcg",
    "tcg",
    "warhammer",
    "wargames",
    "yugioh",
}

ONLINE_STORE_TERMS = {
    "/cart",
    "/carrito",
    "/checkout",
    "/collections/",
    "/product-category/",
    "/producto/",
    "/productos/",
    "/products/",
    "/shop/",
    "/tienda/",
    "agregar al carrito",
    "anadir al carrito",
    "carrito",
    "catalogo",
    "checkout",
    "compra en linea",
    "comprar",
    "comprar ahora",
    "ecommerce",
    "envio",
    "envios",
    "finalizar compra",
    "mxn",
    "pedido",
    "pedidos",
    "precio",
    "precio regular",
    "producto",
    "productos",
    "shopify",
    "sku",
    "tienda en linea",
    "tienda online",
    "ver carrito",
    "woocommerce",
}

MEXICO_TERMS = {
    "+52",
    "$ mxn",
    "a todo mexico",
    "aguascalientes",
    "baja california",
    "baja california sur",
    "campeche",
    "cdmx",
    "chiapas",
    "chihuahua",
    "ciudad de mexico",
    "coahuila",
    "colima",
    "durango",
    "envios a mexico",
    "envios nacionales",
    "estado de mexico",
    "guanajuato",
    "guerrero",
    "guadalajara",
    "hidalgo",
    "jalisco",
    "mexican",
    "mexico",
    "monterrey",
    "morelos",
    "nayarit",
    "nuevo leon",
    "oaxaca",
    "pesos",
    "puebla",
    "quintana roo",
    "queretaro",
    "san luis potosi",
    "sinaloa",
    "sonora",
    "tabasco",
    "tamaulipas",
    "tlaxcala",
    "veracruz",
    "yucatan",
    "zacatecas",
}


def canonical_domain(url_or_domain: str) -> str:
    value = url_or_domain.strip()
    if not value:
        return ""
    if "://" not in value and not value.startswith("//"):
        value = f"//{value}"
    parsed = urlparse(value)
    host = parsed.hostname or parsed.path.split("/")[0]
    host = host.casefold().strip(".")
    for prefix in ("www.", "m.", "amp."):
        if host.startswith(prefix):
            host = host.removeprefix(prefix)
    return host


def homepage_url(url: str) -> str:
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return url
    return f"{parsed.scheme}://{parsed.netloc}/"


def is_blocked_domain(domain: str) -> bool:
    for blocked in BLOCKED_DOMAINS:
        if domain == blocked or domain.endswith(f".{blocked}"):
            return True
    return False


def classify_store_candidate(result: SearchResult, homepage_text: str = "") -> CandidateDecision:
    domain = canonical_domain(result.url)
    if is_blocked_domain(domain):
        return CandidateDecision(False, 0.0, ("blocked_domain",))

    text = normalize_text(" ".join([result.title, result.description, result.url, homepage_text]))
    boardgame_hits = _term_hits(text, BOARDGAME_TERMS)
    online_hits = _term_hits(text, ONLINE_STORE_TERMS)
    mexico_hits = _term_hits(text, MEXICO_TERMS)

    reasons: list[str] = []
    if boardgame_hits:
        reasons.append("boardgame")
    else:
        reasons.append("missing_boardgame")

    if online_hits:
        reasons.append("online_store")
    else:
        reasons.append("missing_online_store")

    if mexico_hits or domain.endswith(".mx"):
        reasons.append("mexico")
    else:
        reasons.append("missing_mexico")

    accepted = bool(boardgame_hits and online_hits and (mexico_hits or domain.endswith(".mx")))
    confidence = _confidence(domain, boardgame_hits, online_hits, mexico_hits)
    return CandidateDecision(accepted, confidence if accepted else min(confidence, 0.49), tuple(reasons))


def normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value.casefold())
    asciiish = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    asciiish = re.sub(r"\s+", " ", asciiish)
    return asciiish.strip()


def _term_hits(text: str, terms: set[str]) -> list[str]:
    return sorted(term for term in terms if normalize_text(term) in text)


def _confidence(
    domain: str,
    boardgame_hits: list[str],
    online_hits: list[str],
    mexico_hits: list[str],
) -> float:
    score = 0.0
    if boardgame_hits:
        score += 0.34
    if online_hits:
        score += 0.31
    if mexico_hits:
        score += 0.22
    if domain.endswith(".mx"):
        score += 0.10
    if len(boardgame_hits) >= 2:
        score += 0.02
    if len(online_hits) >= 2:
        score += 0.01
    return min(score, 1.0)
