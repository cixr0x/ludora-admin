import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

import cv2
import numpy as np

from ludora.image_similarity import estimate_image_similarity, load_image, main


def textured_cover(seed: int = 17) -> np.ndarray:
    rng = np.random.default_rng(seed)
    image = np.full((520, 380, 3), (230, 205, 155), dtype=np.uint8)
    cv2.rectangle(image, (8, 8), (371, 511), (35, 45, 90), 10)
    cv2.putText(image, "LUDORA", (35, 95), cv2.FONT_HERSHEY_DUPLEX, 1.7, (15, 30, 115), 4, cv2.LINE_AA)
    cv2.putText(image, "BOARD GAME", (42, 455), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (70, 25, 25), 3, cv2.LINE_AA)
    for index in range(45):
        center = (int(rng.integers(25, 355)), int(rng.integers(120, 420)))
        radius = int(rng.integers(4, 17))
        color = tuple(int(channel) for channel in rng.integers(20, 235, size=3))
        cv2.circle(image, center, radius, color, -1 if index % 2 else 2, cv2.LINE_AA)
    return image


def perspective_scene(reference: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    scene = np.full((900, 1200, 3), 238, dtype=np.uint8)
    source = np.float32(
        [[0, 0], [reference.shape[1] - 1, 0], [reference.shape[1] - 1, reference.shape[0] - 1], [0, reference.shape[0] - 1]]
    )
    destination = np.float32([[620, 165], [960, 230], [900, 745], [575, 690]])
    homography = cv2.getPerspectiveTransform(source, destination)
    warped = cv2.warpPerspective(reference, homography, (scene.shape[1], scene.shape[0]))
    mask = cv2.warpPerspective(
        np.full(reference.shape[:2], 255, dtype=np.uint8),
        homography,
        (scene.shape[1], scene.shape[0]),
    )
    scene[mask > 0] = warped[mask > 0]
    cv2.putText(scene, "PRODUCT PHOTO", (55, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (80, 80, 80), 3)
    return scene, destination


class ImageSimilarityTests(unittest.TestCase):
    def test_finds_reference_as_perspective_distorted_fraction_of_scene(self):
        reference = textured_cover()
        scene, expected_corners = perspective_scene(reference)

        result = estimate_image_similarity(reference, scene)

        self.assertGreater(result.score, 70)
        self.assertTrue(result.diagnostics.homography_valid)
        self.assertGreater(result.diagnostics.inliers, 20)
        self.assertIsNotNone(result.matched_region)
        actual_corners = np.float32(
            [
                [point["x"] * scene.shape[1], point["y"] * scene.shape[0]]
                for point in result.matched_region or []
            ]
        )
        np.testing.assert_allclose(actual_corners, expected_corners, atol=12)

    def test_unrelated_images_receive_low_score(self):
        reference = textured_cover(seed=17)
        rng = np.random.default_rng(900)
        unrelated = rng.integers(0, 256, size=reference.shape, dtype=np.uint8)
        unrelated = cv2.GaussianBlur(unrelated, (7, 7), 0)
        cv2.putText(unrelated, "OTHER", (65, 280), cv2.FONT_HERSHEY_DUPLEX, 1.8, (255, 255, 255), 5)

        result = estimate_image_similarity(reference, unrelated)

        self.assertLess(result.score, 35)

    def test_featureless_images_return_zero(self):
        reference = np.full((300, 220, 3), 127, dtype=np.uint8)
        candidate = np.full((700, 900, 3), 127, dtype=np.uint8)

        result = estimate_image_similarity(reference, candidate)

        self.assertEqual(result.score, 0)
        self.assertEqual(result.diagnostics.inliers, 0)
        self.assertIsNone(result.matched_region)

    def test_load_image_reports_invalid_input(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "not-an-image"
            path.write_text("not image data", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "Could not decode image"):
                load_image(path)

    def test_cli_prints_machine_readable_result(self):
        reference = textured_cover()
        scene, _ = perspective_scene(reference)
        with tempfile.TemporaryDirectory() as directory:
            reference_path = Path(directory) / "reference.png"
            scene_path = Path(directory) / "scene.jpg"
            cv2.imwrite(str(reference_path), reference)
            cv2.imwrite(str(scene_path), scene)

            output = StringIO()
            with redirect_stdout(output):
                exit_code = main([str(reference_path), str(scene_path)])

        self.assertEqual(exit_code, 0)
        self.assertIn('"method":"sift_homography_v1"', output.getvalue())


if __name__ == "__main__":
    unittest.main()
