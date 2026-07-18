import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.database import ItemCandidateUpsertResult
from ludora.inventory import collect_store_inventory, update_confirmed_store_items
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import crawl_store_product_details, update_confirmed_store_item_details
from ludora.webfetch import FetchResult


class FakeRepository:
    def __init__(
        self,
        upsert_result=None,
        existing_urls=None,
        confirmed_items=None,
        update_change_log_results=None,
        store_platforms=None,
    ):
        self.item_records = []
        self.upsert_result = upsert_result
        self.existing_urls = set(existing_urls or [])
        self.exists_checks = []
        self.confirmed_items = list(confirmed_items or [])
        self.confirmed_items_limit = None
        self.confirmed_items_store_ids = None
        self.update_change_log_calls = []
        self.update_change_log_results = list(update_change_log_results or [])
        self.price_availability_update_calls = []
        self.inactive_update_calls = []
        self.store_platforms = dict(store_platforms or {})
        self.discovery_source_store_ids = None

    def item_candidate_exists(self, store_id, source_url):
        self.exists_checks.append((store_id, source_url))
        return (store_id, source_url) in self.existing_urls

    def upsert_item_candidate(self, record):
        self.item_records.append(record)
        return self.upsert_result

    def list_confirmed_boardgame_item_candidates(self, limit=None, store_ids=None):
        self.confirmed_items_limit = limit
        self.confirmed_items_store_ids = store_ids
        return self.confirmed_items

    def list_store_item_discovery_sources(self, *, store_ids=None):
        self.discovery_source_store_ids = store_ids
        selected_store_ids = store_ids if store_ids is not None else self.store_platforms
        return [
            SimpleNamespace(store_id=store_id, platform=self.store_platforms.get(store_id, ""))
            for store_id in selected_store_ids
        ]

    def update_item_candidate_with_change_log(
        self,
        existing_record,
        refreshed_record,
        *,
        job_id,
        run_id,
        include_title=True,
    ):
        self.update_change_log_calls.append((existing_record, refreshed_record, job_id, run_id, include_title))
        self.item_records.append(refreshed_record)
        if self.update_change_log_results:
            return self.update_change_log_results.pop(0)
        return ItemCandidateUpsertResult(candidate_id=101, listing_status="LISTED", item_id=refreshed_record.item_id, should_process=False)

    def update_item_candidate_price_availability(self, existing_record, refreshed_record, *, include_title=True):
        self.price_availability_update_calls.append((existing_record, refreshed_record, include_title))
        self.item_records.append(refreshed_record)
        return ItemCandidateUpsertResult(candidate_id=101, listing_status="LISTED", item_id=refreshed_record.item_id, should_process=False)

    def mark_item_candidate_inactive(self, existing_record, *, job_id=None, run_id=None):
        self.inactive_update_calls.append((existing_record, job_id, run_id))
        existing_record.store_active = False
        self.item_records.append(existing_record)
        return ItemCandidateUpsertResult(
            candidate_id=existing_record.store_item_id or 101,
            listing_status=existing_record.listing_status,
            item_id=existing_record.item_id,
            should_process=False,
            changed=True,
        )


class FakeItemProcessor:
    def __init__(self):
        self.processed = []

    def process_candidate(self, candidate_id, record):
        self.processed.append((candidate_id, record))


class FakeTraceLogger:
    def __init__(self):
        self.events = []

    def log(self, event, **fields):
        self.events.append((event, fields))


