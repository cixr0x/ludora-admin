import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.amukiri_discovery import (
    amukiri_catalog_page_url,
    crawl_amukiri_inventory,
    discover_amukiri_listing_candidates,
    extract_amukiri_product_detail_candidate,
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
        return SimpleNamespace(candidate_id=91, created=True, should_process=False)


class FakeTraceLogger:
    def __init__(self):
        self.events = []

    def log(self, event, **fields):
        self.events.append((event, fields))


class AmukiriDiscoveryTests(unittest.TestCase):
    def test_discovers_every_catalog_page_and_normalizes_listing_cards(self):
        pages = {
            1: self._catalog_page(
                1,
                2,
                3,
                [
                    ("alpha", "Alpha Game MX$530.00 MX$530.00"),
                    ("beta", "Beta Game No disponible en este momento"),
                ],
            ),
            2: self._catalog_page(
                2,
                2,
                3,
                [("gamma", "Gamma Game MX$1,250.00 MX$1,250.00")],
            ),
        }
        fetched_urls = []
        trace = FakeTraceLogger()

        def fetcher(url):
            fetched_urls.append(url)
            page_number = int(parse_qs(urlparse(url).query).get("ep_no", ["1"])[0])
            return FetchResult(url=url, text=pages[page_number])

        records = discover_amukiri_listing_candidates(
            "https://amukiri.mx/",
            12,
            fetcher=fetcher,
            trace_logger=trace,
        )

        self.assertEqual(
            fetched_urls,
            [
                "https://amukiri.mx/tienda",
                "https://amukiri.mx/tienda?ep_no=2",
            ],
        )
        self.assertEqual([record.title for record in records], ["Alpha Game", "Beta Game", "Gamma Game"])
        self.assertEqual(records[0].source_url, "https://amukiri.mx/detalles/product/alpha")
        self.assertEqual(records[0].source_listing_url, "https://amukiri.mx/tienda")
        self.assertEqual(records[0].price, "530.00")
        self.assertEqual(records[0].price_source, "amukiri_listing")
        self.assertEqual(records[0].availability, "available")
        self.assertEqual(records[1].availability, "out_of_stock")
        self.assertEqual(records[2].price, "1250.00")
        completed = [
            fields
            for event, fields in trace.events
            if event == "amukiri_inventory.catalog_discovery.completed"
        ]
        self.assertEqual(
            completed,
            [
                {
                    "candidate_count": 3,
                    "limited": False,
                    "store_id": 12,
                    "total_pages": 2,
                    "total_products": 3,
                }
            ],
        )

    def test_stops_catalog_pagination_when_limit_is_reached(self):
        fetched_urls = []

        def fetcher(url):
            fetched_urls.append(url)
            return FetchResult(
                url=url,
                text=self._catalog_page(
                    1,
                    2,
                    3,
                    [
                        ("alpha", "Alpha Game MX$100.00"),
                        ("beta", "Beta Game MX$200.00"),
                    ],
                ),
            )

        records = discover_amukiri_listing_candidates(
            "https://amukiri.mx/",
            12,
            limit=2,
            fetcher=fetcher,
        )

        self.assertEqual(len(records), 2)
        self.assertEqual(fetched_urls, ["https://amukiri.mx/tienda"])

    def test_fails_when_unique_product_count_does_not_match_catalog_total(self):
        duplicate_page = self._catalog_page(
            1,
            1,
            2,
            [
                ("duplicate", "Duplicate MX$100.00"),
                ("duplicate", "Duplicate MX$100.00"),
            ],
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "Amukiri catalog completeness check failed: expected 2 products but found 1 unique product URLs",
        ):
            discover_amukiri_listing_candidates(
                "https://amukiri.mx/",
                12,
                fetcher=lambda url: FetchResult(url=url, text=duplicate_page),
            )

    def test_extracts_full_description_and_characteristics_from_nuxt_payload(self):
        record = extract_amukiri_product_detail_candidate(
            self._detail_html(
                slug="el-frutal",
                title="El Frutal",
                rich_description=(
                    "<p>El frutal es un juego cooperativo para niños.</p>"
                    "<p>Los jugadores deben recoger la cosecha antes que el cuervo.</p>"
                    "<table><tbody>"
                    "<tr><th>Características</th><th>Descripción</th></tr>"
                    "<tr><td>Número de Jugadores</td><td>2-8</td></tr>"
                    "<tr><td>Idioma</td><td>Español</td></tr>"
                    "<tr><td>Edad Recomendada</td><td>3+</td></tr>"
                    "<tr><td>Duración</td><td>10 min</td></tr>"
                    "<tr><td>Dificultad</td><td>1/5</td></tr>"
                    "</tbody></table>"
                    "<p><a href='https://boardgamegeek.com/boardgame/5770/orchard'>BGG</a></p>"
                ),
            ),
            "https://amukiri.mx/detalles/product/el-frutal",
            12,
            "https://amukiri.mx/tienda?ep_no=17",
        )

        self.assertIsNotNone(record)
        self.assertEqual(
            record.description,
            (
                "El frutal es un juego cooperativo para niños. "
                "Los jugadores deben recoger la cosecha antes que el cuervo."
            ),
        )
        self.assertEqual((record.min_players, record.max_players), (2, 8))
        self.assertEqual((record.min_minutes, record.max_minutes), (10, 10))
        self.assertEqual(record.min_age, 3)
        self.assertEqual(record.language, "es")
        self.assertEqual(record.language_source, "amukiri_characteristics")
        self.assertEqual(record.language_evidence, "Idioma: Español")
        self.assertEqual(
            record.raw_payload["amukiri_characteristics"],
            {
                "Número de Jugadores": "2-8",
                "Idioma": "Español",
                "Edad Recomendada": "3+",
                "Duración": "10 min",
                "Dificultad": "1/5",
            },
        )

    def test_ignores_out_of_range_characteristic_age(self):
        record = extract_amukiri_product_detail_candidate(
            self._detail_html(
                slug="invalid-age",
                title="Invalid Age",
                rich_description=(
                    "<p>Juego de mesa.</p>"
                    "<table><tr><td>Edad Recomendada</td><td>499+</td></tr></table>"
                ),
            ),
            "https://amukiri.mx/detalles/product/invalid-age",
            12,
            "https://amukiri.mx/tienda",
        )

        self.assertIsNotNone(record)
        self.assertIsNone(record.min_age)

    def test_crawl_uses_amukiri_detail_parser_before_classification(self):
        catalog_html = self._catalog_page(
            1,
            1,
            1,
            [("el-frutal", "El Frutal MX$1,275.00 MX$1,275.00")],
        )
        detail_html = self._detail_html(
            slug="el-frutal",
            title="El Frutal",
            rich_description=(
                "<p>Descripción completa del producto.</p>"
                "<table>"
                "<tr><td>Número de Jugadores</td><td>2-8</td></tr>"
                "<tr><td>Duración</td><td>10 min</td></tr>"
                "</table>"
            ),
        )
        repository = FakeRepository()

        def classify(record):
            self.assertEqual(record.min_players, 2)
            self.assertEqual(record.max_players, 8)
            record.is_boardgame = True
            record.category_confidence = 0.99
            return record

        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(
                url="https://amukiri.mx/detalles/product/el-frutal",
                text=detail_html,
            ),
        ):
            records = crawl_amukiri_inventory(
                "https://amukiri.mx/",
                12,
                repository,
                item_classifier=classify,
                catalog_fetcher=lambda url: FetchResult(url=url, text=catalog_html),
            )

        self.assertEqual(len(records), 1)
        self.assertEqual(repository.item_records, records)
        self.assertEqual(records[0].description, "Descripción completa del producto.")
        self.assertTrue(records[0].is_boardgame)

    def test_catalog_page_url_uses_amukiri_pagination_parameter(self):
        self.assertEqual(amukiri_catalog_page_url("https://amukiri.mx/", 1), "https://amukiri.mx/tienda")
        self.assertEqual(
            amukiri_catalog_page_url("https://amukiri.mx/", 17),
            "https://amukiri.mx/tienda?ep_no=17",
        )

    @staticmethod
    def _catalog_page(page_number, total_pages, total_products, products):
        product_links = "".join(
            f'<a href="https://amukiri.mx/detalles/product/{slug}">{title}</a>'
            for slug, title in products
        )
        return (
            "<html><body>"
            f"<span>{total_products} productos</span>"
            f"{product_links}"
            f"<span>Página {page_number} / {total_pages}</span>"
            "</body></html>"
        )

    @staticmethod
    def _detail_html(*, slug, title, rich_description):
        nuxt_payload = [
            None,
            {"slug": 2, "description": 3},
            slug,
            rich_description,
        ]
        json_ld = {
            "@type": "Product",
            "name": title,
            "description": "Short SEO description.",
            "image": ["https://cdn.amukiri.test/product.webp"],
            "offers": {
                "price": "1275",
                "priceCurrency": "MXN",
                "availability": "https://schema.org/InStock",
            },
        }
        return (
            "<html lang='es'><head>"
            f"<script type='application/ld+json'>{json.dumps(json_ld)}</script>"
            "</head><body>"
            f"<h1>{title}</h1>"
            f"<script type='application/json' id='__NUXT_DATA__'>{json.dumps(nuxt_payload)}</script>"
            "</body></html>"
        )


if __name__ == "__main__":
    unittest.main()
