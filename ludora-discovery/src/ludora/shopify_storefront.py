from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from html import escape
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen

from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_detail_extraction import extract_product_detail_candidate
from ludora.webfetch import FetchResult, retry_after_seconds_from_headers


SHOPIFY_STOREFRONT_API_VERSION = "2026-07"
SHOPIFY_GRAPHQL_ERROR_COUNT_LIMIT = 5
SHOPIFY_GRAPHQL_ERROR_CODE_MAX_LENGTH = 100
SHOPIFY_GRAPHQL_ERROR_MESSAGE_MAX_LENGTH = 500
SHOPIFY_STOREFRONT_PRODUCT_QUERY = """
query LudoraProduct($handle: String!) @inContext(country: MX, language: ES) {
  product(handle: $handle) {
    id
    handle
    title
    description
    descriptionHtml
    vendor
    productType
    availableForSale
    updatedAt
    featuredImage {
      url
      altText
    }
    priceRange {
      minVariantPrice {
        amount
        currencyCode
      }
      maxVariantPrice {
        amount
        currencyCode
      }
    }
    variants(first: 25) {
      nodes {
        id
        title
        sku
        availableForSale
        price {
          amount
          currencyCode
        }
        compareAtPrice {
          amount
          currencyCode
        }
      }
    }
  }
}
""".strip()

ShopifyRequestHeadersProvider = Callable[[str, str], Mapping[str, str]]


def shopify_storefront_endpoint(source_url: str) -> str:
    parsed = urlparse(source_url)
    if parsed.scheme.casefold() != "https" or not parsed.netloc:
        raise ValueError("Shopify product URL must use HTTPS and include a host")
    return f"https://{parsed.netloc}/api/{SHOPIFY_STOREFRONT_API_VERSION}/graphql.json"


def shopify_product_handle(source_url: str) -> str:
    parsed = urlparse(source_url)
    parts = [part for part in parsed.path.split("/") if part]
    for index, part in enumerate(parts[:-1]):
        if part.casefold() == "products":
            handle = unquote(parts[index + 1]).strip()
            if handle:
                return handle
    raise ValueError("Shopify product URL does not contain a product handle")


