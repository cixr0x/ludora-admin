import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.enrichment import extract_site_metadata, infer_location


class EnrichmentTests(unittest.TestCase):
    def test_extract_site_metadata_finds_social_links_logo_and_store_name(self):
        html = """
        <html>
          <head>
            <title>Ludoteca MX | Juegos de mesa</title>
            <meta property="og:site_name" content="Ludoteca MX">
            <meta property="og:image" content="/assets/logo.png">
          </head>
          <body>
            <a href="https://www.instagram.com/ludotecamx/?utm_source=site">Instagram</a>
            <a href="https://facebook.com/ludotecamx">Facebook</a>
            <p>Estamos en Guadalajara, Jalisco. Envíos a todo México.</p>
          </body>
        </html>
        """

        metadata = extract_site_metadata(html, "https://ludoteca.example.mx")

        self.assertEqual(metadata.store_name, "Ludoteca MX")
        self.assertEqual(metadata.instagram_url, "https://instagram.com/ludotecamx")
        self.assertEqual(metadata.facebook_url, "https://facebook.com/ludotecamx")
        self.assertEqual(metadata.store_logo, "https://ludoteca.example.mx/assets/logo.png")
        self.assertEqual(metadata.city, "Guadalajara")
        self.assertEqual(metadata.state, "Jalisco")
        self.assertEqual(metadata.country, "Mexico")

    def test_extract_site_metadata_uses_icon_when_open_graph_image_is_missing(self):
        html = """
        <html>
          <head>
            <title>Dados y Meeples</title>
            <link rel="icon" href="/favicon.ico">
          </head>
          <body>Comprar juegos de mesa en Monterrey, Nuevo León.</body>
        </html>
        """

        metadata = extract_site_metadata(html, "https://dados.example.mx")

        self.assertEqual(metadata.store_logo, "https://dados.example.mx/favicon.ico")
        self.assertEqual(metadata.city, "Monterrey")
        self.assertEqual(metadata.state, "Nuevo León")

    def test_infer_location_matches_state_without_city(self):
        city, state = infer_location("Tienda online con envios desde Yucatan a todo Mexico.")

        self.assertEqual(city, "")
        self.assertEqual(state, "Yucatán")


if __name__ == "__main__":
    unittest.main()
