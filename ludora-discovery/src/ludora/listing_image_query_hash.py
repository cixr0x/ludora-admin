"""Bounded query-only box normalization; catalog pHash storage is unchanged."""
from __future__ import annotations

from dataclasses import asdict
import json
import os
import sys

# Bound OpenCV raster allocation before importing it in this standalone CLI.
os.environ["OPENCV_IO_MAX_IMAGE_PIXELS"] = "16000000"
import cv2
import numpy as np

from ludora.box_silhouette import detect_silhouette, flatten_cover_quadrilateral
from ludora.image_phash import METHOD, MAX_DOWNLOAD_BYTES, hash_image_bytes

MAX_DETECTION_DIMENSION = 2048
MAX_OUTPUT_DIMENSION = 1200
MAX_NORMALIZED_VARIANTS = 2
NORMALIZATION_METHOD = "box_silhouette_v1"


def valid_polygon(corners, image_shape: tuple[int, int]) -> bool:
    points = np.asarray(corners, dtype=np.float64)
    height, width = image_shape
    if points.shape != (4, 2) or not np.isfinite(points).all() or len(np.unique(points, axis=0)) != 4:
        return False
    if (points < 0).any() or (points[:, 0] > width - 1).any() or (points[:, 1] > height - 1).any():
        return False
    contour = points.astype(np.float32)
    return bool(cv2.isContourConvex(contour) and abs(cv2.contourArea(contour)) >= width * height * 0.01)


def hash_query_variants(encoded: bytes) -> dict:
    if not encoded or len(encoded) > MAX_DOWNLOAD_BYTES:
        raise ValueError("Listing image is empty or exceeds the 25 MB input limit")
    result = {"method": METHOD, "variants": [{"origin": "raw", "hash": hash_image_bytes(encoded)}],
              "normalization": {"method": NORMALIZATION_METHOD, "status": "no_faces",
                  "limits": {"decode_max_pixels": 16_000_000, "working_max_dimension": MAX_DETECTION_DIMENSION,
                             "flattened_max_dimension": MAX_OUTPUT_DIMENSION, "max_normalized_variants": MAX_NORMALIZED_VARIANTS}}}
    image = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Could not decode listing image")
    height, width = image.shape[:2]
    if height * width > 16_000_000:
        raise ValueError("Listing image exceeds the 16 megapixel decode limit")
    result["normalization"]["source_dimensions"] = {"width": width, "height": height}
    scale = min(1.0, MAX_DETECTION_DIMENSION / max(height, width))
    if scale < 1:
        image = cv2.resize(image, (max(2, round(width * scale)), max(2, round(height * scale))), interpolation=cv2.INTER_AREA)
    height, width = image.shape[:2]
    result["normalization"]["working_dimensions"] = {"width": width, "height": height}
    try:
        detection, _, _ = detect_silhouette(image)
        candidates = []
        if detection.two_face_cover is not None:
            cover = detection.two_face_cover
            candidates.append(("two_faces", 1, "two-face seam and larger-face selection", cover.cover_polygon,
                               cover.vanishing_aspect_ratio, cover.vanishing_confidence, cover.vanishing_focal_spread))
        else:
            for index, cover in enumerate(detection.three_face_covers[:MAX_NORMALIZED_VARIANTS], start=1):
                if cover.inside_silhouette and cover.convex:
                    candidates.append(("three_faces", index, cover.construction, cover.cover_polygon, None, 0.0, None))
        errors = []
        for kind, index, construction, polygon, aspect, confidence, spread in candidates:
            if not valid_polygon(polygon, (height, width)):
                errors.append(f"Face {index} has invalid or out-of-bounds geometry")
                continue
            try:
                flattened, geometry = flatten_cover_quadrilateral(
                    image, np.asarray(polygon), max_dimension=MAX_OUTPUT_DIMENSION,
                    target_aspect_ratio=aspect, vanishing_confidence=confidence, vanishing_focal_spread=spread,
                )
                success, buffer = cv2.imencode(".png", flattened)
                if not success:
                    raise ValueError("Could not encode flattened face")
                result["variants"].append({"origin": "box_silhouette", "hash": hash_image_bytes(buffer.tobytes()),
                    "face": {"type": kind, "index": index, "construction": construction,
                        "corners": [[float(x / (width - 1)), float(y / (height - 1))] for x, y in geometry.ordered_corners],
                        "width": geometry.width, "height": geometry.height, "geometry": asdict(geometry)}})
            except (ValueError, cv2.error) as error:
                errors.append(str(error))
        result["normalization"]["status"] = "completed" if len(result["variants"]) > 1 else "no_faces"
        if errors:
            result["normalization"]["errors"] = errors
    except (ValueError, cv2.error) as error:
        result["normalization"]["status"] = "error"
        result["normalization"]["error"] = str(error)
    return result


def main() -> int:
    cv2.setNumThreads(1)
    try:
        encoded = sys.stdin.buffer.read(MAX_DOWNLOAD_BYTES + 1)
        print(json.dumps(hash_query_variants(encoded), allow_nan=False))
        return 0
    except (ValueError, OSError, cv2.error) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
