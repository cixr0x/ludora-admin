import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.admin_title_extraction import AdminAmazonTitleExtractor
from ludora.models import DiscoveryItemCandidateRecord


class AdminAmazonTitleExtractorTests(unittest.TestCase):
    def test_posts_amazon_title_to_admin_ai_endpoint(self):
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://www.amazon.com.mx/dp/B0TEST1234",
            title="La Compania de los Juegos | Yokai Pagoda | Juego en Espanol",
            raw_payload={"amazon": {"asin": "B0TEST1234"}},
        )

        with patch("ludora.admin_title_extraction.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = json.dumps(
                {"data": {"game_title": "Yokai Pagoda"}}
            ).encode("utf-8")

            title = AdminAmazonTitleExtractor("http://admin.test/").extract_title(record)

        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://admin.test/admin/ai/amazon-title-extractions")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.headers["Content-type"], "application/json")
        self.assertEqual(
            json.loads(request.data.decode("utf-8")),
            {
                "amazon_title": "La Compania de los Juegos | Yokai Pagoda | Juego en Espanol",
                "raw_payload": {"amazon": {"asin": "B0TEST1234"}},
                "source_url": "https://www.amazon.com.mx/dp/B0TEST1234",
            },
        )
        self.assertEqual(title, "Yokai Pagoda")

    def test_returns_empty_title_when_admin_ai_is_not_configured(self):
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://www.amazon.com.mx/dp/B0TEST1234",
            title="La Compania de los Juegos | Yokai Pagoda | Juego en Espanol",
        )
        error = HTTPError(
            "http://admin.test/admin/ai/amazon-title-extractions",
            503,
            "Service Unavailable",
            {},
            io.BytesIO(b'{"error":{"message":"Amazon title extraction service is not configured"}}'),
        )

        with patch("ludora.admin_title_extraction.urlopen", side_effect=error):
            title = AdminAmazonTitleExtractor("http://admin.test").extract_title(record)

        self.assertEqual(title, "")

    def test_returns_empty_title_on_network_error(self):
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://www.amazon.com.mx/dp/B0TEST1234",
            title="La Compania de los Juegos | Yokai Pagoda | Juego en Espanol",
        )

        with patch("ludora.admin_title_extraction.urlopen", side_effect=URLError("connection refused")):
            title = AdminAmazonTitleExtractor("http://admin.test").extract_title(record)

        self.assertEqual(title, "")


if __name__ == "__main__":
    unittest.main()
