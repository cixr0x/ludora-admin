from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
from pathlib import Path

import cv2
import numpy as np


@dataclass(frozen=True)
class SilhouetteLine:
    start: list[float]
    end: list[float]
    length: float
    angle_degrees: float
    axis_label: str
    pair_member: int
    fit_source: str
    support_length: float


@dataclass(frozen=True)
class OppositeLinePair:
    axis_label: str
    line_indices: list[int]
    angles_degrees: list[float]
    difference_degrees: float
    lengths: list[float]
    length_ratio: float
    similar_direction: bool
    similar_length: bool
    matching: bool
    vanishing_point: list[float] | None


@dataclass(frozen=True)
class PerspectiveClassification:
    kind: str
    confidence: float
    matching_opposite_pairs: int
    angle_tolerance_degrees: float
    minimum_length_ratio: float
    pairs: list[OppositeLinePair]


@dataclass(frozen=True)
class VanishingAspectEstimate:
    aspect_ratio: float
    confidence: float
    focal_spread: float


@dataclass(frozen=True)
class TwoFaceCoverDetection:
    parallel_axis_label: str
    parallel_line_indices: list[int]
    seam_vertex_indices: list[int]
    seam: list[list[float]]
    cover_vertex_indices: list[int]
    cover_polygon: list[list[float]]
    cover_area: float
    side_vertex_indices: list[int]
    side_polygon: list[list[float]]
    side_area: float
    cover_area_fraction: float
    vanishing_aspect_ratio: float | None
    vanishing_confidence: float
    vanishing_focal_spread: float | None


@dataclass(frozen=True)
class ThreeFaceCoverConstruction:
    construction: str
    source_intersection_vertex_index: int
    source_line_indices: list[int]
    first_parallel_source_line: str
    first_anchor_vertex_index: int
    first_source_segment: list[list[float]]
    first_translated_segment: list[list[float]]
    second_parallel_source_line: str
    second_anchor_vertex_index: int
    second_source_segment: list[list[float]]
    second_translated_segment: list[list[float]]
    parallel_error_degrees: list[float]
    missing_vertex: list[float]
    cover_polygon: list[list[float]]
    area: float
    inside_silhouette: bool
    convex: bool


@dataclass(frozen=True)
class SilhouetteDetection:
    vertices: list[list[float]]
    initial_vertices: list[list[float]]
    lines: list[SilhouetteLine]
    background_bgr: list[float]
    background_threshold: float
    foreground_area_ratio: float
    hull_area_ratio: float
    polygon_area_retention: float
    perspective: PerspectiveClassification
    two_face_cover: TwoFaceCoverDetection | None
    three_face_covers: list[ThreeFaceCoverConstruction]


@dataclass(frozen=True)
class FlattenedCoverGeometry:
    ordered_corners: list[list[float]]
    top_length: float
    bottom_length: float
    left_length: float
    right_length: float
    estimated_width: float
    estimated_height: float
    aspect_ratio_method: str
    vanishing_confidence: float
    vanishing_focal_spread: float | None
    untrimmed_width: int
    untrimmed_height: int
    square_threshold: float
    square_difference: float
    square_snapped: bool
    trim_fraction: float
    trim_x: int
    trim_y: int
    width: int
    height: int
    aspect_ratio: float
    width_disagreement: float
    height_disagreement: float


@dataclass(frozen=True)
class FlattenedCoverResult:
    candidate_type: str
    candidate_index: int
    construction: str
    output_path: str
    geometry: FlattenedCoverGeometry


@dataclass(frozen=True)
class SilhouetteResult:
    source_path: str
    overlay_path: str
    mask_path: str
    metadata_path: str
    three_face_covers_path: str | None
    flattened_cover_previews_path: str | None
    flattened_covers: list[FlattenedCoverResult]
    detection: SilhouetteDetection


MANUAL_CANDIDATE_INDEX = 3
MANUAL_CANDIDATE_CONSTRUCTION = "manual corner selection"
MANUAL_COVER_TRIM_FRACTION = 0.01


def _border_pixels(image: np.ndarray) -> np.ndarray:
    height, width = image.shape[:2]
    border_width = max(2, int(round(min(height, width) * 0.02)))
    return np.concatenate(
        [
            image[:border_width, :, :].reshape(-1, 3),
            image[-border_width:, :, :].reshape(-1, 3),
            image[:, :border_width, :].reshape(-1, 3),
            image[:, -border_width:, :].reshape(-1, 3),
        ],
        axis=0,
    ).astype(np.float32)


def estimate_background(image: np.ndarray) -> tuple[np.ndarray, float]:
    """Estimate the dominant border background color and a conservative cutoff."""

    backgrounds, threshold = estimate_background_colors(image)
    return backgrounds[0], threshold


def estimate_background_colors(
    image: np.ndarray,
    *,
    maximum_colors: int = 3,
    minimum_cluster_fraction: float = 0.05,
) -> tuple[np.ndarray, float]:
    """Estimate dominant border colors for uniform or letterboxed backgrounds."""

    if maximum_colors <= 0:
        raise ValueError("maximum background colors must be positive")
    if not 0.0 < minimum_cluster_fraction <= 1.0:
        raise ValueError("minimum background cluster fraction must be between zero and one")

    border = _border_pixels(image)
    centers = [np.median(border, axis=0)]
    labels = np.zeros(len(border), dtype=np.int32)
    for _ in range(1, maximum_colors):
        distances_to_centers = np.stack(
            [np.linalg.norm(border - center, axis=1) for center in centers],
            axis=1,
        )
        nearest_distances = distances_to_centers.min(axis=1)
        if float(nearest_distances.max()) < 6.0:
            break
        centers.append(border[int(np.argmax(nearest_distances))].copy())

        for _ in range(12):
            distances_to_centers = np.stack(
                [np.linalg.norm(border - center, axis=1) for center in centers],
                axis=1,
            )
            new_labels = np.argmin(distances_to_centers, axis=1).astype(np.int32)
            updated_centers = []
            for index, center in enumerate(centers):
                members = border[new_labels == index]
                updated_centers.append(np.median(members, axis=0) if len(members) else center)
            if np.array_equal(new_labels, labels) and np.allclose(updated_centers, centers):
                labels = new_labels
                centers = updated_centers
                break
            labels = new_labels
            centers = updated_centers

    distances_to_centers = np.stack(
        [np.linalg.norm(border - center, axis=1) for center in centers],
        axis=1,
    )
    labels = np.argmin(distances_to_centers, axis=1)
    minimum_cluster_size = max(1, int(round(len(border) * minimum_cluster_fraction)))
    clusters = [
        (int(np.count_nonzero(labels == index)), np.asarray(center, dtype=np.float32))
        for index, center in enumerate(centers)
        if int(np.count_nonzero(labels == index)) >= minimum_cluster_size
    ]
    if not clusters:
        counts = [int(np.count_nonzero(labels == index)) for index in range(len(centers))]
        largest_index = int(np.argmax(counts))
        clusters = [(counts[largest_index], np.asarray(centers[largest_index], dtype=np.float32))]
    clusters.sort(key=lambda cluster: cluster[0], reverse=True)
    backgrounds = np.stack([center for _, center in clusters]).astype(np.float32)
    distances = np.min(
        np.stack([np.linalg.norm(border - background, axis=1) for background in backgrounds], axis=1),
        axis=1,
    )
    median_distance = float(np.median(distances))
    mad = float(np.median(np.abs(distances - median_distance)))
    threshold = max(6.0, median_distance + 6.0 * 1.4826 * mad)
    return backgrounds, threshold


