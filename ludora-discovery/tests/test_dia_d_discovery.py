import json
import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.dia_d_discovery import (
    _merge_dia_d_catalog_details,
    dia_d_catalog_request_fields,
    discover_dia_d_listing_candidates,
    is_dia_d_store_url,
)
from ludora.models import DiscoveryItemCandidateRecord
from ludora.webfetch import FetchResult


class FakeTraceLogger:
    def __init__(self):
        self.events = []

    def log(self, event, **fields):
        self.events.append((event, fields))


class DiaDDiscoveryTests(unittest.TestCase):
    def test_walks_sitemap_categories_and_deduplicates_complete_api_pages(self):
        sitemap_html = """
        <html><body>
          <a href="/catalogo/infantiles-3">Infantiles</a>
          <a href="/catalogo/familiares-4">Familiares</a>
          <a href="/catalogo/infantiles-3">Infantiles duplicate</a>
        </body></html>
        """
        pages = {
            (3, 1): self._payload(3, [self._product(1, stock=3), self._product(2, stock=0)]),
            (3, 2): self._payload(3, [self._product(3, stock=1)]),
            (4, 1): self._payload(2, [self._product(2, stock=0), self._product(4, stock=2)]),
        }
        requests = []
        trace = FakeTraceLogger()

        def catalog_fetcher(url, fields):
            requests.append((url, dict(fields)))
            key = (int(fields["id"]), int(fields["pageNumber"]))
            return FetchResult(url=url, text=pages[key])

        records = discover_dia_d_listing_candidates(
            "https://www.diadejuegos.mx/",
            21,
            sitemap_fetcher=lambda url: FetchResult(url=url, text=sitemap_html),
            catalog_fetcher=catalog_fetcher,
            page_size=2,
            trace_logger=trace,
        )

        self.assertEqual([record.title for record in records], ["Game 1", "Game 2", "Game 3", "Game 4"])
        self.assertEqual(
            [(fields["id"], fields["pageNumber"]) for _url, fields in requests],
            [("3", "1"), ("3", "2"), ("4", "1")],
        )
        self.assertTrue(all(url.endswith("/module/diadjuegoscms/ajax") for url, _fields in requests))
        self.assertEqual(records[0].source_url, "https://www.diadejuegos.mx/familiares/1-game-1.html")
        self.assertEqual(records[0].source_listing_url, "https://www.diadejuegos.mx/catalogo/infantiles-3")
        self.assertEqual(records[0].price, "101.00")
        self.assertEqual(records[0].availability, "available")
        self.assertEqual(records[1].availability, "out_of_stock")
        self.assertEqual(records[0].raw_payload["dia_d_catalog"]["id_product"], "1")
        self.assertIn(
            (
                "dia_d_inventory.catalog_discovery.completed",
                {
                    "candidate_count": 4,
                    "category_count": 2,
                    "limited": False,
                    "store_id": 21,
                },
            ),
            trace.events,
        )

    def test_fails_when_api_page_does_not_match_reported_total(self):
        sitemap_html = '<a href="/catalogo/infantiles-3">Infantiles</a>'

        with self.assertRaisesRegex(
            RuntimeError,
            "expected 2 products but found 1",
        ):
            discover_dia_d_listing_candidates(
                "https://www.diadejuegos.mx/",
                21,
                sitemap_fetcher=lambda url: FetchResult(url=url, text=sitemap_html),
                catalog_fetcher=lambda url, fields: FetchResult(
                    url=url,
                    text=self._payload(2, [self._product(1, stock=1)]),
                ),
                page_size=2,
            )

    def test_fails_on_product_without_a_valid_identity_url(self):
        sitemap_html = '<a href="/catalogo/infantiles-3">Infantiles</a>'
        malformed = self._product(1, stock=1)
        malformed["link"] = "https://example.com/not-dia-d.html"

        with self.assertRaisesRegex(RuntimeError, "off-domain product URL"):
            discover_dia_d_listing_candidates(
                "https://www.diadejuegos.mx/",
                21,
                sitemap_fetcher=lambda url: FetchResult(url=url, text=sitemap_html),
                catalog_fetcher=lambda url, fields: FetchResult(
                    url=url,
                    text=self._payload(1, [malformed]),
                ),
                page_size=2,
            )

    def test_recognizes_domain_and_builds_theme_api_fields(self):
        self.assertTrue(is_dia_d_store_url("https://diadejuegos.mx/familiares/141-mal-trago.html"))
        self.assertEqual(
            dia_d_catalog_request_fields(8, 3, 100),
            {
                "action": "productCategory",
                "ctrl": "category",
                "id": "8",
                "search": "",
                "order": "product.position.desc",
                "filters": "",
                "pageNumber": "3",
                "pageSize": "100",
            },
        )

    def test_catalog_price_and_stock_override_unrelated_detail_page_text(self):
        listing = DiscoveryItemCandidateRecord(
            store_id=21,
            source_url="https://www.diadejuegos.mx/infantiles/12-el-frutal.html",
            title="EL FRUTAL",
            raw_price="$990.00",
            price="990.00",
            price_source="dia_d_catalog_api",
            availability="available",
            availability_source="dia_d_catalog_api",
            raw_payload={"dia_d_catalog": {"reference": "1660"}},
        )
        detail = DiscoveryItemCandidateRecord(
            store_id=21,
            source_url=listing.source_url,
            title=listing.title,
            raw_price="$1.00",
            price="1.00",
            price_source="generic_text",
            availability="out_of_stock",
            availability_source="generic_text",
        )

        merged = _merge_dia_d_catalog_details(detail, listing)

        self.assertEqual(merged.store_sku, "1660")
        self.assertEqual(merged.price, "990.00")
        self.assertEqual(merged.price_source, "dia_d_catalog_api")
        self.assertEqual(merged.availability, "available")
        self.assertEqual(merged.availability_source, "dia_d_catalog_api")

    @staticmethod
    def _payload(total, items):
        return json.dumps({"status": True, "total": total, "items": items})

    @staticmethod
    def _product(product_id, *, stock):
        return {
            "id_product": str(product_id),
            "name": f"Game {product_id}",
            "link": f"https://www.diadejuegos.mx/familiares/{product_id}-game-{product_id}.html",
            "cover": f"https://www.diadejuegos.mx/images/{product_id}.jpg",
            "price_amount": 100 + product_id,
            "stock": str(stock),
            "reference": f"REF-{product_id}",
            "id_category_default": "4",
            "description_short": f"Description {product_id}",
        }


if __name__ == "__main__":
    unittest.main()
