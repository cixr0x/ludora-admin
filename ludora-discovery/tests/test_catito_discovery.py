import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.catito_discovery import (
    catito_catalog_page_url,
    crawl_catito_inventory,
    discover_catito_listing_candidates,
)
from ludora.webfetch import FetchResult


class FakeRepository:
    def __init__(self):
        self.exists_checks = []
        self.item_records = []

    def item_candidate_exists(self, store_id, source_url):
        self.exists_checks.append((store_id, source_url))
        return False

    def upsert_item_candidate(self, record):
        self.item_records.append(record)
        return SimpleNamespace(candidate_id=44, created=True, should_process=False)


class FakeTraceLogger:
    def __init__(self):
        self.events = []

    def log(self, event, **fields):
        self.events.append((event, fields))


class CatitoDiscoveryTests(unittest.TestCase):
    def test_discovers_every_catalog_page_and_maps_listing_details(self):
        pages = {
            0: self._catalog_page(
                0,
                2,
                3,
                [
                    self._product(
                        "alpha-id",
                        "Alpha Game",
                        "alpha-game",
                        price=1250.5,
                        stock=4,
                        longDescription="Long Alpha description",
                        shortDescription="Short Alpha description",
                        brand="Alpha Editorial",
                    ),
                    self._product("beta-id", "Beta Game", "beta-game", price=500, stock=0),
                ],
            ),
            1: self._catalog_page(
                1,
                2,
                3,
                [self._product("gamma-id", "Gamma Game", "gamma-game", price=300, stock=8, availableOnline=False)],
            ),
        }
        fetched_urls = []
        trace = FakeTraceLogger()

        def fetcher(url):
            fetched_urls.append(url)
            page_number = int(parse_qs(urlparse(url).query)["_page"][0])
            return FetchResult(url=url, text=json.dumps(pages[page_number]))

        records = discover_catito_listing_candidates(
            "https://www.catitogames.com/",
            16,
            fetcher=fetcher,
            page_size=2,
            trace_logger=trace,
        )

        self.assertEqual(
            fetched_urls,
            [catito_catalog_page_url(0, page_size=2), catito_catalog_page_url(1, page_size=2)],
        )
        self.assertEqual([record.title for record in records], ["Alpha Game", "Beta Game", "Gamma Game"])
        self.assertEqual(records[0].source_url, "https://www.catitogames.com/product/alpha-game")
        self.assertEqual(records[0].publisher, "Alpha Editorial")
        self.assertEqual(records[0].description, "Long Alpha description")
        self.assertEqual(records[0].price, "1250.5")
        self.assertEqual(records[0].price_source, "catito_catalog_api")
        self.assertEqual(records[0].availability, "available")
        self.assertEqual(records[0].store_sku, "alpha-id")
        self.assertEqual(records[0].raw_payload["catito_catalog"]["shortDescription"], "Short Alpha description")
        self.assertEqual(records[1].availability, "out_of_stock")
        self.assertEqual(records[2].availability, "out_of_stock")
        completed = [fields for event, fields in trace.events if event == "catito_inventory.catalog_discovery.completed"]
        self.assertEqual(completed, [{
            "candidate_count": 3,
            "limited": False,
            "store_id": 16,
            "total_elements": 3,
            "total_pages": 2,
        }])

    def test_fails_when_unique_product_count_does_not_match_catalog_total(self):
        duplicate = self._product("duplicate-id", "Duplicate", "duplicate", price=100, stock=1)
        payload = self._catalog_page(0, 1, 2, [duplicate, duplicate])

        with self.assertRaisesRegex(
            RuntimeError,
            "Catito catalog completeness check failed: expected 2 products but found 1 unique valid slugs",
        ):
            discover_catito_listing_candidates(
                "https://www.catitogames.com/",
                16,
                fetcher=lambda url: FetchResult(url=url, text=json.dumps(payload)),
            )

    def test_crawl_preserves_catalog_details_missing_from_product_page(self):
        product = self._product(
            "catalog-product-id",
            "Catalog Product",
            "catalog-product",
            price=499,
            stock=3,
            longDescription="Complete catalog description",
            brand="Catalog Publisher",
            imageUrl="https://cdn.catito.test/catalog-product.webp",
            categories=["Juego de mesa", "Estrategia"],
        )
        catalog_payload = self._catalog_page(0, 1, 1, [product])
        detail_html = """
        <html lang="es">
          <head>
            <script type="application/ld+json">
              {
                "@type": "Product",
                "name": "Catalog Product",
                "offers": {
                  "price": "499",
                  "priceCurrency": "MXN",
                  "availability": "https://schema.org/InStock"
                }
              }
            </script>
          </head>
          <body><h1>Catalog Product</h1></body>
        </html>
        """
        repository = FakeRepository()

        def classify(record):
            record.is_boardgame = True
            record.category_confidence = 0.99
            return record

        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(
                url="https://www.catitogames.com/product/catalog-product",
                text=detail_html,
            ),
        ):
            records = crawl_catito_inventory(
                "https://www.catitogames.com/",
                16,
                repository,
                item_classifier=classify,
                catalog_fetcher=lambda url: FetchResult(url=url, text=json.dumps(catalog_payload)),
            )

        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record.publisher, "Catalog Publisher")
        self.assertEqual(record.description, "Complete catalog description")
        self.assertEqual(record.image_url, "https://cdn.catito.test/catalog-product.webp")
        self.assertEqual(record.store_sku, "catalog-product-id")
        self.assertEqual(record.price, "499")
        self.assertEqual(record.availability, "available")
        self.assertTrue(record.is_boardgame)
        self.assertEqual(record.raw_payload["catito_catalog"]["categories"], ["Juego de mesa", "Estrategia"])
        self.assertEqual(repository.item_records, records)

    @staticmethod
    def _catalog_page(number, total_pages, total_elements, content):
        return {
            "content": content,
            "number": number,
            "totalPages": total_pages,
            "totalElements": total_elements,
        }

    @staticmethod
    def _product(product_id, name, slug, **overrides):
        product = {
            "id": product_id,
            "name": name,
            "slug": slug,
            "shortDescription": f"{name} short description",
            "longDescription": None,
            "brand": "Publisher",
            "price": 100,
            "stock": 1,
            "availableOnline": True,
            "imageUrl": f"https://cdn.catito.test/{slug}.webp",
            "categories": ["Juego de mesa"],
        }
        product.update(overrides)
        return product


if __name__ == "__main__":
    unittest.main()
