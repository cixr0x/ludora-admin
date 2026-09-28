"""Canonical phash_dct256_v1; shared by catalog writers and the Node adapter."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import cv2
import numpy as np

METHOD = "phash_dct256_v1"
MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024


def hash_image_bytes(encoded: bytes) -> str:
    if not encoded:
        raise ValueError("Image is empty")
    # IMREAD_COLOR applies supported EXIF orientation and discards alpha.
    image = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Could not decode catalog image")
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    normalized = cv2.resize(gray, (64, 64), interpolation=cv2.INTER_AREA)
    coefficients = cv2.dct(normalized.astype(np.float32))[:16, :16].reshape(-1)
    median = np.median(coefficients[1:])
    value = 0
    for bit in coefficients > median:
        value = (value << 1) | int(bit)
    return f"{value:064x}"


def hash_image_url(url: str) -> str:
    if urlparse(url).scheme not in {"http", "https"}:
        raise ValueError("Catalog image must use HTTP(S)")
    request = Request(url, headers={"User-Agent": "LudoraCatalogImageHash/1.0", "Cache-Control": "no-cache"})
    with urlopen(request, timeout=30) as response:
        encoded = response.read(MAX_DOWNLOAD_BYTES + 1)
    if len(encoded) > MAX_DOWNLOAD_BYTES:
        raise ValueError("Catalog image exceeds the 25 MB download limit")
    return hash_image_bytes(encoded)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate canonical catalog pHash JSON; no database writes.")
    parser.add_argument("image", nargs="?", help="Local image path; otherwise read encoded image bytes from stdin")
    args = parser.parse_args()
    try:
        encoded = Path(args.image).read_bytes() if args.image else sys.stdin.buffer.read(MAX_DOWNLOAD_BYTES + 1)
        if len(encoded) > MAX_DOWNLOAD_BYTES:
            raise ValueError("Catalog image exceeds the 25 MB input limit")
        print(json.dumps({"method": METHOD, "hash": hash_image_bytes(encoded)}))
        return 0
    except (OSError, ValueError, cv2.error) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
