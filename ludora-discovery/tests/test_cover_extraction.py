import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from ludora.cover_extraction import (
    ExtractionResult,
    estimate_output_size,
    order_points,
    status_for_confidence,
    write_metadata,
)


class CoverExtractionGeometryTests(unittest.TestCase):
    def test_order_points_returns_clockwise_points_from_top_left(self):
        points = np.array(
            [
                [120.0, 320.0],
                [100.0, 100.0],
                [430.0, 115.0],
                [440.0, 330.0],
            ],
            dtype=np.float32,
        )

        ordered = order_points(points)

        np.testing.assert_allclose(
            ordered,
            np.array(
                [
                    [100.0, 100.0],
                    [430.0, 115.0],
                    [440.0, 330.0],
                    [120.0, 320.0],
                ],
                dtype=np.float32,
            ),
        )

    def test_estimate_output_size_preserves_detected_aspect_ratio(self):
        points = np.array(
            [
                [100.0, 100.0],
                [500.0, 100.0],
                [500.0, 500.0],
                [100.0, 500.0],
            ],
            dtype=np.float32,
        )

        self.assertEqual(estimate_output_size(points, max_dimension=720), (720, 720))

    def test_estimate_output_size_scales_landscape_cover(self):
        points = np.array(
            [
                [100.0, 100.0],
                [700.0, 100.0],
                [700.0, 400.0],
                [100.0, 400.0],
            ],
            dtype=np.float32,
        )

        self.assertEqual(estimate_output_size(points, max_dimension=720), (720, 360))

    def test_status_for_confidence_uses_review_band(self):
        self.assertEqual(status_for_confidence(0.80), "accepted")
        self.assertEqual(status_for_confidence(0.50), "review")
        self.assertEqual(status_for_confidence(0.10), "failed")

    def test_write_metadata_serializes_result(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            metadata_path = Path(temp_dir) / "metadata.json"
            result = ExtractionResult(
                source_path="source.png",
                cover_path="cover.jpg",
                debug_path="debug.jpg",
                metadata_path=str(metadata_path),
                corners=[[1.0, 2.0], [3.0, 2.0], [3.0, 4.0], [1.0, 4.0]],
                confidence=0.8,
                status="accepted",
                width=200,
                height=300,
            )

            write_metadata(result)

            data = json.loads(metadata_path.read_text(encoding="utf-8"))
            self.assertEqual(data["status"], "accepted")
            self.assertEqual(data["aspect_ratio"], 200 / 300)
            self.assertEqual(data["corners"][0], [1.0, 2.0])

    def test_extract_cover_rejects_unreadable_image(self):
        from ludora.cover_extraction import extract_cover

        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "bad.txt"
            output = Path(temp_dir) / "out"
            source.write_text("not an image", encoding="utf-8")

            with self.assertRaises(ValueError):
                extract_cover(source, output)

    def test_extract_cover_uses_manual_corners(self):
        import cv2
        from ludora.cover_extraction import extract_cover

        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "source.png"
            output = Path(temp_dir) / "out"
            image = np.full((120, 160, 3), 255, dtype=np.uint8)
            image[20:100, 40:120] = [30, 60, 120]
            cv2.imwrite(str(source), image)

            result = extract_cover(
                source,
                output,
                manual_corners=[(40, 20), (120, 20), (120, 100), (40, 100)],
                max_dimension=80,
            )

            self.assertEqual(result.status, "accepted")
            self.assertEqual((result.width, result.height), (80, 80))
            self.assertTrue(Path(result.cover_path).exists())
            self.assertTrue(Path(result.debug_path).exists())
            self.assertTrue(Path(result.metadata_path).exists())

    def test_detect_front_face_prefers_front_panel_over_left_spine(self):
        import cv2
        from ludora.cover_extraction import detect_front_face

        image = np.full((140, 180, 3), 255, dtype=np.uint8)
        top = np.array([[20, 20], [130, 10], [160, 25], [55, 35]], dtype=np.int32)
        side = np.array([[20, 20], [55, 35], [55, 120], [20, 105]], dtype=np.int32)
        front = np.array([[55, 35], [160, 25], [160, 120], [55, 120]], dtype=np.int32)
        cv2.fillPoly(image, [top], (65, 78, 110))
        cv2.fillPoly(image, [side], (45, 60, 95))
        cv2.fillPoly(image, [front], (80, 110, 170))
        cv2.polylines(image, [top, side, front], True, (0, 0, 0), 2)

        detected = detect_front_face(image)

        self.assertIsNotNone(detected)
        corners, confidence = detected
        ordered = order_points(corners)
        self.assertGreater(confidence, 0.35)
        self.assertGreaterEqual(float(ordered[0][0]), 48.0)
        self.assertGreaterEqual(float(ordered[3][0]), 48.0)
        self.assertLessEqual(float(ordered[1][0]), 165.0)
        self.assertLessEqual(float(ordered[2][0]), 165.0)

    def test_find_left_front_boundary_uses_first_plausible_seam(self):
        from ludora.cover_extraction import find_left_front_boundary

        image = np.full((120, 180, 3), [240, 240, 240], dtype=np.uint8)
        image[:, 0:55] = [70, 90, 130]
        image[:, 55:85] = [80, 105, 150]
        image[:, 85:] = [230, 210, 70]
        points = np.array([[0, 0], [179, 0], [179, 119], [0, 119]], dtype=np.float32)

        seam_x = find_left_front_boundary(image, points)

        self.assertIsNotNone(seam_x)
        self.assertLess(float(seam_x), 70.0)

    def test_find_left_border_line_prefers_detected_edge_before_inner_seam(self):
        import cv2
        from ludora.cover_extraction import find_left_border_line, x_at_y

        image = np.full((140, 180, 3), 255, dtype=np.uint8)
        outer = np.array([[20, 20], [160, 15], [160, 125], [35, 130]], dtype=np.float32)
        cv2.polylines(image, [outer.astype(np.int32)], True, (0, 0, 0), 2)
        cv2.line(image, (58, 35), (70, 122), (0, 0, 0), 3)
        cv2.line(image, (110, 35), (110, 122), (0, 0, 0), 3)

        line = find_left_border_line(image, outer, 110.0)

        self.assertIsNotNone(line)
        self.assertLess(x_at_y(line, 80.0), 90.0)

    def test_project_left_edge_uses_right_edge_angle(self):
        from ludora.cover_extraction import project_left_edge_from_right_edge

        outer = np.array(
            [
                [38.0, 42.0],
                [460.0, 40.0],
                [453.0, 436.0],
                [78.0, 474.0],
            ],
            dtype=np.float32,
        )

        projected = project_left_edge_from_right_edge(outer, 113.0)
        top_left, top_right, bottom_right, bottom_left = order_points(projected)

        self.assertAlmostEqual(float(top_left[0]), 113.0, delta=0.5)
        self.assertAlmostEqual(float(top_right[0] - bottom_right[0]), float(top_left[0] - bottom_left[0]), delta=0.5)
        self.assertLess(float(bottom_left[1]), 464.0)

    def test_build_front_face_uses_intersections_from_four_border_lines(self):
        from ludora.cover_extraction import build_front_face_from_border_lines

        outer = np.array(
            [
                [38.0, 42.0],
                [460.0, 40.0],
                [453.0, 436.0],
                [78.0, 474.0],
            ],
            dtype=np.float32,
        )

        corners = build_front_face_from_border_lines(outer, 113.0)
        top_left, top_right, bottom_right, bottom_left = order_points(corners)

        self.assertAlmostEqual(float(top_left[0]), 113.0, delta=0.5)
        self.assertAlmostEqual(float(top_right[0]), 460.0, delta=0.5)
        self.assertAlmostEqual(float(bottom_right[1]), 436.0, delta=0.5)
        self.assertGreater(float(bottom_left[1]), 468.0)
        self.assertLess(float(bottom_left[1]), 476.0)

    def test_parser_accepts_manual_corners(self):
        from ludora.cover_extraction import build_parser, parse_corner

        parser = build_parser()
        args = parser.parse_args(
            [
                "source.png",
                "--output-dir",
                "out",
                "--max-dimension",
                "900",
                "--corner",
                "1,2",
                "--corner",
                "3,4",
                "--corner",
                "5,6",
                "--corner",
                "7,8",
            ]
        )

        self.assertEqual(args.source, "source.png")
        self.assertEqual(args.output_dir, "out")
        self.assertEqual(args.max_dimension, 900)
        self.assertEqual([parse_corner(value) for value in args.corner], [(1.0, 2.0), (3.0, 4.0), (5.0, 6.0), (7.0, 8.0)])


if __name__ == "__main__":
    unittest.main()
