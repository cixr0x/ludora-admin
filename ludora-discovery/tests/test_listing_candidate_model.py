import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.models import DiscoveryItemCandidateRecord


class ItemCandidateModelTests(unittest.TestCase):
    def test_item_candidate_serializes_for_database(self):
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/catan",
            source_listing_url="https://example.mx/collections/juegos",
            title="Catan - Edicion en Espanol",
            publisher="Devir",
            description="Juego base",
            item_type="base_game",
            min_players=3,
            max_players=4,
            min_minutes=60,
            max_minutes=90,
            min_age=10,
            language="es",
            image_url="https://example.mx/catan.jpg",
            raw_price="$899.00",
            price="899.00",
            price_source="woocommerce_product_price",
            currency="MXN",
            availability="available",
            availability_source="woocommerce_stock",
            store_sku="CATAN-ES",
            raw_payload={"json_ld": {"name": "Catan"}},
            is_boardgame=True,
            is_boardgame_confirmed=False,
            category_confidence=0.87,
            classification_reasons=["player count found", "boardgame category found"],
            match_source="LOCAL",
            item_id=7,
            matched_bgg_id=13,
            matched_name="Catan",
            match_score=0.94,
            match_reasons=["exact local item name match"],
            match_payload={"item": {"id": 7}},
            processing_error="",
        )

        output = record.to_db_dict()

        self.assertEqual(output["store_id"], 12)
        self.assertEqual(output["source_listing_url"], "https://example.mx/collections/juegos")
        self.assertEqual(output["title"], "Catan - Edicion en Espanol")
        self.assertEqual(output["publisher"], "Devir")
        self.assertEqual(output["item_type"], "base_game")
        self.assertEqual(output["min_players"], 3)
        self.assertEqual(output["max_players"], 4)
        self.assertEqual(output["min_minutes"], 60)
        self.assertEqual(output["max_minutes"], 90)
        self.assertEqual(output["min_age"], 10)
        self.assertEqual(output["language"], "es")
        self.assertEqual(output["image_url"], "https://example.mx/catan.jpg")
        self.assertEqual(output["price"], "899.00")
        self.assertEqual(output["price_source"], "woocommerce_product_price")
        self.assertEqual(output["currency"], "MXN")
        self.assertEqual(output["availability"], "available")
        self.assertEqual(output["availability_source"], "woocommerce_stock")
        self.assertEqual(output["store_sku"], "CATAN-ES")
        self.assertEqual(output["raw_payload"], {"json_ld": {"name": "Catan"}})
        self.assertNotIn("candidate_category", output)
        self.assertTrue(output["is_boardgame"])
        self.assertFalse(output["is_boardgame_confirmed"])
        self.assertEqual(output["category_confidence"], 0.87)
        self.assertEqual(output["classification_reasons"], ["player count found", "boardgame category found"])
        self.assertEqual(output["listing_status"], "PENDING")
        self.assertNotIn("status", output)
        self.assertNotIn("offer_id", output)
        self.assertEqual(output["match_source"], "LOCAL")
        self.assertNotIn("match_item_id", output)
        self.assertEqual(output["item_id"], 7)
        self.assertEqual(output["matched_bgg_id"], 13)
        self.assertEqual(output["matched_name"], "Catan")
        self.assertEqual(output["match_score"], 0.94)
        self.assertEqual(output["match_reasons"], ["exact local item name match"])
        self.assertEqual(output["match_payload"], {"item": {"id": 7}})
        self.assertEqual(output["processing_error"], "")

    def test_item_candidate_converts_empty_price_to_none(self):
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/catan",
            title="Catan",
            price="",
        )

        output = record.to_db_dict()

        self.assertIsNone(output["price"])


if __name__ == "__main__":
    unittest.main()
