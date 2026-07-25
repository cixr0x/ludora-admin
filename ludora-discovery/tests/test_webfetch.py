import sys
import unittest
from email.message import Message
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from unittest.mock import Mock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.webfetch import FetchResult, fetch_html, fetch_with_transient_retries


class WebFetchTests(unittest.TestCase):
    def test_fetch_html_returns_none_when_server_sends_too_many_headers(self):
        with patch("ludora.webfetch.urlopen", side_effect=HTTPException("got more than 100 headers")):
            result = fetch_html("https://example.mx/")

        self.assertIsNone(result)

    def test_fetch_html_can_preserve_definitive_removed_status(self):
        error = HTTPError(
            "https://example.mx/products/catan",
            404,
            "Not Found",
            hdrs=None,
            fp=None,
        )

        with patch("ludora.webfetch.urlopen", side_effect=error):
            result = fetch_html(
                "https://example.mx/products/catan",
                include_http_error_status=True,
            )

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.status_code, 404)

    def test_fetch_html_still_collapses_http_errors_by_default(self):
        error = HTTPError(
            "https://example.mx/products/catan",
            503,
            "Service Unavailable",
            hdrs=None,
            fp=None,
        )

        with patch("ludora.webfetch.urlopen", side_effect=error):
            result = fetch_html("https://example.mx/products/catan")

        self.assertIsNone(result)

    def test_fetch_html_can_preserve_transient_status_and_retry_after(self):
        headers = Message()
        headers["Retry-After"] = "179"
        error = HTTPError(
            "https://example.mx/products/catan",
            503,
            "Service Unavailable",
            hdrs=headers,
            fp=None,
        )

        with patch("ludora.webfetch.urlopen", side_effect=error):
            result = fetch_html(
                "https://example.mx/products/catan",
                include_http_error_status=True,
            )

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.status_code, 503)
        self.assertEqual(result.retry_after_seconds, 179.0)

    def test_fetch_html_can_preserve_network_error_details_for_tracing(self):
        with patch("ludora.webfetch.urlopen", side_effect=URLError("connection reset")):
            result = fetch_html(
                "https://example.mx/products/catan",
                include_http_error_status=True,
            )

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.status_code, 0)
        self.assertEqual(result.error_type, "URLError")
        self.assertIn("connection reset", result.error or "")

    def test_verbose_retry_trace_records_attempt_error_delay_and_success(self):
        trace = Mock()
        responses = [
            FetchResult(
                url="https://example.mx/products/catan",
                text="",
                status_code=429,
                retry_after_seconds=60,
            ),
            FetchResult(url="https://example.mx/products/catan", text="<html></html>"),
        ]

        with patch("ludora.webfetch._wait_for_fetch_retry") as wait_for_retry:
            result = fetch_with_transient_retries(
                "https://example.mx/products/catan",
                lambda _url: responses.pop(0),
                trace_event="item_update.item.fetch.http_error",
                trace_logger=trace,
                trace_fields={"store_item_id": 501},
                trace_attempts=True,
            )

        self.assertIsNotNone(result)
        self.assertEqual(
            [call.args[0] for call in trace.log.call_args_list],
            [
                "item_update.item.fetch.http_error",
                "item_update.item.fetch.retry.scheduled",
            ],
        )
        self.assertEqual(trace.log.call_args_list[0].kwargs["status_code"], 429)
        self.assertEqual(trace.log.call_args_list[1].kwargs["retry_in_seconds"], 60)
        wait_for_retry.assert_called_once_with(60, None)


if __name__ == "__main__":
    unittest.main()
