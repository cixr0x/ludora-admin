import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.listing_extraction import extract_listing_candidates


class ListingExtractionTests(unittest.TestCase):
    def test_extracts_product_links_with_prices(self):
        html = """
        <html>
          <body>
            <a href="/products/catan">Catan Edicion en Espanol</a>
            <span>$899.00 MXN</span>
            <a href="/products/dixit">Dixit</a>
            <span>Agotado</span>
          </body>
        </html>
        """

        records = extract_listing_candidates(html, "https://example.mx/", 12)

        self.assertEqual(records[0].title, "Catan Edicion en Espanol")
        self.assertEqual(records[0].store_id, 12)
        self.assertEqual(records[0].source_url, "https://example.mx/products/catan")
        self.assertEqual(records[0].price, "899.00")
        self.assertEqual(records[1].availability, "out_of_stock")

    def test_ignores_non_product_links(self):
        html = '<a href="/contacto">Contacto</a><a href="/blog/catan">Resena Catan</a>'

        records = extract_listing_candidates(html, "https://example.mx/", 12)

        self.assertEqual(records, [])

    def test_does_not_limit_product_links_by_default(self):
        html = "".join(
            f'<a href="/products/item-{index}">Item {index}</a>'
            for index in range(101)
        )

        records = extract_listing_candidates(html, "https://example.mx/", 12)

        self.assertEqual(len(records), 101)


if __name__ == "__main__":
    unittest.main()
