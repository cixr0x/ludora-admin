import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, Mock, call, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.browser_fetch import BrowserTextFetcher
from ludora.cancellation import CancellationToken, OperationCancelled
from ludora.database import ItemCandidateUpsertResult
from ludora.inventory import collect_store_inventory, update_confirmed_store_items
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import (
    ProductDetailRejectedError,
    TransientProductFetchError,
    _should_retry_detail_with_browser,
    _significant_text_tokens,
    crawl_store_product_details,
    refresh_confirmed_store_item_candidate,
    update_confirmed_store_item_details,
)
from ludora.webfetch import FetchResult, PerHostRequestThrottle


class RetryBrowserResponse:
    def __init__(self, url, text, *, content_type="text/html;charset=utf-8"):
        self.url = url
        self._text = text
        self.headers = {"content-type": content_type}
        self.status = 200

    def text(self):
        return self._text


class RetryBrowserPage:
    def __init__(self, response, rendered_html_by_read, *, on_first_content=None):
        self.url = response.url
        self.response = response
        self.rendered_html_by_read = list(rendered_html_by_read)
        self.on_first_content = on_first_content
        self.content_reads = 0
        self.goto_count = 0
        self.wait_timeouts = []
        self.closed = False

    def goto(self, _url, wait_until, timeout):
        self.goto_count += 1
        if wait_until != "domcontentloaded" or timeout != 30_000:
            raise AssertionError("Unexpected browser navigation arguments")
        return self.response

    def content(self):
        if self.content_reads == 0 and self.on_first_content is not None:
            self.on_first_content()
        index = min(self.content_reads, len(self.rendered_html_by_read) - 1)
        self.content_reads += 1
        return self.rendered_html_by_read[index]

    def wait_for_timeout(self, timeout):
        self.wait_timeouts.append(timeout)

    def wait_for_load_state(self, state, timeout):
        return None

    def wait_for_function(self, expression, arg, timeout):
        return None

    def close(self):
        self.closed = True


