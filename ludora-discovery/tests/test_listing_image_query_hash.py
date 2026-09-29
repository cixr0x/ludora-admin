import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from ludora.image_phash import hash_image_bytes


class ListingImageQueryHashTests(unittest.TestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec("ludora.listing_image_query_hash"), "query variant generator is not implemented")
        from ludora import listing_image_query_hash
        return listing_image_query_hash

    def encoded(self, image):
        return cv2.imencode(".png", image)[1].tobytes()

    def test_raw_variant_keeps_independent_canonical_fixture_when_normalization_fails(self):
        module = self.module()
        image = np.random.default_rng(819).integers(0, 256, (64, 64), dtype=np.uint8)
        with patch.object(module, "detect_silhouette", side_effect=ValueError("no box")):
            result = module.hash_query_variants(self.encoded(image))
        self.assertEqual(result["method"], "phash_dct256_v1")
        self.assertEqual(result["variants"], [{"origin": "raw", "hash": "82be24c13fcbc99788379f9edc5cd03b9a9a395944c2a3ebb5e2618ac50a2aec"}])
        self.assertEqual(result["normalization"]["status"], "error")

    def test_real_box_normalization_produces_bounded_faces_and_cli_parity(self):
        module = self.module()
        image = np.full((260, 320, 3), 255, dtype=np.uint8)
        polygon = np.array([[70, 35], [250, 20], [290, 70], [285, 230], [95, 240], [55, 180]], np.int32)
        cv2.fillPoly(image, [polygon], (70, 115, 175))
        cv2.rectangle(image, (100, 150), (235, 215), (252, 252, 252), -1)
        cv2.circle(image, (170, 90), 30, (25, 180, 50), -1)
        encoded = self.encoded(image)
        result = module.hash_query_variants(encoded)
        self.assertEqual(result["variants"][0], {"origin": "raw", "hash": hash_image_bytes(encoded)})
        self.assertGreater(len(result["variants"]), 1)
        self.assertLessEqual(len(result["variants"]), 3)
        for variant in result["variants"][1:]:
            self.assertEqual(variant["origin"], "box_silhouette")
            self.assertEqual(len(variant["hash"]), 64)
            self.assertLessEqual(max(variant["face"]["width"], variant["face"]["height"]), 1200)
            self.assertEqual(len(variant["face"]["corners"]), 4)
        cli = subprocess.run([sys.executable, "-m", "ludora.listing_image_query_hash"], input=encoded, capture_output=True, timeout=30)
        self.assertEqual(cli.returncode, 0, cli.stderr.decode())
        self.assertEqual(json.loads(cli.stdout), result)

    def test_rejects_invalid_geometry_before_flattening(self):
        module = self.module()
        for corners in [
            [[0, 0], [9, 0], [9, 9], [0, 9]],
            [[10, 10], [90, 10], [90, 10], [10, 90]],
            [[-1, 10], [90, 10], [90, 90], [10, 90]],
            [[10, 10], [90, 90], [10, 90], [90, 10]],
            [[float("nan"), 10], [90, 10], [90, 90], [10, 90]],
        ]:
            with self.subTest(corners=corners):
                self.assertFalse(module.valid_polygon(corners, (100, 100)))
        self.assertTrue(module.valid_polygon([[10, 10], [90, 10], [90, 90], [10, 90]], (100, 100)))

    def test_limits_working_dimensions_without_changing_raw_hash(self):
        module = self.module()
        image = np.full((2500, 2600, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (200, 200), (1400, 1300), (30, 90, 150), -1)
        encoded = self.encoded(image)
        with patch.object(module, "detect_silhouette", side_effect=ValueError("no box")) as detection:
            result = module.hash_query_variants(encoded)
        self.assertEqual(result["variants"][0]["hash"], hash_image_bytes(encoded))
        self.assertEqual(max(detection.call_args.args[0].shape[:2]), 2048)

    def test_preserves_detector_pixels_below_the_input_cap(self):
        module = self.module()
        image = np.full((1500, 1600, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (200, 200), (1400, 1300), (30, 90, 150), -1)
        with patch.object(module, "detect_silhouette", side_effect=ValueError("no box")) as detection:
            module.hash_query_variants(self.encoded(image))
        self.assertEqual(detection.call_args.args[0].shape, (1500, 1600, 3))
        np.testing.assert_array_equal(detection.call_args.args[0], image)

    def test_rejects_invalid_encoded_input(self):
        module = self.module()
        with self.assertRaises(ValueError):
            module.hash_query_variants(b"invalid image")


if __name__ == "__main__":
    unittest.main()
