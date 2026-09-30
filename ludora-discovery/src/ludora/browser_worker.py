"""Private JSON-lines browser process; stdout carries protocol only."""
from __future__ import annotations

import json
import sys

from ludora.browser_fetch import BrowserTextFetcher


class _WorkerProtocolError(RuntimeError):
    pass


def _send(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


class _ForwardTrace:
    def log(self, event: str, **fields: object) -> None:
        _send({"kind": "trace", "event": event, "fields": fields})


def main() -> int:
    session: BrowserTextFetcher | None = None
    for line in sys.stdin:
        try:
            request = json.loads(line)
            command = request["command"]
            if command == "start":
                session = BrowserTextFetcher(
                    timeout_ms=int(request.get("timeout_ms", 30_000)),
                    trace_logger=_ForwardTrace(),
                    max_fetches=request.get("max_fetches"),
                    max_age_seconds=request.get("max_age_seconds"),
                )
                session.__enter__()
                _send({"kind": "result", "value": None})
            elif command == "fetch":
                if session is None:
                    raise RuntimeError("Browser has not started")

                def before_navigation(url: str) -> None:
                    _send({"kind": "navigation", "url": url})
                    line = sys.stdin.readline()
                    if not line:
                        raise _WorkerProtocolError("Navigation permit channel closed")
                    try:
                        response = json.loads(line)
                    except ValueError as exc:
                        raise _WorkerProtocolError("Malformed navigation permit") from exc
                    if response.get("command") != "permit":
                        raise _WorkerProtocolError("Navigation was not permitted")

                fetched = session.fetch(request["url"], before_navigation=before_navigation)
                _send({
                    "kind": "result",
                    "value": None if fetched is None else {
                        "url": fetched.url,
                        "text": fetched.text,
                        "status_code": fetched.status_code,
                        "retry_after_seconds": fetched.retry_after_seconds,
                        "error": fetched.error,
                        "error_type": fetched.error_type,
                    },
                    "last_failure": session.last_failure,
                })
            elif command == "reset":
                if session is None:
                    raise RuntimeError("Browser has not started")
                session.reset_context()
                _send({"kind": "result", "value": None})
            elif command == "close":
                if session is not None:
                    session.__exit__(None, None, None)
                _send({"kind": "result", "value": None})
                return 0
            else:
                raise ValueError(f"Unknown browser command: {command}")
        except _WorkerProtocolError as exc:
            _send({"kind": "protocol_error", "error": str(exc)[:1000], "error_type": type(exc).__name__})
            return 70
        except Exception as exc:
            _send({"kind": "error", "error": str(exc)[:1000], "error_type": type(exc).__name__})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
