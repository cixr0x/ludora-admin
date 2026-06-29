import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.brave import parse_brave_results


class BraveTests(unittest.TestCase):
    def test_parse_brave_results_reads_web_results(self):
        payload = {
            "web": {
                "results": [
                    {
                        "title": "Ludoteca MX",
                        "url": "https://ludoteca.example.mx/",
                        "description": "Tienda online de juegos de mesa en Mexico.",
                    }
                ]
            }
        }

        results = parse_brave_results(payload, query="tienda juegos de mesa mexico")

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].title, "Ludoteca MX")
        self.assertEqual(results[0].url, "https://ludoteca.example.mx/")
        self.assertEqual(results[0].description, "Tienda online de juegos de mesa en Mexico.")
        self.assertEqual(results[0].query, "tienda juegos de mesa mexico")

    def test_parse_brave_results_appends_extra_snippets_to_description(self):
        payload = {
            "web": {
                "results": [
                    {
                        "title": "Ludica MX",
                        "url": "https://ludica.example.mx/",
                        "description": "Tienda de hobbies.",
                        "extra_snippets": ["Juegos de mesa modernos.", "Agregar al carrito y pagar en MXN."],
                    }
                ]
            }
        }

        results = parse_brave_results(payload, query="juegos de tablero tienda mexico")

        self.assertIn("Tienda de hobbies.", results[0].description)
        self.assertIn("Juegos de mesa modernos.", results[0].description)
        self.assertIn("Agregar al carrito", results[0].description)


if __name__ == "__main__":
    unittest.main()
