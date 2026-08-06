import sys
import unittest
from email.message import Message
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from unittest.mock import Mock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.webfetch import FetchResult, PerHostRequestThrottle, fetch_html, fetch_with_transient_retries


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

    def test_fetch_html_can_preserve_connection_reset_for_retry(self):
        error = ConnectionResetError(104, "Connection reset by peer")
        with patch("ludora.webfetch.urlopen", side_effect=error):
            result = fetch_html(
                "https://example.mx/products/catan",
                include_http_error_status=True,
            )

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.status_code, 0)
        self.assertEqual(result.error_type, "ConnectionResetError")
        self.assertIn("Connection reset by peer", result.error or "")

    def test_connection_reset_uses_configured_transient_attempts(self):
        fetcher = Mock(
            side_effect=[
                FetchResult(
                    url="https://example.mx/products/catan",
                    text="",
                    status_code=0,
                    error="[Errno 104] Connection reset by peer",
                    error_type="ConnectionResetError",
                ),
                FetchResult(
                    url="https://example.mx/products/catan",
                    text="<html></html>",
                ),
            ]
        )

        result = fetch_with_transient_retries(
            "https://example.mx/products/catan",
            fetcher,
            trace_event="inventory.candidate.detail_fetch.http_error",
            ambiguous_failure_attempts=1,
            max_attempts=3,
        )

        self.assertIsNotNone(result)
        self.assertEqual(fetcher.call_count, 2)

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

    def test_configured_transient_status_returns_immediately_for_outer_scheduling(self):
        trace = Mock()
        fetcher = Mock(
            side_effect=[
                FetchResult(
                    url="https://shop.example/products/catan",
                    text="",
                    status_code=429,
                    retry_after_seconds=120,
                ),
                FetchResult(url="https://shop.example/products/catan", text="<html></html>"),
            ]
        )

        with patch("ludora.webfetch._wait_for_fetch_retry") as wait_for_retry:
            result = fetch_with_transient_retries(
                "https://shop.example/products/catan",
                fetcher,
                trace_event="item_update.item.fetch.http_error",
                trace_logger=trace,
                trace_attempts=True,
                immediate_return_status_codes={429},
            )

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.status_code, 429)
        self.assertEqual(fetcher.call_count, 1)
        wait_for_retry.assert_not_called()
        self.assertEqual([call.args[0] for call in trace.log.call_args_list], ["item_update.item.fetch.http_error"])
        self.assertFalse(trace.log.call_args.kwargs["will_retry"])

    def test_per_host_throttle_spaces_requests_and_honors_cooldown(self):
        clock_value = [10.0]
        waits = []

        def clock():
            return clock_value[0]

        def wait(delay_seconds, _cancellation_token):
            waits.append(delay_seconds)
            clock_value[0] += delay_seconds

        throttle = PerHostRequestThrottle(
            minimum_interval_seconds=2.0,
            jitter_seconds=1.0,
            fallback_cooldown_seconds=30.0,
            clock=clock,
            waiter=wait,
            jitter=lambda _minimum, _maximum: 1.0,
        )

        first = throttle.wait_before_request("https://shop.example/products/catan")
        second = throttle.wait_before_request("https://shop.example/products/azul")
        other_host = throttle.wait_before_request("https://other.example/products/catan")
        cooldown = throttle.start_cooldown("https://shop.example/products/catan", 120.0)
        after_cooldown = throttle.wait_before_request("https://shop.example/products/splendor")

        self.assertEqual(first.delay_seconds, 0.0)
        self.assertEqual(second.delay_seconds, 3.0)
        self.assertEqual(second.reason, "pacing")
        self.assertEqual(other_host.delay_seconds, 0.0)
        self.assertEqual(cooldown, 120.0)
        self.assertEqual(after_cooldown.delay_seconds, 120.0)
        self.assertEqual(after_cooldown.reason, "cooldown")
        self.assertEqual(waits, [3.0, 120.0])


if __name__ == "__main__":
    unittest.main()
