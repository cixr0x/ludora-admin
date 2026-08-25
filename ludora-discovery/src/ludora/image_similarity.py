from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
import sys

import cv2
import numpy as np


METHOD = "sift_homography_v1"
MAX_PROCESSING_DIMENSION = 1800
LOWE_RATIO = 0.75
RANSAC_REPROJECTION_THRESHOLD = 4.0


@dataclass(frozen=True)
class ImageDimensions:
    width: int
    height: int


@dataclass(frozen=True)
class SimilarityDiagnostics:
    reference_dimensions: ImageDimensions
    candidate_dimensions: ImageDimensions
    reference_keypoints: int
    candidate_keypoints: int
    tentative_matches: int
    inliers: int
    inlier_ratio: float
    reference_hull_coverage: float
    reference_grid_coverage: float
    median_reprojection_error: float | None
    projected_area_ratio: float | None
    homography_valid: bool


@dataclass(frozen=True)
class ImageSimilarityResult:
    score: float
    method: str
    matched_region: list[dict[str, float]] | None
    diagnostics: SimilarityDiagnostics


def estimate_image_similarity(reference: np.ndarray, candidate: np.ndarray) -> ImageSimilarityResult:
    """Estimate whether a planar reference image occurs inside a candidate image.

    The score is deliberately a calibratable 0-100 signal, not a probability.
    SIFT supplies scale/rotation-resistant local correspondences and RANSAC
    verifies that the correspondences agree on one perspective transformation.
    """

    _validate_image(reference, "reference")
    _validate_image(candidate, "candidate")

    reference_dimensions = ImageDimensions(width=int(reference.shape[1]), height=int(reference.shape[0]))
    candidate_dimensions = ImageDimensions(width=int(candidate.shape[1]), height=int(candidate.shape[0]))
    prepared_reference = _prepare_image(reference)
    prepared_candidate = _prepare_image(candidate)

    sift = cv2.SIFT_create(nfeatures=5000, contrastThreshold=0.02)
    reference_keypoints, reference_descriptors = sift.detectAndCompute(prepared_reference, None)
    candidate_keypoints, candidate_descriptors = sift.detectAndCompute(prepared_candidate, None)

    base_diagnostics = dict(
        reference_dimensions=reference_dimensions,
        candidate_dimensions=candidate_dimensions,
        reference_keypoints=len(reference_keypoints),
        candidate_keypoints=len(candidate_keypoints),
    )
    if reference_descriptors is None or candidate_descriptors is None:
        return _empty_result(base_diagnostics)

    matcher = cv2.BFMatcher(cv2.NORM_L2)
    raw_pairs = matcher.knnMatch(reference_descriptors, candidate_descriptors, k=2)
    ratio_matches = [
        first
        for pair in raw_pairs
        if len(pair) == 2
        for first, second in [pair]
        if first.distance < LOWE_RATIO * second.distance
    ]

    # A scene feature should contribute at most one vote. Repeated logos and
    # typography otherwise create inflated evidence for an incorrect match.
    matches_by_candidate_feature: dict[int, cv2.DMatch] = {}
    for match in ratio_matches:
        previous = matches_by_candidate_feature.get(match.trainIdx)
        if previous is None or match.distance < previous.distance:
            matches_by_candidate_feature[match.trainIdx] = match
    matches = list(matches_by_candidate_feature.values())

    if len(matches) < 4:
        return _empty_result(base_diagnostics, tentative_matches=len(matches))

    reference_points = np.float32(
        [reference_keypoints[match.queryIdx].pt for match in matches]
    ).reshape(-1, 1, 2)
    candidate_points = np.float32(
        [candidate_keypoints[match.trainIdx].pt for match in matches]
    ).reshape(-1, 1, 2)
    homography, mask = cv2.findHomography(
        reference_points,
        candidate_points,
        cv2.RANSAC,
        RANSAC_REPROJECTION_THRESHOLD,
    )
    if homography is None or mask is None:
        return _empty_result(base_diagnostics, tentative_matches=len(matches))

    inlier_mask = mask.ravel().astype(bool)
    inlier_count = int(np.count_nonzero(inlier_mask))
    inlier_ratio = inlier_count / len(matches)
    inlier_reference_points = reference_points[inlier_mask].reshape(-1, 2)
    inlier_candidate_points = candidate_points[inlier_mask].reshape(-1, 2)
    hull_coverage = _hull_coverage(inlier_reference_points, prepared_reference.shape)
    grid_coverage = _grid_coverage(inlier_reference_points, prepared_reference.shape)
    median_reprojection_error = _median_reprojection_error(
        inlier_reference_points,
        inlier_candidate_points,
        homography,
    )
    projected_corners, projected_area_ratio, homography_valid = _project_reference(
        homography,
        prepared_reference.shape,
        prepared_candidate.shape,
    )
    score = _score(
        homography_valid=homography_valid,
        hull_coverage=hull_coverage,
        grid_coverage=grid_coverage,
        inlier_count=inlier_count,
        inlier_ratio=inlier_ratio,
        median_reprojection_error=median_reprojection_error,
    )

    matched_region = None
    if projected_corners is not None:
        candidate_height, candidate_width = prepared_candidate.shape[:2]
        matched_region = [
            {
                "x": round(float(point[0]) / candidate_width, 6),
                "y": round(float(point[1]) / candidate_height, 6),
            }
            for point in projected_corners
        ]

    return ImageSimilarityResult(
        score=round(score, 2),
        method=METHOD,
        matched_region=matched_region,
        diagnostics=SimilarityDiagnostics(
            **base_diagnostics,
            tentative_matches=len(matches),
            inliers=inlier_count,
            inlier_ratio=round(inlier_ratio, 6),
            reference_hull_coverage=round(hull_coverage, 6),
            reference_grid_coverage=round(grid_coverage, 6),
            median_reprojection_error=round(median_reprojection_error, 4),
            projected_area_ratio=(round(projected_area_ratio, 6) if projected_area_ratio is not None else None),
            homography_valid=homography_valid,
        ),
    )


