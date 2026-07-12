import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

import cv2
import numpy as np

from ludora.box_silhouette import (
    approximate_hull,
    build_foreground_mask,
    classify_perspective,
    detect_silhouette,
    flatten_cover_quadrilateral,
    identify_three_face_covers,
    identify_two_face_cover,
    process_image,
)


class BoxSilhouetteTests(unittest.TestCase):
    def test_flatten_cover_averages_opposite_edge_lengths(self):
        image = np.zeros((180, 220, 3), dtype=np.uint8)
        image[:, :, 1] = np.arange(180, dtype=np.uint8)[:, None]
        polygon = np.array(
            [[20, 20], [180, 30], [160, 150], [30, 140]],
            dtype=np.float32,
        )

        flattened, geometry = flatten_cover_quadrilateral(image, polygon)

        expected_width = (
            np.linalg.norm(polygon[1] - polygon[0])
            + np.linalg.norm(polygon[2] - polygon[3])
        ) / 2
        expected_height = (
            np.linalg.norm(polygon[3] - polygon[0])
            + np.linalg.norm(polygon[2] - polygon[1])
        ) / 2
        self.assertAlmostEqual(geometry.estimated_width, float(expected_width), places=4)
        self.assertAlmostEqual(geometry.estimated_height, float(expected_height), places=4)
        self.assertEqual(flattened.shape[:2], (geometry.height, geometry.width))
        self.assertEqual(geometry.untrimmed_width, round(float(expected_width)))
        self.assertEqual(geometry.untrimmed_height, round(float(expected_height)))
        self.assertEqual(geometry.width, geometry.untrimmed_width - 2 * geometry.trim_x)
        self.assertEqual(geometry.height, geometry.untrimmed_height - 2 * geometry.trim_y)

    def test_flatten_cover_trims_one_percent_from_every_side(self):
        image = np.zeros((140, 220, 3), dtype=np.uint8)
        polygon = np.array(
            [[10, 10], [210, 10], [210, 110], [10, 110]],
            dtype=np.float32,
        )

        flattened, geometry = flatten_cover_quadrilateral(image, polygon)

        self.assertEqual(geometry.trim_fraction, 0.01)
        self.assertEqual(geometry.trim_x, 2)
        self.assertEqual(geometry.trim_y, 1)
        self.assertEqual(flattened.shape[:2], (98, 196))

    def test_flatten_cover_trim_can_be_disabled(self):
        image = np.zeros((100, 120, 3), dtype=np.uint8)
        polygon = np.array(
            [[10, 10], [110, 10], [110, 90], [10, 90]],
            dtype=np.float32,
        )

        flattened, geometry = flatten_cover_quadrilateral(
            image,
            polygon,
            trim_fraction=0.0,
        )

        self.assertEqual(geometry.trim_x, 0)
        self.assertEqual(geometry.trim_y, 0)
        self.assertEqual(flattened.shape[:2], (80, 100))

    def test_flatten_cover_snaps_near_square_dimensions(self):
        image = np.zeros((130, 130, 3), dtype=np.uint8)
        polygon = np.array(
            [[10, 10], [110, 10], [110, 106], [10, 106]],
            dtype=np.float32,
        )

        flattened, geometry = flatten_cover_quadrilateral(image, polygon)

        self.assertAlmostEqual(geometry.square_difference, 0.04)
        self.assertEqual(geometry.square_threshold, 0.05)
        self.assertTrue(geometry.square_snapped)
        self.assertEqual(geometry.untrimmed_width, 98)
        self.assertEqual(geometry.untrimmed_height, 98)
        self.assertEqual(flattened.shape[0], flattened.shape[1])

    def test_flatten_cover_does_not_snap_outside_square_threshold(self):
        image = np.zeros((130, 130, 3), dtype=np.uint8)
        polygon = np.array(
            [[10, 10], [110, 10], [110, 104], [10, 104]],
            dtype=np.float32,
        )

        flattened, geometry = flatten_cover_quadrilateral(image, polygon)

        self.assertAlmostEqual(geometry.square_difference, 0.06)
        self.assertFalse(geometry.square_snapped)
        self.assertEqual(geometry.untrimmed_width, 100)
        self.assertEqual(geometry.untrimmed_height, 94)
        self.assertNotEqual(flattened.shape[0], flattened.shape[1])

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

    def test_mask_supports_white_letterbox_bars_around_a_black_background(self):
        image = np.full((300, 240, 3), 255, dtype=np.uint8)
        image[35:265, :] = 0
        box = np.array(
            [[62, 72], [164, 59], [191, 73], [188, 231], [76, 244], [57, 229]],
            dtype=np.int32,
        )
        cv2.fillPoly(image, [box], (55, 135, 205))

        mask, background, threshold = build_foreground_mask(image)

        self.assertLessEqual(threshold, 6.0)
        np.testing.assert_allclose(background, [255, 255, 255], atol=1)
        self.assertEqual(int(mask[10, 10]), 0)
        self.assertEqual(int(mask[150, 10]), 0)
        self.assertEqual(int(mask[150, 120]), 255)
        foreground_ratio = np.count_nonzero(mask) / mask.size
        self.assertGreater(foreground_ratio, 0.20)
        self.assertLess(foreground_ratio, 0.35)

        detection, _, _ = detect_silhouette(image)
        self.assertEqual(len(detection.lines), 6)

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

    def test_rejects_accidental_parallelism_between_very_different_edge_lengths(self):
        vertices = np.array(
            [
                [129.2695, 34.4528],
                [362.5094, 56.2963],
                [362.9697, 412.6043],
                [125.6831, 424.4649],
                [92.2247, 406.0437],
                [91.7836, 38.7720],
            ],
            dtype=np.float64,
        )

        perspective = classify_perspective(vertices)

        self.assertEqual(perspective.kind, "two_faces")
        self.assertEqual(perspective.matching_opposite_pairs, 1)
        self.assertTrue(perspective.pairs[2].similar_direction)
        self.assertFalse(perspective.pairs[2].similar_length)
        self.assertFalse(perspective.pairs[2].matching)
        self.assertLess(perspective.pairs[2].length_ratio, 0.17)
        self.assertEqual(perspective.minimum_length_ratio, 0.5)

    def test_classifies_strong_three_face_perspective_from_length_symmetry(self):
        vertices = np.array(
            [
                [1438.7418, 125.1114],
                [1807.4877, 199.6587],
                [1700.4412, 1499.9224],
                [556.3910, 1942.3416],
                [304.6030, 1674.6842],
                [187.3440, 272.5297],
            ],
            dtype=np.float64,
        )

        perspective = classify_perspective(vertices)

        self.assertEqual(perspective.kind, "three_faces")
        self.assertEqual(perspective.matching_opposite_pairs, 1)
        self.assertEqual(sum(pair.similar_direction for pair in perspective.pairs), 1)
        self.assertEqual(sum(pair.similar_length for pair in perspective.pairs), 3)
        self.assertEqual(len(identify_three_face_covers(vertices, perspective)), 2)

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

    def test_rejects_extremely_distorted_two_face_candidate(self):
        vertices = np.array(
            [
                [1438.7418, 125.1114],
                [1807.4877, 199.6587],
                [1700.4412, 1499.9224],
                [556.3910, 1942.3416],
                [304.6030, 1674.6842],
                [187.3440, 272.5297],
            ],
            dtype=np.float64,
        )
        perspective = replace(classify_perspective(vertices), kind="two_faces")

        self.assertIsNone(identify_two_face_cover(vertices, perspective))

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

    def test_three_face_cover_translates_c2_through_v2_and_b2_through_v4(self):
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

        covers = identify_three_face_covers(vertices, perspective)

        self.assertEqual(len(covers), 2)
        self.assertEqual(
            sorted({line_index for item in covers for line_index in item.source_line_indices}),
            [2, 3, 5, 6],
        )
        cover = covers[0]
        self.assertEqual(cover.construction, "C2@V2 + B2@V4")
        self.assertEqual(cover.source_intersection_vertex_index, 6)
        self.assertEqual(set(cover.source_line_indices), {5, 6})
        self.assertEqual(cover.first_parallel_source_line, "C2")
        self.assertEqual(cover.first_anchor_vertex_index, 2)
        self.assertEqual(cover.second_parallel_source_line, "B2")
        self.assertEqual(cover.second_anchor_vertex_index, 4)
        np.testing.assert_allclose(cover.first_translated_segment[0], vertices[1])
        np.testing.assert_allclose(cover.second_translated_segment[0], vertices[3])
        np.testing.assert_allclose(cover.missing_vertex, [128.0, 164.5], atol=0.6)
        np.testing.assert_allclose(cover.parallel_error_degrees, [0.0, 0.0], atol=1e-9)
        self.assertTrue(cover.inside_silhouette)
        self.assertTrue(cover.convex)

    def test_second_three_face_cover_translates_b1_through_v1_and_c1_through_v5(self):
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

        covers = identify_three_face_covers(vertices, perspective)

        self.assertEqual(len(covers), 2)
        cover = covers[1]
        self.assertEqual(cover.construction, "B1@V1 + C1@V5")
        self.assertEqual(cover.source_intersection_vertex_index, 3)
        self.assertEqual(set(cover.source_line_indices), {2, 3})
        self.assertEqual(cover.first_parallel_source_line, "B1")
        self.assertEqual(cover.first_anchor_vertex_index, 1)
        self.assertEqual(cover.second_parallel_source_line, "C1")
        self.assertEqual(cover.second_anchor_vertex_index, 5)
        np.testing.assert_allclose(cover.first_translated_segment[0], vertices[0])
        np.testing.assert_allclose(cover.second_translated_segment[0], vertices[4])
        np.testing.assert_allclose(cover.missing_vertex, [497.6, 504.1], atol=0.6)
        np.testing.assert_allclose(cover.parallel_error_degrees, [0.0, 0.0], atol=1e-9)
        self.assertTrue(cover.inside_silhouette)
        self.assertTrue(cover.convex)

    def test_three_face_constructions_are_derived_after_vertex_rotation(self):
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
        vertices = np.roll(vertices, 2, axis=0)
        perspective = classify_perspective(vertices)
        lengths = [
            float(np.linalg.norm(vertices[(index + 1) % 6] - vertices[index]))
            for index in range(6)
        ]
        expected_longest = sorted(
            index + 1 for index in sorted(range(6), key=lambda index: lengths[index], reverse=True)[:4]
        )

        covers = identify_three_face_covers(vertices, perspective)

        self.assertEqual(len(covers), 2)
        self.assertEqual(
            sorted({line_index for cover in covers for line_index in cover.source_line_indices}),
            expected_longest,
        )
        for cover in covers:
            np.testing.assert_allclose(cover.parallel_error_degrees, [0.0, 0.0], atol=1e-9)

    def test_two_face_outline_does_not_create_three_face_cover(self):
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

        self.assertEqual(identify_three_face_covers(vertices, perspective), [])

    def test_classifies_ideal_abcabc_hexagon_as_three_faces(self):
        edge_vectors = np.array(
            [[100, 10], [20, 100], [-80, 40], [-100, -10], [-20, -100], [80, -40]],
            dtype=np.float64,
        )
        vertices = np.vstack([np.array([[100.0, 100.0]]), 100.0 + np.cumsum(edge_vectors[:-1], axis=0)])

        perspective = classify_perspective(vertices)

        self.assertEqual(perspective.kind, "three_faces")
        self.assertEqual(perspective.matching_opposite_pairs, 3)
        self.assertTrue(all(pair.matching for pair in perspective.pairs))
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
            self.assertTrue(result.flattened_covers)
            self.assertTrue(Path(result.flattened_covers[0].output_path).exists())
            self.assertIsNotNone(result.flattened_cover_previews_path)
            self.assertTrue(Path(result.flattened_cover_previews_path).exists())


if __name__ == "__main__":
    unittest.main()
