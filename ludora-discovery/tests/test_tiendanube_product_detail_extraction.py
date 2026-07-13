import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.product_detail_extraction import extract_product_detail_candidate


class TiendanubeProductDetailExtractionTests(unittest.TestCase):
    def test_prefers_webpage_main_entity_over_related_product_schema(self):
        html = """
        <html lang="es-MX">
          <head>
            <script type="application/ld+json">
            {
              "@context": "https://schema.org/",
              "@type": "WebPage",
              "name": "Juego de Civilizacion: Beyond The Horizon",
              "mainEntity": {
                "@type": "Product",
                "name": "Beyond The Horizon",
                "image": "https://cdn.example.mx/beyond-the-horizon.webp",
                "sku": "CTGBTH201",
                "offers": {
                  "@type": "Offer",
                  "price": "1450.00",
                  "priceCurrency": "MXN",
                  "availability": "https://schema.org/InStock"
                }
              }
            }
            </script>
            <script type="application/ld+json">
            {
              "@context": "https://schema.org/",
              "@type": "Product",
              "name": "Related Game",
              "image": "https://cdn.example.mx/related-game.webp",
              "sku": "RELATED-1",
              "offers": {
                "@type": "Offer",
                "price": "999.00",
                "priceCurrency": "MXN"
              }
            }
            </script>
          </head>
          <body><h1>Beyond The Horizon</h1></body>
        </html>
        """

        record = extract_product_detail_candidate(
            html,
            "https://www.amigocalavera.mx/productos/beyond-the-horizon/",
            12,
            "https://www.amigocalavera.mx/sitemap.xml",
        )

        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.title, "Beyond The Horizon")
        self.assertEqual(record.image_url, "https://cdn.example.mx/beyond-the-horizon.webp")
        self.assertEqual(record.price, "1450.00")
        self.assertEqual(record.store_sku, "CTGBTH201")
        self.assertEqual(record.raw_payload["json_ld"]["name"], "Beyond The Horizon")


if __name__ == "__main__":
    unittest.main()
