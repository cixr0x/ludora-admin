import json
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from ludora.cover_asset_workflow import (
    build_s3_key,
    finish_cover_asset,
    public_url_for_key,
    read_metadata,
    slugify,
    stage_cover_asset,
)


def write_test_image(path: Path) -> None:
    image = np.full((80, 60, 3), [40, 80, 120], dtype=np.uint8)
    cv2.imwrite(str(path), image)


class CoverAssetWorkflowTests(unittest.TestCase):
    def test_slugify_keeps_spanish_names_s3_safe(self):
        self.assertEqual(slugify("CATAN: Piratas y Exploradores Edicion Espanola"), "catan-piratas-y-exploradores-edicion-espanola")
        self.assertEqual(slugify("Azul: Jardín de la Reina"), "azul-jardin-de-la-reina")

    def test_s3_key_and_public_url_are_normalized(self):
        self.assertEqual(build_s3_key("Azul Reina", "covers/es/"), "covers/es/azul-reina.webp")
        self.assertEqual(
            public_url_for_key("https://cdn.example.com/images/", "covers/es/azul reina.webp"),
            "https://cdn.example.com/images/covers/es/azul%20reina.webp",
        )

    def test_stage_copies_local_source_and_writes_metadata(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "store-source.png"
            write_test_image(source)

            metadata = stage_cover_asset(
                source=str(source),
                name="Catan Piratas y Exploradores",
                output_root=root / "assets",
                s3_prefix="covers/es",
            )

            self.assertTrue(Path(metadata.source_path).exists())
            self.assertEqual(metadata.s3_key, "covers/es/catan-piratas-y-exploradores.webp")
            self.assertEqual(Path(metadata.edited_path).name, "edited.png")

            saved = read_metadata(Path(metadata.final_path).parent / "cover_asset.json")
            self.assertEqual(saved.slug, "catan-piratas-y-exploradores")
            self.assertEqual(saved.source, str(source))

    def test_finish_converts_edited_image_to_webp_and_updates_metadata(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "source.png"
            write_test_image(source)
            metadata = stage_cover_asset(str(source), "Cafe Barista", root / "assets", s3_prefix="covers/es")
            edited = Path(metadata.edited_path)
            write_test_image(edited)

            result = finish_cover_asset(
                Path(metadata.final_path).parent,
                public_base_url="https://cdn.example.com/images",
                quality=80,
            )

            self.assertTrue(Path(result.final_path).exists())
            self.assertEqual(result.public_url, "https://cdn.example.com/images/covers/es/cafe-barista.webp")
            self.assertFalse(result.uploaded)
            self.assertEqual(cv2.imread(result.final_path).shape[:2], (80, 60))

            updated = json.loads((Path(metadata.final_path).parent / "cover_asset.json").read_text(encoding="utf-8"))
            self.assertEqual(updated["public_url"], result.public_url)

    def test_finish_uses_injected_uploader_when_upload_is_enabled(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "source.png"
            write_test_image(source)
            metadata = stage_cover_asset(str(source), "Dixit Odyssey", root / "assets", s3_prefix="covers/es")
            write_test_image(Path(metadata.edited_path))
            calls = []

            def fake_upload(path: Path, bucket: str, key: str, content_type: str, cache_control: str) -> None:
                calls.append((path, bucket, key, content_type, cache_control))

            result = finish_cover_asset(
                Path(metadata.final_path).parent,
                upload=True,
                bucket="ludora-assets",
                public_base_url="https://cdn.example.com",
                uploader=fake_upload,
            )

            self.assertTrue(result.uploaded)
            self.assertEqual(result.public_url, "https://cdn.example.com/covers/es/dixit-odyssey.webp")
            self.assertEqual(calls[0][1], "ludora-assets")
            self.assertEqual(calls[0][2], "covers/es/dixit-odyssey.webp")
            self.assertEqual(calls[0][3], "image/webp")

    def test_finish_requires_an_edited_image(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "source.png"
            write_test_image(source)
            metadata = stage_cover_asset(str(source), "Missing Edit", root / "assets")

            with self.assertRaises(FileNotFoundError):
                finish_cover_asset(Path(metadata.final_path).parent)


if __name__ == "__main__":
    unittest.main()
