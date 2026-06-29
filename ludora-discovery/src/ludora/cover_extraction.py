from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from typing import Iterable
import json
from pathlib import Path

import cv2
import numpy as np


@dataclass(frozen=True)
class ExtractionResult:
    source_path: str
    cover_path: str
    debug_path: str
    metadata_path: str
    corners: list[list[float]]
    confidence: float
    status: str
    width: int
    height: int


def order_points(points: np.ndarray) -> np.ndarray:
    pts = np.asarray(points, dtype=np.float32)
    if pts.shape != (4, 2):
        raise ValueError("expected exactly four 2D points")
    ordered = np.zeros((4, 2), dtype=np.float32)
    sums = pts.sum(axis=1)
    diffs = np.diff(pts, axis=1).reshape(4)
    ordered[0] = pts[np.argmin(sums)]
    ordered[2] = pts[np.argmax(sums)]
    ordered[1] = pts[np.argmin(diffs)]
    ordered[3] = pts[np.argmax(diffs)]
    return ordered


def estimate_output_size(points: np.ndarray, max_dimension: int = 1200) -> tuple[int, int]:
    tl, tr, br, bl = order_points(points)
    width_top = float(np.linalg.norm(tr - tl))
    width_bottom = float(np.linalg.norm(br - bl))
    height_right = float(np.linalg.norm(br - tr))
    height_left = float(np.linalg.norm(bl - tl))
    width = max(width_top, width_bottom)
    height = max(height_left, height_right)
    if width <= 0 or height <= 0:
        raise ValueError("detected cover dimensions must be positive")
    scale = max_dimension / max(width, height)
    return max(1, int(round(width * scale))), max(1, int(round(height * scale)))


def status_for_confidence(confidence: float) -> str:
    if confidence >= 0.70:
        return "accepted"
    if confidence >= 0.35:
        return "review"
    return "failed"