class InventoryTests(unittest.TestCase):
    def test_collect_store_inventory_prefers_sitemap_product_urls(self):
        detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Catan",
          "description": "Juego de mesa para 3 a 4 jugadores.",
          "brand": {"name": "Devir"},
          "offers": {"price": "899.00", "priceCurrency": "MXN"}
        }
        </script>
        """
        repository = FakeRepository()

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=["https://example.mx/products/catan"],
        ) as discover_product_urls, patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url="https://example.mx/products/catan", text=detail_html),
        ) as fetch_html:
            records = collect_store_inventory("https://example.mx/", 12, repository)

        discover_product_urls.assert_called_once_with(
            "https://example.mx/",
            browser_fetcher=None,
            browser_fallback_enabled=False,
            limit=None,
            trace_logger=ANY,
            cancellation_token=None,
        )
        fetch_html.assert_called_once_with(
            "https://example.mx/products/catan",
            include_http_error_status=True,
        )
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].title, "Catan")
        self.assertTrue(records[0].is_boardgame)
        self.assertFalse(records[0].is_boardgame_confirmed)
        self.assertEqual(repository.item_records[0].source_listing_url, "https://example.mx/sitemap.xml")

    def test_collect_store_inventory_falls_back_to_homepage_product_links(self):
        html = '<a href="/products/catan">Catan</a><span>$899 MXN</span>'
        detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Catan",
          "brand": {"name": "Devir"},
          "offers": {"price": "899.00", "priceCurrency": "MXN"}
        }
        </script>
        """
        repository = FakeRepository()

        with patch("ludora.product_crawler.discover_product_urls_from_sitemaps", return_value=[]), patch(
            "ludora.product_crawler.fetch_html",
            side_effect=[
                FetchResult(url="https://example.mx/", text=html),
                FetchResult(url="https://example.mx/products/catan", text=detail_html),
            ],
        ):
            records = collect_store_inventory("https://example.mx/", 12, repository)

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].title, "Catan")
        self.assertEqual(records[0].publisher, "Devir")
        self.assertEqual(repository.item_records[0].store_id, 12)
        self.assertEqual(repository.item_records[0].source_url, "https://example.mx/products/catan")
        self.assertEqual(repository.item_records[0].source_listing_url, "https://example.mx/")

    def test_collect_store_inventory_raises_when_homepage_fetch_fails(self):
        repository = FakeRepository()

        with patch("ludora.product_crawler.discover_product_urls_from_sitemaps", return_value=[]), patch(
            "ludora.product_crawler.fetch_html",
            return_value=None,
        ):
            with self.assertRaisesRegex(RuntimeError, "Failed to fetch store listing page: https://example.mx/"):
                collect_store_inventory("https://example.mx/", 12, repository)

        self.assertEqual(repository.item_records, [])

    def test_collect_store_inventory_retries_transient_homepage_status_and_honors_retry_after(self):
        listing_html = '<a href="/products/catan">Catan</a><span>$899 MXN</span>'
        detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Catan",
          "offers": {"price": "899.00", "priceCurrency": "MXN"}
        }
        </script>
        """
        store_url = "https://example.mx/"
        product_url = "https://example.mx/products/catan"
        repository = FakeRepository()
        trace = FakeTraceLogger()

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[],
        ), patch(
            "ludora.product_crawler.fetch_html",
            side_effect=[
                FetchResult(url=store_url, text="", status_code=503, retry_after_seconds=23.0),
                FetchResult(url=store_url, text=listing_html),
                FetchResult(url=product_url, text=detail_html),
            ],
        ) as fetch_html, patch("ludora.webfetch._wait_for_fetch_retry") as wait_for_retry:
            records = collect_store_inventory(
                store_url,
                12,
                repository,
                trace_logger=trace,
            )

        self.assertEqual(len(records), 1)
        self.assertEqual(fetch_html.call_count, 3)
        wait_for_retry.assert_called_once_with(23.0, None)
        http_error_events = [fields for event, fields in trace.events if event == "inventory.listing_fetch.http_error"]
        self.assertEqual(len(http_error_events), 1)
        self.assertEqual(http_error_events[0]["status_code"], 503)
        self.assertEqual(http_error_events[0]["retry_in_seconds"], 23.0)
        self.assertTrue(http_error_events[0]["will_retry"])

    def test_collect_store_inventory_reports_homepage_status_after_retries_exhausted(self):
        store_url = "https://example.mx/"
        repository = FakeRepository()
        trace = FakeTraceLogger()
        unavailable = FetchResult(url=store_url, text="", status_code=503, retry_after_seconds=0.0)

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[],
        ), patch(
            "ludora.product_crawler.fetch_html",
            side_effect=[unavailable, unavailable, unavailable],
        ) as fetch_html, patch("ludora.webfetch._wait_for_fetch_retry") as wait_for_retry:
            with self.assertRaisesRegex(
                RuntimeError,
                r"Failed to fetch store listing page: https://example.mx/ \(HTTP 503\)",
            ):
                collect_store_inventory(
                    store_url,
                    12,
                    repository,
                    trace_logger=trace,
                )

        self.assertEqual(fetch_html.call_count, 3)
        self.assertEqual(wait_for_retry.call_count, 2)
        http_error_events = [fields for event, fields in trace.events if event == "inventory.listing_fetch.http_error"]
        self.assertEqual([event["status_code"] for event in http_error_events], [503, 503, 503])
        self.assertEqual([event["will_retry"] for event in http_error_events], [True, True, False])
        self.assertEqual(repository.item_records, [])

    def test_collect_store_inventory_routes_amazon_platform_to_amazon_crawler(self):
        repository = FakeRepository()
        expected_records = [DiscoveryItemCandidateRecord(store_id=12, source_url="https://www.amazon.com.mx/dp/B0DZL3YFC5", title="Catfe")]

        with patch("ludora.inventory.crawl_amazon_store_inventory", return_value=expected_records) as amazon_crawler, patch(
            "ludora.inventory.crawl_store_product_details"
        ) as generic_crawler:
            records = collect_store_inventory(
                "https://www.amazon.com.mx/stores/page/00565807-102E-497A-894A-3434B4619BD2",
                12,
                repository,
                platform="amazon",
            )

        self.assertEqual(records, expected_records)
        generic_crawler.assert_not_called()
        amazon_crawler.assert_called_once()
        self.assertEqual(amazon_crawler.call_args.args[:3], (
            "https://www.amazon.com.mx/stores/page/00565807-102E-497A-894A-3434B4619BD2",
            12,
            repository,
        ))

    def test_collect_store_inventory_routes_amazon_brand_platform_to_brand_crawler(self):
        repository = FakeRepository()
        expected_records = [DiscoveryItemCandidateRecord(store_id=12, source_url="https://www.amazon.com.mx/dp/B0HASBRO01", title="Clue")]

        with patch("ludora.inventory.crawl_amazon_brand_inventory", return_value=expected_records) as brand_crawler, patch(
            "ludora.inventory.crawl_store_product_details"
        ) as generic_crawler:
            records = collect_store_inventory(
                "https://www.amazon.com.mx/s?srs=19815643011&rh=p_89%3AHasbro%2BGaming",
                12,
                repository,
                platform="amazon_brand",
                store_name="Hasbro Gaming",
            )

        self.assertEqual(records, expected_records)
        generic_crawler.assert_not_called()
        brand_crawler.assert_called_once()
        self.assertEqual(brand_crawler.call_args.args[:3], (
            "https://www.amazon.com.mx/s?srs=19815643011&rh=p_89%3AHasbro%2BGaming",
            12,
            repository,
        ))
        self.assertEqual(brand_crawler.call_args.kwargs["brand_name"], "Hasbro Gaming")

    def test_collect_store_inventory_enables_browser_fetch_for_godaddy_platform(self):
        repository = FakeRepository()

        with patch("ludora.inventory.crawl_store_product_details", return_value=[]) as generic_crawler:
            collect_store_inventory(
                "https://avalonstore.com.mx/",
                12,
                repository,
                platform="godaddy_website_builder",
                browser_sitemap_fetch_enabled=False,
            )

        generic_crawler.assert_called_once()
        self.assertTrue(generic_crawler.call_args.kwargs["browser_sitemap_fetch_enabled"])

    def test_crawl_store_product_details_uses_browser_for_blocked_detail_page(self):
        challenge_html = """
        <!DOCTYPE html>
        <html>
          <head><title>One moment, please...</title></head>
          <body>
            <script>
              setTimeout(function(){ window.location.reload(); }, 5000);
            </script>
          </body>
        </html>
        """
        detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Exploding Kittens",
          "brand": {"name": "Exploding Kittens"},
          "offers": {"price": "499.00", "priceCurrency": "MXN"}
        }
        </script>
        """
        repository = FakeRepository()
        browser_fetched_urls = []

        def fake_browser_fetcher(url):
            browser_fetched_urls.append(url)
            return FetchResult(url=url, text=detail_html)

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=["https://example.mx/producto/exploding-kittens/"],
        ) as discover_product_urls, patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url="https://example.mx/producto/exploding-kittens/", text=challenge_html),
        ):
            records = crawl_store_product_details(
                "https://example.mx/",
                12,
                repository,
                browser_fetch_enabled=True,
                browser_fetcher=fake_browser_fetcher,
            )

        discover_product_urls.assert_called_once_with(
            "https://example.mx/",
            browser_fetcher=fake_browser_fetcher,
            browser_fallback_enabled=True,
            limit=None,
            trace_logger=ANY,
            cancellation_token=None,
        )
        self.assertEqual(browser_fetched_urls, ["https://example.mx/producto/exploding-kittens/"])
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].title, "Exploding Kittens")
        self.assertEqual(records[0].price, "499.00")

    def test_crawl_store_product_details_uses_browser_when_static_detail_does_not_match_listing(self):
        static_html = """
        <html>
          <head>
            <title>7-Die Set Opaque Light Blue/white Chessex 25416</title>
            <meta name="description" content="Los dados opacos Chessex.">
          </head>
          <body>
            <h1>This website uses cookies.</h1>
          </body>
        </html>
        """
        rendered_html = """
        <html>
          <body>
            <h1>Catan</h1>
            <p>$850.00 MXN</p>
            <p>Almost Gone!</p>
            <p>Idioma: Espanol</p>
            <p>Jugadores: 3-4</p>
            <p>Duracion: 75 minutos</p>
            <p>Edad: 10+</p>
            <p>Editorial: Devir / Kosmos</p>
            <p>Un juego de mesa de comercio y desarrollo.</p>
          </body>
        </html>
        """
        product_url = "https://example.mx/tienda/ols/products/catan"
        repository = FakeRepository()
        browser_fetched_urls = []

        def fake_browser_fetcher(url):
            browser_fetched_urls.append(url)
            return FetchResult(url=url, text=rendered_html)

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=product_url, text=static_html),
        ):
            records = crawl_store_product_details(
                "https://example.mx/",
                12,
                repository,
                browser_fetch_enabled=True,
                browser_fetcher=fake_browser_fetcher,
            )

        self.assertEqual(browser_fetched_urls, [product_url])
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].title, "Catan")
        self.assertEqual(records[0].price, "850.00")
        self.assertEqual(records[0].min_players, 3)
        self.assertEqual(records[0].max_players, 4)
        self.assertTrue(records[0].is_boardgame)

    def test_crawl_store_product_details_uses_custom_item_classifier(self):
        detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Catan",
          "description": "Juego de mesa para 3 a 4 jugadores."
        }
        </script>
        """
        repository = FakeRepository()
        classified_titles = []

        def classify_with_ai(record):
            classified_titles.append(record.title)
            record.is_boardgame = False
            record.is_boardgame_confirmed = False
            record.category_confidence = 0.22
            record.classification_reasons = ["AI classifier: the payload is not a standalone board game."]
            return record

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=["https://example.mx/products/catan"],
        ), patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url="https://example.mx/products/catan", text=detail_html),
        ):
            records = crawl_store_product_details(
                "https://example.mx/",
                12,
                repository,
                item_classifier=classify_with_ai,
            )

        self.assertEqual(classified_titles, ["Catan"])
        self.assertEqual(len(records), 1)
        self.assertFalse(records[0].is_boardgame)
        self.assertEqual(records[0].category_confidence, 0.22)
        self.assertEqual(repository.item_records[0].classification_reasons[0], "AI classifier: the payload is not a standalone board game.")

    def test_crawl_store_product_details_propagates_classifier_errors(self):
        detail_html = """
        <script type="application/ld+json">
        {"@type": "Product", "name": "Catan"}
        </script>
        """
        repository = FakeRepository()

        def fail_classifier(record):
            raise RuntimeError("AI item classifier request failed: unavailable")

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=["https://example.mx/products/catan"],
        ), patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url="https://example.mx/products/catan", text=detail_html),
        ):
            with self.assertRaisesRegex(RuntimeError, "AI item classifier request failed"):
                crawl_store_product_details(
                    "https://example.mx/",
                    12,
                    repository,
                    item_classifier=fail_classifier,
                )

        self.assertEqual(repository.item_records, [])

    def test_crawl_store_product_details_raises_when_detail_fetch_fails(self):
        repository = FakeRepository()

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=["https://example.mx/products/catan"],
        ), patch(
            "ludora.product_crawler.fetch_html",
            return_value=None,
        ):
            with self.assertRaisesRegex(RuntimeError, "Failed to fetch product detail page: https://example.mx/products/catan"):
                crawl_store_product_details("https://example.mx/", 12, repository)

        self.assertEqual(repository.item_records, [])

    def test_crawl_store_product_details_retries_transient_http_status_and_honors_retry_after(self):
        detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Catan",
          "offers": {"price": "899.00", "priceCurrency": "MXN"}
        }
        </script>
        """
        product_url = "https://example.mx/products/catan"
        repository = FakeRepository()
        trace = FakeTraceLogger()

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch(
            "ludora.product_crawler.fetch_html",
            side_effect=[
                FetchResult(
                    url=product_url,
                    text="",
                    status_code=503,
                    retry_after_seconds=179.0,
                ),
                FetchResult(url=product_url, text=detail_html),
            ],
        ) as fetch_html, patch("ludora.webfetch._wait_for_fetch_retry") as wait_for_retry:
            records = crawl_store_product_details(
                "https://example.mx/",
                12,
                repository,
                trace_logger=trace,
            )

        self.assertEqual(len(records), 1)
        self.assertEqual(fetch_html.call_count, 2)
        wait_for_retry.assert_called_once_with(179.0, None)
        http_error_events = [fields for event, fields in trace.events if event == "inventory.candidate.detail_fetch.http_error"]
        self.assertEqual(
            http_error_events,
            [
                {
                    "attempt": 1,
                    "fetch_method": "static",
                    "max_attempts": 3,
                    "retry_after_seconds": 179.0,
                    "retry_in_seconds": 179.0,
                    "source_url": product_url,
                    "status_code": 503,
                    "will_retry": True,
                }
            ],
        )

    def test_crawl_store_product_details_reports_transient_http_status_after_retries_exhausted(self):
        product_url = "https://example.mx/products/catan"
        repository = FakeRepository()
        trace = FakeTraceLogger()
        unavailable = FetchResult(url=product_url, text="", status_code=503, retry_after_seconds=0.0)

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch(
            "ludora.product_crawler.fetch_html",
            side_effect=[unavailable, unavailable, unavailable],
        ) as fetch_html, patch("ludora.webfetch._wait_for_fetch_retry") as wait_for_retry:
            with self.assertRaisesRegex(
                RuntimeError,
                r"Failed to fetch product detail page: https://example.mx/products/catan \(HTTP 503\)",
            ):
                crawl_store_product_details(
                    "https://example.mx/",
                    12,
                    repository,
                    trace_logger=trace,
                )

        self.assertEqual(fetch_html.call_count, 3)
        self.assertEqual(wait_for_retry.call_count, 2)
        http_error_events = [fields for event, fields in trace.events if event == "inventory.candidate.detail_fetch.http_error"]
        self.assertEqual([event["status_code"] for event in http_error_events], [503, 503, 503])
        self.assertEqual([event["will_retry"] for event in http_error_events], [True, True, False])
        self.assertEqual(repository.item_records, [])

    def test_crawl_store_product_details_keeps_listing_title_when_browser_detail_is_cookie_only(self):
        cookie_html = """
        <html>
          <head>
            <title>7-Die Set Opaque Light Blue/white Chessex 25416</title>
            <meta name="description" content="Los dados opacos Chessex.">
          </head>
          <body>
            <h1>This website uses cookies.</h1>
          </body>
        </html>
        """
        product_url = "https://example.mx/tienda/ols/products/the-resistance-avalon"
        repository = FakeRepository()

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=product_url, text=cookie_html),
        ):
            records = crawl_store_product_details(
                "https://example.mx/",
                12,
                repository,
                browser_fetch_enabled=True,
                browser_fetcher=lambda url: FetchResult(url=url, text=cookie_html),
            )

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].title, "the resistance avalon")
        self.assertNotEqual(records[0].title, "This website uses cookies.")
        self.assertEqual(repository.item_records[0].title, "the resistance avalon")

    def test_crawl_store_product_details_processes_new_candidates_after_upsert(self):
        detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Catan",
          "description": "Juego de mesa para 3 a 4 jugadores.",
          "offers": {"price": "899.00", "priceCurrency": "MXN"}
        }
        </script>
        """
        repository = FakeRepository(
            ItemCandidateUpsertResult(candidate_id=101, listing_status="PENDING", item_id=None, should_process=True)
        )
        processor = FakeItemProcessor()

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=["https://example.mx/products/catan"],
        ), patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url="https://example.mx/products/catan", text=detail_html),
        ):
            crawl_store_product_details(
                "https://example.mx/",
                12,
                repository,
                item_processor=processor,
            )

        self.assertEqual(len(processor.processed), 1)
        self.assertEqual(processor.processed[0][0], 101)
        self.assertEqual(processor.processed[0][1].title, "Catan")

    def test_crawl_store_product_details_skips_processing_when_upsert_says_not_to_process(self):
        detail_html = """
        <script type="application/ld+json">
        {"@type": "Product", "name": "Catan"}
        </script>
        """
        repository = FakeRepository(
            ItemCandidateUpsertResult(candidate_id=102, listing_status="PENDING", item_id=None, should_process=False)
        )
        processor = FakeItemProcessor()

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=["https://example.mx/products/catan"],
        ), patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url="https://example.mx/products/catan", text=detail_html),
        ):
            crawl_store_product_details(
                "https://example.mx/",
                12,
                repository,
                item_processor=processor,
            )

        self.assertEqual(processor.processed, [])

    def test_crawl_store_product_details_skips_existing_product_urls_before_fetching_details(self):
        product_url = "https://example.mx/products/catan"
        repository = FakeRepository(existing_urls={(12, product_url)})

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch("ludora.product_crawler.fetch_html") as fetch_html:
            records = crawl_store_product_details(
                "https://example.mx/",
                12,
                repository,
            )

        fetch_html.assert_not_called()
        self.assertEqual(records, [])
        self.assertEqual(repository.item_records, [])
        self.assertEqual(repository.exists_checks, [(12, product_url)])

    def test_update_confirmed_store_item_details_refreshes_confirmed_rows_with_price_availability_update(self):
        detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Catan Nueva Edicion",
          "description": "Juego de mesa para 3 a 4 jugadores.",
          "offers": {"price": "799.00", "priceCurrency": "MXN"}
        }
        </script>
        """
        existing_record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/catan",
            source_listing_url="https://example.mx/sitemap.xml",
            title="Catan",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
            category_confidence=0.91,
            classification_reasons=["previously confirmed"],
        )
        repository = FakeRepository(confirmed_items=[existing_record])

        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url="https://example.mx/products/catan", text=detail_html),
        ) as fetch_html:
            records = update_confirmed_store_item_details(repository, limit=25)

        fetch_html.assert_called_once_with(
            "https://example.mx/products/catan",
            include_http_error_status=True,
        )
        self.assertEqual(repository.confirmed_items_limit, 25)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].title, "Catan Nueva Edicion")
        self.assertEqual(records[0].price, "799.00")
        self.assertEqual(len(repository.price_availability_update_calls), 1)
        self.assertEqual(repository.price_availability_update_calls[0][0], existing_record)
        self.assertTrue(repository.price_availability_update_calls[0][2])
        self.assertEqual(repository.item_records[0].item_id, 77)
        self.assertEqual(repository.item_records[0].listing_status, "LISTED")
        self.assertTrue(repository.item_records[0].is_boardgame)
        self.assertTrue(repository.item_records[0].is_boardgame_confirmed)
        self.assertEqual(repository.item_records[0].category_confidence, 0.91)
        self.assertEqual(repository.item_records[0].classification_reasons, ["previously confirmed"])
        self.assertEqual(repository.update_change_log_calls, [])

    def test_update_confirmed_amazon_item_uses_amazon_detail_parser(self):
        product_html = """
        <html><body>
          <span id="productTitle">Catan - Juego de Mesa</span>
          <span class="a-offscreen">$799.00</span>
          <div id="availability">Disponible</div>
          <input id="add-to-cart-button" type="submit" value="Agregar al carrito">
          <input id="buy-now-button" type="submit" value="Comprar ahora">
          <table><tr><th>ASIN</th><td>B0TEST1234</td></tr></table>
        </body></html>
        """
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://www.amazon.com.mx/dp/B0TEST1234",
            source_listing_url="https://www.amazon.com.mx/stores/page/store-id/search?terms=jue",
            title="Catan",
            item_id=77,
            listing_status="LISTED",
            price_source="amazon_detail",
            availability_source="amazon_detail",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(confirmed_items=[existing_record], store_platforms={12: "amazon"})

        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=existing_record.source_url, text=product_html),
        ), patch("ludora.product_crawler.extract_product_detail_candidate") as generic_parser:
            records = update_confirmed_store_item_details(repository, job_id=99, run_id="run-amazon")

        generic_parser.assert_not_called()
        self.assertEqual(repository.discovery_source_store_ids, None)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].price, "799.00")
        self.assertEqual(records[0].price_source, "amazon_detail")
        self.assertEqual(records[0].availability, "available")
        self.assertEqual(records[0].availability_source, "amazon_detail")
        self.assertEqual(len(repository.update_change_log_calls), 1)
        self.assertFalse(repository.update_change_log_calls[0][4])

    def test_update_confirmed_amazon_item_marks_missing_direct_buy_option_out_of_stock(self):
        product_html = """
        <html><body>
          <span id="productTitle">Asmodee Survive The Island Monster Pack</span>
          <div id="availability"><div id="all-offers-display"></div></div>
          <div id="recommendations"><span class="a-offscreen">$635.11</span></div>
          <table><tr><th>ASIN</th><td>B0DQVHVBX6</td></tr></table>
        </body></html>
        """
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=57,
            store_id=12,
            source_url="https://www.amazon.com.mx/dp/B0DQVHVBX6",
            source_listing_url="https://www.amazon.com.mx/stores/page/store-id/search?terms=jue",
            title="Survive The Island Monster Pack",
            raw_price="$199.00",
            price="199.00",
            price_source="amazon_detail",
            availability="available",
            availability_source="amazon_detail",
            item_id=78,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(confirmed_items=[existing_record], store_platforms={12: "amazon_brand"})

        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=existing_record.source_url, text=product_html),
        ):
            records = update_confirmed_store_item_details(repository, job_id=100, run_id="run-amazon-out")

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].availability, "out_of_stock")
        self.assertEqual(records[0].availability_source, "amazon_detail")
        self.assertEqual(records[0].raw_price, "")
        self.assertEqual(records[0].price, "")
        self.assertEqual(records[0].price_source, "none")
        self.assertEqual(len(repository.update_change_log_calls), 1)
        self.assertFalse(repository.update_change_log_calls[0][4])

    def test_update_confirmed_store_item_details_raises_when_detail_fetch_fails(self):
        existing_record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/catan",
            title="Catan",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(confirmed_items=[existing_record])

        with patch("ludora.product_crawler.fetch_html", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "Failed to fetch product detail page: https://example.mx/products/catan"):
                update_confirmed_store_item_details(repository, job_id=99, run_id="run-123")

        self.assertEqual(repository.item_records, [])
        self.assertEqual(repository.update_change_log_calls, [])

    def test_update_confirmed_store_item_details_retries_transient_pool_after_normal_items(self):
        candidates = [
            DiscoveryItemCandidateRecord(
                store_item_id=store_item_id,
                store_id=12,
                source_url=f"https://example.mx/products/{slug}",
                title=title,
                item_id=item_id,
                listing_status="LISTED",
                is_boardgame=True,
                is_boardgame_confirmed=True,
            )
            for store_item_id, slug, title, item_id in (
                (56, "catan", "Catan", 77),
                (57, "azul", "Azul", 78),
                (58, "splendor", "Splendor", 79),
            )
        ]
        repository = FakeRepository(confirmed_items=candidates)
        attempts_by_url = {candidate.source_url: 0 for candidate in candidates}
        fetch_order = []

        def fetch_detail(url, include_http_error_status=False):
            self.assertTrue(include_http_error_status)
            attempts_by_url[url] += 1
            fetch_order.append(url)
            if url != candidates[2].source_url and attempts_by_url[url] <= 3:
                return FetchResult(url=url, text="", status_code=503, retry_after_seconds=0.0)
            title = next(candidate.title for candidate in candidates if candidate.source_url == url)
            return FetchResult(
                url=url,
                text=f'<script type="application/ld+json">{{"@type":"Product","name":"{title}"}}</script>',
            )

        with patch("ludora.product_crawler.random.shuffle"), patch(
            "ludora.product_crawler.fetch_html",
            side_effect=fetch_detail,
        ) as fetch_html, patch("ludora.webfetch._wait_for_fetch_retry") as wait_for_retry:
            records = update_confirmed_store_item_details(repository, job_id=99, run_id="run-123")

        self.assertEqual(fetch_html.call_count, 9)
        self.assertEqual(wait_for_retry.call_count, 4)
        self.assertEqual(
            fetch_order,
            [
                candidates[0].source_url,
                candidates[0].source_url,
                candidates[0].source_url,
                candidates[1].source_url,
                candidates[1].source_url,
                candidates[1].source_url,
                candidates[2].source_url,
                candidates[0].source_url,
                candidates[1].source_url,
            ],
        )
        self.assertEqual([record.store_item_id for record in records], [58, 56, 57])
        self.assertEqual([record.store_item_id for record in repository.item_records], [58, 56, 57])

    def test_update_confirmed_store_item_details_fails_on_first_retry_pool_failure(self):
        candidates = [
            DiscoveryItemCandidateRecord(
                store_item_id=store_item_id,
                store_id=12,
                source_url=f"https://example.mx/products/{slug}",
                title=title,
                item_id=item_id,
                listing_status="LISTED",
                is_boardgame=True,
                is_boardgame_confirmed=True,
            )
            for store_item_id, slug, title, item_id in (
                (56, "catan", "Catan", 77),
                (57, "azul", "Azul", 78),
                (58, "splendor", "Splendor", 79),
            )
        ]
        repository = FakeRepository(confirmed_items=candidates)
        fetch_order = []

        def fetch_detail(url, include_http_error_status=False):
            self.assertTrue(include_http_error_status)
            fetch_order.append(url)
            if url != candidates[2].source_url:
                return FetchResult(url=url, text="", status_code=503, retry_after_seconds=0.0)
            return FetchResult(
                url=url,
                text='<script type="application/ld+json">{"@type":"Product","name":"Splendor"}</script>',
            )

        with patch("ludora.product_crawler.random.shuffle"), patch(
            "ludora.product_crawler.fetch_html",
            side_effect=fetch_detail,
        ) as fetch_html, patch("ludora.webfetch._wait_for_fetch_retry") as wait_for_retry:
            with self.assertRaisesRegex(
                RuntimeError,
                r"Failed to fetch product detail page: https://example.mx/products/catan \(HTTP 503\)",
            ):
                update_confirmed_store_item_details(repository, job_id=99, run_id="run-123")

        self.assertEqual(fetch_html.call_count, 10)
        self.assertEqual(wait_for_retry.call_count, 6)
        self.assertEqual(
            fetch_order,
            [
                *([candidates[0].source_url] * 3),
                *([candidates[1].source_url] * 3),
                candidates[2].source_url,
                *([candidates[0].source_url] * 3),
            ],
        )
        self.assertEqual([record.store_item_id for record in repository.item_records], [58])

    def test_update_confirmed_store_item_details_marks_http_404_as_inactive(self):
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://example.mx/products/catan",
            title="Catan",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(confirmed_items=[existing_record])

        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(
                url=existing_record.source_url,
                text="",
                status_code=404,
            ),
        ):
            records = update_confirmed_store_item_details(repository, job_id=99, run_id="run-123")

        self.assertEqual(len(records), 1)
        self.assertFalse(records[0].store_active)
        self.assertEqual(records.updated_items, 1)
        self.assertEqual(repository.inactive_update_calls, [(existing_record, 99, "run-123")])
        self.assertEqual(repository.update_change_log_calls, [])
        self.assertEqual(repository.price_availability_update_calls, [])

    def test_update_confirmed_store_item_details_retries_ambiguous_failure_before_marking_404_inactive(self):
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=3529,
            store_id=4,
            source_url="https://caravanagameshop.com/producto/pareja-de-pacotilla/",
            title="Pareja de Pacotilla",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(confirmed_items=[existing_record])

        with patch(
            "ludora.product_crawler.fetch_html",
            side_effect=[
                None,
                FetchResult(url=existing_record.source_url, text="", status_code=404),
            ],
        ) as fetch_html:
            records = update_confirmed_store_item_details(repository, job_id=12, run_id="run-retry")

        self.assertEqual(fetch_html.call_count, 2)
        self.assertEqual(len(records), 1)
        self.assertFalse(records[0].store_active)
        self.assertEqual(records.updated_items, 1)
        self.assertEqual(repository.inactive_update_calls, [(existing_record, 12, "run-retry")])

    def test_update_confirmed_store_item_details_marks_browser_http_410_as_inactive(self):
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://example.mx/products/catan",
            title="Catan",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(confirmed_items=[existing_record])

        with patch("ludora.product_crawler.fetch_html", return_value=None):
            records = update_confirmed_store_item_details(
                repository,
                browser_fetch_enabled=True,
                browser_fetcher=lambda url: FetchResult(url=url, text="", status_code=410),
            )

        self.assertEqual(len(records), 1)
        self.assertFalse(records[0].store_active)
        self.assertEqual(records.updated_items, 1)
        self.assertEqual(repository.inactive_update_calls, [(existing_record, None, None)])

    def test_update_confirmed_store_item_details_marks_explicit_soft_404_as_inactive(self):
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://example.mx/products/catan",
            title="Catan",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(confirmed_items=[existing_record])
        soft_404_html = "<html><head><title>Página no encontrada</title></head><body></body></html>"

        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=existing_record.source_url, text=soft_404_html),
        ):
            records = update_confirmed_store_item_details(repository)

        self.assertEqual(len(records), 1)
        self.assertFalse(records[0].store_active)
        self.assertEqual(records.updated_items, 1)
        self.assertEqual(repository.inactive_update_calls, [(existing_record, None, None)])

    def test_update_confirmed_store_items_forwards_selected_store_ids(self):
        repository = FakeRepository()

        with patch("ludora.inventory.update_confirmed_store_item_details", return_value=[]) as updater:
            records = update_confirmed_store_items(repository, limit=25, store_ids=[12, 34])

        self.assertEqual(records, [])
        updater.assert_called_once()
        self.assertIs(updater.call_args.args[0], repository)
        self.assertEqual(updater.call_args.kwargs["limit"], 25)
        self.assertEqual(updater.call_args.kwargs["store_ids"], [12, 34])

    def test_update_confirmed_store_item_details_forwards_selected_store_ids_to_repository(self):
        repository = FakeRepository()

        records = update_confirmed_store_item_details(repository, limit=25, store_ids=[12, 34])

        self.assertEqual(records, [])
        self.assertEqual(repository.confirmed_items_limit, 25)
        self.assertEqual(repository.confirmed_items_store_ids, [12, 34])
        self.assertEqual(repository.discovery_source_store_ids, [12, 34])

    def test_update_confirmed_store_item_details_randomizes_older_pool_before_newer_pool(self):
        first_record = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://alpha.example/products/catan",
            title="Catan",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        second_record = DiscoveryItemCandidateRecord(
            store_item_id=57,
            store_id=34,
            source_url="https://beta.example/products/azul",
            title="Azul",
            item_id=78,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        third_record = DiscoveryItemCandidateRecord(
            store_item_id=58,
            store_id=12,
            source_url="https://alpha.example/products/carcassonne",
            title="Carcassonne",
            item_id=79,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        fourth_record = DiscoveryItemCandidateRecord(
            store_item_id=59,
            store_id=34,
            source_url="https://beta.example/products/splendor",
            title="Splendor",
            item_id=80,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        fifth_record = DiscoveryItemCandidateRecord(
            store_item_id=60,
            store_id=12,
            source_url="https://alpha.example/products/patchwork",
            title="Patchwork",
            item_id=81,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(
            confirmed_items=[first_record, second_record, third_record, fourth_record, fifth_record]
        )
        fetched_store_item_ids = []
        shuffled_pools = []

        def fake_fetch_detail_candidate(*, listing_candidate, **_kwargs):
            fetched_store_item_ids.append(listing_candidate.store_item_id)
            return listing_candidate

        def deterministic_shuffle(candidates):
            shuffled_pools.append([candidate.store_item_id for candidate in candidates])
            candidates.reverse()

        with patch(
            "ludora.product_crawler.random.shuffle",
            side_effect=deterministic_shuffle,
        ) as shuffle, patch(
            "ludora.product_crawler._fetch_detail_candidate",
            side_effect=fake_fetch_detail_candidate,
        ):
            records = update_confirmed_store_item_details(repository)

        self.assertEqual(shuffle.call_count, 2)
        self.assertEqual(shuffled_pools, [[56, 57, 58], [59, 60]])
        self.assertEqual(fetched_store_item_ids, [58, 57, 56, 60, 59])
        self.assertEqual([record.store_item_id for record in records], [58, 57, 56, 60, 59])
        self.assertEqual(
            [record.store_item_id for record in repository.confirmed_items],
            [56, 57, 58, 59, 60],
        )

    def test_update_confirmed_store_item_details_uses_age_pools_for_one_store(self):
        first_record = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://alpha.example/products/catan",
            title="Catan",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        second_record = DiscoveryItemCandidateRecord(
            store_item_id=57,
            store_id=12,
            source_url="https://alpha.example/products/azul",
            title="Azul",
            item_id=78,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        third_record = DiscoveryItemCandidateRecord(
            store_item_id=58,
            store_id=12,
            source_url="https://alpha.example/products/carcassonne",
            title="Carcassonne",
            item_id=79,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        fourth_record = DiscoveryItemCandidateRecord(
            store_item_id=59,
            store_id=12,
            source_url="https://alpha.example/products/splendor",
            title="Splendor",
            item_id=80,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(
            confirmed_items=[first_record, second_record, third_record, fourth_record]
        )
        fetched_store_item_ids = []

        def fake_fetch_detail_candidate(*, listing_candidate, **_kwargs):
            fetched_store_item_ids.append(listing_candidate.store_item_id)
            return listing_candidate

        with patch(
            "ludora.product_crawler.random.shuffle",
            side_effect=lambda candidates: candidates.reverse(),
        ) as shuffle, patch(
            "ludora.product_crawler._fetch_detail_candidate",
            side_effect=fake_fetch_detail_candidate,
        ):
            records = update_confirmed_store_item_details(repository, store_ids=[12])

        self.assertEqual(shuffle.call_count, 2)
        self.assertEqual(fetched_store_item_ids, [57, 56, 59, 58])
        self.assertEqual([record.store_item_id for record in records], [57, 56, 59, 58])

    def test_update_confirmed_store_item_details_logs_changes_when_job_id_is_available(self):
        detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Catan Nueva Edicion",
          "offers": {"price": "799.00", "priceCurrency": "MXN"}
        }
        </script>
        """
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://example.mx/products/catan",
            source_listing_url="https://example.mx/sitemap.xml",
            title="Catan",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(confirmed_items=[existing_record])

        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url="https://example.mx/products/catan", text=detail_html),
        ):
            records = update_confirmed_store_item_details(repository, job_id=99, run_id="run-123")

        self.assertEqual(len(records), 1)
        self.assertEqual(len(repository.update_change_log_calls), 1)
        logged_existing, logged_refreshed, logged_job_id, logged_run_id, include_title = (
            repository.update_change_log_calls[0]
        )
        self.assertIs(logged_existing, existing_record)
        self.assertEqual(logged_refreshed.title, "Catan Nueva Edicion")
        self.assertEqual(logged_refreshed.store_item_id, 56)
        self.assertEqual(logged_refreshed.item_id, 77)
        self.assertEqual(logged_refreshed.listing_status, "LISTED")
        self.assertEqual(logged_job_id, 99)
        self.assertEqual(logged_run_id, "run-123")
        self.assertTrue(include_title)

    def test_update_confirmed_store_item_details_counts_only_changed_items_as_updated(self):
        first_detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Catan Nueva Edicion"
        }
        </script>
        """
        second_detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Azul"
        }
        </script>
        """
        first_record = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://example.mx/products/catan",
            title="Catan",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        second_record = DiscoveryItemCandidateRecord(
            store_item_id=57,
            store_id=12,
            source_url="https://example.mx/products/azul",
            title="Azul",
            item_id=78,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(
            confirmed_items=[first_record, second_record],
            update_change_log_results=[SimpleNamespace(changed=True), SimpleNamespace(changed=False)],
        )

        with patch(
            "ludora.product_crawler.fetch_html",
            side_effect=[
                FetchResult(url="https://example.mx/products/catan", text=first_detail_html),
                FetchResult(url="https://example.mx/products/azul", text=second_detail_html),
            ],
        ):
            records = update_confirmed_store_item_details(repository, job_id=99, run_id="run-123")

        self.assertEqual(len(records), 2)
        self.assertEqual(getattr(records, "updated_items", None), 1)


if __name__ == "__main__":
    unittest.main()