def fetch_shopify_storefront_product(
    source_url: str,
    *,
    request_headers_provider: ShopifyRequestHeadersProvider | None,
    before_request: Callable[[], None] | None = None,
    timeout_seconds: int = 20,
) -> FetchResult:
    endpoint = shopify_storefront_endpoint(source_url)
    handle = shopify_product_handle(source_url)
    request_headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": (
            "LudoraStoreCollector/1.0 "
            "(+https://admin.ludora.bobbycrimson.com/crawler)"
        ),
    }
    body = json.dumps(
        {
            "query": SHOPIFY_STOREFRONT_PRODUCT_QUERY,
            "variables": {"handle": handle},
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    try:
        if request_headers_provider is not None:
            request_headers.update(request_headers_provider(endpoint, "POST"))
        request = Request(endpoint, data=body, headers=request_headers, method="POST")
    except (HTTPException, RuntimeError, TypeError, URLError, TimeoutError, ValueError) as exc:
        return FetchResult(
            url=endpoint,
            text="",
            status_code=0,
            error=str(exc),
            error_type=type(exc).__name__,
        )

    if before_request is not None:
        before_request()

    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return FetchResult(
                url=response.geturl(),
                text=response.read().decode(charset, errors="replace"),
                status_code=int(getattr(response, "status", 200)),
                retry_after_seconds=retry_after_seconds_from_headers(response.headers),
            )
    except HTTPError as exc:
        charset = exc.headers.get_content_charset() if exc.headers is not None else None
        return FetchResult(
            url=exc.geturl() or endpoint,
            text=exc.read().decode(charset or "utf-8", errors="replace"),
            status_code=int(exc.code),
            retry_after_seconds=retry_after_seconds_from_headers(exc.headers),
        )
    except (HTTPException, RuntimeError, TypeError, URLError, TimeoutError, ValueError) as exc:
        return FetchResult(
            url=endpoint,
            text="",
            status_code=0,
            error=str(exc),
            error_type=type(exc).__name__,
        )


def parse_shopify_storefront_payload(text: str) -> dict[str, object]:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Shopify Storefront GraphQL returned invalid JSON: {exc.msg}") from exc
    if not isinstance(payload, dict):
        raise ValueError("Shopify Storefront GraphQL returned a non-object payload")
    return payload


def shopify_graphql_errors(payload: Mapping[str, object]) -> list[dict[str, object]]:
    errors = payload.get("errors")
    return [dict(error) for error in errors if isinstance(error, dict)] if isinstance(errors, list) else []


def shopify_graphql_error_messages(errors: list[dict[str, object]]) -> list[str]:
    messages = []
    for error in errors[:SHOPIFY_GRAPHQL_ERROR_COUNT_LIMIT]:
        message = _bounded_graphql_diagnostic(
            error.get("message") or "Unknown GraphQL error",
            SHOPIFY_GRAPHQL_ERROR_MESSAGE_MAX_LENGTH,
        )
        extensions = error.get("extensions")
        code = (
            _bounded_graphql_diagnostic(
                extensions.get("code") or "",
                SHOPIFY_GRAPHQL_ERROR_CODE_MAX_LENGTH,
            )
            if isinstance(extensions, dict)
            else ""
        )
        messages.append(f"{code}: {message}" if code else message)
    return messages


def _bounded_graphql_diagnostic(value: object, max_length: int) -> str:
    normalized = " ".join(str(value).split())
    if len(normalized) <= max_length:
        return normalized
    if max_length <= 3:
        return normalized[:max_length]
    return f"{normalized[:max_length - 3]}..."


def shopify_graphql_is_throttled(errors: list[dict[str, object]]) -> bool:
    for error in errors:
        extensions = error.get("extensions")
        code = str(extensions.get("code") or "").strip().casefold() if isinstance(extensions, dict) else ""
        message = str(error.get("message") or "").casefold()
        if code in {"throttled", "throttle_exceeded"} or "throttl" in message or "too many requests" in message:
            return True
    return False


def shopify_product_from_payload(payload: Mapping[str, object]) -> dict[str, object] | None:
    data = payload.get("data")
    if not isinstance(data, dict):
        return None
    product = data.get("product")
    return dict(product) if isinstance(product, dict) else None


def shopify_discovery_product_from_payload(payload: Mapping[str, object]) -> dict[str, object] | None:
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError("malformed Shopify Storefront GraphQL payload: data must be an object")
    if "product" not in data:
        raise ValueError("malformed Shopify Storefront GraphQL payload: data.product is missing")
    product = data["product"]
    if product is None:
        return None
    if not isinstance(product, dict):
        raise ValueError("malformed Shopify Storefront GraphQL payload: data.product must be an object or null")
    return dict(product)


def extract_shopify_storefront_candidate(
    product: Mapping[str, object],
    *,
    product_url: str,
    source_listing_url: str,
    store_id: int | None,
) -> DiscoveryItemCandidateRecord:
    title = _text(product.get("title"))
    if not title:
        raise ValueError("Shopify Storefront GraphQL product is missing its title")

    description = _text(product.get("description"))
    description_html = _text(product.get("descriptionHtml")) or escape(description)
    vendor = _text(product.get("vendor"))
    featured_image = product.get("featuredImage")
    image_url = _text(featured_image.get("url")) if isinstance(featured_image, dict) else ""
    price = _money(product, "priceRange", "minVariantPrice")
    currency = _money(product, "priceRange", "minVariantPrice", field="currencyCode") or "MXN"
    sku = _first_variant_text(product, "sku")
    available = product.get("availableForSale") is True

    json_ld: dict[str, object] = {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": title,
        "description": description,
        "offers": {
            "@type": "Offer",
            "availability": "https://schema.org/InStock" if available else "https://schema.org/OutOfStock",
            "price": price,
            "priceCurrency": currency,
        },
    }
    if vendor:
        json_ld["brand"] = {"@type": "Brand", "name": vendor}
    if image_url:
        json_ld["image"] = image_url
    if sku:
        json_ld["sku"] = sku

    serialized_json_ld = json.dumps(json_ld, ensure_ascii=False).replace("</", "<\\/")
    html = (
        "<html><head>"
        f'<script type="application/ld+json">{serialized_json_ld}</script>'
        "</head><body>"
        f"<h1>{escape(title)}</h1>"
        f'<div class="product__description">{description_html}</div>'
        "</body></html>"
    )
    candidate = extract_product_detail_candidate(
        html=html,
        product_url=product_url,
        store_id=store_id,
        source_listing_url=source_listing_url,
    )
    if candidate is None:
        raise ValueError("Shopify Storefront GraphQL product could not be normalized")
    if candidate.price:
        candidate.price_source = "shopify_storefront_graphql"
    candidate.availability_source = "shopify_storefront_graphql"
    candidate.raw_payload["shopify_graphql"] = dict(product)
    return candidate


def _money(
    product: Mapping[str, object],
    container_key: str,
    money_key: str,
    *,
    field: str = "amount",
) -> str:
    container = product.get(container_key)
    money = container.get(money_key) if isinstance(container, dict) else None
    return _text(money.get(field)) if isinstance(money, dict) else ""


def _first_variant_text(product: Mapping[str, object], key: str) -> str:
    variants = product.get("variants")
    nodes = variants.get("nodes") if isinstance(variants, dict) else None
    if not isinstance(nodes, list):
        return ""
    for node in nodes:
        if isinstance(node, dict):
            value = _text(node.get(key))
            if value:
                return value
    return ""


def _text(value: object) -> str:
    return str(value).strip() if value is not None else ""