def build_foreground_mask(
    image: np.ndarray,
    *,
    background_threshold: float | None = None,
) -> tuple[np.ndarray, np.ndarray, float]:
    backgrounds, automatic_threshold = estimate_background_colors(image)
    background = backgrounds[0]
    threshold = automatic_threshold if background_threshold is None else float(background_threshold)
    if threshold <= 0:
        raise ValueError("background threshold must be positive")

    image_float = image.astype(np.float32)
    distances = np.full(image.shape[:2], np.inf, dtype=np.float32)
    for candidate_background in backgrounds:
        distances = np.minimum(
            distances,
            np.linalg.norm(image_float - candidate_background, axis=2),
        )
    mask = np.where(distances > threshold, 255, 0).astype(np.uint8)

    kernel_size = max(3, int(round(min(image.shape[:2]) * 0.006)))
    if kernel_size % 2 == 0:
        kernel_size += 1
    kernel = np.ones((kernel_size, kernel_size), dtype=np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if component_count <= 1:
        raise ValueError("could not find a foreground object against the image border")

    component_index = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    largest_mask = np.where(labels == component_index, 255, 0).astype(np.uint8)
    return largest_mask, background, threshold


def _reduce_convex_polygon(points: np.ndarray, target_vertices: int) -> np.ndarray:
    """Remove the least significant convex-hull corners until the target is met."""

    reduced = np.asarray(points, dtype=np.float32).reshape(-1, 2)
    while len(reduced) > target_vertices:
        triangle_areas = []
        for index in range(len(reduced)):
            previous_point = reduced[(index - 1) % len(reduced)]
            point = reduced[index]
            next_point = reduced[(index + 1) % len(reduced)]
            incoming = point - previous_point
            outgoing = next_point - point
            triangle_areas.append(abs(float(incoming[0] * outgoing[1] - incoming[1] * outgoing[0])))
        reduced = np.delete(reduced, int(np.argmin(triangle_areas)), axis=0)
    return reduced


def approximate_hull(hull: np.ndarray, target_vertices: int = 6) -> np.ndarray:
    if target_vertices < 3:
        raise ValueError("target vertices must be at least three")

    perimeter = cv2.arcLength(hull, True)
    for epsilon_ratio in np.linspace(0.0005, 0.12, 480):
        approximation = cv2.approxPolyDP(hull, float(epsilon_ratio * perimeter), True).reshape(-1, 2)
        if len(approximation) == target_vertices:
            return approximation.astype(np.float32)
        if len(approximation) < target_vertices:
            break

    hull_points = hull.reshape(-1, 2).astype(np.float32)
    if len(hull_points) <= target_vertices:
        return hull_points
    return _reduce_convex_polygon(hull_points, target_vertices)


def normalize_vertices(points: np.ndarray) -> np.ndarray:
    vertices = np.rint(np.asarray(points, dtype=np.float32).reshape(-1, 2)).astype(np.int32)
    if cv2.contourArea(vertices, oriented=True) < 0:
        vertices = vertices[::-1]
    start_index = min(range(len(vertices)), key=lambda index: (int(vertices[index][1]), int(vertices[index][0])))
    return np.roll(vertices, -start_index, axis=0)


@dataclass(frozen=True)
class _BoundaryLineFit:
    coefficients: np.ndarray
    source: str
    support_length: float


def _fit_line(points: np.ndarray) -> np.ndarray:
    fit_points = np.asarray(points, dtype=np.float32).reshape(-1, 2)
    if len(fit_points) < 2:
        raise ValueError("at least two points are required to fit a line")
    vx, vy, x0, y0 = [
        float(value)
        for value in cv2.fitLine(fit_points, cv2.DIST_WELSCH, 0, 0.01, 0.01).reshape(4)
    ]
    coefficients = np.array([-vy, vx, vy * x0 - vx * y0], dtype=np.float64)
    normal_length = float(np.hypot(coefficients[0], coefficients[1]))
    return coefficients / normal_length


def _line_angle_degrees(coefficients: np.ndarray) -> float:
    angle = float(np.degrees(np.arctan2(-coefficients[0], coefficients[1])))
    return (angle + 90.0) % 180.0 - 90.0


def _angle_difference(first: float, second: float) -> float:
    return abs((first - second + 90.0) % 180.0 - 90.0)


def _point_line_distance(point: np.ndarray, coefficients: np.ndarray) -> float:
    return abs(float(coefficients[0] * point[0] + coefficients[1] * point[1] + coefficients[2]))


def _intersect_lines(first: np.ndarray, second: np.ndarray) -> np.ndarray | None:
    homogeneous_point = np.cross(first, second)
    if abs(float(homogeneous_point[2])) < 1e-8:
        return None
    return homogeneous_point[:2] / homogeneous_point[2]


def _segment_contrast(image: np.ndarray, endpoints: np.ndarray) -> float:
    direction = endpoints[1] - endpoints[0]
    length = float(np.linalg.norm(direction))
    direction /= length
    normal = np.array([-direction[1], direction[0]], dtype=np.float64)
    sample_count = max(8, min(64, int(length / 4.0)))
    positions = np.linspace(0.1, 0.9, sample_count)[:, None]
    samples = endpoints[0] + positions * (endpoints[1] - endpoints[0])
    first_side = np.rint(samples + normal * 3.0).astype(np.int32)
    second_side = np.rint(samples - normal * 3.0).astype(np.int32)
    for points in (first_side, second_side):
        points[:, 0] = np.clip(points[:, 0], 0, image.shape[1] - 1)
        points[:, 1] = np.clip(points[:, 1], 0, image.shape[0] - 1)
    first_colors = image[first_side[:, 1], first_side[:, 0]].astype(np.float32)
    second_colors = image[second_side[:, 1], second_side[:, 0]].astype(np.float32)
    return float(np.median(np.linalg.norm(first_colors - second_colors, axis=1)))


def _detect_image_segments(image: np.ndarray) -> list[tuple[float, float, np.ndarray, np.ndarray]]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    detector = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD)
    detected = detector.detect(gray)[0]
    if detected is None:
        return []

    segments: list[tuple[float, float, np.ndarray, np.ndarray]] = []
    for raw_segment in detected[:, 0, :]:
        endpoints = raw_segment.astype(np.float64).reshape(2, 2)
        length = float(np.linalg.norm(endpoints[1] - endpoints[0]))
        if length < 18.0:
            continue
        segments.append((length, _segment_contrast(image, endpoints), _fit_line(endpoints), endpoints))
    return segments


def _hull_line_fit(
    hull_points: np.ndarray,
    start: np.ndarray,
    end: np.ndarray,
    base_line: np.ndarray,
    band: float,
) -> _BoundaryLineFit:
    side = end - start
    side_length = float(np.linalg.norm(side))
    direction = side / side_length
    extension = side_length * 0.25
    support = [
        point
        for point in hull_points
        if -extension <= float(np.dot(point - start, direction)) <= side_length + extension
        and _point_line_distance(point, base_line) <= band
    ]
    if len(support) < 2:
        support = [start, end]
    support_array = np.asarray(support, dtype=np.float64)
    projections = support_array @ direction
    support_length = float(projections.max() - projections.min())
    return _BoundaryLineFit(
        coefficients=_fit_line(support_array),
        source="mask_hull",
        support_length=support_length,
    )


def _image_edge_line_fit(
    segments: list[tuple[float, float, np.ndarray, np.ndarray]],
    start: np.ndarray,
    end: np.ndarray,
    base_line: np.ndarray,
    band: float,
) -> _BoundaryLineFit | None:
    side = end - start
    side_length = float(np.linalg.norm(side))
    direction = side / side_length
    extension = side_length * 0.25
    base_angle = _line_angle_degrees(base_line)
    candidates: list[tuple[float, float, np.ndarray]] = []

    for length, contrast, coefficients, endpoints in segments:
        midpoint = endpoints.mean(axis=0)
        projection = float(np.dot(midpoint - start, direction))
        distance = _point_line_distance(midpoint, base_line)
        angle_difference = _angle_difference(_line_angle_degrees(coefficients), base_angle)
        if (
            angle_difference <= 12.0
            and distance <= band
            and -extension <= projection <= side_length + extension
            and length >= max(18.0, side_length * 0.08)
        ):
            score = length + 1.25 * contrast - 2.0 * distance - 1.5 * angle_difference
            candidates.append((score, length, coefficients))

    if not candidates:
        return None
    _, support_length, coefficients = max(candidates, key=lambda item: item[0])
    if support_length < max(25.0, side_length * 0.18):
        return None
    return _BoundaryLineFit(
        coefficients=coefficients,
        source="image_edge",
        support_length=support_length,
    )