def write_metadata(result: ExtractionResult) -> None:
    data = asdict(result)
    data["aspect_ratio"] = result.width / result.height if result.height else 0
    Path(result.metadata_path).write_text(
        json.dumps(data, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def extract_cover(
    source_path: str | Path,
    output_dir: str | Path,
    *,
    manual_corners: Iterable[tuple[float, float]] | None = None,
    max_dimension: int = 1200,
) -> ExtractionResult:
    source = Path(source_path)
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    image = cv2.imread(str(source), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"could not read image: {source}")

    if manual_corners is not None:
        corners = order_points(np.array(list(manual_corners), dtype=np.float32))
        confidence = 1.0
    else:
        detected = detect_front_face(image)
        if detected is None:
            raise ValueError(f"could not detect front cover: {source}")
        corners, confidence = detected

    width, height = estimate_output_size(corners, max_dimension=max_dimension)
    destination = np.array(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(corners, destination)
    warped = cv2.warpPerspective(image, matrix, (width, height))

    cover_path = output / "cover.jpg"
    debug_path = output / "debug.jpg"
    metadata_path = output / "metadata.json"
    cv2.imwrite(str(cover_path), warped, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    cv2.imwrite(str(debug_path), draw_debug_overlay(image, corners, confidence))

    result = ExtractionResult(
        source_path=str(source),
        cover_path=str(cover_path),
        debug_path=str(debug_path),
        metadata_path=str(metadata_path),
        corners=[[float(x), float(y)] for x, y in corners.tolist()],
        confidence=float(confidence),
        status=status_for_confidence(float(confidence)),
        width=width,
        height=height,
    )
    write_metadata(result)
    return result


def detect_front_face(image: np.ndarray) -> tuple[np.ndarray, float] | None:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 40, 120)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    image_area = image.shape[0] * image.shape[1]
    candidates: list[tuple[float, np.ndarray]] = []

    for contour in contours:
        area = cv2.contourArea(contour)
        if area < image_area * 0.08:
            continue
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.03 * perimeter, True)
        if len(approx) != 4:
            rect = cv2.minAreaRect(contour)
            approx = cv2.boxPoints(rect).reshape(4, 1, 2).astype(np.float32)
        points = refine_front_face_from_outer_box(image, order_points(approx.reshape(4, 2)))
        width, height = estimate_output_size(points, max_dimension=10_000)
        if width < 40 or height < 40:
            continue
        rectangularity = min(1.0, area / max(1.0, float(width * height)))
        center_x = float(points[:, 0].mean())
        left_penalty = max(0.0, (image.shape[1] * 0.35 - center_x) / image.shape[1])
        score = rectangularity + (area / image_area) - left_penalty
        candidates.append((score, points))

    if not candidates:
        return None

    score, points = max(candidates, key=lambda item: item[0])
    confidence = max(0.0, min(1.0, score))
    return points, confidence


def refine_front_face_from_outer_box(image: np.ndarray, points: np.ndarray) -> np.ndarray:
    ordered = order_points(points)
    seam_x = find_left_front_boundary(image, ordered)
    if seam_x is None:
        return ordered

    tl, tr, br, bl = ordered
    if seam_x <= max(tl[0], bl[0]) + 4 or seam_x >= min(tr[0], br[0]) - 20:
        return ordered

    left_line = find_left_border_line(image, ordered, seam_x)
    return build_front_face_from_border_lines(ordered, seam_x, left_line=left_line)


def build_front_face_from_border_lines(
    points: np.ndarray,
    seam_x: float,
    *,
    left_line: np.ndarray | None = None,
) -> np.ndarray:
    tl, tr, br, bl = order_points(points)
    height = max(float(np.linalg.norm(bl - tl)), float(np.linalg.norm(br - tr)))
    left_top_seed = point_on_edge_at_x(tl, tr, seam_x)
    left_top_seed[1] += height * 0.05

    top_line = line_through_points(left_top_seed, tr)
    right_line = line_through_points(tr, br)
    bottom_line = line_through_points(bl, br)
    left_line = left_line if left_line is not None else parallel_line_through_point(right_line, left_top_seed)

    top_left = intersect_lines(left_line, top_line)
    top_right = intersect_lines(right_line, top_line)
    bottom_right = intersect_lines(right_line, bottom_line)
    bottom_left = intersect_lines(left_line, bottom_line)
    return order_points(np.array([top_left, top_right, bottom_right, bottom_left], dtype=np.float32))


def project_left_edge_from_right_edge(points: np.ndarray, seam_x: float) -> np.ndarray:
    tl, tr, br, _ = order_points(points)
    top_left = point_on_edge_at_x(tl, tr, seam_x)
    height = float(np.linalg.norm(br - tr))
    top_left[1] += height * 0.05
    bottom_left = top_left + (br - tr)
    return order_points(np.array([top_left, tr, br, bottom_left], dtype=np.float32))


def line_through_points(point_a: np.ndarray, point_b: np.ndarray) -> np.ndarray:
    x1, y1 = point_a
    x2, y2 = point_b
    return np.array([y1 - y2, x2 - x1, x1 * y2 - x2 * y1], dtype=np.float32)


def parallel_line_through_point(line: np.ndarray, point: np.ndarray) -> np.ndarray:
    a, b, _ = line
    x, y = point
    return np.array([a, b, -(a * x + b * y)], dtype=np.float32)


def x_at_y(line: np.ndarray, y: float) -> float:
    a, b, c = line
    if abs(float(a)) < 1e-6:
        raise ValueError("cannot solve x for a horizontal line")
    return float(-(b * y + c) / a)


def intersect_lines(line_a: np.ndarray, line_b: np.ndarray) -> np.ndarray:
    point = np.cross(line_a, line_b)
    if abs(float(point[2])) < 1e-6:
        raise ValueError("cannot intersect parallel border lines")
    return np.array([point[0] / point[2], point[1] / point[2]], dtype=np.float32)


def find_left_border_line(image: np.ndarray, points: np.ndarray, seam_x: float) -> np.ndarray | None:
    tl, tr, br, bl = order_points(points)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (3, 3), 0), 30, 100)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=28, minLineLength=35, maxLineGap=10)
    if lines is None:
        return None

    outer_left_line = line_through_points(tl, bl)
    top_y = float(min(tl[1], tr[1]) - 20)
    bottom_y = float(max(bl[1], br[1]) + 20)
    candidates: list[tuple[float, float, np.ndarray]] = []
    for raw_line in lines[:, 0, :]:
        x1, y1, x2, y2 = [float(value) for value in raw_line]
        dx = x2 - x1
        dy = y2 - y1
        length = float(np.hypot(dx, dy))
        if length < 35:
            continue
        angle = abs(float(np.degrees(np.arctan2(dy, dx))))
        if angle > 90:
            angle = 180 - angle
        if angle < 65:
            continue

        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        if center_y < top_y or center_y > bottom_y:
            continue
        try:
            outer_left_x = x_at_y(outer_left_line, center_y)
        except ValueError:
            continue
        if center_x <= outer_left_x + 4:
            continue
        if center_x >= seam_x + 10:
            continue

        candidates.append((length, center_x, np.array([[x1, y1], [x2, y2]], dtype=np.float32)))

    if not candidates:
        return None

    max_length = max(length for length, _, _ in candidates)
    long_candidates = [item for item in candidates if item[0] >= max(35.0, max_length * 0.55)]
    leftmost_center = min(center_x for _, center_x, _ in long_candidates)
    selected = [points for _, center_x, points in long_candidates if center_x <= leftmost_center + 25]
    if not selected:
        return None

    fit_points = np.concatenate(selected, axis=0).astype(np.float32)
    vx, vy, x0, y0 = [float(value) for value in cv2.fitLine(fit_points, cv2.DIST_L2, 0, 0.01, 0.01).reshape(4)]
    base = np.array([x0, y0], dtype=np.float32)
    direction = np.array([vx, vy], dtype=np.float32)
    return line_through_points(base, base + direction)


