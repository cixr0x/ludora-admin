import sys
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.database import ItemCandidateUpsertResult
from ludora.inventory import collect_store_inventory
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import crawl_store_product_details, update_confirmed_store_item_details
from ludora.webfetch import FetchResult


class FakeRepository:
    def __init__(self, upsert_result=None, existing_urls=None, confirmed_items=None):
        self.item_records = []
        self.upsert_result = upsert_result
        self.existing_urls = set(existing_urls or [])
        self.exists_checks = []
        self.confirmed_items = list(confirmed_items or [])
        self.confirmed_items_limit = None

    def item_candidate_exists(self, store_id, source_url):
        self.exists_checks.append((store_id, source_url))
        return (store_id, source_url) in self.existing_urls

    def upsert_item_candidate(self, record):
        self.item_records.append(record)
        return self.upsert_result

    def list_confirmed_boardgame_item_candidates(self, limit=None):
        self.confirmed_items_limit = limit
        return self.confirmed_items


class FakeItemProcessor:
    def __init__(self):
        self.processed = []

    def process_candidate(self, candidate_id, record):
        self.processed.append((candidate_id, record))


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
        )
        fetch_html.assert_called_once_with("https://example.mx/products/catan")
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

    def test_update_confirmed_store_item_details_refreshes_only_confirmed_boardgame_rows(self):
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

        fetch_html.assert_called_once_with("https://example.mx/products/catan")
        self.assertEqual(repository.confirmed_items_limit, 25)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].title, "Catan Nueva Edicion")
        self.assertEqual(records[0].price, "799.00")
        self.assertEqual(repository.item_records[0].item_id, 77)
        self.assertEqual(repository.item_records[0].listing_status, "LISTED")
        self.assertTrue(repository.item_records[0].is_boardgame)
        self.assertTrue(repository.item_records[0].is_boardgame_confirmed)
        self.assertEqual(repository.item_records[0].category_confidence, 0.91)
        self.assertEqual(repository.item_records[0].classification_reasons, ["previously confirmed"])


if __name__ == "__main__":
    unittest.main()
