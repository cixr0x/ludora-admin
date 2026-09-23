"""One persistent browser child per store with bounded product fetch recovery."""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

from ludora.cancellation import CancellationToken, OperationCancelled, raise_if_cancelled
from ludora.discovery_browser_lifecycle import browser_watchdog_scope
from ludora.owned_child import owned_command, terminate_and_reap_tree
from ludora.trace import TraceLogger
from ludora.webfetch import FetchResult


class BrowserWorkerTimeout(RuntimeError):
    pass


class BrowserWorkerFetchError(RuntimeError):
    pass


class BrowserWorkerProtocolError(RuntimeError):
    pass


class BrowserFetchFailed(RuntimeError):
    """A product fetch failed after one fresh-worker retry."""


class BrowserFetchTimeout(BrowserFetchFailed):
    """Both bounded attempts for a product exhausted their browser worker."""


class _ProcessBrowserWorker:
    def __init__(self, *, timeout_seconds: float, trace_logger: TraceLogger | None = None,
                 timeout_ms: int = 30_000, max_fetches: int | None = None,
                 max_age_seconds: float | None = None,
                 worker_command: list[str] | None = None) -> None:
        self.timeout_seconds = timeout_seconds
        self.trace_logger = trace_logger
        self.timeout_ms = timeout_ms
        self.max_fetches = max_fetches
        self.max_age_seconds = max_age_seconds
        self.worker_command = worker_command or [sys.executable, "-m", "ludora.browser_worker"]
        self.process: subprocess.Popen | None = None
        self.responses: queue.Queue[dict] = queue.Queue()
        self.last_failure: dict | None = None
        self.terminal_seen = False

    def start(self, *, cancellation_token: CancellationToken | None = None) -> None:
        raise_if_cancelled(cancellation_token)
        environment = dict(os.environ)
        environment["LUDORA_DISCOVERY_BROWSER_WATCHDOG"] = "0"
        package_src = str(Path(__file__).resolve().parents[1])
        environment["PYTHONPATH"] = os.pathsep.join(filter(None, (package_src, environment.get("PYTHONPATH", ""))))
        self.process = subprocess.Popen(
            owned_command(self.worker_command),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr,
            text=True, encoding="utf-8", bufsize=1, env=environment,
        )
        threading.Thread(target=self._read_responses, daemon=True).start()
        try:
            self.request("start", timeout_ms=self.timeout_ms, max_fetches=self.max_fetches,
                         max_age_seconds=self.max_age_seconds,
                         cancellation_token=cancellation_token)
        except BaseException:
            self.terminate_and_reap()
            raise

    def _read_responses(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        try:
            for line in self.process.stdout:
                self.responses.put(json.loads(line))
        except (OSError, ValueError) as exc:
            self.responses.put({"kind": "protocol_error", "error": str(exc), "error_type": type(exc).__name__})
        finally:
            self.responses.put({"kind": "eof"})

    def _write(self, payload: dict) -> None:
        assert self.process is not None and self.process.stdin is not None
        try:
            self.process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise BrowserWorkerProtocolError("Browser worker exited while receiving a command") from exc

    def request(self, command: str, url: str | None = None, *,
                before_navigation: Callable[[str], None] | None = None,
                cancellation_token: CancellationToken | None = None, **kwargs) -> FetchResult | None:
        self.terminal_seen = False
        self._write({"command": command, **({"url": url} if url is not None else {}), **kwargs})
        deadline = time.monotonic() + self.timeout_seconds
        while True:
            raise_if_cancelled(cancellation_token)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BrowserWorkerTimeout(f"Browser {command} exceeded {self.timeout_seconds:g} seconds")
            try:
                message = self.responses.get(timeout=min(0.1, remaining))
            except queue.Empty:
                continue
            kind = message.get("kind")
            if kind == "navigation":
                if before_navigation is not None:
                    before_navigation(str(message["url"]))
                raise_if_cancelled(cancellation_token)
                self._write({"command": "permit"})
            elif kind == "trace":
                if self.trace_logger is not None:
                    self.trace_logger.log(str(message.get("event", "browser_fetch.worker.trace")), **message.get("fields", {}))
            elif kind == "result":
                self.terminal_seen = True
                self.last_failure = message.get("last_failure")
                value = message.get("value")
                return FetchResult(**value) if isinstance(value, dict) else None
            elif kind == "error":
                self.terminal_seen = True
                error = f"Browser worker {message.get('error_type', 'error')}: {message.get('error', '')}"
                if command == "fetch":
                    raise BrowserWorkerFetchError(error)
                raise RuntimeError(error)
            elif kind == "protocol_error":
                raise BrowserWorkerProtocolError(str(message.get("error") or "Browser worker protocol failed"))
            elif kind == "eof":
                raise BrowserWorkerProtocolError("Browser worker exited before responding")
            else:
                raise BrowserWorkerProtocolError(f"Unexpected browser worker response: {kind}")

    def terminate_and_reap(self) -> None:
        if self.process is None:
            return
        process, self.process = self.process, None
        terminate_and_reap_tree(process, allow_exited_root=self.terminal_seen)
        if process.stdin is not None:
            process.stdin.close()
        if process.stdout is not None:
            process.stdout.close()


class SupervisedBrowserFetcher:
    def __init__(self, *, timeout_seconds: float = 100.0, trace_logger: TraceLogger | None = None,
                 worker_factory: Callable[[], object] | None = None,
                 timeout_ms: int = 30_000, max_fetches: int | None = None,
                 max_age_seconds: float | None = None,
                 cancellation_token: CancellationToken | None = None) -> None:
        self.timeout_seconds = timeout_seconds
        self.trace_logger = trace_logger
        self.cancellation_token = cancellation_token
        self.worker_factory = worker_factory or (lambda: _ProcessBrowserWorker(
            timeout_seconds=timeout_seconds, trace_logger=trace_logger, timeout_ms=timeout_ms,
            max_fetches=max_fetches, max_age_seconds=max_age_seconds,
        ))
        self.worker = None
        self.last_failure: dict | None = None

    def __enter__(self) -> SupervisedBrowserFetcher:
        with browser_watchdog_scope(phase="startup"):
            self._start_worker()
        return self

    def _start_worker(self) -> None:
        raise_if_cancelled(self.cancellation_token)
        worker = self.worker_factory()
        try:
            worker.start(cancellation_token=self.cancellation_token)
        except BaseException:
            worker.terminate_and_reap()
            raise
        self.worker = worker

    def _discard_worker(self) -> None:
        if self.worker is not None:
            worker, self.worker = self.worker, None
            worker.terminate_and_reap()

    def fetch(self, url: str, *, before_navigation: Callable[[str], None] | None = None,
              cancellation_token: CancellationToken | None = None) -> FetchResult | None:
        cancellation_token = cancellation_token or self.cancellation_token
        for attempt in (1, 2):
            raise_if_cancelled(cancellation_token)
            if self.worker is None:
                with browser_watchdog_scope(phase="startup"):
                    self._start_worker()
            with browser_watchdog_scope(url):
                try:
                    result = self.worker.request("fetch", url, before_navigation=before_navigation,
                                                 cancellation_token=cancellation_token)
                    self.last_failure = getattr(self.worker, "last_failure", None)
                    return result
                except OperationCancelled:
                    self._discard_worker()
                    raise
                except (BrowserWorkerTimeout, BrowserWorkerFetchError) as exc:
                    self._discard_worker()
                    if self.trace_logger is not None:
                        event = "browser_fetch.hard_timeout" if isinstance(exc, BrowserWorkerTimeout) else "browser_fetch.worker_error"
                        self.trace_logger.log(event, source_url=url,
                                              attempt=attempt, timeout_seconds=self.timeout_seconds,
                                              error=str(exc))
                    if attempt == 2:
                        if isinstance(exc, BrowserWorkerTimeout):
                            raise BrowserFetchTimeout(f"Browser fetch timed out twice for {url}") from exc
                        raise BrowserFetchFailed(f"Browser fetch failed twice for {url}: {exc}") from exc
        raise AssertionError("Unreachable browser retry state")

    def reset_context(self) -> None:
        with browser_watchdog_scope(phase="startup"):
            if self.worker is None:
                self._start_worker()
            try:
                self.worker.request("reset", cancellation_token=self.cancellation_token)
            except BrowserWorkerTimeout:
                self._discard_worker()
                raise

    def __exit__(self, exc_type, exc, traceback) -> None:
        if self.worker is None:
            return
        with browser_watchdog_scope(phase="cleanup"):
            try:
                self.worker.request("close")
            finally:
                self._discard_worker()
