import json
import sys
import unittest
from pathlib import Path
from unittest.mock import ANY, Mock, call, patch
from urllib.parse import parse_qs, urlparse


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import crawl_store_product_details
from ludora.webfetch import FetchResult


class FakeTraceLogger:
    def __init__(self):
        self.events = []

    def log(self, event, **fields):
        self.events.append((event, fields))


def json_result(url, payload):
    return FetchResult(url=url, text=json.dumps(payload))


class HidralisticoDiscoveryTests(unittest.TestCase):
    def test_exact_host_selects_category_id_and_paginates_products_without_sitemap_candidates(self):
        first_page = [
            {
                "id": product_id,
                "name": f"Juego {product_id}",
                "permalink": f"https://hidralistico.com.mx/producto/juego-{product_id}/",
            }
            for product_id in range(1, 101)
        ]
        second_page = [
            {
                "id": 101,
                "name": "Bitoku",
                "permalink": "https://hidralistico.com.mx/producto/bitoku/?utm_source=store-api#details",
            },
            {
                "id": 102,
                "name": "Juego 1 duplicado",
                "permalink": "https://hidralistico.com.mx/producto/juego-1/?duplicate=true",
            },
        ]
        fetched_urls = []

        def api_fetcher(url, **kwargs):
            fetched_urls.append(url)
            parsed = urlparse(url)
            query = parse_qs(parsed.query)
            self.assertEqual(kwargs, {"headers": None, "include_http_error_status": True})
            if parsed.path.endswith("/products/categories"):
                return json_result(
                    url,
                    [
                        {"id": 9, "name": "Juegos de mesa y rol", "slug": "juegos-de-mesa-y-rol"},
                        {"id": 27, "name": "Juegos de mesa", "slug": "juegos-de-mesa"},
                    ],
                )
            self.assertEqual(query["category"], ["27"])
            self.assertEqual(query["per_page"], ["100"])
            page = int(query["page"][0])
            return json_result(url, first_page if page == 1 else second_page)

        repository = Mock()
        trace = FakeTraceLogger()
        expected_records = [
            DiscoveryItemCandidateRecord(
                store_id=55,
                source_url="https://hidralistico.com.mx/producto/bitoku/",
                title="Bitoku",
            )
        ]
        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=["https://hidralistico.com.mx/producto/sitemap-only/"],
        ) as sitemap_discovery, patch(
            "ludora.product_crawler.fetch_html",
            side_effect=api_fetcher,
        ), patch(
            "ludora.product_crawler.crawl_listing_candidates",
            return_value=expected_records,
        ) as crawl_candidates:
            records = crawl_store_product_details(
                "https://www.hidralistico.com.mx/",
                55,
                repository,
                platform="woocommerce",
                trace_logger=trace,
            )

        self.assertEqual(records, expected_records)
        sitemap_discovery.assert_not_called()
        self.assertEqual(len(fetched_urls), 3)
        candidates = crawl_candidates.call_args.args[0]
        self.assertEqual(len(candidates), 101)
        self.assertEqual(candidates[-1].source_url, "https://hidralistico.com.mx/producto/bitoku/")
        self.assertEqual(candidates[-1].title, "Bitoku")
        self.assertEqual(candidates[-1].store_id, 55)
        self.assertEqual(
            sum(candidate.source_url == "https://hidralistico.com.mx/producto/juego-1/" for candidate in candidates),
            1,
        )
        selected = [fields for event, fields in trace.events if event == "inventory.hidralistico_store_api.category_selected"]
        self.assertEqual(selected, [{"category_id": 27, "category_slug": "juegos-de-mesa", "store_id": 55}])
        completed = [fields for event, fields in trace.events if event == "inventory.hidralistico_store_api.completed"]
        self.assertEqual(completed[0]["product_count"], 101)

    def test_limit_stops_after_requested_candidates_without_fetching_another_product_page(self):
        product_page = [
            {
                "id": product_id,
                "name": f"Juego {product_id}",
                "permalink": f"https://hidralistico.com.mx/producto/juego-{product_id}/",
            }
            for product_id in range(1, 101)
        ]
        fetched_product_pages = []

        def api_fetcher(url, **_kwargs):
            parsed = urlparse(url)
            query = parse_qs(parsed.query)
            if parsed.path.endswith("/products/categories"):
                return json_result(url, [{"id": 83, "name": "Juegos de mesa", "slug": "juegos-de-mesa"}])
            fetched_product_pages.append(int(query["page"][0]))
            self.assertEqual(query["category"], ["83"])
            self.assertEqual(query["per_page"], ["100"])
            return json_result(url, product_page)

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=["https://hidralistico.com.mx/producto/sitemap-only/"],
        ) as sitemap_discovery, patch(
            "ludora.product_crawler.fetch_html",
            side_effect=api_fetcher,
        ), patch(
            "ludora.product_crawler.crawl_listing_candidates",
            return_value=[],
        ) as crawl_candidates:
            crawl_store_product_details(
                "https://hidralistico.com.mx/",
                55,
                Mock(),
                limit=3,
                platform="woocommerce",
            )

        sitemap_discovery.assert_not_called()
        self.assertEqual(fetched_product_pages, [1])
        self.assertEqual(
            [candidate.source_url for candidate in crawl_candidates.call_args.args[0]],
            [
                "https://hidralistico.com.mx/producto/juego-1/",
                "https://hidralistico.com.mx/producto/juego-2/",
                "https://hidralistico.com.mx/producto/juego-3/",
            ],
        )

    def test_incompatible_category_response_falls_back_to_sitemap_with_reason(self):
        trace = FakeTraceLogger()
        fallback_url = "https://hidralistico.com.mx/producto/sitemap-fallback/"
        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[fallback_url],
        ) as sitemap_discovery, patch(
            "ludora.product_crawler.fetch_html",
            return_value=json_result(
                "https://hidralistico.com.mx/wp-json/wc/store/v1/products/categories",
                {"unexpected": "shape"},
            ),
        ) as api_fetcher, patch(
            "ludora.product_crawler.crawl_listing_candidates",
            return_value=[],
        ) as crawl_candidates:
            crawl_store_product_details(
                "https://hidralistico.com.mx/",
                55,
                Mock(),
                platform="woocommerce",
                trace_logger=trace,
            )

        api_fetcher.assert_called_once()
        sitemap_discovery.assert_called_once_with(
            "https://hidralistico.com.mx/",
            browser_fetcher=None,
            browser_fallback_enabled=False,
            limit=None,
            request_headers_provider=None,
            trace_logger=ANY,
            cancellation_token=None,
        )
        self.assertEqual(crawl_candidates.call_args.args[0][0].source_url, fallback_url)
        fallback_events = [fields for event, fields in trace.events if event == "inventory.hidralistico_store_api.fallback"]
        self.assertEqual(fallback_events[0]["reason"], "category_response_incompatible")

    def test_similar_category_slug_does_not_get_selected(self):
        trace = FakeTraceLogger()
        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=["https://hidralistico.com.mx/producto/sitemap-fallback/"],
        ) as sitemap_discovery, patch(
            "ludora.product_crawler.fetch_html",
            return_value=json_result(
                "https://hidralistico.com.mx/wp-json/wc/store/v1/products/categories",
                [{"id": 91, "name": "Juegos de mesa y rol", "slug": "juegos-de-mesa-y-rol"}],
            ),
        ), patch("ludora.product_crawler.crawl_listing_candidates", return_value=[]):
            crawl_store_product_details(
                "https://hidralistico.com.mx/",
                55,
                Mock(),
                platform="woocommerce",
                trace_logger=trace,
            )

        sitemap_discovery.assert_called_once()
        fallback_events = [fields for event, fields in trace.events if event == "inventory.hidralistico_store_api.fallback"]
        self.assertTrue(fallback_events, "expected a traceable Store API fallback reason")
        self.assertEqual(fallback_events[0]["reason"], "category_not_found")

    def test_selected_category_with_no_products_falls_back_instead_of_completing_empty(self):
        trace = FakeTraceLogger()
        responses = [
            [{"id": 27, "name": "Juegos de mesa", "slug": "juegos-de-mesa"}],
            [],
        ]

        def api_fetcher(url, **_kwargs):
            return json_result(url, responses.pop(0))

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=["https://hidralistico.com.mx/producto/sitemap-fallback/"],
        ) as sitemap_discovery, patch(
            "ludora.product_crawler.fetch_html",
            side_effect=api_fetcher,
        ), patch("ludora.product_crawler.crawl_listing_candidates", return_value=[]):
            crawl_store_product_details(
                "https://hidralistico.com.mx/",
                55,
                Mock(),
                platform="woocommerce",
                trace_logger=trace,
            )

        sitemap_discovery.assert_called_once()
        fallback_events = [fields for event, fields in trace.events if event == "inventory.hidralistico_store_api.fallback"]
        self.assertTrue(fallback_events, "expected a traceable Store API fallback reason")
        self.assertEqual(fallback_events[0]["reason"], "category_products_empty")
        self.assertFalse(any(event == "inventory.hidralistico_store_api.completed" for event, _fields in trace.events))

    def test_lookalike_and_unrelated_hosts_keep_generic_sitemap_discovery(self):
        store_urls = [
            "https://hidralistico.com.mx.attacker.example/",
            "https://evilhidralistico.com.mx/",
            "https://example.mx/",
        ]
        sitemap_url = "https://example.mx/producto/sitemap-product/"
        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[sitemap_url],
        ) as sitemap_discovery, patch(
            "ludora.product_crawler.fetch_html",
        ) as fetch_html, patch(
            "ludora.product_crawler.crawl_listing_candidates",
            return_value=[],
        ):
            for store_url in store_urls:
                crawl_store_product_details(store_url, 55, Mock(), platform="woocommerce")

        self.assertEqual(
            [entry.args[0] for entry in sitemap_discovery.call_args_list],
            store_urls,
        )
        fetch_html.assert_not_called()


if __name__ == "__main__":
    unittest.main()