def fit_boundary_lines(
    image: np.ndarray,
    hull: np.ndarray,
    initial_vertices: np.ndarray,
) -> tuple[np.ndarray, list[_BoundaryLineFit]]:
    vertices = np.asarray(initial_vertices, dtype=np.float64).reshape(-1, 2)
    hull_points = hull.reshape(-1, 2).astype(np.float64)
    image_segments = _detect_image_segments(image)
    hull_band = max(8.0, min(image.shape[:2]) * 0.025)
    image_edge_band = max(12.0, min(image.shape[:2]) * 0.035)
    fitted_lines: list[_BoundaryLineFit] = []

    for index, start in enumerate(vertices):
        end = vertices[(index + 1) % len(vertices)]
        base_line = _fit_line(np.array([start, end]))
        hull_fit = _hull_line_fit(hull_points, start, end, base_line, hull_band)
        image_fit = _image_edge_line_fit(image_segments, start, end, base_line, image_edge_band)
        fitted_lines.append(image_fit or hull_fit)

    intersections: list[np.ndarray] = []
    maximum_shift = max(30.0, min(image.shape[:2]) * 0.15)
    for index, initial_vertex in enumerate(vertices):
        intersection = _intersect_lines(
            fitted_lines[(index - 1) % len(fitted_lines)].coefficients,
            fitted_lines[index].coefficients,
        )
        if (
            intersection is None
            or not np.all(np.isfinite(intersection))
            or float(np.linalg.norm(intersection - initial_vertex)) > maximum_shift
        ):
            intersection = initial_vertex
        intersections.append(intersection)

    refined = np.asarray(intersections, dtype=np.float64)
    initial_area = abs(float(cv2.contourArea(vertices.astype(np.float32))))
    refined_area = abs(float(cv2.contourArea(refined.astype(np.float32))))
    if initial_area and not 0.65 <= refined_area / initial_area <= 1.35:
        return vertices, fitted_lines
    return refined, fitted_lines


def classify_perspective(
    vertices: np.ndarray,
    *,
    angle_tolerance_degrees: float = 12.0,
    minimum_length_ratio: float = 0.5,
) -> PerspectiveClassification:
    points = np.asarray(vertices, dtype=np.float64).reshape(-1, 2)
    if len(points) != 6:
        return PerspectiveClassification(
            kind="ambiguous",
            confidence=0.0,
            matching_opposite_pairs=0,
            angle_tolerance_degrees=float(angle_tolerance_degrees),
            minimum_length_ratio=float(minimum_length_ratio),
            pairs=[],
        )
    if angle_tolerance_degrees <= 0:
        raise ValueError("perspective angle tolerance must be positive")
    if not 0.0 < minimum_length_ratio <= 1.0:
        raise ValueError("perspective minimum length ratio must be between zero and one")

    edge_lines = [
        _fit_line(np.array([points[index], points[(index + 1) % len(points)]]))
        for index in range(len(points))
    ]
    angles = [_line_angle_degrees(line) for line in edge_lines]
    lengths = [
        float(np.linalg.norm(points[(index + 1) % len(points)] - points[index]))
        for index in range(len(points))
    ]
    pairs: list[OppositeLinePair] = []
    for index, axis_label in enumerate("ABC"):
        opposite_index = index + 3
        difference = _angle_difference(angles[index], angles[opposite_index])
        intersection = _intersect_lines(edge_lines[index], edge_lines[opposite_index])
        if difference < 0.25 or intersection is None or not np.all(np.isfinite(intersection)):
            vanishing_point = None
        else:
            vanishing_point = [float(intersection[0]), float(intersection[1])]
        first_length = lengths[index]
        second_length = lengths[opposite_index]
        length_ratio = min(first_length, second_length) / max(first_length, second_length)
        similar_direction = difference <= angle_tolerance_degrees
        similar_length = length_ratio >= minimum_length_ratio
        pairs.append(
            OppositeLinePair(
                axis_label=axis_label,
                line_indices=[index + 1, opposite_index + 1],
                angles_degrees=[float(angles[index]), float(angles[opposite_index])],
                difference_degrees=float(difference),
                lengths=[float(first_length), float(second_length)],
                length_ratio=float(length_ratio),
                similar_direction=similar_direction,
                similar_length=similar_length,
                matching=similar_direction and similar_length,
                vanishing_point=vanishing_point,
            )
        )

    matching_pairs = sum(pair.matching for pair in pairs)
    similar_direction_pairs = sum(pair.similar_direction for pair in pairs)
    similar_length_pairs = sum(pair.similar_length for pair in pairs)
    strong_perspective_three_faces = (
        matching_pairs >= 1
        and similar_direction_pairs >= 1
        and similar_length_pairs >= 2
    )
    matching_differences = [pair.difference_degrees for pair in pairs if pair.matching]
    mismatching_differences = [pair.difference_degrees for pair in pairs if not pair.matching]
    if matching_pairs >= 2:
        kind = "three_faces"
        matching_strength = float(
            np.mean([1.0 - difference / angle_tolerance_degrees for difference in matching_differences])
        )
        if matching_pairs == 3:
            confidence = 0.80 + 0.20 * matching_strength
        else:
            mismatch_strength = min(
                1.0,
                max(0.0, mismatching_differences[0] - angle_tolerance_degrees)
                / angle_tolerance_degrees,
            )
            confidence = 0.55 + 0.20 * matching_strength + 0.15 * mismatch_strength
    elif strong_perspective_three_faces:
        kind = "three_faces"
        direction_strength = float(
            np.mean(
                [
                    1.0 - pair.difference_degrees / angle_tolerance_degrees
                    for pair in pairs
                    if pair.similar_direction
                ]
            )
        )
        length_strength = float(
            np.mean([pair.length_ratio for pair in pairs if pair.similar_length])
        )
        confidence = 0.50 + 0.20 * direction_strength + 0.25 * length_strength
    elif matching_pairs == 1:
        kind = "two_faces"
        matching_strength = 1.0 - matching_differences[0] / angle_tolerance_degrees
        mismatch_strength = float(
            np.mean(
                [
                    min(1.0, max(0.0, difference - angle_tolerance_degrees) / angle_tolerance_degrees)
                    for difference in mismatching_differences
                ]
            )
        )
        confidence = 0.55 + 0.25 * matching_strength + 0.20 * mismatch_strength
    else:
        kind = "ambiguous"
        confidence = 0.25

    return PerspectiveClassification(
        kind=kind,
        confidence=float(min(1.0, max(0.0, confidence))),
        matching_opposite_pairs=matching_pairs,
        angle_tolerance_degrees=float(angle_tolerance_degrees),
        minimum_length_ratio=float(minimum_length_ratio),
        pairs=pairs,
    )