class RetryBrowserContext:
    def __init__(self, pages):
        self.pages = list(pages)

    def new_page(self):
        return self.pages.pop(0)


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
        self.progress_updates = []
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

    def update_store_item_update_progress(self, *, job_id, scanned_items, updated_items):
        self.progress_updates.append((job_id, scanned_items, updated_items))


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
    def setUp(self):
        interval_patcher = patch("ludora.product_crawler.STORE_UPDATE_MIN_INTERVAL_SECONDS", 0.0)
        jitter_patcher = patch("ludora.product_crawler.STORE_UPDATE_JITTER_SECONDS", 0.0)
        interval_patcher.start()
        jitter_patcher.start()
        self.addCleanup(interval_patcher.stop)
        self.addCleanup(jitter_patcher.stop)

    def test_title_tokens_expand_common_ligatures_before_ascii_folding(self):
        self.assertEqual(
            _significant_text_tokens("Æterna Œuvre Straße"),
            {"aeterna", "oeuvre", "strasse"},
        )

    def test_title_validation_rejects_a_lone_generic_pack_overlap(self):
        listing = DiscoveryItemCandidateRecord(
            store_id=10,
            source_url="https://www.amigocalavera.mx/productos/arcs-en-espanol-combo/",
            title="(PREVENTA) ARCS en Español COMBO (Base+expansión Líderes+Pack Minaturas)",
        )
        detail = DiscoveryItemCandidateRecord(
            store_id=10,
            source_url=listing.source_url,
            title="SKS8810 Sleeve Kings Card Game (63.5x88mm) - 110 Pack - Standard 60micrones",
        )

        self.assertTrue(_should_retry_detail_with_browser(detail, listing))

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
            request_headers_provider=None,
            trace_logger=ANY,
            cancellation_token=None,
        )
        fetch_html.assert_called_once_with(
            "https://example.mx/products/catan",
            headers=None,
            include_http_error_status=True,
        )
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].title, "Catan")
        self.assertTrue(records[0].is_boardgame)
        self.assertFalse(records[0].is_boardgame_confirmed)
        self.assertEqual(repository.item_records[0].source_listing_url, "https://example.mx/sitemap.xml")

    def test_collect_store_inventory_matches_ligature_detail_title_to_sitemap_slug(self):
        detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Æterna",
          "description": "Juego de mesa de estrategia para dos jugadores.",
          "image": "https://cdn.example.mx/aeterna.webp",
          "offers": {"price": "1250.00", "priceCurrency": "MXN"}
        }
        </script>
        """
        product_url = "https://www.amigocalavera.mx/productos/aeterna/"
        repository = FakeRepository()

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=product_url, text=detail_html),
        ):
            records = crawl_store_product_details("https://www.amigocalavera.mx/", 12, repository)

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].title, "Æterna")
        self.assertEqual(records[0].price, "1250.00")
        self.assertEqual(records[0].image_url, "https://cdn.example.mx/aeterna.webp")
        self.assertTrue(records[0].raw_payload)
        self.assertEqual(repository.item_records[0].title, "Æterna")

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

    def test_collect_store_inventory_rejects_shopify_without_sitemap_product_urls(self):
        repository = FakeRepository()

        with patch("ludora.product_crawler.discover_product_urls_from_sitemaps", return_value=[]), patch(
            "ludora.product_crawler.fetch_html"
        ) as fetch_html:
            with self.assertRaisesRegex(
                RuntimeError,
                "Shopify sitemap discovery returned no product URLs: https://example.mx/",
            ):
                collect_store_inventory(
                    "https://example.mx/",
                    12,
                    repository,
                    platform="shopify",
                    request_headers_provider=Mock(),
                )

        fetch_html.assert_not_called()

    def test_collect_store_inventory_rejects_shopify_without_signer_before_enumeration(self):
        repository = FakeRepository()

        with patch("ludora.inventory.crawl_store_product_details") as crawl_store_product_details:
            with self.assertRaisesRegex(
                RuntimeError,
                "Shopify discovery requires a Web Bot Auth signing provider",
            ):
                collect_store_inventory(
                    "https://example.mx/",
                    12,
                    repository,
                    platform="shopify",
                    request_headers_provider=None,
                )

        crawl_store_product_details.assert_not_called()

    def test_shopify_product_crawler_rejects_missing_signer_before_sitemap_enumeration(self):
        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
        ) as discover_product_urls_from_sitemaps:
            with self.assertRaisesRegex(
                RuntimeError,
                "Shopify discovery requires a Web Bot Auth signing provider",
            ):
                crawl_store_product_details(
                    "https://example.mx/",
                    12,
                    FakeRepository(),
                    platform="shopify",
                    request_headers_provider=None,
                )

        discover_product_urls_from_sitemaps.assert_not_called()

    def test_shopify_sitemap_discovery_never_uses_unsigned_browser_fallback(self):
        store_url = "https://example.mx/"
        product_url = "https://example.mx/products/catan"
        repository = FakeRepository()
        browser_fetcher = Mock(
            return_value=FetchResult(
                url=f"{store_url}sitemap.xml",
                text=f"<urlset><url><loc>{product_url}</loc></url></urlset>",
            )
        )

        with patch("ludora.sitemap_discovery.fetch_sitemap_text", return_value=None), patch(
            "ludora.product_crawler.fetch_shopify_storefront_product",
            return_value=FetchResult(url="https://example.mx/graphql.json", text="{}"),
        ) as fetch_product:
            with self.assertRaisesRegex(
                RuntimeError,
                "Shopify sitemap discovery returned no product URLs: https://example.mx/",
            ):
                crawl_store_product_details(
                    store_url,
                    12,
                    repository,
                    platform="shopify",
                    browser_sitemap_fetch_enabled=True,
                    browser_fetcher=browser_fetcher,
                    request_headers_provider=Mock(),
                )

        browser_fetcher.assert_not_called()
        fetch_product.assert_not_called()

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

    def test_collect_store_inventory_forwards_product_callback_to_every_detail_crawler(self):
        repository = FakeRepository()
        callback = Mock()
        routes = [
            ("https://example.mx/", "custom", "crawl_store_product_details"),
            ("https://www.amazon.com.mx/stores/page/example", "amazon", "crawl_amazon_store_inventory"),
            ("https://www.amazon.com.mx/s?brand=example", "amazon_brand", "crawl_amazon_brand_inventory"),
            ("https://amukiri.mx/", "custom", "crawl_amukiri_inventory"),
            ("https://www.catitogames.com/", "custom", "crawl_catito_inventory"),
            ("https://demonjuegosdemesa.com/", "custom", "crawl_demon_inventory"),
            ("https://www.diadejuegos.mx/", "prestashop", "crawl_dia_d_inventory"),
        ]
        with patch("ludora.inventory.crawl_store_product_details", return_value=[]) as generic, patch(
            "ludora.inventory.crawl_amazon_store_inventory", return_value=[]
        ) as amazon, patch("ludora.inventory.crawl_amazon_brand_inventory", return_value=[]) as amazon_brand, patch(
            "ludora.inventory.crawl_amukiri_inventory", return_value=[]
        ) as amukiri, patch("ludora.inventory.crawl_catito_inventory", return_value=[]) as catito, patch(
            "ludora.inventory.crawl_demon_inventory", return_value=[]
        ) as demon, patch("ludora.inventory.crawl_dia_d_inventory", return_value=[]) as dia_d:
            crawlers = {
                "crawl_store_product_details": generic,
                "crawl_amazon_store_inventory": amazon,
                "crawl_amazon_brand_inventory": amazon_brand,
                "crawl_amukiri_inventory": amukiri,
                "crawl_catito_inventory": catito,
                "crawl_demon_inventory": demon,
                "crawl_dia_d_inventory": dia_d,
            }
            for store_url, platform, crawler_name in routes:
                collect_store_inventory(
                    store_url, 12, repository, platform=platform, before_product_request=callback
                )
                self.assertIs(crawlers[crawler_name].call_args.kwargs["before_product_request"], callback)

    def test_crawl_store_product_details_calls_product_callback_immediately_before_detail_fetch(self):
        product_url = "https://example.mx/products/catan"
        repository = FakeRepository()
        calls = []

        def callback(url):
            calls.append(("callback", url))

        def fetcher(url, **_kwargs):
            calls.append(("fetch", url))
            return FetchResult(url=url, text='<script type="application/ld+json">{"@type":"Product","name":"Catan"}</script>')

        with patch("ludora.product_crawler.discover_product_urls_from_sitemaps", return_value=[product_url]), patch(
            "ludora.product_crawler.fetch_html", side_effect=fetcher
        ):
            crawl_store_product_details("https://example.mx/", 12, repository, before_product_request=callback)

        self.assertEqual(calls, [("callback", product_url), ("fetch", product_url)])

    def test_crawl_store_product_details_calls_product_callback_for_each_transient_retry(self):
        product_url = "https://example.mx/products/catan"
        repository = FakeRepository()
        callback = Mock()
        detail_html = '<script type="application/ld+json">{"@type":"Product","name":"Catan"}</script>'
        with patch("ludora.product_crawler.discover_product_urls_from_sitemaps", return_value=[product_url]), patch(
            "ludora.product_crawler.fetch_html",
            side_effect=[FetchResult(url=product_url, text="", status_code=503), FetchResult(url=product_url, text=detail_html)],
        ), patch("ludora.webfetch._wait_for_fetch_retry"):
            crawl_store_product_details("https://example.mx/", 12, repository, before_product_request=callback)

        self.assertEqual(callback.call_args_list, [((product_url,), {}), ((product_url,), {})])

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

    def test_collect_store_inventory_routes_catito_domain_to_custom_crawler(self):
        repository = FakeRepository()
        expected_records = [
            DiscoveryItemCandidateRecord(
                store_id=16,
                source_url="https://www.catitogames.com/product/catan",
                title="Catan",
            )
        ]

        with patch("ludora.inventory.crawl_catito_inventory", return_value=expected_records) as catito_crawler, patch(
            "ludora.inventory.crawl_store_product_details"
        ) as generic_crawler:
            records = collect_store_inventory(
                "https://www.catitogames.com/",
                16,
                repository,
                platform="custom",
            )

        self.assertEqual(records, expected_records)
        generic_crawler.assert_not_called()
        catito_crawler.assert_called_once()
        self.assertEqual(
            catito_crawler.call_args.args[:3],
            ("https://www.catitogames.com/", 16, repository),
        )

    def test_collect_store_inventory_routes_amukiri_domain_to_custom_crawler(self):
        repository = FakeRepository()
        expected_records = [
            DiscoveryItemCandidateRecord(
                store_id=12,
                source_url="https://amukiri.mx/detalles/product/el-frutal",
                title="El Frutal",
            )
        ]

        with patch("ludora.inventory.crawl_amukiri_inventory", return_value=expected_records) as amukiri_crawler, patch(
            "ludora.inventory.crawl_store_product_details"
        ) as generic_crawler:
            records = collect_store_inventory(
                "https://amukiri.mx/",
                12,
                repository,
                platform="custom",
            )

        self.assertEqual(records, expected_records)
        generic_crawler.assert_not_called()
        amukiri_crawler.assert_called_once()
        self.assertEqual(
            amukiri_crawler.call_args.args[:3],
            ("https://amukiri.mx/", 12, repository),
        )

    def test_collect_store_inventory_routes_demon_domain_to_custom_crawler(self):
        repository = FakeRepository()
        expected_records = [
            DiscoveryItemCandidateRecord(
                store_id=20,
                source_url="https://demonjuegosdemesa.com/Alpha/",
                title="Alpha",
            )
        ]

        with patch("ludora.inventory.crawl_demon_inventory", return_value=expected_records) as crawler, patch(
            "ludora.inventory.crawl_store_product_details"
        ) as generic_crawler:
            records = collect_store_inventory(
                "https://demonjuegosdemesa.com/",
                20,
                repository,
                platform="custom",
            )

        self.assertEqual(records, expected_records)
        generic_crawler.assert_not_called()
        self.assertEqual(crawler.call_args.args[:3], ("https://demonjuegosdemesa.com/", 20, repository))

    def test_collect_store_inventory_routes_dia_d_domain_to_custom_crawler(self):
        repository = FakeRepository()
        expected_records = [
            DiscoveryItemCandidateRecord(
                store_id=21,
                source_url="https://www.diadejuegos.mx/familiares/141-mal-trago.html",
                title="MAL TRAGO",
            )
        ]

        with patch("ludora.inventory.crawl_dia_d_inventory", return_value=expected_records) as crawler, patch(
            "ludora.inventory.crawl_store_product_details"
        ) as generic_crawler:
            records = collect_store_inventory(
                "https://www.diadejuegos.mx/",
                21,
                repository,
                platform="prestashop",
            )

        self.assertEqual(records, expected_records)
        generic_crawler.assert_not_called()
        self.assertEqual(crawler.call_args.args[:3], ("https://www.diadejuegos.mx/", 21, repository))

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
            request_headers_provider=None,
            trace_logger=ANY,
            cancellation_token=None,
        )
        self.assertEqual(browser_fetched_urls, ["https://example.mx/producto/exploding-kittens/"])
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].title, "Exploding Kittens")
        self.assertEqual(records[0].price, "499.00")

    def test_real_browser_detail_retry_paces_each_navigation_but_not_sitemap(self):
        store_url = "https://example.mx/"
        sitemap_url = f"{store_url}sitemap.xml"
        product_url = "https://example.mx/products/catan"
        challenge_html = (
            "<html><head><title>One moment</title></head>"
            "<body><script>window.location.reload()</script></body></html>"
        )
        detail_html = (
            '<script type="application/ld+json">'
            '{"@type":"Product","name":"Catan"}'
            "</script>"
        )
        sitemap_text = f"<urlset><url><loc>{product_url}</loc></url></urlset>"
        sitemap_page = RetryBrowserPage(
            RetryBrowserResponse(sitemap_url, sitemap_text, content_type="application/xml"),
            [sitemap_text],
        )
        detail_page = RetryBrowserPage(
            RetryBrowserResponse(product_url, detail_html),
            [challenge_html, challenge_html, detail_html],
        )
        browser_fetcher = BrowserTextFetcher()
        browser_fetcher._context = RetryBrowserContext([sitemap_page, detail_page])
        callback = Mock()

        def discover_from_sitemap(_store_url, *, browser_fetcher, **_kwargs):
            fetched_sitemap = browser_fetcher(sitemap_url)
            self.assertEqual(fetched_sitemap.text, sitemap_text)
            return [product_url]

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            side_effect=discover_from_sitemap,
        ), patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=product_url, text=challenge_html),
        ), patch(
            "ludora.browser_fetch.wait_for_discovery_delay",
        ):
            records = crawl_store_product_details(
                store_url,
                12,
                FakeRepository(),
                browser_sitemap_fetch_enabled=True,
                browser_fetcher=browser_fetcher.fetch,
                before_product_request=callback,
            )

        self.assertEqual(len(records), 1)
        self.assertEqual(sitemap_page.goto_count, 1)
        self.assertEqual(detail_page.goto_count, 3)
        self.assertEqual(callback.call_args_list, [call(product_url)] * 4)

    def test_real_browser_detail_retry_stops_before_next_navigation_when_cancelled(self):
        product_url = "https://example.mx/products/catan"
        challenge_html = (
            "<html><head><title>One moment</title></head>"
            "<body><script>window.location.reload()</script></body></html>"
        )
        detail_html = (
            '<script type="application/ld+json">'
            '{"@type":"Product","name":"Catan"}'
            "</script>"
        )
        cancellation_token = CancellationToken()
        detail_page = RetryBrowserPage(
            RetryBrowserResponse(product_url, detail_html),
            [challenge_html, challenge_html, detail_html],
            on_first_content=cancellation_token.cancel,
        )
        browser_fetcher = BrowserTextFetcher()
        browser_fetcher._context = RetryBrowserContext([detail_page])

        with patch(
            "ludora.product_crawler.discover_product_urls_from_sitemaps",
            return_value=[product_url],
        ), patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=product_url, text=challenge_html),
        ):
            with self.assertRaises(OperationCancelled):
                crawl_store_product_details(
                    "https://example.mx/",
                    12,
                    FakeRepository(),
                    browser_fetch_enabled=True,
                    browser_fetcher=browser_fetcher.fetch,
                    cancellation_token=cancellation_token,
                )

        self.assertEqual(detail_page.goto_count, 1)

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

    def test_crawl_store_product_details_skips_removed_candidate_and_continues(self):
        removed_url = "https://example.mx/products/removed"
        valid_url = "https://example.mx/products/catan"
        detail_html = """
        <script type="application/ld+json">
        {"@type": "Product", "name": "Catan"}
        </script>
        """

        for status_code in (404, 410):
            with self.subTest(status_code=status_code):
                repository = FakeRepository()
                trace = FakeTraceLogger()

                def fetch_detail(url, **_kwargs):
                    if url == removed_url:
                        return FetchResult(url=url, text="", status_code=status_code)
                    return FetchResult(url=url, text=detail_html)

                with patch(
                    "ludora.product_crawler.discover_product_urls_from_sitemaps",
                    return_value=[removed_url, valid_url],
                ), patch(
                    "ludora.product_crawler.fetch_html",
                    side_effect=fetch_detail,
                ) as fetch_html:
                    records = crawl_store_product_details(
                        "https://example.mx/",
                        12,
                        repository,
                        trace_logger=trace,
                    )

                self.assertEqual(fetch_html.call_count, 2)
                self.assertEqual([record.title for record in records], ["Catan"])
                self.assertEqual([record.title for record in repository.item_records], ["Catan"])
                skipped_events = [
                    fields
                    for event, fields in trace.events
                    if event == "inventory.candidate.detail_fetch.skipped_removed"
                ]
                self.assertEqual(len(skipped_events), 1)
                self.assertEqual(skipped_events[0]["source_url"], removed_url)
                self.assertEqual(skipped_events[0]["status_code"], status_code)
                self.assertEqual(skipped_events[0]["reason"], f"http_{status_code}")

    def test_crawl_store_product_details_skips_sitemap_candidate_when_parsed_detail_is_rejected(self):
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
        trace = FakeTraceLogger()

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
                trace_logger=trace,
            )

        self.assertEqual(records, [])
        self.assertEqual(repository.item_records, [])
        rejected_events = [
            fields for event, fields in trace.events if event == "inventory.candidate.detail_fetch.rejected"
        ]
        self.assertEqual(len(rejected_events), 1)
        self.assertEqual(rejected_events[0]["listing_title"], "the resistance avalon")
        self.assertEqual(rejected_events[0]["source_url"], product_url)

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
          "image": "https://cdn.example.mx/catan-current.webp",
          "offers": {"price": "799.00", "priceCurrency": "MXN"}
        }
        </script>
        """
        existing_record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/catan",
            source_listing_url="https://example.mx/sitemap.xml",
            title="Catan",
            image_url="https://cdn.example.mx/catan-old.webp",
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
            headers=None,
            include_http_error_status=True,
        )
        self.assertEqual(repository.confirmed_items_limit, 25)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].title, "Catan Nueva Edicion")
        self.assertEqual(records[0].original_title, "Catan Nueva Edicion")
        self.assertEqual(records[0].price, "799.00")
        self.assertEqual(records[0].image_url, "https://cdn.example.mx/catan-current.webp")
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

    def test_refresh_demon_item_uses_browser_headers_and_product_microdata(self):
        existing = DiscoveryItemCandidateRecord(
            store_id=20,
            source_url="https://demonjuegosdemesa.com/Dog-Park/",
            source_listing_url="https://demonjuegosdemesa.com/?scpp=100&spage=1",
            title="Dog Park",
            image_url="https://cdn.example.mx/dog-park-existing.webp",
            store_sku="6379021812874",
            is_boardgame=True,
            is_boardgame_confirmed=True,
            listing_status="LISTED",
        )
        page_html = """
        <html><body>
          <h2>WhatsApp al 5568041896</h2>
          <div itemtype="https://schema.org/Product" itemscope>
            <meta itemprop="name" content="Dog Park" />
            <meta itemprop="sku" content="6379021812874" />
            <div itemprop="offers" itemtype="https://schema.org/Offer" itemscope>
              <meta itemprop="priceCurrency" content="MXN" />
              <meta itemprop="price" content="980" />
              <link itemprop="availability" href="https://schema.org/InStock" />
            </div>
          </div>
        </body></html>
        """

        def fetcher(url, **kwargs):
            self.assertIn("Mozilla/5.0", kwargs["headers"]["User-Agent"])
            return FetchResult(url=url, text=page_html)

        with patch("ludora.product_crawler.fetch_html", side_effect=fetcher):
            refreshed = refresh_confirmed_store_item_candidate(existing, platform="custom")

        self.assertEqual(refreshed.title, "Dog Park")
        self.assertEqual(refreshed.store_sku, "6379021812874")
        self.assertEqual(refreshed.price, "980.00")
        self.assertEqual(refreshed.availability, "available")
        self.assertEqual(refreshed.image_url, "https://cdn.example.mx/dog-park-existing.webp")

    def test_update_confirmed_store_item_details_rejects_conflicting_store_sku(self):
        detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Catan",
          "sku": "WRONG-SKU",
          "offers": {"price": "799.00", "priceCurrency": "MXN"}
        }
        </script>
        """
        existing_record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/catan",
            source_listing_url="https://example.mx/sitemap.xml",
            title="Catan",
            store_sku="CATAN-ES",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(confirmed_items=[existing_record])

        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=existing_record.source_url, text=detail_html),
        ):
            with self.assertRaisesRegex(ProductDetailRejectedError, "store_sku_mismatch"):
                update_confirmed_store_item_details(repository)

        self.assertEqual(repository.price_availability_update_calls, [])
        self.assertEqual(repository.update_change_log_calls, [])
        self.assertEqual(repository.item_records, [])

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
            original_title="Catan - Juego de Mesa",
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
        self.assertEqual(records[0].original_title, "Catan - Juego de Mesa")
        self.assertEqual(records[0].title, "Catan")
        self.assertEqual(len(repository.update_change_log_calls), 1)
        self.assertTrue(repository.update_change_log_calls[0][4])

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
            original_title="Asmodee Survive The Island Monster Pack",
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
        self.assertTrue(repository.update_change_log_calls[0][4])

    def test_update_confirmed_amazon_item_retries_generic_shell_with_browser(self):
        source_url = "https://www.amazon.com.mx/dp/B0GZ4XV2KH"
        generic_shell_html = """
        <html><head><title>Amazon.com.mx</title></head><body>
          B0GZ4XV2KH
          Haz clic en el boton de abajo para continuar comprando
        </body></html>
        """
        rendered_product_html = """
        <html><body>
          <span id="productTitle">Copa Casas Harry Potter + Alohomora</span>
          <span class="a-offscreen">$380.39</span>
          <div id="availability">Disponible</div>
          <input id="add-to-cart-button" type="submit" value="Agregar al carrito">
          <div>ASIN: B0GZ4XV2KH</div>
        </body></html>
        """
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=15644,
            store_id=12,
            source_url=source_url,
            title="Copa Casas Harry Potter + Alohomora",
            original_title="Copa Casas Harry Potter + Alohomora",
            raw_price="$380.39",
            price="380.39",
            price_source="amazon_detail",
            availability="available",
            availability_source="amazon_detail",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(confirmed_items=[existing_record], store_platforms={12: "amazon"})
        browser_fetches = []

        def browser_fetch(url):
            browser_fetches.append(url)
            return FetchResult(url=url, text=rendered_product_html)

        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=source_url, text=generic_shell_html),
        ):
            records = update_confirmed_store_item_details(
                repository,
                browser_fetch_enabled=True,
                browser_fetcher=browser_fetch,
                job_id=101,
                run_id="run-amazon-shell",
            )

        self.assertEqual(browser_fetches, [source_url])
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].availability, "available")
        self.assertEqual(records[0].price, "380.39")
        self.assertEqual(records[0].price_source, "amazon_detail")
        self.assertEqual(len(repository.update_change_log_calls), 1)
        self.assertTrue(repository.update_change_log_calls[0][4])

    def test_continuous_amazon_refresh_prefers_two_browser_attempts_after_one_static_failure(self):
        source_url = "https://www.amazon.com.mx/dp/B0D36CJG5N"
        generic_shell_html = """
        <html><head><title>Amazon.com.mx</title></head><body></body></html>
        """
        product_html = """
        <html><head><title>Mi Villano Favorito 4</title></head><body>
          <span id="productTitle">Mi Villano Favorito 4</span>
          <span class="a-offscreen">$399.00</span>
          <div id="availability">Disponible</div>
          <input id="add-to-cart-button" type="submit" value="Agregar al carrito">
          <div>ASIN: B0D36CJG5N</div>
        </body></html>
        """
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=15694,
            store_id=12,
            source_url=source_url,
            title="Mi Villano Favorito 4",
            original_title="Mi Villano Favorito 4",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )

        class BrowserFetcher:
            def __init__(self):
                self.fetches = []
                self.reset_count = 0

            def fetch(self, url):
                self.fetches.append(url)
                html = generic_shell_html if len(self.fetches) == 1 else product_html
                return FetchResult(url=url, text=html)

            def reset_context(self):
                self.reset_count += 1

        browser = BrowserFetcher()
        trace = FakeTraceLogger()
        requests = []
        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=source_url, text="", status_code=500),
        ) as fetch_html:
            refreshed = refresh_confirmed_store_item_candidate(
                existing_record,
                platform="amazon",
                browser_fetcher=browser.fetch,
                before_request=requests.append,
                trace_logger=trace,
            )

        fetch_html.assert_called_once()
        self.assertEqual(browser.fetches, [source_url, source_url])
        self.assertEqual(browser.reset_count, 1)
        self.assertEqual(requests, [source_url, source_url, source_url])
        self.assertEqual(refreshed.price, "399.00")
        invalid = next(fields for event, fields in trace.events if event == "item_update.item.browser_fetch.invalid")
        self.assertEqual(invalid["reason"], "missing_product_title")
        self.assertTrue(invalid["will_retry"])
        self.assertIn("item_update.item.browser_fetch.context_reset.completed", [event for event, _ in trace.events])

    def test_continuous_amazon_refresh_error_includes_browser_page_diagnostics(self):
        source_url = "https://www.amazon.com.mx/dp/B0D36CJG5N"
        generic_shell_html = """
        <html><head><title>Amazon.com.mx</title></head><body></body></html>
        """
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=15694,
            store_id=12,
            source_url=source_url,
            title="Mi Villano Favorito 4",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )

        class BrowserFetcher:
            def __init__(self):
                self.fetches = []
                self.reset_count = 0

            def fetch(self, url):
                self.fetches.append(url)
                return FetchResult(url=url, text=generic_shell_html)

            def reset_context(self):
                self.reset_count += 1

        browser = BrowserFetcher()
        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=source_url, text="", status_code=500),
        ) as fetch_html:
            with self.assertRaisesRegex(
                TransientProductFetchError,
                r"HTTP 500.*browser fallback missing_product_title.*status=200.*page_title=Amazon.com.mx",
            ):
                refresh_confirmed_store_item_candidate(
                    existing_record,
                    platform="amazon_brand",
                    browser_fetcher=browser.fetch,
                )

        fetch_html.assert_called_once()
        self.assertEqual(browser.fetches, [source_url, source_url])
        self.assertEqual(browser.reset_count, 1)

    def test_update_changed_amazon_original_title_uses_transformer_for_same_asin(self):
        source_url = "https://www.amazon.com.mx/dp/B08LRDKF6V"
        product_html = """
        <html><body>
          <span id="productTitle">Asmodee Giocattolo</span>
          <span class="a-offscreen">$599.00</span>
          <div id="availability">Disponible</div>
          <input id="add-to-cart-button" type="submit" value="Agregar al carrito">
          <div>ASIN: B08LRDKF6V</div>
        </body></html>
        """
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=15032,
            store_id=12,
            source_url=source_url,
            title="Timeline",
            original_title="Timeline",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(confirmed_items=[existing_record], store_platforms={12: "amazon"})
        extracted_titles = []

        def transform_title(record):
            extracted_titles.append(record.title)
            return "Timeline"

        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=source_url, text=product_html),
        ):
            records = update_confirmed_store_item_details(
                repository,
                job_id=102,
                run_id="run-amazon-title-change",
                item_title_extractor=transform_title,
            )

        self.assertEqual(extracted_titles, ["Asmodee Giocattolo"])
        self.assertEqual(records[0].original_title, "Asmodee Giocattolo")
        self.assertEqual(records[0].title, "Timeline")
        self.assertTrue(repository.update_change_log_calls[0][4])

    def test_update_confirmed_amazon_item_defers_invalid_static_and_browser_shells(self):
        source_url = "https://www.amazon.com.mx/dp/B0GZ4XV2KH"
        generic_shell_html = """
        <html><head><title>Amazon.com.mx</title></head><body>
          B0GZ4XV2KH
          Haz clic en el boton de abajo para continuar comprando
        </body></html>
        """
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=15644,
            store_id=12,
            source_url=source_url,
            title="Copa Casas Harry Potter + Alohomora",
            raw_price="$380.39",
            price="380.39",
            price_source="amazon_detail",
            availability="available",
            availability_source="amazon_detail",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(confirmed_items=[existing_record], store_platforms={12: "amazon_brand"})
        browser_fetches = []

        def browser_fetch(url):
            browser_fetches.append(url)
            return FetchResult(url=url, text=generic_shell_html)

        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=source_url, text=generic_shell_html),
        ):
            with self.assertRaisesRegex(
                TransientProductFetchError,
                "Failed to fetch product detail page",
            ):
                update_confirmed_store_item_details(
                    repository,
                    browser_fetch_enabled=True,
                    browser_fetcher=browser_fetch,
                    job_id=102,
                    run_id="run-amazon-invalid-shell",
                )

        self.assertEqual(browser_fetches, [source_url, source_url])
        self.assertEqual(repository.update_change_log_calls, [])
        self.assertEqual(repository.price_availability_update_calls, [])

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
        trace = FakeTraceLogger()
        attempts_by_url = {candidate.source_url: 0 for candidate in candidates}
        fetch_order = []

        def fetch_detail(url, headers=None, include_http_error_status=False):
            self.assertIsNone(headers)
            self.assertTrue(include_http_error_status)
            attempts_by_url[url] += 1
            fetch_order.append(url)
            if url != candidates[2].source_url and attempts_by_url[url] <= 3:
                return FetchResult(url=url, text="", status_code=500, retry_after_seconds=0.0)
            title = next(candidate.title for candidate in candidates if candidate.source_url == url)
            return FetchResult(
                url=url,
                text=f'<script type="application/ld+json">{{"@type":"Product","name":"{title}"}}</script>',
            )

        with patch("ludora.product_crawler.random.shuffle"), patch(
            "ludora.product_crawler.fetch_html",
            side_effect=fetch_detail,
        ) as fetch_html, patch("ludora.webfetch._wait_for_fetch_retry") as wait_for_retry:
            records = update_confirmed_store_item_details(
                repository,
                job_id=99,
                run_id="run-123",
                trace_logger=trace,
            )

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
        self.assertEqual(repository.progress_updates, [(99, 1, 0), (99, 2, 0), (99, 3, 0)])
        event_names = [event for event, _fields in trace.events]
        self.assertIn("item_update.item.fetch.started", event_names)
        self.assertIn("item_update.item.fetch.http_error", event_names)
        self.assertIn("item_update.item.fetch.retry.scheduled", event_names)
        http_errors = [
            fields
            for event, fields in trace.events
            if event == "item_update.item.fetch.http_error"
        ]
        self.assertEqual([fields["status_code"] for fields in http_errors], [500] * 6)
        self.assertEqual(event_names.count("item_update.item.deferred"), 2)
        retry_pool_started = next(
            fields
            for event, fields in trace.events
            if event == "item_update.pool.started" and fields["pool"] == "retry"
        )
        self.assertEqual(retry_pool_started["item_count"], 2)
        completed = [fields for event, fields in trace.events if event == "item_update.item.completed"]
        self.assertEqual([fields["store_item_id"] for fields in completed], [58, 56, 57])

    def test_update_confirmed_items_throttle_every_store_and_defer_429_without_browser_retry(self):
        rate_limited_item = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://shop.example/products/catan",
            title="Catan",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        other_store_item = DiscoveryItemCandidateRecord(
            store_item_id=57,
            store_id=34,
            source_url="https://other.example/products/azul",
            title="Azul",
            item_id=78,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        cooled_store_item = DiscoveryItemCandidateRecord(
            store_item_id=58,
            store_id=12,
            source_url="https://shop.example/products/splendor",
            title="Splendor",
            item_id=79,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        candidates = [rate_limited_item, other_store_item, cooled_store_item]
        repository = FakeRepository(
            confirmed_items=candidates,
            store_platforms={12: "woocommerce", 34: "custom"},
        )
        trace = FakeTraceLogger()
        fetch_order = []
        browser_fetches = []
        attempts_by_url = {candidate.source_url: 0 for candidate in candidates}
        clock_value = [0.0]
        waits = []

        def clock():
            return clock_value[0]

        def wait(delay_seconds, _cancellation_token):
            waits.append(delay_seconds)
            clock_value[0] += delay_seconds

        throttle = PerHostRequestThrottle(
            minimum_interval_seconds=2.0,
            jitter_seconds=0.0,
            fallback_cooldown_seconds=30.0,
            clock=clock,
            waiter=wait,
        )

        def fetch_detail(url, headers=None, include_http_error_status=False):
            self.assertIsNone(headers)
            self.assertTrue(include_http_error_status)
            fetch_order.append(url)
            attempts_by_url[url] += 1
            if url == rate_limited_item.source_url and attempts_by_url[url] == 1:
                return FetchResult(url=url, text="", status_code=429, retry_after_seconds=120.0)
            title = next(candidate.title for candidate in candidates if candidate.source_url == url)
            return FetchResult(
                url=url,
                text=f'<script type="application/ld+json">{{"@type":"Product","name":"{title}"}}</script>',
            )

        def browser_fetch(url):
            browser_fetches.append(url)
            return FetchResult(url=url, text="")

        with patch("ludora.product_crawler.random.shuffle"), patch(
            "ludora.product_crawler.fetch_html",
            side_effect=fetch_detail,
        ) as fetch_html:
            records = update_confirmed_store_item_details(
                repository,
                browser_fetch_enabled=True,
                browser_fetcher=browser_fetch,
                job_id=99,
                run_id="run-store-throttle",
                request_throttle=throttle,
                trace_logger=trace,
            )

        self.assertEqual(fetch_html.call_count, 4)
        self.assertEqual(
            fetch_order,
            [
                rate_limited_item.source_url,
                other_store_item.source_url,
                cooled_store_item.source_url,
                rate_limited_item.source_url,
            ],
        )
        self.assertEqual(browser_fetches, [])
        self.assertEqual(waits, [120.0, 2.0])
        self.assertEqual([record.store_item_id for record in records], [57, 58, 56])
        event_names = [event for event, _fields in trace.events]
        self.assertIn("item_update.store.cooldown.started", event_names)
        self.assertIn("item_update.item.cooldown.deferred", event_names)
        self.assertEqual(event_names.count("item_update.store.throttle.wait"), 2)
        self.assertNotIn("item_update.item.fetch.retry.scheduled", event_names)
        cooldown_pool = next(
            fields
            for event, fields in trace.events
            if event == "item_update.pool.started" and fields["pool"] == "cooldown"
        )
        retry_pool = next(
            fields
            for event, fields in trace.events
            if event == "item_update.pool.started" and fields["pool"] == "retry"
        )
        self.assertEqual(cooldown_pool["item_count"], 1)
        self.assertEqual(retry_pool["item_count"], 1)

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

        def fetch_detail(url, headers=None, include_http_error_status=False):
            self.assertIsNone(headers)
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
        self.assertEqual(repository.progress_updates, [(99, 1, 0)])

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
        self.assertEqual(logged_refreshed.original_title, "Catan Nueva Edicion")
        self.assertEqual(logged_refreshed.store_item_id, 56)
        self.assertEqual(logged_refreshed.item_id, 77)
        self.assertEqual(logged_refreshed.listing_status, "LISTED")
        self.assertEqual(logged_job_id, 99)
        self.assertEqual(logged_run_id, "run-123")
        self.assertTrue(include_title)

    def test_update_confirmed_store_item_accepts_title_mismatch_as_logged_title_change(self):
        detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Completely Renamed Game",
          "offers": {"price": "890.00", "priceCurrency": "MXN"}
        }
        </script>
        """
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://example.mx/productos/the-resistance-avalon",
            source_listing_url="https://example.mx/sitemap.xml",
            title="The Resistance Avalon",
            original_title="The Resistance Avalon",
            item_id=77,
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        repository = FakeRepository(confirmed_items=[existing_record])
        trace = FakeTraceLogger()

        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=existing_record.source_url, text=detail_html),
        ):
            records = update_confirmed_store_item_details(
                repository,
                job_id=99,
                run_id="run-title-mismatch",
                trace_logger=trace,
            )

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].title, "Completely Renamed Game")
        self.assertEqual(records[0].original_title, "Completely Renamed Game")
        self.assertEqual(len(repository.update_change_log_calls), 1)
        logged_existing, logged_refreshed, logged_job_id, logged_run_id, include_title = (
            repository.update_change_log_calls[0]
        )
        self.assertIs(logged_existing, existing_record)
        self.assertEqual(logged_refreshed.title, "Completely Renamed Game")
        self.assertEqual(logged_refreshed.original_title, "Completely Renamed Game")
        self.assertEqual(logged_job_id, 99)
        self.assertEqual(logged_run_id, "run-title-mismatch")
        self.assertTrue(include_title)
        accepted = [
            fields
            for event, fields in trace.events
            if event == "item_update.item.detail.title_mismatch_accepted"
        ]
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0]["listing_title"], "The Resistance Avalon")
        self.assertEqual(accepted[0]["detail_title"], "Completely Renamed Game")
        self.assertNotIn(
            "item_update.item.detail.rejected",
            [event for event, _fields in trace.events],
        )

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
        self.assertEqual(repository.progress_updates, [(99, 1, 1), (99, 2, 1)])


if __name__ == "__main__":
    unittest.main()
