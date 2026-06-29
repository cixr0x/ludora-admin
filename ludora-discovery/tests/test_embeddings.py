import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.database import ItemSearchEmbeddingSource
from ludora.embeddings import build_item_embedding_text, source_text_hash


class EmbeddingsTests(unittest.TestCase):
    def test_builds_item_embedding_text_with_descriptions_and_taxonomy(self):
        source = ItemSearchEmbeddingSource(
            item_id=77,
            canonical_name="Calico",
            canonical_name_es="Calico",
            description="A puzzly tile-laying game about sewing quilts and attracting cats.",
            description_es="Un juego sobre coser colchas y atraer gatos.",
            categories=["Animals", "Puzzle"],
            mechanics=["Tile Placement", "Pattern Building"],
            families=["Cats"],
        )

        text = build_item_embedding_text(source)

        self.assertEqual(
            text,
            "\n".join(
                [
                    "Name: Calico",
                    "Spanish name: Calico",
                    "Description: A puzzly tile-laying game about sewing quilts and attracting cats.",
                    "Description_es: Un juego sobre coser colchas y atraer gatos.",
                    "Categories: Animals, Puzzle",
                    "Mechanics: Tile Placement, Pattern Building",
                    "Families: Cats",
                ]
            ),
        )
        self.assertEqual(source_text_hash(text), source_text_hash(text))
        self.assertEqual(len(source_text_hash(text)), 64)


if __name__ == "__main__":
    unittest.main()