def identify_two_face_cover(
    vertices: np.ndarray,
    perspective: PerspectiveClassification,
    *,
    image_shape: tuple[int, int] | None = None,
    maximum_edge_disagreement: float = 0.9,
) -> TwoFaceCoverDetection | None:
    if maximum_edge_disagreement <= 0:
        raise ValueError("maximum edge disagreement must be positive")

    points = np.asarray(vertices, dtype=np.float64).reshape(-1, 2)
    matching_pairs = [pair for pair in perspective.pairs if pair.matching]
    if perspective.kind != "two_faces" or len(points) != 6 or len(matching_pairs) != 1:
        return None

    parallel_pair = matching_pairs[0]
    touched_vertices: set[int] = set()
    for one_based_line_index in parallel_pair.line_indices:
        line_index = one_based_line_index - 1
        touched_vertices.add(line_index)
        touched_vertices.add((line_index + 1) % len(points))
    seam_vertex_indices = sorted(set(range(len(points))) - touched_vertices)
    if len(seam_vertex_indices) != 2:
        return None

    first_vertex, second_vertex = seam_vertex_indices

    def clockwise_path(start: int, end: int) -> list[int]:
        path = [start]
        while path[-1] != end and len(path) <= len(points):
            path.append((path[-1] + 1) % len(points))
        return path

    first_face_indices = clockwise_path(first_vertex, second_vertex)
    return_path = clockwise_path(second_vertex, first_vertex)
    second_face_indices = [first_vertex, *return_path[:-1]]
    if len(first_face_indices) != 4 or len(second_face_indices) != 4:
        return None

    first_polygon = points[first_face_indices]
    second_polygon = points[second_face_indices]
    first_area = abs(float(cv2.contourArea(first_polygon.astype(np.float32))))
    second_area = abs(float(cv2.contourArea(second_polygon.astype(np.float32))))
    if first_area >= second_area:
        cover_indices, cover_polygon, cover_area = first_face_indices, first_polygon, first_area
        side_indices, side_polygon, side_area = second_face_indices, second_polygon, second_area
    else:
        cover_indices, cover_polygon, cover_area = second_face_indices, second_polygon, second_area
        side_indices, side_polygon, side_area = first_face_indices, first_polygon, first_area

    top_left, top_right, bottom_right, bottom_left = order_quadrilateral(cover_polygon)
    top_length = float(np.linalg.norm(top_right - top_left))
    bottom_length = float(np.linalg.norm(bottom_right - bottom_left))
    left_length = float(np.linalg.norm(bottom_left - top_left))
    right_length = float(np.linalg.norm(bottom_right - top_right))
    estimated_width = (top_length + bottom_length) / 2.0
    estimated_height = (left_length + right_length) / 2.0
    width_disagreement = abs(top_length - bottom_length) / estimated_width
    height_disagreement = abs(left_length - right_length) / estimated_height
    if max(width_disagreement, height_disagreement) > maximum_edge_disagreement:
        return None

    total_area = cover_area + side_area
    vanishing_estimate = (
        estimate_two_face_vanishing_aspect_ratio(
            cover_polygon,
            side_polygon,
            image_shape,
        )
        if image_shape is not None
        else None
    )

    return TwoFaceCoverDetection(
        parallel_axis_label=parallel_pair.axis_label,
        parallel_line_indices=parallel_pair.line_indices,
        seam_vertex_indices=[index + 1 for index in seam_vertex_indices],
        seam=[[float(value) for value in points[index].tolist()] for index in seam_vertex_indices],
        cover_vertex_indices=[index + 1 for index in cover_indices],
        cover_polygon=[[float(value) for value in point.tolist()] for point in cover_polygon],
        cover_area=cover_area,
        side_vertex_indices=[index + 1 for index in side_indices],
        side_polygon=[[float(value) for value in point.tolist()] for point in side_polygon],
        side_area=side_area,
        cover_area_fraction=cover_area / total_area if total_area else 0.0,
        vanishing_aspect_ratio=(
            vanishing_estimate.aspect_ratio if vanishing_estimate is not None else None
        ),
        vanishing_confidence=(
            vanishing_estimate.confidence if vanishing_estimate is not None else 0.0
        ),
        vanishing_focal_spread=(
            vanishing_estimate.focal_spread if vanishing_estimate is not None else None
        ),
    )


def _parallel_line_through_point(coefficients: np.ndarray, point: np.ndarray) -> np.ndarray:
    a, b, _ = coefficients
    return np.array([a, b, -(a * point[0] + b * point[1])], dtype=np.float64)


def _construct_three_face_cover(
    points: np.ndarray,
    *,
    construction: str,
    source_intersection_vertex_index: int,
    first_source_label: str,
    first_source_line_index: int,
    first_anchor_vertex_index: int,
    second_source_label: str,
    second_source_line_index: int,
    second_anchor_vertex_index: int,
    polygon_vertex_indices: list[int | None],
) -> ThreeFaceCoverConstruction | None:
    first_source_segment = np.array(
        [points[first_source_line_index], points[(first_source_line_index + 1) % len(points)]],
        dtype=np.float64,
    )
    second_source_segment = np.array(
        [points[second_source_line_index], points[(second_source_line_index + 1) % len(points)]],
        dtype=np.float64,
    )
    first_source_line = _fit_line(first_source_segment)
    second_source_line = _fit_line(second_source_segment)
    first_translated_line = _parallel_line_through_point(
        first_source_line,
        points[first_anchor_vertex_index],
    )
    second_translated_line = _parallel_line_through_point(
        second_source_line,
        points[second_anchor_vertex_index],
    )
    missing_vertex = _intersect_lines(first_translated_line, second_translated_line)
    if missing_vertex is None or not np.all(np.isfinite(missing_vertex)):
        return None

    polygon = np.array(
        [missing_vertex if index is None else points[index] for index in polygon_vertex_indices],
        dtype=np.float64,
    )
    first_translated_segment = np.array(
        [points[first_anchor_vertex_index], missing_vertex],
        dtype=np.float64,
    )
    second_translated_segment = np.array(
        [points[second_anchor_vertex_index], missing_vertex],
        dtype=np.float64,
    )
    return ThreeFaceCoverConstruction(
        construction=construction,
        source_intersection_vertex_index=source_intersection_vertex_index + 1,
        source_line_indices=[first_source_line_index + 1, second_source_line_index + 1],
        first_parallel_source_line=first_source_label,
        first_anchor_vertex_index=first_anchor_vertex_index + 1,
        first_source_segment=[[float(value) for value in point] for point in first_source_segment],
        first_translated_segment=[[float(value) for value in point] for point in first_translated_segment],
        second_parallel_source_line=second_source_label,
        second_anchor_vertex_index=second_anchor_vertex_index + 1,
        second_source_segment=[[float(value) for value in point] for point in second_source_segment],
        second_translated_segment=[[float(value) for value in point] for point in second_translated_segment],
        parallel_error_degrees=[
            _angle_difference(
                _line_angle_degrees(first_source_line),
                _line_angle_degrees(first_translated_line),
            ),
            _angle_difference(
                _line_angle_degrees(second_source_line),
                _line_angle_degrees(second_translated_line),
            ),
        ],
        missing_vertex=[float(value) for value in missing_vertex.tolist()],
        cover_polygon=[[float(value) for value in point] for point in polygon],
        area=abs(float(cv2.contourArea(polygon.astype(np.float32)))),
        inside_silhouette=cv2.pointPolygonTest(
            points.astype(np.float32),
            (float(missing_vertex[0]), float(missing_vertex[1])),
            False,
        ) >= 0,
        convex=bool(cv2.isContourConvex(polygon.astype(np.float32))),
    )


def identify_three_face_covers(
    vertices: np.ndarray,
    perspective: PerspectiveClassification,
) -> list[ThreeFaceCoverConstruction]:
    points = np.asarray(vertices, dtype=np.float64).reshape(-1, 2)
    if perspective.kind != "three_faces" or len(points) != 6:
        return []

    edge_lines = [
        _fit_line(np.array([points[index], points[(index + 1) % len(points)]]))
        for index in range(len(points))
    ]
    edge_lengths = [
        float(np.linalg.norm(points[(index + 1) % len(points)] - points[index]))
        for index in range(len(points))
    ]
    longest_lines = set(
        sorted(range(len(points)), key=lambda index: edge_lengths[index], reverse=True)[:4]
    )
    source_intersections = [
        vertex_index
        for vertex_index in range(len(points))
        if (vertex_index - 1) % len(points) in longest_lines and vertex_index in longest_lines
    ]
    if len(source_intersections) != 2:
        return []
    source_intersections.sort(
        key=lambda vertex_index: (
            edge_lengths[(vertex_index - 1) % len(points)] + edge_lengths[vertex_index]
        ),
        reverse=True,
    )

    def line_label(line_index: int) -> str:
        return f"{'ABC'[line_index % 3]}{1 + line_index // 3}"

    def closest_non_touching_vertex(line_index: int) -> int:
        touching_vertices = {line_index, (line_index + 1) % len(points)}
        return min(
            (vertex_index for vertex_index in range(len(points)) if vertex_index not in touching_vertices),
            key=lambda vertex_index: _point_line_distance(points[vertex_index], edge_lines[line_index]),
        )

    constructions: list[ThreeFaceCoverConstruction | None] = []
    for source_intersection in source_intersections:
        source_line_indices = [(source_intersection - 1) % len(points), source_intersection]
        sources_with_anchors = [
            (line_index, closest_non_touching_vertex(line_index))
            for line_index in source_line_indices
        ]
        sources_with_anchors.sort(key=lambda item: item[1])
        (first_line, first_anchor), (second_line, second_anchor) = sources_with_anchors
        opposite_vertex = (source_intersection + 3) % len(points)
        constructions.append(
            _construct_three_face_cover(
                points,
                construction=(
                    f"{line_label(first_line)}@V{first_anchor + 1} + "
                    f"{line_label(second_line)}@V{second_anchor + 1}"
                ),
                source_intersection_vertex_index=source_intersection,
                first_source_label=line_label(first_line),
                first_source_line_index=first_line,
                first_anchor_vertex_index=first_anchor,
                second_source_label=line_label(second_line),
                second_source_line_index=second_line,
                second_anchor_vertex_index=second_anchor,
                polygon_vertex_indices=[first_anchor, opposite_vertex, second_anchor, None],
            )
        )
    return [construction for construction in constructions if construction is not None]


