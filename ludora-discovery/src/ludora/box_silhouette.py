from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
from pathlib import Path

import cv2
import numpy as np


@dataclass(frozen=True)
class SilhouetteLine:
    start: list[int]
    end: list[int]
    length: float
    angle_degrees: float


@dataclass(frozen=True)
class SilhouetteDetection:
    vertices: list[list[int]]
    lines: list[SilhouetteLine]
    background_bgr: list[float]
    background_threshold: float
    foreground_area_ratio: float
    hull_area_ratio: float
    polygon_area_retention: float


@dataclass(frozen=True)
class SilhouetteResult:
    source_path: str
    overlay_path: str
    mask_path: str
    metadata_path: str
    detection: SilhouetteDetection


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
    """Estimate a flat background color and a conservative color-distance cutoff."""

    border = _border_pixels(image)
    background = np.median(border, axis=0)
    distances = np.linalg.norm(border - background, axis=1)
    median_distance = float(np.median(distances))
    mad = float(np.median(np.abs(distances - median_distance)))
    threshold = max(6.0, median_distance + 6.0 * 1.4826 * mad)
    return background, threshold


def build_foreground_mask(
    image: np.ndarray,
    *,
    background_threshold: float | None = None,
) -> tuple[np.ndarray, np.ndarray, float]:
    background, automatic_threshold = estimate_background(image)
    threshold = automatic_threshold if background_threshold is None else float(background_threshold)
    if threshold <= 0:
        raise ValueError("background threshold must be positive")

    distances = np.linalg.norm(image.astype(np.float32) - background, axis=2)
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


def lines_from_vertices(vertices: np.ndarray) -> list[SilhouetteLine]:
    lines: list[SilhouetteLine] = []
    for index, start in enumerate(vertices):
        end = vertices[(index + 1) % len(vertices)]
        delta = end.astype(np.float64) - start.astype(np.float64)
        lines.append(
            SilhouetteLine(
                start=[int(start[0]), int(start[1])],
                end=[int(end[0]), int(end[1])],
                length=float(np.linalg.norm(delta)),
                angle_degrees=float(np.degrees(np.arctan2(delta[1], delta[0]))),
            )
        )
    return lines


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
    vertices = normalize_vertices(polygon)
    polygon_area = float(cv2.contourArea(vertices))

    detection = SilhouetteDetection(
        vertices=[[int(x), int(y)] for x, y in vertices.tolist()],
        lines=lines_from_vertices(vertices),
        background_bgr=[float(value) for value in background.tolist()],
        background_threshold=float(threshold),
        foreground_area_ratio=foreground_area_ratio,
        hull_area_ratio=hull_area / image_area,
        polygon_area_retention=polygon_area / hull_area if hull_area else 0.0,
    )
    return detection, mask, hull


def draw_overlay(image: np.ndarray, detection: SilhouetteDetection, hull: np.ndarray) -> np.ndarray:
    overlay = image.copy()
    cv2.polylines(overlay, [hull.astype(np.int32)], True, (255, 160, 0), 2, cv2.LINE_AA)

    vertices = np.asarray(detection.vertices, dtype=np.int32)
    cv2.polylines(overlay, [vertices], True, (0, 0, 255), 4, cv2.LINE_AA)
    for index, line in enumerate(detection.lines, start=1):
        start = np.asarray(line.start)
        end = np.asarray(line.end)
        midpoint = np.rint((start + end) / 2).astype(int)
        label_position = (int(midpoint[0] + 6), int(midpoint[1] - 6))
        cv2.putText(overlay, f"L{index}", label_position, cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 4, cv2.LINE_AA)
        cv2.putText(overlay, f"L{index}", label_position, cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1, cv2.LINE_AA)

    for index, vertex in enumerate(vertices, start=1):
        point = (int(vertex[0]), int(vertex[1]))
        cv2.circle(overlay, point, 6, (0, 255, 0), -1, cv2.LINE_AA)
        cv2.circle(overlay, point, 6, (0, 0, 0), 1, cv2.LINE_AA)
        label_position = (point[0] + 8, point[1] + 18)
        cv2.putText(overlay, str(index), label_position, cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 4, cv2.LINE_AA)
        cv2.putText(overlay, str(index), label_position, cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1, cv2.LINE_AA)

    return overlay


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

    cv2.imwrite(str(overlay_path), draw_overlay(image, detection, hull))
    cv2.imwrite(str(mask_path), mask)
    result = SilhouetteResult(
        source_path=str(source.resolve()),
        overlay_path=str(overlay_path.resolve()),
        mask_path=str(mask_path.resolve()),
        metadata_path=str(metadata_path.resolve()),
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
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
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
