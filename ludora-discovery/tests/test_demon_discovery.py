import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.demon_discovery import (
    demon_catalog_page_url,
    discover_demon_listing_candidates,
    extract_demon_product_detail_candidate,
    is_demon_store_url,
)
from ludora.webfetch import FetchResult


class FakeTraceLogger:
    def __init__(self):
        self.events = []

    def log(self, event, **fields):
        self.events.append((event, fields))


class DemonDiscoveryTests(unittest.TestCase):
    def test_discovers_every_catalog_page_with_root_level_product_links(self):
        pages = {
            1: self._catalog_page(
                1,
                2,
                [
                    ("sku-alpha", "/Alpha-Espa%C3%B1ol/", "Alpha Español", "$1,250", True),
                    ("sku-beta", "/Beta/", "Beta", "$499", False),
                ],
            ),
            2: self._catalog_page(
                2,
                2,
                [("sku-gamma", "/Gamma/", "Gamma", "$300", True)],
            ),
        }
        fetched_urls = []
        trace = FakeTraceLogger()

        def fetcher(url):
            fetched_urls.append(url)
            page_number = int(url.rsplit("spage=", 1)[-1])
            return FetchResult(url=url, text=pages[page_number])

        records = discover_demon_listing_candidates(
            "https://demonjuegosdemesa.com/",
            20,
            fetcher=fetcher,
            page_size=2,
            trace_logger=trace,
        )

        self.assertEqual(
            fetched_urls,
            [
                "https://demonjuegosdemesa.com/?scpp=2&spage=1",
                "https://demonjuegosdemesa.com/?scpp=2&spage=2",
            ],
        )
        self.assertEqual([record.title for record in records], ["Alpha Español", "Beta", "Gamma"])
        self.assertEqual(records[0].source_url, "https://demonjuegosdemesa.com/Alpha-Espa%C3%B1ol/")
        self.assertEqual(records[0].source_listing_url, fetched_urls[0])
        self.assertEqual(records[0].price, "1250.00")
        self.assertEqual(records[0].availability, "available")
        self.assertEqual(records[1].availability, "out_of_stock")
        self.assertEqual(records[0].raw_payload["demon_catalog"]["item_id"], "sku-alpha")
        self.assertIn(
            (
                "demon_inventory.catalog_discovery.completed",
                {
                    "candidate_count": 3,
                    "limited": False,
                    "skipped_invalid_items": 0,
                    "store_id": 20,
                    "total_pages": 2,
                },
            ),
            trace.events,
        )

    def test_skips_and_traces_source_card_without_a_product_title(self):
        page = self._catalog_page(
            1,
            1,
            [
                ("sku-alpha", "/Alpha/", "Alpha", "$100", True),
                ("sku-blank", "/store-item-sku-blank/", "", "$200", True),
            ],
        )
        trace = FakeTraceLogger()

        records = discover_demon_listing_candidates(
            "https://demonjuegosdemesa.com/",
            20,
            fetcher=lambda url: FetchResult(url=url, text=page),
            page_size=2,
            trace_logger=trace,
        )

        self.assertEqual([record.title for record in records], ["Alpha"])
        invalid_events = [fields for event, fields in trace.events if event == "demon_inventory.catalog_product.invalid"]
        self.assertEqual(len(invalid_events), 1)
        self.assertEqual(invalid_events[0]["item_id"], "sku-blank")
        self.assertEqual(invalid_events[0]["reason"], "missing_title")

    def test_fails_when_a_non_final_catalog_page_is_incomplete(self):
        page = self._catalog_page(
            1,
            2,
            [("sku-alpha", "/Alpha/", "Alpha", "$100", True)],
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "page 1 expected 2 products but found 1",
        ):
            discover_demon_listing_candidates(
                "https://demonjuegosdemesa.com/",
                20,
                fetcher=lambda url: FetchResult(url=url, text=page),
                page_size=2,
            )

    def test_product_microdata_overrides_sitewide_heading(self):
        record = extract_demon_product_detail_candidate(
            """
            <html><body>
              <h2>WhatsApp al 5568041896</h2>
              <div itemtype="https://schema.org/Product" itemscope>
                <meta itemprop="name" content="Dog Park: Nuevos trucos (Español)" />
                <meta itemprop="description" content="Una expansi&amp;oacute;n para cinco jugadores." />
                <link itemprop="image" href="/images/dog-park.jpg" />
                <meta itemprop="category" content="2 a 5 jugadores" />
                <meta itemprop="sku" content="6379021812874" />
                <div itemprop="offers" itemtype="https://schema.org/Offer" itemscope>
                  <meta itemprop="priceCurrency" content="MXN" />
                  <meta itemprop="price" content="980" />
                  <link itemprop="availability" href="https://schema.org/InStock" />
                </div>
              </div>
            </body></html>
            """,
            "https://demonjuegosdemesa.com/Dog-Park/",
            20,
            "https://demonjuegosdemesa.com/?scpp=100&spage=1",
        )

        self.assertEqual(record.title, "Dog Park: Nuevos trucos (Español)")
        self.assertEqual(record.original_title, record.title)
        self.assertEqual(record.description, "Una expansión para cinco jugadores.")
        self.assertEqual(record.image_url, "https://demonjuegosdemesa.com/images/dog-park.jpg")
        self.assertEqual(record.store_sku, "6379021812874")
        self.assertEqual(record.price, "980.00")
        self.assertEqual(record.price_source, "demon_product_microdata")
        self.assertEqual(record.availability, "available")
        self.assertEqual(record.availability_source, "demon_product_microdata")

    def test_recognizes_domain_and_builds_catalog_url(self):
        self.assertTrue(is_demon_store_url("https://www.demonjuegosdemesa.com/Alpha/"))
        self.assertEqual(
            demon_catalog_page_url("https://demonjuegosdemesa.com/", 5),
            "https://demonjuegosdemesa.com/?scpp=100&spage=5",
        )

    @staticmethod
    def _catalog_page(page_number, total_pages, products):
        cards = []
        for item_id, href, title, price, available in products:
            button = (
                '<button class="wb-store-item-add-to-cart store-btn">Add to cart</button>'
                if available
                else ""
            )
            cards.append(
                f"""
                <div class="wb-store-item" data-item-id="{item_id}">
                  <div class="wb-store-name"><a href="{href}">{title}</a></div>
                  <div class="wb-store-price">{price}</div>
                  <div class="wb-store-item-buttons">{button}</div>
                </div>
                """
            )
        pagination = "".join(
            f'<a href="/?spage={number}&amp;scpp=2">{number}</a>'
            for number in range(1, total_pages + 1)
        )
        return f"<html><body>{''.join(cards)}<nav>{pagination}</nav><span>{page_number}</span></body></html>"


if __name__ == "__main__":
    unittest.main()
