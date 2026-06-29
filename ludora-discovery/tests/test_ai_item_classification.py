import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.ai_item_classification import OpenAIItemClassifier
from ludora.models import DiscoveryItemCandidateRecord


class AIItemClassificationTests(unittest.TestCase):
    def test_classifies_boardgame_from_openai_response(self):
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/catan",
            title="Catan",
            description="Juego de mesa para 3 a 4 jugadores.",
            raw_payload={"json_ld": {"name": "Catan"}},
        )
        response_body = {
            "output_text": json.dumps(
                {
                    "classification": "LIKELY_BOARDGAME",
                    "confidence": 87,
                    "reasoning": "The raw payload describes a boxed board game with player count.",
                }
            )
        }

        with patch("ludora.ai_item_classification.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = json.dumps(response_body).encode("utf-8")

            classifier = OpenAIItemClassifier(api_key="key", model="model", base_url="http://ai.test/v1")
            classifier.apply_item_classification(record)

        request = urlopen.call_args.args[0]
        request_payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(request.full_url, "http://ai.test/v1/responses")
        self.assertEqual(request.headers["Authorization"], "Bearer key")
        self.assertEqual(request_payload["model"], "model")
        self.assertIn('"raw_payload"', request_payload["input"][1]["content"])
        self.assertTrue(record.is_boardgame)
        self.assertFalse(record.is_boardgame_confirmed)
        self.assertEqual(record.category_confidence, 0.87)
        self.assertEqual(
            record.classification_reasons,
            ["AI classifier: The raw payload describes a boxed board game with player count."],
        )

    def test_prompt_treats_boardgame_expansions_as_positive_items(self):
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/catan-expansion",
            title="Catan Navegantes Expansion",
            description="Expansion para Catan. Requiere el juego base.",
            raw_payload={"json_ld": {"name": "Catan Navegantes Expansion"}},
        )
        response_body = {
            "output_text": json.dumps(
                {
                    "classification": "LIKELY_BOARDGAME",
                    "confidence": 86,
                    "reasoning": "The payload describes a board-game expansion for Catan.",
                }
            )
        }

        with patch("ludora.ai_item_classification.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = json.dumps(response_body).encode("utf-8")

            OpenAIItemClassifier(api_key="key", model="model").apply_item_classification(record)

        request = urlopen.call_args.args[0]
        request_payload = json.loads(request.data.decode("utf-8"))
        system_prompt = request_payload["input"][0]["content"]
        self.assertIn("board-game expansions", system_prompt)
        self.assertIn("requires a base game", system_prompt)
        self.assertIn("LIKELY_BOARDGAME", system_prompt)
        self.assertTrue(record.is_boardgame)

    def test_classifies_non_boardgame_from_openai_response(self):
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/sleeves",
            title="Card Sleeves",
            raw_payload={"json_ld": {"name": "Card Sleeves"}},
        )
        response_body = {
            "output_text": json.dumps(
                {
                    "classification": "LIKELY_NON_BOARDGAME",
                    "confidence": 91,
                    "reasoning": "The raw payload describes card accessories, not a board game.",
                }
            )
        }

        with patch("ludora.ai_item_classification.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = json.dumps(response_body).encode("utf-8")

            OpenAIItemClassifier(api_key="key", model="model").apply_item_classification(record)

        self.assertFalse(record.is_boardgame)
        self.assertTrue(record.is_boardgame_confirmed)
        self.assertEqual(record.category_confidence, 0.91)

    def test_normalizes_non_boardgame_classification_alias_from_openai_response(self):
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/sleeves",
            title="Card Sleeves",
            raw_payload={"json_ld": {"name": "Card Sleeves"}},
        )
        response_body = {
            "output_text": json.dumps(
                {
                    "classification": "LIKELY_NON_BOARD_GAME",
                    "confidence": 91,
                    "reasoning": "The raw payload describes card accessories, not a board game.",
                }
            )
        }

        with patch("ludora.ai_item_classification.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = json.dumps(response_body).encode("utf-8")

            OpenAIItemClassifier(api_key="key", model="model").apply_item_classification(record)

        self.assertFalse(record.is_boardgame)
        self.assertTrue(record.is_boardgame_confirmed)
        self.assertEqual(record.category_confidence, 0.91)

    def test_normalizes_boardgame_classification_alias_from_openai_response(self):
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/catan",
            title="Catan",
            raw_payload={"json_ld": {"name": "Catan"}},
        )
        response_body = {
            "output_text": json.dumps(
                {
                    "classification": "LIKELY_BOARD_GAME",
                    "confidence": 88,
                    "reasoning": "The raw payload describes a standalone board game.",
                }
            )
        }

        with patch("ludora.ai_item_classification.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = json.dumps(response_body).encode("utf-8")

            OpenAIItemClassifier(api_key="key", model="model").apply_item_classification(record)

        self.assertTrue(record.is_boardgame)
        self.assertFalse(record.is_boardgame_confirmed)
        self.assertEqual(record.category_confidence, 0.88)

    def test_does_not_auto_confirm_non_boardgame_at_sixty_percent_confidence(self):
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/sleeves-review",
            title="Card Sleeves Review",
            raw_payload={"json_ld": {"name": "Card Sleeves Review"}},
        )
        response_body = {
            "output_text": json.dumps(
                {
                    "classification": "LIKELY_NON_BOARDGAME",
                    "confidence": 60,
                    "reasoning": "The payload likely describes accessories but confidence is at the review boundary.",
                }
            )
        }

        with patch("ludora.ai_item_classification.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = json.dumps(response_body).encode("utf-8")

            OpenAIItemClassifier(api_key="key", model="model").apply_item_classification(record)

        self.assertFalse(record.is_boardgame)
        self.assertFalse(record.is_boardgame_confirmed)
        self.assertEqual(record.category_confidence, 0.6)

    def test_rejects_invalid_ai_classification(self):
        response_body = {
            "output_text": json.dumps(
                {
                    "classification": "UNCERTAIN",
                    "confidence": 70,
                    "reasoning": "Not allowed by the contract.",
                }
            )
        }

        with patch("ludora.ai_item_classification.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = json.dumps(response_body).encode("utf-8")

            with self.assertRaisesRegex(RuntimeError, "invalid classification"):
                OpenAIItemClassifier(api_key="key", model="model").apply_item_classification(
                    DiscoveryItemCandidateRecord(store_id=None, source_url="", title="")
                )

    def test_rejects_invalid_ai_confidence(self):
        response_body = {
            "output_text": json.dumps(
                {
                    "classification": "LIKELY_BOARDGAME",
                    "confidence": 101,
                    "reasoning": "Out of range.",
                }
            )
        }

        with patch("ludora.ai_item_classification.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = json.dumps(response_body).encode("utf-8")

            with self.assertRaisesRegex(RuntimeError, "confidence"):
                OpenAIItemClassifier(api_key="key", model="model").apply_item_classification(
                    DiscoveryItemCandidateRecord(store_id=None, source_url="", title="")
                )

    def test_wraps_openai_request_errors(self):
        with patch("ludora.ai_item_classification.urlopen", side_effect=URLError("connection refused")):
            with self.assertRaisesRegex(RuntimeError, "AI item classifier request failed"):
                OpenAIItemClassifier(api_key="key", model="model").apply_item_classification(
                    DiscoveryItemCandidateRecord(store_id=None, source_url="", title="")
                )


if __name__ == "__main__":
    unittest.main()
