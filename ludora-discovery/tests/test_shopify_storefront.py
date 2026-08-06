import json
import sys
import unittest
from email.message import Message
from pathlib import Path
from unittest.mock import Mock, call, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import (
    ProductPageRemovedError,
    TransientProductFetchError,
    crawl_store_product_details,
    refresh_confirmed_store_item_candidate,
)
from ludora.shopify_storefront import (
    SHOPIFY_STOREFRONT_API_VERSION,
    extract_shopify_storefront_candidate,
    fetch_shopify_storefront_product,
    shopify_product_handle,
    shopify_storefront_endpoint,
)
from ludora.webfetch import FetchResult


PRODUCT_URL = "https://tienda.example.mx/products/mago-el-despertar-2%C2%AA-edicion?variant=123"
GRAPHQL_ENDPOINT = (
    f"https://tienda.example.mx/api/{SHOPIFY_STOREFRONT_API_VERSION}/graphql.json"
)


def _shopify_product(**overrides):
    product = {
        "id": "gid://shopify/Product/123",
        "handle": "mago-el-despertar-2ª-edicion",
        "title": "Mago: El Despertar 2ª edición",
        "description": "Juego de mesa para 2 a 5 jugadores, de 60 a 120 minutos. Edad 14 años.",
        "descriptionHtml": (
            "<p>Juego de mesa para 2 a 5 jugadores, de 60 a 120 minutos. "
            "Edad 14 años.</p>"
        ),
        "vendor": "Editorial Ludora",
        "productType": "Juegos de mesa",
        "availableForSale": True,
        "updatedAt": "2026-08-04T12:00:00Z",
        "featuredImage": {
            "url": "https://cdn.shopify.com/product.jpg",
            "altText": "Caja del juego",
        },
        "priceRange": {
            "minVariantPrice": {"amount": "899.00", "currencyCode": "MXN"},
            "maxVariantPrice": {"amount": "999.00", "currencyCode": "MXN"},
        },
        "variants": {
            "nodes": [
                {
                    "id": "gid://shopify/ProductVariant/456",
                    "title": "Default Title",
                    "sku": "MAG-02",
                    "availableForSale": True,
                    "price": {"amount": "899.00", "currencyCode": "MXN"},
                    "compareAtPrice": None,
                }
            ]
        },
    }
    product.update(overrides)
    return product


def _payload(product=None, *, errors=None):
    payload = {"data": {"product": _shopify_product() if product is None else product}}
    if errors is not None:
        payload["errors"] = errors
    return json.dumps(payload, ensure_ascii=False)


def _existing_record():
    return DiscoveryItemCandidateRecord(
        store_id=31,
        store_item_id=501,
        item_id=91,
        source_url=PRODUCT_URL,
        source_listing_url="https://tienda.example.mx/collections/juegos",
        title="Nombre anterior",
        original_title="Nombre anterior",
        publisher="Editorial anterior",
        description="Descripción anterior",
        item_type="base_game",
        min_players=1,
        max_players=4,
        min_minutes=30,
        max_minutes=90,
        min_age=12,
        language="es",
        language_source="existing",
        language_evidence="Idioma: Español",
        image_url="https://cdn.example.mx/old.jpg",
        listing_status="LISTED",
        raw_price="$799.00",
        price="799.00",
        price_source="json_ld",
        currency="MXN",
        availability="in_stock",
        availability_source="json_ld",
        store_sku="OLD-SKU",
        raw_payload={"product_details": {"designer": "Ada"}},
        is_boardgame=True,
        is_boardgame_confirmed=True,
        category_confidence=0.99,
        classification_reasons=["confirmed"],
    )


class FakeTraceLogger:
    def __init__(self):
        self.events = []

    def log(self, event, **fields):
        self.events.append((event, fields))