def load_image(path: str | Path) -> np.ndarray:
    source = Path(path)
    try:
        encoded = np.frombuffer(source.read_bytes(), dtype=np.uint8)
    except OSError as exc:
        raise ValueError(f"Could not read image: {source}") from exc
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Could not decode image: {source}")
    return image


def estimate_image_similarity_files(reference_path: str | Path, candidate_path: str | Path) -> ImageSimilarityResult:
    return estimate_image_similarity(load_image(reference_path), load_image(candidate_path))


def _prepare_image(image: np.ndarray) -> np.ndarray:
    height, width = image.shape[:2]
    scale = min(1.0, MAX_PROCESSING_DIMENSION / max(height, width))
    if scale < 1.0:
        image = cv2.resize(
            image,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)


def _validate_image(image: np.ndarray, label: str) -> None:
    if not isinstance(image, np.ndarray) or image.ndim != 3 or image.shape[2] not in {3, 4}:
        raise ValueError(f"{label} image must be a decoded color image")
    if image.shape[0] < 16 or image.shape[1] < 16:
        raise ValueError(f"{label} image must be at least 16 by 16 pixels")


def _empty_result(base_diagnostics: dict[str, object], tentative_matches: int = 0) -> ImageSimilarityResult:
    return ImageSimilarityResult(
        score=0.0,
        method=METHOD,
        matched_region=None,
        diagnostics=SimilarityDiagnostics(
            **base_diagnostics,
            tentative_matches=tentative_matches,
            inliers=0,
            inlier_ratio=0.0,
            reference_hull_coverage=0.0,
            reference_grid_coverage=0.0,
            median_reprojection_error=None,
            projected_area_ratio=None,
            homography_valid=False,
        ),
    )


