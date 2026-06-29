import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.queries import build_queries


class QueryTests(unittest.TestCase):
    def test_build_queries_includes_mexican_online_boardgame_terms(self):
        queries = build_queries(scope="core")
        normalized = "\n".join(queries).lower()

        self.assertIn("tienda juegos de mesa mexico", normalized)
        self.assertIn("juegos de mesa tienda online mexico", normalized)
        self.assertIn("comprar juegos de mesa mexico", normalized)
        self.assertIn("juegos de tablero tienda mexico", normalized)
        self.assertIn("tienda juegos de rol mexico", normalized)
        self.assertIn("magic the gathering tienda mexico", normalized)
        self.assertIn("site:.mx", normalized)

    def test_build_queries_expanded_adds_city_specific_terms(self):
        queries = build_queries(scope="expanded")
        normalized = "\n".join(queries).lower()

        self.assertIn("guadalajara", normalized)
        self.assertIn("monterrey", normalized)
        self.assertIn("ciudad de mexico", normalized)


if __name__ == "__main__":
    unittest.main()
