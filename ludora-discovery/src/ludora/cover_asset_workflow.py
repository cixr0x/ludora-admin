from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

import cv2


DEFAULT_OUTPUT_ROOT = Path("output") / "cover-assets"
METADATA_FILENAME = "cover_asset.json"
IMAGE_EXTENSIONS = {".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
EDITED_CANDIDATES = ("edited.webp", "edited.png", "edited.jpg", "edited.jpeg", "edited.tif", "edited.tiff")


@dataclass(frozen=True)
class CoverAssetMetadata:
    slug: str
    name: str
    source: str
    source_path: str
    edited_path: str
    final_path: str
    s3_key: str
    public_url: str = ""
    uploaded: bool = False
    uploaded_at: str = ""


@dataclass(frozen=True)
class FinishedCoverAsset:
    final_path: str
    s3_key: str
    public_url: str
    uploaded: bool
    copied_to_clipboard: bool


S3Uploader = Callable[[Path, str, str, str, str], None]


def slugify(value: str, fallback: str = "cover") -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", normalized.casefold()).strip("-")
    return slug or fallback


def build_s3_key(slug: str, prefix: str = "") -> str:
    clean_prefix = prefix.strip().strip("/")
    filename = f"{slugify(slug)}.webp"
    return f"{clean_prefix}/{filename}" if clean_prefix else filename


def public_url_for_key(base_url: str, key: str) -> str:
    clean_base = base_url.rstrip("/")
    encoded_key = "/".join(quote(part) for part in key.strip("/").split("/"))
    return f"{clean_base}/{encoded_key}" if clean_base else ""


def is_http_url(value: str) -> bool:
    return urlparse(value).scheme in {"http", "https"}


def stage_cover_asset(
    source: str,
    name: str,
    output_root: str | Path = DEFAULT_OUTPUT_ROOT,
    slug: str | None = None,
    s3_prefix: str = "",
    open_editor: bool = False,
    editor: str | None = None,
) -> CoverAssetMetadata:
    asset_slug = slugify(slug or name)
    workspace = Path(output_root) / asset_slug
    workspace.mkdir(parents=True, exist_ok=True)

    source_path = fetch_source_image(source, workspace)
    metadata = CoverAssetMetadata(
        slug=asset_slug,
        name=name,
        source=source,
        source_path=str(source_path),
        edited_path=str(workspace / "edited.png"),
        final_path=str(workspace / f"{asset_slug}.webp"),
        s3_key=build_s3_key(asset_slug, s3_prefix),
    )
    write_metadata(metadata, workspace / METADATA_FILENAME)

    if open_editor:
        launch_editor(source_path, editor)

    return metadata


def finish_cover_asset(
    workspace: str | Path,
    edited_path: str | Path | None = None,
    quality: int = 90,
    upload: bool = False,
    bucket: str = "",
    s3_key: str = "",
    s3_prefix: str = "",
    public_base_url: str = "",
    copy_url: bool = False,
    env: Mapping[str, str] | None = None,
    uploader: S3Uploader | None = None,
) -> FinishedCoverAsset:
    workspace_path = Path(workspace)
    metadata_path = workspace_path / METADATA_FILENAME
    metadata = read_metadata(metadata_path)
    edited = resolve_edited_path(workspace_path, metadata, edited_path)
    final_path = Path(metadata.final_path)
    convert_to_webp(edited, final_path, quality)

    current_env = env if env is not None else os.environ
    resolved_bucket = bucket or current_env.get("LUDORA_COVER_S3_BUCKET", "").strip()
    resolved_key = s3_key or metadata.s3_key
    if not s3_key and s3_prefix:
        resolved_key = build_s3_key(metadata.slug, s3_prefix)

    uploaded = False
    if upload:
        if not resolved_bucket:
            raise ValueError("S3 upload requires --bucket or LUDORA_COVER_S3_BUCKET.")
        upload_func = uploader or upload_file_to_s3
        upload_func(final_path, resolved_bucket, resolved_key, "image/webp", "public, max-age=31536000, immutable")
        uploaded = True

    base_url = public_base_url or current_env.get("LUDORA_COVER_PUBLIC_BASE_URL", "").strip()
    public_url = public_url_for_key(base_url, resolved_key) if base_url else ""
    if not public_url and uploaded:
        public_url = f"s3://{resolved_bucket}/{resolved_key}"

    copied = False
    if copy_url:
        copied = copy_to_clipboard(public_url or str(final_path))

    updated_metadata = replace(
        metadata,
        final_path=str(final_path),
        s3_key=resolved_key,
        public_url=public_url,
        uploaded=uploaded,
        uploaded_at=datetime.now(timezone.utc).isoformat() if uploaded else metadata.uploaded_at,
    )
    write_metadata(updated_metadata, metadata_path)

    return FinishedCoverAsset(
        final_path=str(final_path),
        s3_key=resolved_key,
        public_url=public_url,
        uploaded=uploaded,
        copied_to_clipboard=copied,
    )


def fetch_source_image(source: str, workspace: Path) -> Path:
    if is_http_url(source):
        return download_source_image(source, workspace)

    source_path = Path(source).expanduser()
    if not source_path.exists():
        raise FileNotFoundError(f"Source image does not exist: {source_path}")
    suffix = normalized_image_suffix(source_path.suffix)
    destination = workspace / f"source{suffix}"
    shutil.copy2(source_path, destination)
    return destination


def download_source_image(source_url: str, workspace: Path) -> Path:
    request = Request(source_url, headers={"User-Agent": "LudoraCoverAsset/1.0"})
    with urlopen(request, timeout=30) as response:
        content = response.read()
        suffix = suffix_from_url_or_content_type(source_url, response.headers.get("Content-Type", ""))

    destination = workspace / f"source{suffix}"
    destination.write_bytes(content)
    return destination


def suffix_from_url_or_content_type(source_url: str, content_type: str) -> str:
    suffix = normalized_image_suffix(Path(urlparse(source_url).path).suffix)
    if suffix:
        return suffix

    guessed = mimetypes.guess_extension(content_type.split(";", 1)[0].strip().lower())
    return normalized_image_suffix(guessed or "") or ".jpg"


def normalized_image_suffix(suffix: str) -> str:
    clean_suffix = suffix.casefold()
    if clean_suffix == ".jpe":
        return ".jpg"
    return clean_suffix if clean_suffix in IMAGE_EXTENSIONS else ""


def resolve_edited_path(
    workspace: Path,
    metadata: CoverAssetMetadata,
    edited_path: str | Path | None = None,
) -> Path:
    candidates: list[Path] = []
    if edited_path is not None:
        candidates.append(Path(edited_path))
    candidates.append(Path(metadata.edited_path))
    candidates.extend(workspace / name for name in EDITED_CANDIDATES)

    for candidate in candidates:
        if candidate.exists():
            return candidate

    expected = ", ".join(str(path) for path in candidates)
    raise FileNotFoundError(f"No edited image found. Checked: {expected}")


def convert_to_webp(source_path: str | Path, output_path: str | Path, quality: int = 90) -> Path:
    source = Path(source_path)
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    if source.suffix.casefold() == ".webp" and source.resolve() != output.resolve():
        shutil.copy2(source, output)
        return output

    image = cv2.imread(str(source), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError(f"Edited image could not be read: {source}")

    webp_quality = max(1, min(100, int(quality)))
    params = [cv2.IMWRITE_WEBP_QUALITY, webp_quality] if hasattr(cv2, "IMWRITE_WEBP_QUALITY") else []
    if not cv2.imwrite(str(output), image, params):
        raise ValueError(f"Could not write WebP output: {output}")
    return output


def launch_editor(source_path: Path, editor: str | None = None) -> None:
    executable = editor or os.environ.get("LUDORA_GIMP_PATH", "").strip() or "gimp-3.exe"
    subprocess.Popen([executable, str(source_path)])


def upload_file_to_s3(
    file_path: Path,
    bucket: str,
    key: str,
    content_type: str,
    cache_control: str,
) -> None:
    try:
        import boto3
    except ImportError as exc:
        raise RuntimeError("S3 upload requires boto3. Run `python -m pip install -e .` from ludora-discovery.") from exc

    client = boto3.client("s3")
    client.upload_file(
        str(file_path),
        bucket,
        key,
        ExtraArgs={
            "ContentType": content_type,
            "CacheControl": cache_control,
        },
    )


def copy_to_clipboard(value: str) -> bool:
    if not value:
        return False

    try:
        if sys.platform == "win32":
            subprocess.run(
                ["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $args[0]", value],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        if sys.platform == "darwin":
            subprocess.run(["pbcopy"], input=value, text=True, check=True)
            return True
        for command in ("wl-copy", "xclip"):
            if shutil.which(command):
                args = [command] if command == "wl-copy" else [command, "-selection", "clipboard"]
                subprocess.run(args, input=value, text=True, check=True)
                return True
    except (OSError, subprocess.CalledProcessError):
        return False

    return False


def read_metadata(path: str | Path) -> CoverAssetMetadata:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return CoverAssetMetadata(
        slug=str(data["slug"]),
        name=str(data["name"]),
        source=str(data["source"]),
        source_path=str(data["source_path"]),
        edited_path=str(data["edited_path"]),
        final_path=str(data["final_path"]),
        s3_key=str(data["s3_key"]),
        public_url=str(data.get("public_url", "")),
        uploaded=bool(data.get("uploaded", False)),
        uploaded_at=str(data.get("uploaded_at", "")),
    )


def write_metadata(metadata: CoverAssetMetadata, path: str | Path) -> None:
    Path(path).write_text(json.dumps(asdict(metadata), indent=2, sort_keys=True), encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Stage and finish manually edited Spanish boardgame cover assets.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    stage = subparsers.add_parser("stage", help="Copy/download a source image and optionally open it in GIMP.")
    stage.add_argument("source", help="Local source image path or image URL.")
    stage.add_argument("--name", required=True, help="Boardgame name used for the workspace and default file name.")
    stage.add_argument("--slug", help="Override the generated file slug.")
    stage.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT), help="Root folder for staged cover workspaces.")
    stage.add_argument("--s3-prefix", default=os.environ.get("LUDORA_COVER_S3_PREFIX", ""), help="Optional S3 key prefix.")
    stage.add_argument("--open-editor", action="store_true", help="Open the staged source image in GIMP.")
    stage.add_argument("--editor", help="Editor executable. Defaults to LUDORA_GIMP_PATH or gimp-3.exe.")

    finish = subparsers.add_parser("finish", help="Convert the manually edited image to WebP and optionally upload it.")
    finish.add_argument("workspace", help="Workspace folder created by the stage command.")
    finish.add_argument("--edited", help="Edited image path. Defaults to edited.* inside the workspace.")
    finish.add_argument("--quality", type=int, default=90, help="WebP quality, 1-100.")
    finish.add_argument("--upload", action="store_true", help="Upload the WebP output to S3.")
    finish.add_argument("--bucket", default="", help="S3 bucket. Defaults to LUDORA_COVER_S3_BUCKET.")
    finish.add_argument("--s3-key", default="", help="Override the S3 object key.")
    finish.add_argument("--s3-prefix", default="", help="Override the S3 prefix while keeping the staged slug.")
    finish.add_argument(
        "--public-base-url",
        default="",
        help="Public CDN/S3 base URL. Defaults to LUDORA_COVER_PUBLIC_BASE_URL.",
    )
    finish.add_argument("--copy-url", action="store_true", help="Copy the final public URL, or final file path, to clipboard.")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "stage":
        metadata = stage_cover_asset(
            source=args.source,
            name=args.name,
            output_root=args.output_root,
            slug=args.slug,
            s3_prefix=args.s3_prefix,
            open_editor=args.open_editor,
            editor=args.editor,
        )
        print(f"Workspace: {Path(metadata.final_path).parent}")
        print(f"Source: {metadata.source_path}")
        print(f"Export edited image to: {metadata.edited_path}")
        print(f"Final WebP: {metadata.final_path}")
        print(f"S3 key: {metadata.s3_key}")
        return 0

    if args.command == "finish":
        result = finish_cover_asset(
            workspace=args.workspace,
            edited_path=args.edited,
            quality=args.quality,
            upload=args.upload,
            bucket=args.bucket,
            s3_key=args.s3_key,
            s3_prefix=args.s3_prefix,
            public_base_url=args.public_base_url,
            copy_url=args.copy_url,
        )
        print(f"Final WebP: {result.final_path}")
        print(f"S3 key: {result.s3_key}")
        if result.public_url:
            print(f"URL: {result.public_url}")
        print(f"Uploaded: {str(result.uploaded).lower()}")
        print(f"Copied to clipboard: {str(result.copied_to_clipboard).lower()}")
        return 0

    parser.error("Unknown command")
    return 2