def _hull_coverage(points: np.ndarray, image_shape: tuple[int, ...]) -> float:
    if len(points) < 3:
        return 0.0
    hull = cv2.convexHull(points.astype(np.float32))
    image_area = float(image_shape[0] * image_shape[1])
    return _clamp(float(cv2.contourArea(hull)) / image_area)


def _grid_coverage(points: np.ndarray, image_shape: tuple[int, ...], grid_size: int = 4) -> float:
    if len(points) == 0:
        return 0.0
    height, width = image_shape[:2]
    cells = {
        (
            min(grid_size - 1, max(0, int(point[0] * grid_size / width))),
            min(grid_size - 1, max(0, int(point[1] * grid_size / height))),
        )
        for point in points
    }
    return len(cells) / float(grid_size * grid_size)


def _median_reprojection_error(
    reference_points: np.ndarray,
    candidate_points: np.ndarray,
    homography: np.ndarray,
) -> float:
    if len(reference_points) == 0:
        return float("inf")
    projected = cv2.perspectiveTransform(reference_points.reshape(-1, 1, 2), homography).reshape(-1, 2)
    errors = np.linalg.norm(projected - candidate_points, axis=1)
    return float(np.median(errors))


def _project_reference(
    homography: np.ndarray,
    reference_shape: tuple[int, ...],
    candidate_shape: tuple[int, ...],
) -> tuple[np.ndarray | None, float | None, bool]:
    reference_height, reference_width = reference_shape[:2]
    candidate_height, candidate_width = candidate_shape[:2]
    corners = np.float32(
        [[0, 0], [reference_width - 1, 0], [reference_width - 1, reference_height - 1], [0, reference_height - 1]]
    ).reshape(-1, 1, 2)
    projected = cv2.perspectiveTransform(corners, homography).reshape(-1, 2)
    if not np.all(np.isfinite(projected)):
        return None, None, False

    contour = projected.astype(np.float32).reshape(-1, 1, 2)
    projected_area = abs(float(cv2.contourArea(contour)))
    projected_area_ratio = projected_area / float(candidate_height * candidate_width)
    edge_lengths = [
        float(np.linalg.norm(projected[(index + 1) % 4] - projected[index]))
        for index in range(4)
    ]
    margin_x = candidate_width * 0.5
    margin_y = candidate_height * 0.5
    inside_extended_frame = all(
        -margin_x <= point[0] <= candidate_width + margin_x
        and -margin_y <= point[1] <= candidate_height + margin_y
        for point in projected
    )
    minimum_edge = max(8.0, min(candidate_height, candidate_width) * 0.01)
    valid = (
        cv2.isContourConvex(contour)
        and projected_area_ratio >= 0.0005
        and projected_area_ratio <= 4.0
        and min(edge_lengths) >= minimum_edge
        and inside_extended_frame
    )
    return projected, projected_area_ratio, bool(valid)


def _score(
    *,
    homography_valid: bool,
    hull_coverage: float,
    grid_coverage: float,
    inlier_count: int,
    inlier_ratio: float,
    median_reprojection_error: float,
) -> float:
    if inlier_count < 4:
        return 0.0

    evidence = 1.0 - math.exp(-inlier_count / 12.0)
    ratio_quality = _clamp((inlier_ratio - 0.15) / 0.65)
    coverage_quality = (
        0.65 * _clamp(hull_coverage / 0.25)
        + 0.35 * _clamp(grid_coverage / 0.50)
    )
    reprojection_quality = math.exp(-max(0.0, median_reprojection_error) / RANSAC_REPROJECTION_THRESHOLD)
    quality = 0.40 + 0.25 * ratio_quality + 0.20 * coverage_quality + 0.15 * reprojection_quality
    validity_factor = 1.0 if homography_valid else 0.25
    return 100.0 * evidence * quality * validity_factor


def _clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return min(maximum, max(minimum, value))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Estimate planar image similarity using SIFT and a RANSAC homography.")
    parser.add_argument("reference_image")
    parser.add_argument("candidate_image")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = estimate_image_similarity_files(args.reference_image, args.candidate_image)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps(asdict(result), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