class DiscoveryRepository:
    def __init__(self, *, existing_urls=None):
        self.existing_urls = set(existing_urls or [])
        self.exists_checks = []
        self.records = []

    def item_candidate_exists(self, store_id, source_url):
        self.exists_checks.append((store_id, source_url))
        return (store_id, source_url) in self.existing_urls

    def upsert_item_candidate(self, record):
        self.records.append(record)
        return None


class ShopifyStorefrontTests(unittest.TestCase):
    def test_builds_versioned_endpoint_and_decodes_product_handle(self):
        self.assertEqual(shopify_storefront_endpoint(PRODUCT_URL), GRAPHQL_ENDPOINT)
        self.assertEqual(shopify_product_handle(PRODUCT_URL), "mago-el-despertar-2ª-edicion")

    def test_posts_signed_product_query_to_storefront_graphql(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.headers = Message()
        response.headers["Content-Type"] = "application/json; charset=utf-8"
        response.status = 200
        response.geturl.return_value = GRAPHQL_ENDPOINT
        response.read.return_value = _payload().encode("utf-8")
        headers_provider = Mock(return_value={"Signature": "sig-value"})

        with patch("ludora.shopify_storefront.urlopen", return_value=response) as urlopen:
            fetched = fetch_shopify_storefront_product(
                PRODUCT_URL,
                request_headers_provider=headers_provider,
            )

        request = urlopen.call_args.args[0]
        request_payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(request.full_url, GRAPHQL_ENDPOINT)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request_payload["variables"], {"handle": "mago-el-despertar-2ª-edicion"})
        self.assertIn("product(handle: $handle)", request_payload["query"])
        self.assertIn("@inContext(country: MX, language: ES)", request_payload["query"])
        self.assertEqual(request.get_header("Signature"), "sig-value")
        headers_provider.assert_called_once_with(GRAPHQL_ENDPOINT, "POST")
        self.assertEqual(fetched.status_code, 200)

    def test_new_shopify_sitemap_candidate_uses_graphql_without_product_html(self):
        store_url = "https://tienda.example.mx/"
        product_url = PRODUCT_URL.split("?")[0]
        repository = DiscoveryRepository()
        before_product_request = Mock()
        headers_provider = Mock(return_value={"Signature": "sig-value"})
        browser_fetcher = Mock()

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch(
            "ludora.product_crawler.fetch_shopify_storefront_product",
            return_value=FetchResult(url=GRAPHQL_ENDPOINT, text=_payload()),
        ) as fetch_product, patch("ludora.product_crawler.fetch_html") as fetch_html:
            records = crawl_store_product_details(
                store_url,
                31,
                repository,
                platform="shopify",
                browser_fetcher=browser_fetcher,
                request_headers_provider=headers_provider,
                before_product_request=before_product_request,
            )

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].price_source, "shopify_storefront_graphql")
        fetch_product.assert_called_once_with(product_url, request_headers_provider=headers_provider)
        fetch_html.assert_not_called()
        browser_fetcher.assert_not_called()
        self.assertEqual(before_product_request.call_args_list, [call(product_url)])

    def test_existing_shopify_sitemap_candidate_is_checked_before_graphql(self):
        store_url = "https://tienda.example.mx/"
        product_url = PRODUCT_URL.split("?")[0]
        repository = DiscoveryRepository(existing_urls={(31, product_url)})

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch("ludora.product_crawler.fetch_shopify_storefront_product") as fetch_product:
            records = crawl_store_product_details(
                store_url,
                31,
                repository,
                platform="shopify",
            )

        self.assertEqual(records, [])
        self.assertEqual(repository.exists_checks, [(31, product_url)])
        fetch_product.assert_not_called()

    def test_null_shopify_graphql_product_is_omitted_and_the_store_continues(self):
        first_url = PRODUCT_URL.split("?")[0]
        second_url = "https://tienda.example.mx/products/catan"
        repository = DiscoveryRepository()
        trace = FakeTraceLogger()

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[first_url, second_url],
        ), patch(
            "ludora.product_crawler.fetch_shopify_storefront_product",
            side_effect=[
                FetchResult(url=GRAPHQL_ENDPOINT, text=json.dumps({"data": {"product": None}})),
                FetchResult(url=GRAPHQL_ENDPOINT, text=_payload()),
            ],
        ) as fetch_product:
            records = crawl_store_product_details(
                "https://tienda.example.mx/",
                31,
                repository,
                platform="shopify",
                trace_logger=trace,
            )

        self.assertEqual(len(records), 1)
        self.assertEqual(fetch_product.call_count, 2)
        event, fields = next(
            (event, fields)
            for event, fields in trace.events
            if event == "item_discovery.candidate.shopify_graphql.not_found"
        )
        self.assertEqual(event, "item_discovery.candidate.shopify_graphql.not_found")
        self.assertEqual(fields["source_url"], first_url)
        self.assertEqual(fields["product_handle"], "mago-el-despertar-2ª-edicion")

    def test_shopify_discovery_retries_http_429_with_retry_after_then_succeeds(self):
        product_url = PRODUCT_URL.split("?")[0]
        repository = DiscoveryRepository()
        before_product_request = Mock()

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch(
            "ludora.product_crawler.fetch_shopify_storefront_product",
            side_effect=[
                FetchResult(url=GRAPHQL_ENDPOINT, text="busy", status_code=429, retry_after_seconds=17.5),
                FetchResult(url=GRAPHQL_ENDPOINT, text=_payload()),
            ],
        ) as fetch_product, patch("ludora.product_crawler.wait_for_discovery_delay") as wait:
            records = crawl_store_product_details(
                "https://tienda.example.mx/",
                31,
                repository,
                platform="shopify",
                before_product_request=before_product_request,
            )

        self.assertEqual(len(records), 1)
        self.assertEqual(fetch_product.call_count, 2)
        wait.assert_called_once_with(17.5, None)
        self.assertEqual(before_product_request.call_args_list, [call(product_url), call(product_url)])

    def test_shopify_discovery_exhausts_http_429_without_headers_using_bounded_fallbacks(self):
        product_url = PRODUCT_URL.split("?")[0]
        repository = DiscoveryRepository()
        throttled = FetchResult(url=GRAPHQL_ENDPOINT, text="busy", status_code=429)

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch(
            "ludora.product_crawler.fetch_shopify_storefront_product",
            side_effect=[throttled, throttled, throttled],
        ) as fetch_product, patch("ludora.product_crawler.wait_for_discovery_delay") as wait:
            with self.assertRaises(TransientProductFetchError) as raised:
                crawl_store_product_details(
                    "https://tienda.example.mx/",
                    31,
                    repository,
                    platform="shopify",
                )

        self.assertEqual(fetch_product.call_count, 3)
        self.assertEqual(wait.call_args_list, [call(60.0, None), call(300.0, None)])
        self.assertEqual(raised.exception.status_code, 429)

    def test_shopify_discovery_exhausts_graphql_throttling_using_bounded_fallbacks(self):
        product_url = PRODUCT_URL.split("?")[0]
        repository = DiscoveryRepository()
        errors = [{"message": "Query throttled", "extensions": {"code": "THROTTLED"}}]
        throttled = FetchResult(url=GRAPHQL_ENDPOINT, text=_payload(errors=errors))

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch(
            "ludora.product_crawler.fetch_shopify_storefront_product",
            side_effect=[throttled, throttled, throttled],
        ) as fetch_product, patch("ludora.product_crawler.wait_for_discovery_delay") as wait:
            with self.assertRaises(TransientProductFetchError) as raised:
                crawl_store_product_details(
                    "https://tienda.example.mx/",
                    31,
                    repository,
                    platform="shopify",
                )

        self.assertEqual(fetch_product.call_count, 3)
        self.assertEqual(wait.call_args_list, [call(60.0, None), call(300.0, None)])
        self.assertEqual(raised.exception.status_code, 429)

    def test_shopify_discovery_rejects_http_430_without_retry(self):
        product_url = PRODUCT_URL.split("?")[0]
        repository = DiscoveryRepository()

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch(
            "ludora.product_crawler.fetch_shopify_storefront_product",
            return_value=FetchResult(url=GRAPHQL_ENDPOINT, text="blocked", status_code=430),
        ) as fetch_product, patch("ludora.product_crawler.wait_for_discovery_delay") as wait:
            with self.assertRaisesRegex(RuntimeError, "HTTP 430"):
                crawl_store_product_details(
                    "https://tienda.example.mx/",
                    31,
                    repository,
                    platform="shopify",
                )

        fetch_product.assert_called_once()
        wait.assert_not_called()

    def test_shopify_discovery_rejects_permanent_graphql_errors_without_retry(self):
        product_url = PRODUCT_URL.split("?")[0]
        repository = DiscoveryRepository()
        errors = [{"message": "Access denied", "extensions": {"code": "ACCESS_DENIED"}}]

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch(
            "ludora.product_crawler.fetch_shopify_storefront_product",
            return_value=FetchResult(url=GRAPHQL_ENDPOINT, text=_payload(errors=errors)),
        ) as fetch_product:
            with self.assertRaisesRegex(RuntimeError, "ACCESS_DENIED"):
                crawl_store_product_details(
                    "https://tienda.example.mx/",
                    31,
                    repository,
                    platform="shopify",
                )

        fetch_product.assert_called_once()

    def test_shopify_discovery_reports_invalid_json_with_bounded_excerpt(self):
        product_url = PRODUCT_URL.split("?")[0]
        repository = DiscoveryRepository()
        trace = FakeTraceLogger()
        invalid_json = "{" + ("x" * 600)

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch(
            "ludora.product_crawler.fetch_shopify_storefront_product",
            return_value=FetchResult(url=GRAPHQL_ENDPOINT, text=invalid_json),
        ):
            with self.assertRaisesRegex(RuntimeError, "invalid JSON"):
                crawl_store_product_details(
                    "https://tienda.example.mx/",
                    31,
                    repository,
                    platform="shopify",
                    trace_logger=trace,
                )

        failed_fields = next(fields for event, fields in trace.events if event.endswith(".failed"))
        self.assertLessEqual(len(failed_fields["response_excerpt"]), 503)

    def test_shopify_discovery_rejects_product_without_required_title(self):
        product_url = PRODUCT_URL.split("?")[0]
        repository = DiscoveryRepository()

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch(
            "ludora.product_crawler.fetch_shopify_storefront_product",
            return_value=FetchResult(url=GRAPHQL_ENDPOINT, text=_payload(_shopify_product(title=""))),
        ):
            with self.assertRaisesRegex(RuntimeError, "missing its title"):
                crawl_store_product_details(
                    "https://tienda.example.mx/",
                    31,
                    repository,
                    platform="shopify",
                )

    def test_maps_public_product_fields_to_existing_candidate_shape(self):
        candidate = extract_shopify_storefront_candidate(
            _shopify_product(),
            product_url=PRODUCT_URL,
            source_listing_url="https://tienda.example.mx/collections/juegos",
            store_id=31,
        )

        self.assertEqual(candidate.title, "Mago: El Despertar 2ª edición")
        self.assertEqual(candidate.publisher, "Editorial Ludora")
        self.assertEqual(candidate.price, "899.00")
        self.assertEqual(candidate.currency, "MXN")
        self.assertEqual(candidate.availability, "available")
        self.assertEqual(candidate.store_sku, "MAG-02")
        self.assertEqual(candidate.image_url, "https://cdn.shopify.com/product.jpg")
        self.assertEqual(candidate.price_source, "shopify_storefront_graphql")
        self.assertEqual(candidate.availability_source, "shopify_storefront_graphql")
        self.assertEqual(candidate.raw_payload["shopify_graphql"]["id"], "gid://shopify/Product/123")

    def test_confirmed_shopify_refresh_uses_graphql_and_preserves_linkage(self):
        existing = _existing_record()
        trace = FakeTraceLogger()
        waited_urls = []
        browser_fetcher = Mock()
        headers_provider = Mock(return_value={"Signature": "sig-value"})

        with patch(
            "ludora.product_crawler.fetch_shopify_storefront_product",
            return_value=FetchResult(url=GRAPHQL_ENDPOINT, text=_payload()),
        ) as fetch_product:
            refreshed = refresh_confirmed_store_item_candidate(
                existing,
                platform="shopify",
                browser_fetcher=browser_fetcher,
                before_request=waited_urls.append,
                request_headers_provider=headers_provider,
                trace_logger=trace,
            )

        fetch_product.assert_called_once_with(PRODUCT_URL, request_headers_provider=headers_provider)
        browser_fetcher.assert_not_called()
        self.assertEqual(waited_urls, [GRAPHQL_ENDPOINT])
        self.assertEqual(refreshed.title, "Mago: El Despertar 2ª edición")
        self.assertEqual(refreshed.price, "899.00")
        self.assertEqual(refreshed.store_id, 31)
        self.assertEqual(refreshed.store_item_id, 501)
        self.assertEqual(refreshed.item_id, 91)
        self.assertEqual(refreshed.listing_status, "LISTED")
        self.assertTrue(refreshed.is_boardgame_confirmed)
        self.assertEqual(refreshed.raw_payload["product_details"], {"designer": "Ada"})
        self.assertIn(
            "item_update.item.shopify_graphql.completed",
            [event for event, _ in trace.events],
        )

    def test_http_429_is_returned_immediately_for_store_cooldown(self):
        existing = _existing_record()
        trace = FakeTraceLogger()
        browser_fetcher = Mock()

        with patch(
            "ludora.product_crawler.fetch_shopify_storefront_product",
            return_value=FetchResult(
                url=GRAPHQL_ENDPOINT,
                text='{"error":"Too Many Requests"}',
                status_code=429,
                retry_after_seconds=60.0,
            ),
        ) as fetch_product:
            with self.assertRaises(TransientProductFetchError) as raised:
                refresh_confirmed_store_item_candidate(
                    existing,
                    platform="shopify",
                    browser_fetcher=browser_fetcher,
                    trace_logger=trace,
                )

        self.assertEqual(fetch_product.call_count, 1)
        browser_fetcher.assert_not_called()
        self.assertEqual(raised.exception.status_code, 429)
        self.assertEqual(raised.exception.retry_after_seconds, 60.0)
        self.assertIn("Too Many Requests", str(raised.exception))
        failed_event = next(fields for event, fields in trace.events if event.endswith(".failed"))
        self.assertEqual(failed_event["response_excerpt"], '{"error":"Too Many Requests"}')

    def test_graphql_throttled_error_becomes_429_for_store_cooldown(self):
        errors = [
            {
                "message": "Query cost exceeds the available throttle budget",
                "extensions": {"code": "THROTTLED"},
            }
        ]
        with patch(
            "ludora.product_crawler.fetch_shopify_storefront_product",
            return_value=FetchResult(url=GRAPHQL_ENDPOINT, text=_payload(errors=errors)),
        ):
            with self.assertRaises(TransientProductFetchError) as raised:
                refresh_confirmed_store_item_candidate(_existing_record(), platform="shopify")

        self.assertEqual(raised.exception.status_code, 429)
        self.assertIn("THROTTLED", str(raised.exception))

    def test_null_product_marks_confirmed_listing_as_removed(self):
        with patch(
            "ludora.product_crawler.fetch_shopify_storefront_product",
            return_value=FetchResult(
                url=GRAPHQL_ENDPOINT,
                text=json.dumps({"data": {"product": None}}),
            ),
        ):
            with self.assertRaises(ProductPageRemovedError):
                refresh_confirmed_store_item_candidate(_existing_record(), platform="shopify")


if __name__ == "__main__":
    unittest.main()
