import json
from pathlib import Path
import subprocess
import sys
import struct
import unittest

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from ludora.image_phash import hash_image_bytes


class ImagePhashTests(unittest.TestCase):
    def test_alpha_is_discarded_by_the_documented_color_decode_policy(self):
        image = np.random.default_rng(101).integers(0, 256, (64, 64, 4), dtype=np.uint8)
        image[:, :, 3] = 0
        transparent = cv2.imencode(".png", image)[1].tobytes()
        image[:, :, 3] = 255
        opaque = cv2.imencode(".png", image)[1].tobytes()
        self.assertEqual(hash_image_bytes(transparent), hash_image_bytes(opaque))

    def test_jpeg_exif_orientation_matches_the_oriented_raster(self):
        image = np.random.default_rng(18).integers(0, 256, (128, 64, 3), dtype=np.uint8)
        jpeg = cv2.imencode(".jpg", image)[1].tobytes()
        exif = b"Exif\0\0II" + struct.pack("<HIH", 42, 8, 1) + struct.pack("<HHI", 0x112, 3, 1) + struct.pack("<HHI", 6, 0, 0)
        oriented_jpeg = jpeg[:2] + b"\xff\xe1" + struct.pack(">H", len(exif) + 2) + exif + jpeg[2:]
        decoded = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        rotated = cv2.rotate(decoded, cv2.ROTATE_90_CLOCKWISE)
        png = cv2.imencode(".png", rotated)[1].tobytes()
        self.assertEqual(hash_image_bytes(oriented_jpeg), hash_image_bytes(png))

    def test_independent_dct_fixture_and_repeatability(self):
        # Literal derived independently with an orthonormal cosine matrix.
        image = np.random.default_rng(819).integers(0, 256, (64, 64), dtype=np.uint8)
        encoded = cv2.imencode(".png", image)[1].tobytes()
        expected = "82be24c13fcbc99788379f9edc5cd03b9a9a395944c2a3ebb5e2618ac50a2aec"
        self.assertEqual(hash_image_bytes(encoded), expected)
        self.assertEqual(hash_image_bytes(encoded), expected)

    def test_resized_recompressed_artwork_remains_close(self):
        image = np.zeros((256, 192, 3), dtype=np.uint8)
        cv2.rectangle(image, (12, 16), (170, 225), (70, 190, 245), -1)
        cv2.circle(image, (80, 95), 42, (220, 45, 80), -1)
        cv2.putText(image, "GAME", (15, 190), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 3)
        original = cv2.imencode(".png", image)[1].tobytes()
        smaller = cv2.resize(image, (96, 128), interpolation=cv2.INTER_AREA)
        recompressed = cv2.imencode(".jpg", smaller, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()
        distance = (int(hash_image_bytes(original), 16) ^ int(hash_image_bytes(recompressed), 16)).bit_count()
        self.assertLess(distance, 32)

    def test_invalid_image_is_rejected(self):
        with self.assertRaises(ValueError):
            hash_image_bytes(b"not an image")

    def test_cli_reads_exact_stdin_bytes(self):
        image = np.random.default_rng(819).integers(0, 256, (64, 64), dtype=np.uint8)
        encoded = cv2.imencode(".png", image)[1].tobytes()
        result = subprocess.run([sys.executable, "-m", "ludora.image_phash"], input=encoded, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout), {
            "method": "phash_dct256_v1",
            "hash": "82be24c13fcbc99788379f9edc5cd03b9a9a395944c2a3ebb5e2618ac50a2aec",
        })


if __name__ == "__main__":
    unittest.main()
