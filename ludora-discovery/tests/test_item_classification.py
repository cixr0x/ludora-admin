import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.item_classification import apply_item_classification, classify_item_candidate
from ludora.models import DiscoveryItemCandidateRecord


class ItemClassificationTests(unittest.TestCase):
    def test_classifies_likely_boardgame_from_player_time_and_category_signals(self):
        record = DiscoveryItemCandidateRecord(
            store_id=1,
            source_url="https://example.mx/products/catan",
            title="Catan",
            description="Juego de mesa de estrategia para comerciar y construir.",
            min_players=3,
            max_players=4,
            min_minutes=60,
            min_age=10,
            raw_payload={"text": "Categoria: Juegos de mesa familiares"},
        )

        result = classify_item_candidate(record)

        self.assertEqual(result.category, "LIKELY_BOARDGAME")
        self.assertGreaterEqual(result.confidence, 0.75)
        self.assertTrue(any("player" in reason for reason in result.reasons))

    def test_classifies_likely_expansion_from_base_game_requirement(self):
        record = DiscoveryItemCandidateRecord(
            store_id=1,
            source_url="https://example.mx/products/catan-expansion",
            title="Catan Expansion Navegantes",
            description="Expansion para Catan. Requiere el juego base.",
            raw_payload={"text": "requiere el juego base"},
        )

        result = classify_item_candidate(record)

        self.assertEqual(result.category, "LIKELY_EXPANSION")
        self.assertGreaterEqual(result.confidence, 0.75)

    def test_classifies_obvious_hobby_supply_as_likely_non_boardgame(self):
        record = DiscoveryItemCandidateRecord(
            store_id=1,
            source_url="https://example.mx/products/vallejo-951",
            title="Vallejo Blanco 951",
            description="Pintura acrilica para miniaturas.",
            raw_payload={"text": "paint brush hobby color"},
        )

        result = classify_item_candidate(record)

        self.assertEqual(result.category, "LIKELY_NON_BOARDGAME")
        self.assertGreaterEqual(result.confidence, 0.75)

    def test_positive_boardgame_signals_prevent_non_boardgame_classification(self):
        record = DiscoveryItemCandidateRecord(
            store_id=1,
            source_url="https://example.mx/products/card-game",
            title="Fast Card Game",
            description="Juego de cartas para 2 a 4 jugadores con turnos rapidos.",
            min_players=2,
            max_players=4,
            min_minutes=20,
            raw_payload={"text": "card game estrategia familiar"},
        )

        result = classify_item_candidate(record)

        self.assertNotEqual(result.category, "LIKELY_NON_BOARDGAME")
        self.assertEqual(result.category, "LIKELY_BOARDGAME")

    def test_full_page_raw_text_does_not_create_boardgame_classification(self):
        record = DiscoveryItemCandidateRecord(
            store_id=4,
            source_url="https://caravanagameshop.com/producto/smash-burguer/",
            title="Smash Burguer",
            description="Hamburguesa clasica o especial.",
            raw_payload={
                "text": "Tienda y Restaurante con Juegos de Mesa | Caravana Game Shop. "
                "Juegos de mesa, jugadores, estrategia, productos relacionados.",
                "meta": {
                    "og:title": "Smash Burguer - Tienda y Restaurante con Juegos de Mesa | Caravana Game Shop"
                },
            },
        )

        result = classify_item_candidate(record)

        self.assertNotEqual(result.category, "LIKELY_BOARDGAME")

    def test_componentes_alone_does_not_create_boardgame_classification(self):
        record = DiscoveryItemCandidateRecord(
            store_id=1,
            source_url="https://example.mx/products/componentes-plasticos",
            title="Set de componentes plasticos",
            description="Componentes de repuesto para organizacion y almacenaje.",
        )

        result = classify_item_candidate(record)

        self.assertEqual(result.category, "UNCERTAIN")

    def test_apply_item_classification_updates_record_metadata(self):
        record = DiscoveryItemCandidateRecord(
            store_id=1,
            source_url="https://example.mx/products/sleeves",
            title="Card Sleeves Standard",
            description="100 protectores transparentes.",
        )

        apply_item_classification(record)

        self.assertFalse(record.is_boardgame)
        self.assertTrue(record.is_boardgame_confirmed)
        self.assertIsNotNone(record.category_confidence)
        self.assertGreater(len(record.classification_reasons), 0)
        self.assertTrue(all(reason.startswith("heuristic classifier: ") for reason in record.classification_reasons))

    def test_apply_item_classification_marks_likely_boardgames_as_boardgames(self):
        record = DiscoveryItemCandidateRecord(
            store_id=1,
            source_url="https://example.mx/products/catan",
            title="Catan",
            description="Juego de mesa para 3 a 4 jugadores.",
            min_players=3,
            max_players=4,
        )

        apply_item_classification(record)

        self.assertTrue(record.is_boardgame)
        self.assertFalse(record.is_boardgame_confirmed)


if __name__ == "__main__":
    unittest.main()
