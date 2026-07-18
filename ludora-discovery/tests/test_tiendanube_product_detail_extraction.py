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

    def test_selects_url_matching_product_group_variant_before_unrelated_product_script(self):
        html = """
        <html lang="es-MX">
          <head>
            <meta property="og:title" content="ARCS en Español COMBO (Base+expansión Líderes+Pack Minaturas)">
            <script type="application/ld+json">
            {
              "@context": "https://schema.org/",
              "@type": "Product",
              "name": "SKS8810 Sleeve Kings Card Game (63.5x88mm) - 110 Pack - Standard 60micrones",
              "image": "https://cdn.example.mx/sleeve-kings.webp",
              "sku": "SKS8810",
              "offers": {"price": "57", "priceCurrency": "MXN"}
            }
            </script>
            <script type="application/ld+json">
            {
              "@context": "https://schema.org/",
              "@type": "WebPage",
              "name": "Arcs en Español COMBO: Juego de Estrategia Galáctica Completo",
              "mainEntity": {
                "@type": "ProductGroup",
                "name": "ARCS en Español COMBO (Base+expansión Líderes+Pack Minaturas)",
                "url": "https://www.amigocalavera.mx/productos/arcs-en-espanol-combo/",
                "description": "Juego de estrategia galáctica.",
                "hasVariant": [
                  {
                    "@type": "Product",
                    "name": "ARCS en Español COMBO (Anticipo 50%)",
                    "image": "https://cdn.example.mx/arcs.webp",
                    "sku": "2TOM06000",
                    "url": "https://www.amigocalavera.mx/productos/arcs-en-espanol-combo/?variant=1231769097",
                    "offers": {"price": "1775.00", "priceCurrency": "MXN"}
                  },
                  {
                    "@type": "Product",
                    "name": "ARCS en Español COMBO (Pago Completo)",
                    "sku": "2TOM06000",
                    "url": "https://www.amigocalavera.mx/productos/arcs-en-espanol-combo/?variant=1231769112",
                    "offers": {"price": "3550.00", "priceCurrency": "MXN"}
                  }
                ]
              }
            }
            </script>
          </head>
          <body><h1>ARCS en Español COMBO (Base+expansión Líderes+Pack Minaturas)</h1></body>
        </html>
        """

        record = extract_product_detail_candidate(
            html,
            "https://www.amigocalavera.mx/productos/arcs-en-espanol-combo/",
            10,
            "https://www.amigocalavera.mx/sitemap.xml",
        )

        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.title, "ARCS en Español COMBO (Base+expansión Líderes+Pack Minaturas)")
        self.assertEqual(record.image_url, "https://cdn.example.mx/arcs.webp")
        self.assertEqual(record.price, "1775.00")
        self.assertEqual(record.store_sku, "2TOM06000")
        self.assertEqual(record.raw_payload["json_ld"]["name"], record.title)


if __name__ == "__main__":
    unittest.main()
