import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.continuous_update_worker import _process_claim
from ludora.database import ClaimedStoreItemUpdate, ItemCandidateUpsertResult
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import TransientProductFetchError


class ContinuousUpdateWorkerTests(unittest.TestCase):
    def setUp(self):
        self.record = DiscoveryItemCandidateRecord(
            store_id=12,
            store_item_id=501,
            source_url="https://example.test/products/catan",
            source_listing_url="https://example.test/collections/games",
            title="Catan",
            original_title="Catan",
            item_id=77,
            listing_status="LISTED",
            store_active=True,
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        self.claim = ClaimedStoreItemUpdate(
            attempt_id=91,
            consecutive_failures=0,
            lease_token="ee2bf2df-2330-430b-8f65-ad41dad4dc62",
            platform="shopify",
            record=self.record,
            shopify_consecutive_429s=0,
            store_name="Example",
        )
        self.now = datetime(2026, 8, 4, 18, 0, tzinfo=timezone.utc)

    def test_success_schedules_item_22_hours_ahead_and_completes_lease(self):
        repository = Mock()
        repository.complete_claimed_store_item_update.return_value = ItemCandidateUpsertResult(
            candidate_id=501,
            listing_status="LISTED",
            item_id=77,
            should_process=False,
            changed=True,
        )
        refreshed = DiscoveryItemCandidateRecord(**self.record.__dict__)

        with (
            patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate", return_value=refreshed),
            patch("ludora.continuous_update_worker._utc_now", return_value=self.now),
            patch("ludora.continuous_update_worker.random.uniform", return_value=22.0),
        ):
            _process_claim(
                browser_fetcher=None,
                claim=self.claim,
                item_title_extractor=Mock(),
                job_id=17,
                repository=repository,
                request_headers_provider=Mock(),
                run_id="continuous:test",
                throttle=Mock(),
                worker_id="worker-1",
            )

        kwargs = repository.complete_claimed_store_item_update.call_args.kwargs
        self.assertEqual(kwargs["next_update_at"], self.now + timedelta(hours=22))
        self.assertEqual(kwargs["lease_token"], self.claim.lease_token)
        repository.fail_claimed_store_item_update.assert_not_called()

    def test_first_shopify_429_pauses_shopify_and_reschedules_item_for_15_minutes(self):
        repository = Mock()
        error = TransientProductFetchError(
            "HTTP 429",
            retry_after_seconds=30,
            status_code=429,
        )

        with (
            patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate", side_effect=error),
            patch("ludora.continuous_update_worker._utc_now", return_value=self.now),
            patch("ludora.continuous_update_worker.random.uniform", return_value=1.0),
        ):
            _process_claim(
                browser_fetcher=None,
                claim=self.claim,
                item_title_extractor=Mock(),
                job_id=17,
                repository=repository,
                request_headers_provider=Mock(),
                run_id="continuous:test",
                throttle=Mock(),
                worker_id="worker-1",
            )

        kwargs = repository.fail_claimed_store_item_update.call_args.kwargs
        expected_retry = self.now + timedelta(minutes=15)
        self.assertEqual(kwargs["http_status"], 429)
        self.assertEqual(kwargs["shopify_blocked_until"], expected_retry)
        self.assertEqual(kwargs["next_update_at"], expected_retry)
        repository.complete_claimed_store_item_update.assert_not_called()


if __name__ == "__main__":
    unittest.main()
