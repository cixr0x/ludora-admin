import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.trace import create_item_update_trace_logger


class TraceLoggerTests(unittest.TestCase):
    def test_item_update_trace_logger_persists_job_scoped_payload_immediately(self):
        connection = MagicMock()
        cursor = connection.cursor.return_value.__enter__.return_value
        trace = create_item_update_trace_logger(connection, "run-update-27", 27)

        trace.log(
            "item_update.item.fetch.http_error",
            message="Product detail returned HTTP 429",
            retry_in_seconds=60,
            store_item_id=501,
        )

        cursor.execute.assert_called_once()
        sql, params = cursor.execute.call_args.args
        self.assertIn("insert into store_item_update_trace_log", " ".join(sql.split()))
        self.assertEqual(params[0:4], (27, "run-update-27", "item_update", "item_update.item.fetch.http_error"))
        payload = json.loads(params[4])
        self.assertEqual(payload["message"], "Product detail returned HTTP 429")
        self.assertEqual(payload["retry_in_seconds"], 60)
        self.assertEqual(payload["store_item_id"], 501)
        self.assertIsInstance(payload["elapsed_ms"], int)
        connection.commit.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
