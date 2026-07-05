from __future__ import annotations

import argparse
import json
import signal
import sys

from ludora.cancellation import CancellationToken, OperationCancelled
from ludora.operations import (
    EmbeddingRefreshMode,
    run_item_discovery_batch,
    run_item_discovery,
    run_item_embeddings,
    run_item_update,
    run_store_discovery,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one Ludora discovery operation and print JSON.")
    parser.add_argument("--env-file", default=".env", help="Path to the .env file used by the operation.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("store-discovery")

    item_discovery = subparsers.add_parser("item-discovery")
    item_discovery.add_argument("--store-id", type=int, required=True)
    item_discovery.add_argument("--website-url", required=True)
    item_discovery.add_argument("--store-name", default="")
    item_discovery.add_argument("--platform", default="")

    item_discovery_batch = subparsers.add_parser("item-discovery-batch")
    item_discovery_batch.add_argument("--store-id", type=int, action="append", default=[])

    item_update = subparsers.add_parser("item-update")
    item_update.add_argument("--store-id", type=int, action="append", default=[])

    item_embeddings = subparsers.add_parser("item-embeddings")
    item_embeddings.add_argument("--refresh-mode", choices=["missing", "full"], default="missing")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cancellation_token = CancellationToken()
    _install_signal_handlers(cancellation_token)

    try:
        result = _run_command(args, cancellation_token)
    except OperationCancelled:
        print(json.dumps({"cancelled": True}), file=sys.stderr)
        return 130
    except Exception as exc:
        print(json.dumps({"error": {"message": str(exc)}}), file=sys.stderr)
        return 1

    print(json.dumps({"result": result.to_dict()}))
    return 0


def _run_command(args: argparse.Namespace, cancellation_token: CancellationToken):
    if args.command == "store-discovery":
        return run_store_discovery(env_file=args.env_file, cancellation_token=cancellation_token)
    if args.command == "item-discovery":
        return run_item_discovery(
            store_id=args.store_id,
            website_url=args.website_url,
            store_name=args.store_name,
            platform=args.platform.strip().casefold(),
            env_file=args.env_file,
            cancellation_token=cancellation_token,
        )
    if args.command == "item-discovery-batch":
        store_ids = _selected_store_ids(args.store_id)
        return run_item_discovery_batch(
            env_file=args.env_file,
            cancellation_token=cancellation_token,
            store_ids=store_ids,
        )
    if args.command == "item-update":
        store_ids = _selected_store_ids(args.store_id)
        return run_item_update(
            env_file=args.env_file,
            cancellation_token=cancellation_token,
            store_ids=store_ids,
        )
    if args.command == "item-embeddings":
        return run_item_embeddings(
            refresh_mode=args.refresh_mode,
            env_file=args.env_file,
            cancellation_token=cancellation_token,
        )
    raise RuntimeError(f"Unknown operation command: {args.command}")


def _selected_store_ids(raw_store_ids: list[int]) -> list[int] | None:
    if not raw_store_ids:
        return None
    if any(store_id <= 0 for store_id in raw_store_ids):
        raise ValueError("store ids must be positive integers")
    if len(set(raw_store_ids)) != len(raw_store_ids):
        raise ValueError("store ids must not contain duplicates")
    return raw_store_ids


def _install_signal_handlers(cancellation_token: CancellationToken) -> None:
    def request_cancel(_signum: int, _frame: object) -> None:
        cancellation_token.cancel()

    signal.signal(signal.SIGINT, request_cancel)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, request_cancel)


if __name__ == "__main__":
    raise SystemExit(main())