def lines_from_vertices(
    vertices: np.ndarray,
    fitted_lines: list[_BoundaryLineFit],
) -> list[SilhouetteLine]:
    lines: list[SilhouetteLine] = []
    for index, start in enumerate(vertices):
        end = vertices[(index + 1) % len(vertices)]
        delta = end.astype(np.float64) - start.astype(np.float64)
        fit = fitted_lines[index]
        lines.append(
            SilhouetteLine(
                start=[float(start[0]), float(start[1])],
                end=[float(end[0]), float(end[1])],
                length=float(np.linalg.norm(delta)),
                angle_degrees=float(np.degrees(np.arctan2(delta[1], delta[0]))),
                axis_label="ABC"[index % 3],
                pair_member=1 + index // 3,
                fit_source=fit.source,
                support_length=fit.support_length,
            )
        )
    return lines


def order_quadrilateral(points: np.ndarray) -> np.ndarray:
    vertices = np.asarray(points, dtype=np.float32).reshape(-1, 2)
    if vertices.shape != (4, 2):
        raise ValueError("expected exactly four cover corners")

    ordered = np.zeros((4, 2), dtype=np.float32)
    sums = vertices.sum(axis=1)
    differences = np.diff(vertices, axis=1).reshape(4)
    indices = [
        int(np.argmin(sums)),
        int(np.argmin(differences)),
        int(np.argmax(sums)),
        int(np.argmax(differences)),
    ]
    if len(set(indices)) == 4:
        ordered[:] = vertices[indices]
        return ordered

    center = vertices.mean(axis=0)
    angles = np.arctan2(vertices[:, 1] - center[1], vertices[:, 0] - center[0])
    cyclic = vertices[np.argsort(angles)]
    start = int(np.argmin(cyclic.sum(axis=1)))
    cyclic = np.roll(cyclic, -start, axis=0)
    if cyclic[1][0] < cyclic[-1][0]:
        cyclic = np.concatenate([cyclic[:1], cyclic[:0:-1]], axis=0)
    return cyclic.astype(np.float32)