def find_left_front_boundary(image: np.ndarray, points: np.ndarray) -> float | None:
    tl, tr, br, bl = order_points(points)
    left = int(max(0, min(tl[0], bl[0])))
    right = int(min(image.shape[1] - 1, max(tr[0], br[0])))
    top = int(max(0, min(tl[1], tr[1]) + 0.15 * max(1.0, max(bl[1], br[1]) - min(tl[1], tr[1]))))
    bottom = int(min(image.shape[0] - 1, max(bl[1], br[1]) - 0.10 * max(1.0, max(bl[1], br[1]) - min(tl[1], tr[1]))))
    width = right - left
    if width < 80 or bottom <= top:
        return None

    search_start = int(left + width * 0.18)
    search_end = int(left + width * 0.50)
    if search_end <= search_start:
        return None

    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    window = max(4, int(width * 0.03))
    scores: list[tuple[float, int]] = []
    for x in range(search_start, search_end):
        left_slice = lab[top:bottom, max(0, x - window) : x]
        right_slice = lab[top:bottom, x : min(image.shape[1], x + window)]
        if left_slice.size == 0 or right_slice.size == 0:
            continue
        left_mean = left_slice.mean(axis=(0, 1))
        right_mean = right_slice.mean(axis=(0, 1))
        scores.append((float(np.linalg.norm(left_mean - right_mean)), x))

    if not scores:
        return None
    best_score = max(score for score, _ in scores)
    threshold = max(8.0, best_score * 0.15)
    plausible = [x for score, x in scores if score >= threshold]
    return float(min(plausible)) if plausible else None


def point_on_edge_at_x(start: np.ndarray, end: np.ndarray, x: float) -> np.ndarray:
    dx = float(end[0] - start[0])
    if abs(dx) < 1e-6:
        return np.array([x, start[1]], dtype=np.float32)
    t = (x - float(start[0])) / dx
    t = max(0.0, min(1.0, t))
    return np.array([x, float(start[1] + t * (end[1] - start[1]))], dtype=np.float32)


def draw_debug_overlay(image: np.ndarray, corners: np.ndarray, confidence: float) -> np.ndarray:
    debug = image.copy()
    pts = order_points(corners).astype(int)
    cv2.polylines(debug, [pts], True, (0, 255, 0), 3)
    for index, point in enumerate(pts):
        cv2.circle(debug, tuple(point), 6, (0, 0, 255), -1)
        cv2.putText(
            debug,
            str(index + 1),
            tuple(point + np.array([8, -8])),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (0, 0, 255),
            2,
            cv2.LINE_AA,
        )
    cv2.putText(
        debug,
        f"confidence={confidence:.2f}",
        (20, 35),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        (0, 128, 0),
        2,
        cv2.LINE_AA,
    )
    return debug


def parse_corner(value: str) -> tuple[float, float]:
    x_text, y_text = value.split(",", 1)
    return float(x_text), float(y_text)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Extract a flat board-game cover from a box image.")
    parser.add_argument("source", help="Path to the source image.")
    parser.add_argument(
        "--output-dir",
        default="cover-extraction-output",
        help="Directory for cover, debug, and metadata outputs.",
    )
    parser.add_argument("--max-dimension", type=int, default=1200, help="Maximum output width or height in pixels.")
    parser.add_argument(
        "--corner",
        action="append",
        default=[],
        help="Manual corner as x,y. Provide exactly four values in any order.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    manual_corners = [parse_corner(value) for value in args.corner]
    if manual_corners and len(manual_corners) != 4:
        parser.error("--corner must be provided exactly four times when used")
    result = extract_cover(
        args.source,
        args.output_dir,
        manual_corners=manual_corners or None,
        max_dimension=args.max_dimension,
    )
    print(result.metadata_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
