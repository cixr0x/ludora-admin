import sys
import unittest
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.webfetch import fetch_html


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

    def test_fetch_html_still_collapses_other_http_errors(self):
        error = HTTPError(
            "https://example.mx/products/catan",
            503,
            "Service Unavailable",
            hdrs=None,
            fp=None,
        )

        with patch("ludora.webfetch.urlopen", side_effect=error):
            result = fetch_html(
                "https://example.mx/products/catan",
                include_http_error_status=True,
            )

        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
