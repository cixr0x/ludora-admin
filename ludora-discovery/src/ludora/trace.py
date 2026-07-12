from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any, Protocol


class TraceLogger(Protocol):
    def log(self, event: str, **fields: object) -> None:
        ...


class DatabaseTraceLogger:
    def __init__(self, connection: Any, *, run_id: str, source: str = "discovery") -> None:
        self.connection = connection
        self.run_id = run_id
        self.source = source
        self.started_at = time.monotonic()

    def log(self, event: str, **fields: object) -> None:
        payload = {
            "elapsed_ms": int((time.monotonic() - self.started_at) * 1000),
            **fields,
        }
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(
                    """
                    insert into store_item_discovery_trace_log (
                        run_id,
                        source,
                        event,
                        payload,
                        created_at
                    )
                    values (%s, %s, %s, %s::jsonb, %s)
                    """,
                    (
                        self.run_id,
                        self.source,
                        event,
                        json.dumps(payload, ensure_ascii=False, default=str, separators=(",", ":")),
                        datetime.now(timezone.utc),
                    ),
                )
            self.connection.commit()
        except Exception:
            try:
                self.connection.rollback()
            except Exception:
                pass
            return


class NullTraceLogger:
    def log(self, event: str, **fields: object) -> None:
        return


def create_item_discovery_trace_logger(
    connection: Any,
    run_id: str,
) -> TraceLogger:
    return DatabaseTraceLogger(connection, run_id=run_id)
