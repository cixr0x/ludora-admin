import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from ludora.box_silhouette import (
    approximate_hull,
    build_foreground_mask,
    classify_perspective,
    detect_silhouette,
    identify_three_face_cover_candidates,
    identify_two_face_cover,
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

    def test_classifies_three_faces_when_two_opposite_pairs_match(self):
        vertices = np.array(
            [
                [523.53, 116.50],
                [610.80, 133.54],
                [581.55, 571.32],
                [164.96, 680.50],
                [118.07, 603.54],
                [85.16, 144.63],
            ],
            dtype=np.float64,
        )

        perspective = classify_perspective(vertices)

        self.assertEqual(perspective.kind, "three_faces")
        self.assertEqual(perspective.matching_opposite_pairs, 2)
        self.assertEqual([pair.axis_label for pair in perspective.pairs], ["A", "B", "C"])
        self.assertEqual([pair.line_indices for pair in perspective.pairs], [[1, 4], [2, 5], [3, 6]])
        self.assertFalse(perspective.pairs[0].similar_direction)
        self.assertTrue(perspective.pairs[1].similar_direction)
        self.assertTrue(perspective.pairs[2].similar_direction)

    def test_classifies_two_faces_when_only_one_opposite_pair_matches(self):
        vertices = np.array(
            [
                [126.87, 34.22],
                [362.72, 56.31],
                [362.80, 412.61],
                [125.59, 424.48],
                [92.21, 405.95],
                [91.81, 46.77],
            ],
            dtype=np.float64,
        )

        perspective = classify_perspective(vertices)

        self.assertEqual(perspective.kind, "two_faces")
        self.assertEqual(perspective.matching_opposite_pairs, 1)
        self.assertFalse(perspective.pairs[0].similar_direction)
        self.assertTrue(perspective.pairs[1].similar_direction)
        self.assertFalse(perspective.pairs[2].similar_direction)

    def test_two_face_cover_connects_vertices_not_touching_parallel_lines(self):
        vertices = np.array(
            [
                [126.87, 34.22],
                [362.72, 56.31],
                [362.80, 412.61],
                [125.59, 424.48],
                [92.21, 405.95],
                [91.81, 46.77],
            ],
            dtype=np.float64,
        )
        perspective = classify_perspective(vertices)

        cover = identify_two_face_cover(vertices, perspective)

        self.assertIsNotNone(cover)
        self.assertEqual(cover.parallel_axis_label, "B")
        self.assertEqual(cover.parallel_line_indices, [2, 5])
        self.assertEqual(cover.seam_vertex_indices, [1, 4])
        np.testing.assert_allclose(cover.seam, vertices[[0, 3]])
        self.assertEqual(cover.cover_vertex_indices, [1, 2, 3, 4])
        np.testing.assert_allclose(cover.cover_polygon, vertices[[0, 1, 2, 3]])
        self.assertGreater(cover.cover_area, cover.side_area)
        self.assertGreater(cover.cover_area_fraction, 0.80)

    def test_three_face_outline_does_not_create_two_face_cover(self):
        vertices = np.array(
            [
                [523.53, 116.50],
                [610.80, 133.54],
                [581.55, 571.32],
                [164.96, 680.50],
                [118.07, 603.54],
                [85.16, 144.63],
            ],
            dtype=np.float64,
        )
        perspective = classify_perspective(vertices)

        self.assertIsNone(identify_two_face_cover(vertices, perspective))

    def test_three_face_cover_generates_four_parallel_line_candidates(self):
        vertices = np.array(
            [
                [523.53, 116.50],
                [610.80, 133.54],
                [581.55, 571.32],
                [164.96, 680.50],
                [118.07, 603.54],
                [85.16, 144.63],
            ],
            dtype=np.float64,
        )
        perspective = classify_perspective(vertices)

        candidate_set = identify_three_face_cover_candidates(vertices, perspective)

        self.assertIsNotNone(candidate_set)
        self.assertEqual(candidate_set.longest_line_indices, [2, 3, 5, 6])
        self.assertEqual(candidate_set.base_vertex_index, 3)
        self.assertEqual(candidate_set.anchor_vertex_indices, [2, 4])
        self.assertEqual(len(candidate_set.candidates), 4)
        self.assertTrue(all(candidate.inside_silhouette for candidate in candidate_set.candidates))
        self.assertTrue(all(candidate.convex for candidate in candidate_set.candidates))
        self.assertEqual(candidate_set.largest_area_candidate_id, 4)
        largest = candidate_set.candidates[3]
        self.assertEqual(largest.first_parallel_source_line, "C2")
        self.assertEqual(largest.first_anchor_vertex_index, 2)
        self.assertEqual(largest.second_parallel_source_line, "B2")
        self.assertEqual(largest.second_anchor_vertex_index, 4)
        np.testing.assert_allclose(largest.missing_vertex, [128.0, 164.5], atol=0.6)

    def test_two_face_outline_does_not_create_three_face_candidates(self):
        vertices = np.array(
            [
                [126.87, 34.22],
                [362.72, 56.31],
                [362.80, 412.61],
                [125.59, 424.48],
                [92.21, 405.95],
                [91.81, 46.77],
            ],
            dtype=np.float64,
        )
        perspective = classify_perspective(vertices)

        self.assertIsNone(identify_three_face_cover_candidates(vertices, perspective))

    def test_classifies_ideal_abcabc_hexagon_as_three_faces(self):
        edge_vectors = np.array(
            [[100, 10], [20, 100], [-80, 40], [-100, -10], [-20, -100], [80, -40]],
            dtype=np.float64,
        )
        vertices = np.vstack([np.array([[100.0, 100.0]]), 100.0 + np.cumsum(edge_vectors[:-1], axis=0)])

        perspective = classify_perspective(vertices)

        self.assertEqual(perspective.kind, "three_faces")
        self.assertEqual(perspective.matching_opposite_pairs, 3)
        self.assertGreater(perspective.confidence, 0.99)

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