def estimate_two_face_vanishing_aspect_ratio(
    cover_polygon: np.ndarray,
    side_polygon: np.ndarray,
    image_shape: tuple[int, int],
    *,
    maximum_focal_spread: float = 2.0,
    maximum_nullspace_residual: float = 0.05,
) -> VanishingAspectEstimate | None:
    """Recover a cover ratio only when three cuboid vanishing axes agree."""

    if maximum_focal_spread <= 1.0:
        raise ValueError("maximum focal spread must be greater than one")
    if maximum_nullspace_residual <= 0.0:
        raise ValueError("maximum nullspace residual must be positive")
    height, width = image_shape
    if height <= 1 or width <= 1:
        raise ValueError("image dimensions must be greater than one pixel")

    cover = order_quadrilateral(cover_polygon).astype(np.float64)
    side = order_quadrilateral(side_polygon).astype(np.float64)

    def homogeneous_line(first: np.ndarray, second: np.ndarray) -> np.ndarray:
        return np.cross(np.append(first, 1.0), np.append(second, 1.0))

    def finite_vanishing_point(
        first_start: np.ndarray,
        first_end: np.ndarray,
        second_start: np.ndarray,
        second_end: np.ndarray,
    ) -> np.ndarray | None:
        point = np.cross(
            homogeneous_line(first_start, first_end),
            homogeneous_line(second_start, second_end),
        )
        if not np.all(np.isfinite(point)):
            return None
        if abs(float(point[2])) <= 1e-10 * max(1.0, float(np.linalg.norm(point[:2]))):
            return None
        normalized = point / point[2]
        return normalized if np.all(np.isfinite(normalized)) else None

    horizontal_vanishing = finite_vanishing_point(cover[0], cover[1], cover[3], cover[2])
    vertical_vanishing = finite_vanishing_point(cover[0], cover[3], cover[1], cover[2])
    depth_vanishing = finite_vanishing_point(side[0], side[1], side[3], side[2])
    if horizontal_vanishing is None or vertical_vanishing is None or depth_vanishing is None:
        return None

    principal_point = np.array([(width - 1.0) / 2.0, (height - 1.0) / 2.0])
    vanishing_points = [horizontal_vanishing, vertical_vanishing, depth_vanishing]
    focal_squared: list[float] = []
    for first_index, second_index in ((0, 1), (0, 2), (1, 2)):
        first = vanishing_points[first_index][:2] - principal_point
        second = vanishing_points[second_index][:2] - principal_point
        estimate = -float(np.dot(first, second))
        if not np.isfinite(estimate) or estimate <= 0.0:
            return None
        focal_squared.append(estimate)

    focal_spread = max(focal_squared) / min(focal_squared)
    if focal_spread > maximum_focal_spread:
        return None
    focal_length = float(np.sqrt(np.median(focal_squared)))
    image_diagonal = float(np.hypot(width, height))
    if not 0.20 * image_diagonal <= focal_length <= 50.0 * image_diagonal:
        return None

    intrinsic = np.array(
        [
            [focal_length, 0.0, principal_point[0]],
            [0.0, focal_length, principal_point[1]],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    inverse_intrinsic = np.linalg.inv(intrinsic)

    def camera_direction(vanishing_point: np.ndarray) -> np.ndarray:
        direction = inverse_intrinsic @ vanishing_point
        return direction / np.linalg.norm(direction)

    horizontal_direction = camera_direction(horizontal_vanishing)
    vertical_direction = camera_direction(vertical_vanishing)
    depth_direction = camera_direction(depth_vanishing)
    maximum_orthogonality_error = max(
        abs(float(np.dot(horizontal_direction, vertical_direction))),
        abs(float(np.dot(horizontal_direction, depth_direction))),
        abs(float(np.dot(vertical_direction, depth_direction))),
    )
    if maximum_orthogonality_error > 0.20:
        return None

    rays = [inverse_intrinsic @ np.append(point, 1.0) for point in cover]
    system = np.zeros((6, 5), dtype=np.float64)
    system[:3, 0] = -rays[0]
    system[:3, 1] = rays[1]
    system[:3, 3] = -horizontal_direction
    system[3:, 0] = -rays[0]
    system[3:, 2] = rays[3]
    system[3:, 4] = -vertical_direction
    _, singular_values, right_vectors = np.linalg.svd(system)
    if len(singular_values) < 2 or singular_values[-2] <= 0.0:
        return None
    nullspace_residual = float(singular_values[-1] / singular_values[-2])
    if nullspace_residual > maximum_nullspace_residual:
        return None
    solution = right_vectors[-1]
    physical_width = abs(float(solution[3]))
    physical_height = abs(float(solution[4]))
    if physical_width <= 1e-9 or physical_height <= 1e-9:
        return None
    aspect_ratio = physical_width / physical_height
    if not 0.20 <= aspect_ratio <= 5.0:
        return None

    spread_score = 1.0 - min(1.0, np.log(focal_spread) / np.log(maximum_focal_spread))
    residual_score = 1.0 - min(1.0, nullspace_residual / maximum_nullspace_residual)
    orthogonality_score = 1.0 - min(1.0, maximum_orthogonality_error / 0.20)
    confidence = float(
        0.45 * spread_score + 0.30 * residual_score + 0.25 * orthogonality_score
    )
    return VanishingAspectEstimate(
        aspect_ratio=float(aspect_ratio),
        confidence=confidence,
        focal_spread=float(focal_spread),
    )


def flatten_cover_quadrilateral(
    image: np.ndarray,
    polygon: np.ndarray,
    *,
    max_dimension: int = 1600,
    square_threshold: float = 0.05,
    square_edge_disagreement_threshold: float = 0.10,
    target_aspect_ratio: float | None = None,
    vanishing_confidence: float = 0.0,
    vanishing_focal_spread: float | None = None,
    trim_fraction: float = 0.025,
) -> tuple[np.ndarray, FlattenedCoverGeometry]:
    if max_dimension <= 0:
        raise ValueError("maximum flattened cover dimension must be positive")
    if not 0.0 <= square_threshold < 1.0:
        raise ValueError("square threshold must be between zero and one")
    if not 0.0 <= square_edge_disagreement_threshold < 1.0:
        raise ValueError("square edge disagreement threshold must be between zero and one")
    if target_aspect_ratio is not None and not 0.20 <= target_aspect_ratio <= 5.0:
        raise ValueError("target aspect ratio must be between 0.2 and 5")
    if not 0.0 <= vanishing_confidence <= 1.0:
        raise ValueError("vanishing confidence must be between zero and one")
    if not 0.0 <= trim_fraction < 0.5:
        raise ValueError("cover trim fraction must be between zero and one half")
    top_left, top_right, bottom_right, bottom_left = order_quadrilateral(polygon)
    top_length = float(np.linalg.norm(top_right - top_left))
    bottom_length = float(np.linalg.norm(bottom_right - bottom_left))
    left_length = float(np.linalg.norm(bottom_left - top_left))
    right_length = float(np.linalg.norm(bottom_right - top_right))
    estimated_width = (top_length + bottom_length) / 2.0
    estimated_height = (left_length + right_length) / 2.0
    if estimated_width <= 1.0 or estimated_height <= 1.0:
        raise ValueError("flattened cover dimensions must be greater than one pixel")

    width_disagreement = abs(top_length - bottom_length) / estimated_width
    height_disagreement = abs(left_length - right_length) / estimated_height
    square_difference = abs(estimated_width - estimated_height) / max(
        estimated_width,
        estimated_height,
    )
    if target_aspect_ratio is not None:
        aspect_ratio_method = "vanishing_points"
        corrected_width = estimated_height * target_aspect_ratio
        scale = min(1.0, max_dimension / max(corrected_width, estimated_height))
        untrimmed_width = max(2, int(round(corrected_width * scale)))
        untrimmed_height = max(2, int(round(estimated_height * scale)))
        square_snapped = abs(target_aspect_ratio - 1.0) <= square_threshold
    elif (
        square_difference <= square_threshold
        and width_disagreement <= square_edge_disagreement_threshold
        and height_disagreement <= square_edge_disagreement_threshold
    ):
        aspect_ratio_method = "near_square"
        scale = min(1.0, max_dimension / max(estimated_width, estimated_height))
        square_snapped = True
        square_size = max(
            2,
            int(round(((estimated_width + estimated_height) / 2.0) * scale)),
        )
        untrimmed_width = square_size
        untrimmed_height = square_size
    else:
        aspect_ratio_method = "edge_average"
        scale = min(1.0, max_dimension / max(estimated_width, estimated_height))
        square_snapped = False
        untrimmed_width = max(2, int(round(estimated_width * scale)))
        untrimmed_height = max(2, int(round(estimated_height * scale)))
    destination = np.array(
        [
            [0, 0],
            [untrimmed_width - 1, 0],
            [untrimmed_width - 1, untrimmed_height - 1],
            [0, untrimmed_height - 1],
        ],
        dtype=np.float32,
    )
    ordered = np.array([top_left, top_right, bottom_right, bottom_left], dtype=np.float32)
    transform = cv2.getPerspectiveTransform(ordered, destination)
    untrimmed = cv2.warpPerspective(
        image,
        transform,
        (untrimmed_width, untrimmed_height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )
    trim_x = min(
        max(1, int(round(untrimmed_width * trim_fraction))) if trim_fraction else 0,
        (untrimmed_width - 2) // 2,
    )
    trim_y = min(
        max(1, int(round(untrimmed_height * trim_fraction))) if trim_fraction else 0,
        (untrimmed_height - 2) // 2,
    )
    flattened = untrimmed[
        trim_y : untrimmed_height - trim_y,
        trim_x : untrimmed_width - trim_x,
    ].copy()
    height, width = flattened.shape[:2]
    geometry = FlattenedCoverGeometry(
        ordered_corners=[[float(value) for value in point] for point in ordered],
        top_length=top_length,
        bottom_length=bottom_length,
        left_length=left_length,
        right_length=right_length,
        estimated_width=estimated_width,
        estimated_height=estimated_height,
        aspect_ratio_method=aspect_ratio_method,
        vanishing_confidence=vanishing_confidence,
        vanishing_focal_spread=vanishing_focal_spread,
        untrimmed_width=untrimmed_width,
        untrimmed_height=untrimmed_height,
        square_threshold=square_threshold,
        square_difference=square_difference,
        square_snapped=square_snapped,
        trim_fraction=trim_fraction,
        trim_x=trim_x,
        trim_y=trim_y,
        width=width,
        height=height,
        aspect_ratio=width / height,
        width_disagreement=width_disagreement,
        height_disagreement=height_disagreement,
    )
    return flattened, geometry


def manual_cover_polygon(
    normalized_points: object,
    image_shape: tuple[int, int],
) -> np.ndarray:
    """Validate normalized clicks and convert them to ordered source pixels."""

    try:
        points = np.asarray(normalized_points, dtype=np.float64)
    except (TypeError, ValueError) as error:
        raise ValueError("manual cover points must contain numeric x and y coordinates") from error
    if points.shape != (4, 2):
        raise ValueError("manual cover selection requires exactly four points")
    if not np.all(np.isfinite(points)):
        raise ValueError("manual cover points must be finite")
    if np.any(points < 0.0) or np.any(points > 1.0):
        raise ValueError("manual cover points must be normalized between zero and one")

    height, width = image_shape
    if height <= 1 or width <= 1:
        raise ValueError("source image dimensions must be greater than one pixel")
    pixel_points = points * np.array([width - 1, height - 1], dtype=np.float64)
    hull = cv2.convexHull(pixel_points.astype(np.float32), returnPoints=True)
    if hull.reshape(-1, 2).shape[0] != 4:
        raise ValueError("manual cover points must form four distinct convex corners")

    ordered = order_quadrilateral(pixel_points).astype(np.float32)
    if not cv2.isContourConvex(ordered):
        raise ValueError("manual cover points must form a convex quadrilateral")
    edges = np.roll(ordered, -1, axis=0) - ordered
    if float(np.min(np.linalg.norm(edges, axis=1))) <= 1.0:
        raise ValueError("manual cover corners must be more than one pixel apart")
    if abs(float(cv2.contourArea(ordered))) <= 1.0:
        raise ValueError("manual cover points must enclose a visible area")
    return ordered


def process_manual_cover(
    source_path: str | Path,
    output_dir: str | Path,
    normalized_points: object,
) -> FlattenedCoverResult:
    source = Path(source_path)
    image = cv2.imread(str(source), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"could not read image: {source}")

    polygon = manual_cover_polygon(normalized_points, image.shape[:2])
    flattened, geometry = flatten_cover_quadrilateral(
        image,
        polygon,
        trim_fraction=MANUAL_COVER_TRIM_FRACTION,
    )
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    output_path = output / "flattened-cover-manual.png"
    metadata_path = output / "manual-cover.json"
    if not cv2.imwrite(str(output_path), flattened):
        raise ValueError(f"could not write flattened cover: {output_path}")

    result = FlattenedCoverResult(
        candidate_type="manual",
        candidate_index=MANUAL_CANDIDATE_INDEX,
        construction=MANUAL_CANDIDATE_CONSTRUCTION,
        output_path=str(output_path.resolve()),
        geometry=geometry,
    )
    metadata_path.write_text(
        json.dumps(
            {
                "source_path": str(source.resolve()),
                "metadata_path": str(metadata_path.resolve()),
                "flattened_covers": [asdict(result)],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return result


def detect_silhouette(
    image: np.ndarray,
    *,
    target_lines: int = 6,
    background_threshold: float | None = None,
    minimum_area_ratio: float = 0.02,
) -> tuple[SilhouetteDetection, np.ndarray, np.ndarray]:
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("expected a BGR color image")

    mask, background, threshold = build_foreground_mask(
        image,
        background_threshold=background_threshold,
    )
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        raise ValueError("could not trace the foreground object")

    contour = max(contours, key=cv2.contourArea)
    image_area = float(image.shape[0] * image.shape[1])
    foreground_area_ratio = float(cv2.contourArea(contour) / image_area)
    if foreground_area_ratio < minimum_area_ratio:
        raise ValueError(
            f"largest foreground object is too small ({foreground_area_ratio:.3f} of the image)"
        )

    hull = cv2.convexHull(contour)
    hull_area = float(cv2.contourArea(hull))
    polygon = approximate_hull(hull, target_vertices=target_lines)
    initial_vertices = normalize_vertices(polygon).astype(np.float64)
    vertices, fitted_lines = fit_boundary_lines(image, hull, initial_vertices)
    polygon_area = abs(float(cv2.contourArea(vertices.astype(np.float32))))
    lines = lines_from_vertices(vertices, fitted_lines)
    perspective = classify_perspective(vertices)
    two_face_cover = identify_two_face_cover(
        vertices,
        perspective,
        image_shape=(image.shape[0], image.shape[1]),
    )
    three_face_covers = identify_three_face_covers(vertices, perspective)

    detection = SilhouetteDetection(
        vertices=[[float(x), float(y)] for x, y in vertices.tolist()],
        initial_vertices=[[float(x), float(y)] for x, y in initial_vertices.tolist()],
        lines=lines,
        background_bgr=[float(value) for value in background.tolist()],
        background_threshold=float(threshold),
        foreground_area_ratio=foreground_area_ratio,
        hull_area_ratio=hull_area / image_area,
        polygon_area_retention=polygon_area / hull_area if hull_area else 0.0,
        perspective=perspective,
        two_face_cover=two_face_cover,
        three_face_covers=three_face_covers,
    )
    return detection, mask, hull


def draw_overlay(image: np.ndarray, detection: SilhouetteDetection, hull: np.ndarray) -> np.ndarray:
    overlay = image.copy()
    if detection.two_face_cover is not None:
        cover_polygon = np.rint(np.asarray(detection.two_face_cover.cover_polygon)).astype(np.int32)
        face_overlay = overlay.copy()
        cv2.fillPoly(face_overlay, [cover_polygon], (70, 220, 70), cv2.LINE_AA)
        overlay = cv2.addWeighted(face_overlay, 0.16, overlay, 0.84, 0)
    cv2.polylines(overlay, [hull.astype(np.int32)], True, (255, 160, 0), 2, cv2.LINE_AA)

    initial_vertices = np.rint(np.asarray(detection.initial_vertices)).astype(np.int32)
    cv2.polylines(overlay, [initial_vertices], True, (255, 0, 0), 2, cv2.LINE_AA)

    vertices = np.rint(np.asarray(detection.vertices)).astype(np.int32)
    cv2.polylines(overlay, [vertices], True, (0, 0, 255), 4, cv2.LINE_AA)
    if detection.two_face_cover is not None:
        cover_polygon = np.rint(np.asarray(detection.two_face_cover.cover_polygon)).astype(np.int32)
        seam = np.rint(np.asarray(detection.two_face_cover.seam)).astype(np.int32)
        cv2.polylines(overlay, [cover_polygon], True, (0, 180, 0), 3, cv2.LINE_AA)
        cv2.line(overlay, tuple(seam[0]), tuple(seam[1]), (255, 0, 255), 5, cv2.LINE_AA)
        seam_center = np.rint(seam.mean(axis=0)).astype(int)
        seam_label_position = (int(seam_center[0] + 8), int(seam_center[1]))
        cv2.putText(overlay, "SEAM", seam_label_position, cv2.FONT_HERSHEY_SIMPLEX, 0.48, (255, 255, 255), 4, cv2.LINE_AA)
        cv2.putText(overlay, "SEAM", seam_label_position, cv2.FONT_HERSHEY_SIMPLEX, 0.48, (120, 0, 120), 1, cv2.LINE_AA)
        cover_center = np.rint(cover_polygon.mean(axis=0)).astype(int)
        cv2.putText(overlay, "COVER", tuple(cover_center), cv2.FONT_HERSHEY_SIMPLEX, 0.72, (255, 255, 255), 4, cv2.LINE_AA)
        cv2.putText(overlay, "COVER", tuple(cover_center), cv2.FONT_HERSHEY_SIMPLEX, 0.72, (0, 110, 0), 2, cv2.LINE_AA)
    for line in detection.lines:
        start = np.asarray(line.start)
        end = np.asarray(line.end)
        midpoint = np.rint((start + end) / 2).astype(int)
        label_position = (int(midpoint[0] + 6), int(midpoint[1] - 6))
        label = f"{line.axis_label}{line.pair_member}"
        cv2.putText(overlay, label, label_position, cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 4, cv2.LINE_AA)
        cv2.putText(overlay, label, label_position, cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1, cv2.LINE_AA)

    for index, vertex in enumerate(vertices, start=1):
        point = (int(vertex[0]), int(vertex[1]))
        cv2.circle(overlay, point, 6, (0, 255, 0), -1, cv2.LINE_AA)
        cv2.circle(overlay, point, 6, (0, 0, 0), 1, cv2.LINE_AA)
        label_position = (point[0] + 8, point[1] + 18)
        cv2.putText(overlay, str(index), label_position, cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 4, cv2.LINE_AA)
        cv2.putText(overlay, str(index), label_position, cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1, cv2.LINE_AA)

    perspective = detection.perspective
    summary = (
        f"{perspective.kind}  opposite pairs={perspective.matching_opposite_pairs}/3  "
        f"confidence={perspective.confidence:.2f}"
    )
    summary_scale = 0.58
    summary_width = cv2.getTextSize(summary, cv2.FONT_HERSHEY_SIMPLEX, summary_scale, 1)[0][0]
    if summary_width > image.shape[1] - 30:
        summary_scale *= (image.shape[1] - 30) / summary_width
    summary_position = (15, image.shape[0] - 14)
    cv2.putText(overlay, summary, summary_position, cv2.FONT_HERSHEY_SIMPLEX, summary_scale, (255, 255, 255), 4, cv2.LINE_AA)
    cv2.putText(overlay, summary, summary_position, cv2.FONT_HERSHEY_SIMPLEX, summary_scale, (0, 0, 0), 1, cv2.LINE_AA)

    return overlay


def draw_three_face_covers(
    image: np.ndarray,
    detection: SilhouetteDetection,
) -> np.ndarray | None:
    if not detection.three_face_covers:
        return None

    silhouette = np.rint(np.asarray(detection.vertices)).astype(np.int32)
    panels: list[np.ndarray] = []
    for case_number, construction in enumerate(detection.three_face_covers, start=1):
        panel = image.copy()
        polygon = np.rint(np.asarray(construction.cover_polygon)).astype(np.int32)
        first_source = np.rint(np.asarray(construction.first_source_segment)).astype(np.int32)
        second_source = np.rint(np.asarray(construction.second_source_segment)).astype(np.int32)
        first_translated = np.rint(np.asarray(construction.first_translated_segment)).astype(np.int32)
        second_translated = np.rint(np.asarray(construction.second_translated_segment)).astype(np.int32)
        missing_vertex = tuple(np.rint(construction.missing_vertex).astype(np.int32))

        tint = panel.copy()
        cv2.fillPoly(tint, [polygon], (70, 220, 70), cv2.LINE_AA)
        panel = cv2.addWeighted(tint, 0.17, panel, 0.83, 0)
        cv2.polylines(panel, [silhouette], True, (0, 0, 255), 3, cv2.LINE_AA)
        cv2.line(panel, tuple(first_source[0]), tuple(first_source[1]), (255, 160, 0), 7, cv2.LINE_AA)
        cv2.line(panel, tuple(second_source[0]), tuple(second_source[1]), (255, 160, 0), 7, cv2.LINE_AA)
        cv2.line(panel, tuple(first_translated[0]), tuple(first_translated[1]), (255, 0, 255), 5, cv2.LINE_AA)
        cv2.line(panel, tuple(second_translated[0]), tuple(second_translated[1]), (255, 0, 255), 5, cv2.LINE_AA)
        cv2.polylines(panel, [polygon], True, (0, 155, 0), 3, cv2.LINE_AA)
        cv2.circle(panel, missing_vertex, 9, (0, 215, 255), -1, cv2.LINE_AA)
        cv2.circle(panel, missing_vertex, 9, (0, 0, 0), 1, cv2.LINE_AA)

        title = f"Case {case_number}: {construction.construction}"
        subtitle = (
            f"intersection=({construction.missing_vertex[0]:.1f}, {construction.missing_vertex[1]:.1f})  "
            f"parallel errors={construction.parallel_error_degrees[0]:.4f}, "
            f"{construction.parallel_error_degrees[1]:.4f} deg"
        )
        cv2.rectangle(panel, (0, 0), (image.shape[1], 62), (255, 255, 255), -1)
        title_scale = min(0.58, max(0.36, image.shape[1] / 1200.0))
        cv2.putText(panel, title, (12, 25), cv2.FONT_HERSHEY_SIMPLEX, title_scale, (0, 0, 0), 1, cv2.LINE_AA)
        cv2.putText(panel, subtitle, (12, 51), cv2.FONT_HERSHEY_SIMPLEX, title_scale, (0, 0, 0), 1, cv2.LINE_AA)
        panels.append(panel)

    return np.hstack(panels)


def write_flattened_covers(
    image: np.ndarray,
    detection: SilhouetteDetection,
    output_dir: Path,
) -> tuple[list[FlattenedCoverResult], np.ndarray | None]:
    candidates: list[
        tuple[str, int, str, list[list[float]], float | None, float, float | None]
    ] = []
    if detection.two_face_cover is not None:
        candidates.append(
            (
                "two_faces",
                1,
                "two-face seam and larger-face selection",
                detection.two_face_cover.cover_polygon,
                detection.two_face_cover.vanishing_aspect_ratio,
                detection.two_face_cover.vanishing_confidence,
                detection.two_face_cover.vanishing_focal_spread,
            )
        )
    else:
        for index, construction in enumerate(detection.three_face_covers, start=1):
            candidates.append(
                (
                    "three_faces",
                    index,
                    construction.construction,
                    construction.cover_polygon,
                    None,
                    0.0,
                    None,
                )
            )
    if not candidates:
        return [], None

    results: list[FlattenedCoverResult] = []
    preview_panels: list[np.ndarray] = []
    target_preview_height = 700
    for (
        candidate_type,
        candidate_index,
        construction,
        polygon,
        target_aspect_ratio,
        vanishing_confidence,
        vanishing_focal_spread,
    ) in candidates:
        flattened, geometry = flatten_cover_quadrilateral(
            image,
            np.asarray(polygon),
            target_aspect_ratio=target_aspect_ratio,
            vanishing_confidence=vanishing_confidence,
            vanishing_focal_spread=vanishing_focal_spread,
        )
        filename = (
            "flattened-cover.png"
            if len(candidates) == 1
            else f"flattened-cover-{candidate_index}.png"
        )
        output_path = output_dir / filename
        cv2.imwrite(str(output_path), flattened)
        results.append(
            FlattenedCoverResult(
                candidate_type=candidate_type,
                candidate_index=candidate_index,
                construction=construction,
                output_path=str(output_path.resolve()),
                geometry=geometry,
            )
        )

        preview_scale = min(1.0, target_preview_height / flattened.shape[0])
        preview_width = max(1, int(round(flattened.shape[1] * preview_scale)))
        preview_height = max(1, int(round(flattened.shape[0] * preview_scale)))
        preview = cv2.resize(flattened, (preview_width, preview_height), interpolation=cv2.INTER_AREA)
        header = np.full((66, preview_width, 3), 255, dtype=np.uint8)
        title = f"Candidate {candidate_index}: {construction}"
        subtitle = (
            f"{geometry.width}x{geometry.height}  ratio={geometry.aspect_ratio:.3f}  "
            f"edge disagreement={geometry.width_disagreement:.1%}/{geometry.height_disagreement:.1%}"
        )
        if geometry.square_snapped:
            subtitle += "  square-snapped"
        if geometry.aspect_ratio_method == "vanishing_points":
            subtitle += f"  vanishing confidence={geometry.vanishing_confidence:.2f}"
        text_scale = min(0.5, max(0.3, preview_width / 1050.0))
        cv2.putText(header, title, (8, 25), cv2.FONT_HERSHEY_SIMPLEX, text_scale, (0, 0, 0), 1, cv2.LINE_AA)
        cv2.putText(header, subtitle, (8, 52), cv2.FONT_HERSHEY_SIMPLEX, text_scale, (0, 0, 0), 1, cv2.LINE_AA)
        preview_panels.append(np.vstack([header, preview]))

    maximum_panel_height = max(panel.shape[0] for panel in preview_panels)
    padded_panels = []
    for panel in preview_panels:
        if panel.shape[0] < maximum_panel_height:
            padding = np.full(
                (maximum_panel_height - panel.shape[0], panel.shape[1], 3),
                255,
                dtype=np.uint8,
            )
            panel = np.vstack([panel, padding])
        padded_panels.append(panel)
    return results, np.hstack(padded_panels)


def process_image(
    source_path: str | Path,
    output_dir: str | Path,
    *,
    target_lines: int = 6,
    background_threshold: float | None = None,
) -> SilhouetteResult:
    source = Path(source_path)
    image = cv2.imread(str(source), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"could not read image: {source}")

    detection, mask, hull = detect_silhouette(
        image,
        target_lines=target_lines,
        background_threshold=background_threshold,
    )
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    overlay_path = output / "silhouette-overlay.png"
    mask_path = output / "silhouette-mask.png"
    metadata_path = output / "silhouette.json"
    three_face_covers_image = draw_three_face_covers(image, detection)
    three_face_covers_path = output / "three-face-covers.png" if three_face_covers_image is not None else None
    flattened_covers, flattened_cover_previews = write_flattened_covers(image, detection, output)
    flattened_cover_previews_path = (
        output / "flattened-cover-previews.png"
        if flattened_cover_previews is not None
        else None
    )

    cv2.imwrite(str(overlay_path), draw_overlay(image, detection, hull))
    cv2.imwrite(str(mask_path), mask)
    if three_face_covers_path is not None and three_face_covers_image is not None:
        cv2.imwrite(str(three_face_covers_path), three_face_covers_image)
    if flattened_cover_previews_path is not None and flattened_cover_previews is not None:
        cv2.imwrite(str(flattened_cover_previews_path), flattened_cover_previews)
    result = SilhouetteResult(
        source_path=str(source.resolve()),
        overlay_path=str(overlay_path.resolve()),
        mask_path=str(mask_path.resolve()),
        metadata_path=str(metadata_path.resolve()),
        three_face_covers_path=str(three_face_covers_path.resolve()) if three_face_covers_path is not None else None,
        flattened_cover_previews_path=(
            str(flattened_cover_previews_path.resolve())
            if flattened_cover_previews_path is not None
            else None
        ),
        flattened_covers=flattened_covers,
        detection=detection,
    )
    metadata_path.write_text(json.dumps(asdict(result), indent=2), encoding="utf-8")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Draw a simplified convex polygon around a board-game box on a flat background."
    )
    parser.add_argument("source", help="Path to the source box image.")
    parser.add_argument(
        "--output-dir",
        default="box-silhouette-output",
        help="Directory for the overlay, mask, and JSON geometry.",
    )
    parser.add_argument("--target-lines", type=int, default=6, help="Preferred silhouette line count.")
    parser.add_argument(
        "--background-threshold",
        type=float,
        help="Optional BGR color-distance threshold. By default it is estimated from the image border.",
    )
    parser.add_argument(
        "--manual-points-json",
        help="Optional JSON array of four normalized [x, y] cover corners; bypasses silhouette detection.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.manual_points_json is not None:
        try:
            points = json.loads(args.manual_points_json)
        except json.JSONDecodeError as error:
            raise ValueError("manual cover points must be valid JSON") from error
        process_manual_cover(args.source, args.output_dir, points)
        print((Path(args.output_dir) / "manual-cover.json").resolve())
        return 0
    result = process_image(
        args.source,
        args.output_dir,
        target_lines=args.target_lines,
        background_threshold=args.background_threshold,
    )
    print(result.metadata_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
