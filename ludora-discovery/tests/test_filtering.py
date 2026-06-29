import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.filtering import canonical_domain, classify_store_candidate
from ludora.models import SearchResult


class FilteringTests(unittest.TestCase):
    def test_canonical_domain_strips_scheme_www_and_port(self):
        self.assertEqual(canonical_domain("https://www.example.com.mx:443/products/catan"), "example.com.mx")

    def test_classify_accepts_mexican_boardgame_online_store(self):
        result = SearchResult(
            title="La Mesa Ludica - Tienda de juegos de mesa en linea",
            url="https://lamesa.example.com.mx/products/catan",
            description="Compra juegos de mesa modernos, TCG y accesorios con envios a todo Mexico.",
            query="tienda juegos de mesa mexico",
        )
        homepage_text = "Carrito, checkout, productos, agregar al carrito, Guadalajara Jalisco."

        decision = classify_store_candidate(result, homepage_text)

        self.assertIs(decision.accepted, True)
        self.assertGreaterEqual(decision.confidence, 0.7)
        self.assertIn("boardgame", decision.reasons)
        self.assertIn("online_store", decision.reasons)
        self.assertIn("mexico", decision.reasons)

    def test_classify_accepts_tabletop_variants_and_mxn_store_signals(self):
        result = SearchResult(
            title="La Fortaleza Ludica - Juegos de tablero y rol",
            url="https://fortaleza.example.com/shop/dungeons-dragons",
            description="Catalogo de juegos de tablero, juegos de rol, miniaturas y MTG con precios en MXN.",
            query="juegos de tablero tienda mexico",
        )
        homepage_text = "Productos, precio regular, finalizar compra, envios nacionales desde Queretaro."

        decision = classify_store_candidate(result, homepage_text)

        self.assertIs(decision.accepted, True)
        self.assertIn("boardgame", decision.reasons)
        self.assertIn("online_store", decision.reasons)
        self.assertIn("mexico", decision.reasons)

    def test_classify_rejects_marketplace_even_when_it_sells_boardgames(self):
        result = SearchResult(
            title="Catan juegos de mesa en Mercado Libre Mexico",
            url="https://www.mercadolibre.com.mx/catan",
            description="Compra juegos de mesa con envio.",
            query="comprar juegos de mesa mexico",
        )

        decision = classify_store_candidate(result, "")

        self.assertIs(decision.accepted, False)
        self.assertIn("blocked_domain", decision.reasons)

    def test_classify_rejects_boardgame_blog_without_online_store_signals(self):
        result = SearchResult(
            title="Los mejores juegos de mesa en Mexico",
            url="https://blog.example.mx/juegos-de-mesa",
            description="Noticias, reseñas y recomendaciones de juegos de mesa.",
            query="juegos de mesa mexico",
        )

        decision = classify_store_candidate(result, "Resenas, noticias y calendario de eventos.")

        self.assertIs(decision.accepted, False)
        self.assertIn("missing_online_store", decision.reasons)


if __name__ == "__main__":
    unittest.main()
