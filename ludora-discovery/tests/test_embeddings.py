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
            min_players=1,
            max_players=4,
            min_minutes=30,
            max_minutes=40,
            complexity=1.8,
            min_age=10,
            categories=["Animals", "Puzzle"],
            categories_es=["Animales", "Rompecabezas"],
            mechanics=["Tile Placement", "Pattern Building"],
            mechanics_es=["Colocacion de losetas", "Construccion de patrones"],
            families=["Cats"],
            families_es=["Gatos"],
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
                    "Categories_es: Animales, Rompecabezas",
                    "Mechanics: Tile Placement, Pattern Building",
                    "Mechanics_es: Colocacion de losetas, Construccion de patrones",
                    "Families: Cats",
                    "Families_es: Gatos",
                    (
                        "Derived keywords: single player, solo, solitaire, one player, un jugador, "
                        "juego en solitario, solitario, short duration, quick game, fast game, juego corto, "
                        "partida rapida, light complexity, easy to learn, beginner friendly, baja complejidad, "
                        "facil de aprender, ligero, family friendly, families, familiar, para familia"
                    ),
                ]
            ),
        )
        self.assertEqual(source_text_hash(text), source_text_hash(text))
        self.assertEqual(len(source_text_hash(text)), 64)


if __name__ == "__main__":
    unittest.main()
