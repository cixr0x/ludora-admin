import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from ludora.box_silhouette import (
    approximate_hull,
    build_foreground_mask,
    detect_silhouette,
    process_image,
)


class BoxSilhouetteTests(unittest.TestCase):
    def test_detects_six_sided_convex_box_silhouette(self):
        image = np.full((260, 320, 3), 255, dtype=np.uint8)
        expected = np.array(
            [[55, 48], [215, 30], [270, 48], [260, 215], [80, 235], [45, 205]],
            dtype=np.int32,
        )
        cv2.fillPoly(image, [expected], (70, 115, 175))
        cv2.rectangle(image, (100, 150), (235, 215), (252, 252, 252), -1)

        detection, mask, _ = detect_silhouette(image)

        self.assertEqual(len(detection.lines), 6)
        self.assertEqual(len(detection.vertices), 6)
        self.assertGreater(detection.polygon_area_retention, 0.97)
        self.assertGreater(int(np.count_nonzero(mask)), 20_000)
        detected = np.asarray(detection.vertices)
        for point in expected:
            self.assertLess(float(np.min(np.linalg.norm(detected - point, axis=1))), 4.0)

    def test_mask_uses_largest_component(self):
        image = np.full((180, 220, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (50, 30), (190, 160), (40, 80, 140), -1)
        cv2.rectangle(image, (5, 5), (12, 12), (0, 0, 0), -1)

        mask, _, _ = build_foreground_mask(image)

        self.assertEqual(int(mask[8, 8]), 0)
        self.assertEqual(int(mask[80, 100]), 255)

    def test_line_fitting_prefers_box_edges_over_cast_shadow(self):
        image = np.full((260, 320, 3), 255, dtype=np.uint8)
        expected = np.array(
            [[55, 48], [215, 30], [270, 48], [260, 215], [80, 235], [45, 205]],
            dtype=np.int32,
        )
        shadow = expected + np.array([8, 10], dtype=np.int32)
        cv2.fillPoly(image, [shadow], (225, 225, 225))
        cv2.fillPoly(image, [expected], (70, 115, 175))

        detection, _, _ = detect_silhouette(image)

        initial = np.asarray(detection.initial_vertices)
        refined = np.asarray(detection.vertices)
        initial_error = max(float(np.min(np.linalg.norm(initial - point, axis=1))) for point in expected)
        refined_error = max(float(np.min(np.linalg.norm(refined - point, axis=1))) for point in expected)
        self.assertGreater(initial_error, 9.0)
        self.assertLess(refined_error, 2.0)
        self.assertTrue(all(line.fit_source == "image_edge" for line in detection.lines))

    def test_line_endpoints_share_the_fitted_corner_intersections(self):
        image = np.full((220, 260, 3), 255, dtype=np.uint8)
        polygon = np.array(
            [[40, 35], [165, 22], [220, 40], [215, 180], [65, 200], [32, 175]],
            dtype=np.int32,
        )
        cv2.fillPoly(image, [polygon], (50, 100, 170))

        detection, _, _ = detect_silhouette(image)

        for index, line in enumerate(detection.lines):
            next_line = detection.lines[(index + 1) % len(detection.lines)]
            np.testing.assert_allclose(line.end, next_line.start)

    def test_approximation_returns_requested_line_count(self):
        points = np.array(
            [[10, 10], [50, 5], [90, 10], [100, 50], [90, 90], [50, 95], [10, 90], [5, 50]],
            dtype=np.int32,
        ).reshape(-1, 1, 2)
        hull = cv2.convexHull(points)

        approximation = approximate_hull(hull, target_vertices=6)

        self.assertEqual(len(approximation), 6)

    def test_rejects_an_image_without_a_foreground_object(self):
        image = np.full((100, 100, 3), 255, dtype=np.uint8)

        with self.assertRaisesRegex(ValueError, "foreground object"):
            detect_silhouette(image)

    def test_process_image_writes_overlay_mask_and_metadata(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "source.png"
            output = Path(temp_dir) / "output"
            image = np.full((180, 220, 3), 255, dtype=np.uint8)
            polygon = np.array(
                [[35, 25], [145, 18], [185, 35], [180, 150], [55, 165], [30, 145]],
                dtype=np.int32,
            )
            cv2.fillPoly(image, [polygon], (30, 90, 160))
            cv2.imwrite(str(source), image)

            result = process_image(source, output)

            self.assertTrue(Path(result.overlay_path).exists())
            self.assertTrue(Path(result.mask_path).exists())
            self.assertTrue(Path(result.metadata_path).exists())
            self.assertEqual(len(result.detection.lines), 6)


if __name__ == "__main__":
    unittest.main()
