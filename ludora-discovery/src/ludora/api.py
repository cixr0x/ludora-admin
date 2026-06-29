from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Protocol
from urllib.parse import urlparse

from ludora.operations import OperationAlreadyRunning, OperationNotRunning, StoreDiscoveryRunManager


class RunManager(Protocol):
    def start_store_discovery(self):
        ...

    def start_item_discovery(self, store_id: int, website_url: str):
        ...

    def start_item_update(self):
        ...

    def start_item_embeddings(self, refresh_mode: str):
        ...

    def get_run(self, run_id: str):
        ...

    def get_latest_run(self):
        ...

    def cancel_run(self, run_id: str):
        ...


def route_request(
    method: str,
    raw_path: str,
    manager: RunManager,
    body: dict[str, object] | None = None,
) -> tuple[int, dict[str, object]]:
    path = urlparse(raw_path).path.rstrip("/") or "/"

    if method == "GET" and path == "/health":
        return 200, {"status": "ok", "service": "ludora-discovery-api"}

    if method == "POST" and path == "/operations/store-discovery-runs":
        try:
            run = manager.start_store_discovery()
        except OperationAlreadyRunning as exc:
            return 409, {"error": {"message": str(exc)}}
        return 202, {"data": run.to_dict()}

    item_discovery = _parse_item_discovery_path(path)
    if method == "POST" and item_discovery is not None:
        store_id = item_discovery
        request_body = body or {}
        website_url = str(request_body.get("website_url", "")).strip()
        if store_id <= 0:
            return 400, {"error": {"message": "store id must be a positive integer"}}
        if not website_url:
            return 400, {"error": {"message": "website_url is required"}}
        try:
            run = manager.start_item_discovery(store_id, website_url)
        except OperationAlreadyRunning as exc:
            return 409, {"error": {"message": str(exc)}}
        return 202, {"data": run.to_dict()}

    if method == "POST" and path == "/operations/item-update-runs":
        try:
            run = manager.start_item_update()
        except OperationAlreadyRunning as exc:
            return 409, {"error": {"message": str(exc)}}
        return 202, {"data": run.to_dict()}

    if method == "POST" and path == "/operations/item-embedding-runs":
        refresh_mode = str((body or {}).get("refresh_mode", "missing")).strip().lower() or "missing"
        if refresh_mode not in {"missing", "full"}:
            return 400, {"error": {"message": "refresh_mode must be missing or full"}}
        try:
            run = manager.start_item_embeddings(refresh_mode)
        except OperationAlreadyRunning as exc:
            return 409, {"error": {"message": str(exc)}}
        return 202, {"data": run.to_dict()}

    if method == "GET" and path == "/operations/store-discovery-runs/latest":
        run = manager.get_latest_run()
        return 200, {"data": run.to_dict() if run else None}

    prefix = "/operations/store-discovery-runs/"
    if method == "POST" and path.startswith(prefix) and path.endswith("/cancel"):
        run_id = path.removeprefix(prefix).removesuffix("/cancel").strip("/")
        try:
            run = manager.cancel_run(run_id)
        except OperationNotRunning as exc:
            return 409, {"error": {"message": str(exc)}}
        if run is None:
            return 404, {"error": {"message": "Run not found"}}
        return 202, {"data": run.to_dict()}

    if method == "GET" and path.startswith(prefix):
        run_id = path.removeprefix(prefix)
        run = manager.get_run(run_id)
        if run is None:
            return 404, {"error": {"message": "Run not found"}}
        return 200, {"data": run.to_dict()}

    return 404, {"error": {"message": "Route not found"}}


def _parse_item_discovery_path(path: str) -> int | None:
    prefix = "/operations/stores/"
    suffix = "/item-discovery-runs"
    if not path.startswith(prefix) or not path.endswith(suffix):
        return None
    raw_store_id = path.removeprefix(prefix).removesuffix(suffix).strip("/")
    try:
        return int(raw_store_id)
    except ValueError:
        return 0


def create_handler(manager: StoreDiscoveryRunManager):
    class DiscoveryApiHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self._handle_request("GET")

        def do_POST(self) -> None:
            self._handle_request("POST")

        def log_message(self, format: str, *args: object) -> None:
            return

        def _handle_request(self, method: str) -> None:
            try:
                request_body = self._read_json_body()
            except ValueError:
                status, payload = 400, {"error": {"message": "Invalid JSON body"}}
            else:
                status, payload = route_request(method, self.path, manager, request_body)
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_json_body(self) -> dict[str, object] | None:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0:
                return None
            raw_body = self.rfile.read(content_length)
            parsed = json.loads(raw_body.decode("utf-8"))
            if not isinstance(parsed, dict):
                raise ValueError("JSON body must be an object")
            return parsed

    return DiscoveryApiHandler


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the Ludora discovery operations API.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--env-file", default=".env", help="Path to the .env file used by discovery runs.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    manager = StoreDiscoveryRunManager(env_file=args.env_file)
    server = ThreadingHTTPServer((args.host, args.port), create_handler(manager))
    print(f"ludora-discovery-api listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
