"""Batch parent owns one store child at a time and relays browser events."""
from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Mapping

from ludora.cancellation import CancellationToken, OperationCancelled, raise_if_cancelled
from ludora.owned_child import owned_command, terminate_and_reap_tree
from ludora.operations import ItemDiscoveryRunResult
from ludora.product_discovery_throttle import ProductDiscoveryRequestThrottle


EVENT_PREFIX = "@@LUDORA_OPERATION_EVENT@@"


class StoreChildFailed(RuntimeError):
    pass


class StoreChildCleanupFailed(RuntimeError):
    pass


def run_store_in_child(*, database_url: str, current_env: Mapping[str, str], store_id: int,
                       website_url: str, platform: str, store_name: str, env_file: str,
                       run_id: str, product_request_throttle: ProductDiscoveryRequestThrottle,
                       cancellation_token: CancellationToken | None = None,
                       store_stall_seconds: float = 900.0,
                       worker_command: list[str] | None = None) -> ItemDiscoveryRunResult:
    command = worker_command or [sys.executable, "-m", "ludora.store_discovery_worker"]
    environment = dict(os.environ)
    environment.update(current_env)
    package_src = os.path.dirname(os.path.dirname(__file__))
    environment["PYTHONPATH"] = os.pathsep.join(filter(None, (package_src, environment.get("PYTHONPATH", ""))))
    process = subprocess.Popen(
        owned_command(command), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1, env=environment,
    )
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    events: queue.Queue[dict] = queue.Queue()
    active_browser: dict[str, dict] = {}
    last_activity = [time.monotonic()]

    def read_output() -> None:
        try:
            for line in process.stdout:
                try:
                    events.put(json.loads(line))
                except ValueError:
                    events.put({"kind": "error", "error": "Malformed store child response"})
        finally:
            events.put({"kind": "eof"})

    def read_errors() -> None:
        for line in process.stderr:
            if line.startswith(EVENT_PREFIX):
                try:
                    frame = json.loads(line[len(EVENT_PREFIX):])
                except ValueError:
                    frame = {}
                if frame.get("event") == "item_discovery.browser.started":
                    active_browser[str(frame.get("fetch_id"))] = frame
                    last_activity[0] = time.monotonic()
                elif frame.get("event") == "item_discovery.browser.completed":
                    active_browser.pop(str(frame.get("fetch_id")), None)
                    last_activity[0] = time.monotonic()
            sys.stderr.write(line)
            sys.stderr.flush()

    out_thread = threading.Thread(target=read_output, daemon=True)
    err_thread = threading.Thread(target=read_errors, daemon=True)
    out_thread.start()
    err_thread.start()
    configuration = {
        "database_url": database_url, "current_env": dict(current_env), "store_id": store_id,
        "website_url": website_url, "platform": platform, "store_name": store_name,
        "env_file": env_file, "run_id": run_id,
    }
    terminal_seen = False
    child_reaped = False
    try:
        process.stdin.write(json.dumps(configuration) + "\n")
        process.stdin.flush()
        while True:
            raise_if_cancelled(cancellation_token)
            if time.monotonic() - last_activity[0] >= store_stall_seconds:
                raise StoreChildFailed(f"Store {store_id} made no progress for {store_stall_seconds:g} seconds")
            try:
                message = events.get(timeout=0.1)
            except queue.Empty:
                continue
            kind = message.get("kind")
            if kind == "throttle":
                wait = product_request_throttle.wait_before_request(cancellation_token)
                process.stdin.write(json.dumps({"command": "permit", "delay_seconds": wait.delay_seconds}) + "\n")
                process.stdin.flush()
                last_activity[0] = time.monotonic()
            elif kind == "result":
                terminal_seen = True
                try:
                    # The Linux owned-child wrapper may spend its full three
                    # seconds reaping descendants after the store reports.
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired as exc:
                    raise StoreChildFailed(f"Store {store_id} did not exit after reporting a result") from exc
                if process.returncode != 0:
                    raise StoreChildFailed(f"Store {store_id} exited with status {process.returncode}")
                return ItemDiscoveryRunResult(**message["value"])
            elif kind == "error":
                terminal_seen = True
                raise_if_cancelled(cancellation_token)
                raise StoreChildFailed(str(message.get("error") or "Store child failed"))
            elif kind == "eof":
                raise_if_cancelled(cancellation_token)
                raise StoreChildFailed(f"Store {store_id} child exited without a result")
    except OperationCancelled:
        if process.poll() is None:
            if os.name == "nt":
                terminate_and_reap_tree(process, allow_exited_root=terminal_seen)
                child_reaped = True
            else:
                process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
        raise
    except StoreChildFailed:
        raise
    except Exception as exc:
        raise StoreChildFailed(f"Store {store_id} child execution failed: {exc}") from exc
    finally:
        try:
            if not child_reaped:
                terminate_and_reap_tree(process, allow_exited_root=terminal_seen)
        except Exception as exc:
            if process.poll() is not None:
                out_thread.join(timeout=2)
                err_thread.join(timeout=2)
                process.stdin.close()
                process.stdout.close()
                process.stderr.close()
            raise StoreChildCleanupFailed(f"Cannot verify store {store_id} process tree cleanup: {exc}") from exc
        out_thread.join(timeout=2)
        err_thread.join(timeout=2)
        if out_thread.is_alive() or err_thread.is_alive():
            raise StoreChildCleanupFailed(f"Store {store_id} output pipes remained open after process-tree cleanup")
        # A killed store may have emitted 'started' without reaching its
        # finally block. Pair the exact frame after its process tree is reaped.
        for frame in list(active_browser.values()):
            completed = {**frame, "event": "item_discovery.browser.completed"}
            print(EVENT_PREFIX + json.dumps(completed, separators=(",", ":")), file=sys.stderr, flush=True)
        process.stdin.close()
        process.stdout.close()
        process.stderr.close()
