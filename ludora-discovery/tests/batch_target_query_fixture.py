"""Evaluate the batch target SELECT over fixture CTEs, without DDL or DML."""
import json
import sqlite3


TARGET_COLUMNS = (
    "id", "store_id", "source_url", "source_url_origin", "is_boardgame",
    "is_boardgame_confirmed", "item_id", "listing_status", "store_active",
    "availability", "consecutive_update_failures", "next_update_at",
    "update_lease_token", "update_lease_expires_at", "refreshed_date",
)


def batch_target_row(record, **changes):
    row = {
        "id": record.store_item_id,
        "store_id": record.store_id,
        "source_url": record.source_url,
        "source_url_origin": record.source_url_origin,
        "is_boardgame": record.is_boardgame,
        "is_boardgame_confirmed": record.is_boardgame_confirmed,
        "item_id": record.item_id,
        "listing_status": record.listing_status,
        "store_active": record.store_active,
        "availability": record.availability,
        "consecutive_update_failures": 0,
        "next_update_at": None,
        "update_lease_token": None,
        "update_lease_expires_at": None,
        "refreshed_date": "2026-10-01T00:00:00+00:00",
    }
    row.update(changes)
    return row


class BatchTargetSelectConnection:
    """A SELECT-only DB boundary using the actual repository predicates.

    Fixture rows enter via JSON-valued parameters in CTEs. No table is created,
    inserted into, updated or deleted. PostgreSQL placeholders and now() are the
    only adapted syntax; the production WHERE/ORDER/LIMIT expressions execute.
    """

    def __init__(self, rows, stores=None):
        self.rows = rows
        self.stores = stores if stores is not None else [
            {"id": store_id, "active": True} for store_id in {row["store_id"] for row in rows}
        ]
        self.executions = []
        self.commits = 0
        self._connection = sqlite3.connect(":memory:")
        self._connection.create_function("now", 0, lambda: "2026-10-13T18:00:00+00:00")

    def cursor(self):
        return _SelectCursor(self)

    def commit(self):
        self.commits += 1

    def close(self):
        self._connection.close()


class _SelectCursor:
    def __init__(self, connection):
        self.connection = connection
        self._cursor = connection._connection.cursor()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self._cursor.close()

    def execute(self, sql, params):
        if not sql.lstrip().casefold().startswith("select "):
            raise AssertionError("Batch target fixture accepts only a SELECT")
        self.connection.executions.append((sql, params))
        columns = ", ".join(f"json_extract(value, '$.{column}') as {column}" for column in TARGET_COLUMNS)
        fixture_ctes = (
            f"with store_items as (select {columns} from json_each(?)), "
            "stores as (select json_extract(value, '$.id') as id, "
            "json_extract(value, '$.active') as active from json_each(?)) "
        )
        self._cursor.execute(
            fixture_ctes + sql.replace("%s", "?"),
            (json.dumps(self.connection.rows), json.dumps(self.connection.stores), *params),
        )

    def fetchall(self):
        return self._cursor.fetchall()
