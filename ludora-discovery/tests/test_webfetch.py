import sys
import unittest
from http.client import HTTPException
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.webfetch import fetch_html


class WebFetchTests(unittest.TestCase):
    def test_fetch_html_returns_none_when_server_sends_too_many_headers(self):
        with patch("ludora.webfetch.urlopen", side_effect=HTTPException("got more than 100 headers")):
            result = fetch_html("https://example.mx/")

        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
