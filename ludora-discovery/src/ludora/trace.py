from __future__ import annotations

import json
import re
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from ludora.config import load_dotenv_values


class TraceLogger(Protocol):
    def log(self, event: str, **fields: object) -> None:
        ...


class JsonlTraceLogger:
    def __init__(self, path: str | Path, *, run_id: str) -> None:
        self.path = Path(path).resolve()
        self.run_id = run_id

    def log(self, event: str, **fields: object) -> None:
        record = {
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "run_id": self.run_id,
            "event": event,
            **fields,
        }
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as output:
                output.write(json.dumps(record, ensure_ascii=False, default=str, separators=(",", ":")))
                output.write("\n")
        except OSError:
            return


class NullTraceLogger:
    def log(self, event: str, **fields: object) -> None:
        return


def create_item_discovery_trace_logger(
    run_id: str,
    *,
    env: Mapping[str, str] | None = None,
    dotenv_path: str | Path = ".env",
) -> TraceLogger:
    trace_dir = resolve_discovery_trace_dir(env=env, dotenv_path=dotenv_path)
    if not trace_dir:
        return NullTraceLogger()
    filename = f"item-discovery-{_safe_filename(run_id)}.jsonl"
    return JsonlTraceLogger(Path(trace_dir) / filename, run_id=run_id)


def resolve_discovery_trace_dir(
    env: Mapping[str, str] | None = None,
    dotenv_path: str | Path = ".env",
) -> str:
    current_env = env or {}
    env_value = current_env.get("LUDORA_DISCOVERY_TRACE_DIR", "").strip()
    if env_value:
        return env_value
    return load_dotenv_values(dotenv_path).get("LUDORA_DISCOVERY_TRACE_DIR", "").strip()


def _safe_filename(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-") or "run"
