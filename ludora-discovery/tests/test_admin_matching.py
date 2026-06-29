import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.admin_matching import AdminItemMatcher
from ludora.models import DiscoveryItemCandidateRecord


class AdminItemMatcherTests(unittest.TestCase):
    def test_posts_boardgame_candidates_to_admin_confirm_endpoint(self):
        repository = Mock()
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://store.mx/products/catan",
            title="Catan",
            is_boardgame=True,
        )

        with patch("ludora.admin_matching.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = b'{"data": {"id": 42}}'

            AdminItemMatcher("http://admin.test/", repository).process_candidate(42, record)

        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://admin.test/discovery/listings/42/confirm-boardgame")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.headers["Content-type"], "application/json")
        self.assertEqual(json.loads(request.data.decode("utf-8")), {"confirmation_source": "automated"})
        repository.mark_item_candidate_processing_error.assert_not_called()

    def test_skips_non_boardgame_candidates(self):
        repository = Mock()
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://store.mx/products/sleeves",
            title="Card Sleeves",
            is_boardgame=False,
        )

        with patch("ludora.admin_matching.urlopen") as urlopen:
            AdminItemMatcher("http://admin.test", repository).process_candidate(43, record)

        urlopen.assert_not_called()
        repository.mark_item_candidate_processing_error.assert_not_called()

    def test_records_admin_error_message_on_http_failure(self):
        repository = Mock()
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://store.mx/products/catan",
            title="Catan",
            is_boardgame=True,
        )
        error = HTTPError(
            "http://admin.test/discovery/listings/42/confirm-boardgame",
            503,
            "Service Unavailable",
            {},
            io.BytesIO(b'{"error":{"message":"Item matching service is not configured"}}'),
        )

        with patch("ludora.admin_matching.urlopen", side_effect=error):
            AdminItemMatcher("http://admin.test", repository).process_candidate(42, record)

        repository.mark_item_candidate_processing_error.assert_called_once_with(
            42,
            "Admin item matcher failed with 503: Item matching service is not configured",
        )

    def test_records_network_error_message(self):
        repository = Mock()
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://store.mx/products/catan",
            title="Catan",
            is_boardgame=True,
        )

        with patch("ludora.admin_matching.urlopen", side_effect=URLError("connection refused")):
            AdminItemMatcher("http://admin.test", repository).process_candidate(42, record)

        self.assertIn(
            "Admin item matcher failed:",
            repository.mark_item_candidate_processing_error.call_args.args[1],
        )


if __name__ == "__main__":
    unittest.main()
