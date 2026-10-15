"""Execute the discovery URL SELECT over JSON CTE rows, without DDL or DML."""
import json
import sqlite3


URL_COLUMNS = (
    "id", "store_id", "source_url", "source_url_origin", "store_active",
    "listing_status", "is_boardgame", "is_boardgame_confirmed", "item_id",
    "availability",
)


class DiscoveryUrlSelectConnection:
    def __init__(self, rows):
        self.rows = rows
        self._connection = sqlite3.connect(":memory:")

    def cursor(self):
        return _SelectCursor(self)

    def commit(self):
        raise AssertionError("Discovery URL existence must remain read-only")

    def rollback(self):
        raise AssertionError("Discovery URL existence must remain read-only")

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
            raise AssertionError("Discovery URL fixture accepts only a SELECT")
        columns = ", ".join(f"json_extract(value, '$.{column}') as {column}" for column in URL_COLUMNS)
        fixture_cte = f"with store_items as (select {columns} from json_each(?)) "
        self._cursor.execute(
            fixture_cte + sql.replace("%s", "?"),
            (json.dumps(self.connection.rows), *params),
        )

    def fetchone(self):
        return self._cursor.fetchone()
