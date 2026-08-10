import sys
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.continuous_update_worker import (
    BROWSER_RECYCLE_MAX_AGE_SECONDS,
    BROWSER_RECYCLE_MAX_FETCHES,
    _ContextTraceLogger,
    _create_continuous_browser_session,
    _process_claim,
)
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
            platform_consecutive_429s=0,
            store_name="Example",
        )
        self.now = datetime(2026, 8, 4, 18, 0, tzinfo=timezone.utc)

    def test_continuous_browser_session_uses_bounded_playwright_lifetime(self):
        trace_logger = Mock()

        session = _create_continuous_browser_session(trace_logger)

        self.assertIs(session.trace_logger, trace_logger)
        self.assertEqual(BROWSER_RECYCLE_MAX_FETCHES, 250)
        self.assertEqual(BROWSER_RECYCLE_MAX_AGE_SECONDS, 21_600)
        self.assertEqual(session.max_fetches, 250)
        self.assertEqual(session.max_age_seconds, 21_600)

    def test_context_trace_logger_adds_update_attempt_fields(self):
        delegate = Mock()
        trace = _ContextTraceLogger(delegate, store_item_id=501, update_attempt_id=91)

        trace.log("browser_fetch.failed", error="net::ERR_FAILED")

        delegate.log.assert_called_once_with(
            "browser_fetch.failed",
            error="net::ERR_FAILED",
            store_item_id=501,
            update_attempt_id=91,
        )

    def test_success_clears_due_time_and_completes_lease(self):
        repository = Mock()
        repository.complete_claimed_store_item_update.return_value = ItemCandidateUpsertResult(
            candidate_id=501,
            listing_status="LISTED",
            item_id=77,
            should_process=False,
            changed=True,
        )
        refreshed = DiscoveryItemCandidateRecord(**self.record.__dict__)
        trace_logger = Mock()

        with (
            patch(
                "ludora.continuous_update_worker.refresh_confirmed_store_item_candidate",
                return_value=refreshed,
            ) as patch_refresh,
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
                trace_logger=trace_logger,
                worker_id="worker-1",
            )

        kwargs = repository.complete_claimed_store_item_update.call_args.kwargs
        self.assertNotIn("next_update_at", kwargs)
        self.assertEqual(kwargs["lease_token"], self.claim.lease_token)
        self.assertIs(
            patch_refresh.call_args.kwargs["trace_logger"],
            trace_logger,
        )
        repository.fail_claimed_store_item_update.assert_not_called()

    def test_first_shopify_429_pauses_platform_and_reschedules_item_for_15_minutes(self):
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
        self.assertEqual(kwargs["platform_blocked_until"], expected_retry)
        self.assertEqual(kwargs["next_update_at"], expected_retry)
        repository.complete_claimed_store_item_update.assert_not_called()

    def test_first_woocommerce_429_pauses_all_woocommerce_claims_for_15_minutes(self):
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
                claim=replace(self.claim, platform="woocommerce"),
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
        self.assertEqual(kwargs["platform"], "woocommerce")
        self.assertEqual(kwargs["platform_blocked_until"], expected_retry)
        self.assertEqual(kwargs["next_update_at"], expected_retry)

    def test_woocommerce_429_honors_longer_retry_after(self):
        repository = Mock()
        error = TransientProductFetchError(
            "HTTP 429",
            retry_after_seconds=90 * 60,
            status_code=429,
        )

        with (
            patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate", side_effect=error),
            patch("ludora.continuous_update_worker._utc_now", return_value=self.now),
            patch("ludora.continuous_update_worker.random.uniform", return_value=1.0),
        ):
            _process_claim(
                browser_fetcher=None,
                claim=replace(self.claim, platform="woocommerce"),
                item_title_extractor=Mock(),
                job_id=17,
                repository=repository,
                request_headers_provider=Mock(),
                run_id="continuous:test",
                throttle=Mock(),
                worker_id="worker-1",
            )

        kwargs = repository.fail_claimed_store_item_update.call_args.kwargs
        self.assertEqual(kwargs["platform_blocked_until"], self.now + timedelta(minutes=90))
        self.assertEqual(kwargs["next_update_at"], self.now + timedelta(minutes=90))

    def test_woocommerce_429_caps_platform_cooldown_at_24_hours(self):
        repository = Mock()
        error = TransientProductFetchError(
            "HTTP 429",
            retry_after_seconds=48 * 60 * 60,
            status_code=429,
        )

        with (
            patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate", side_effect=error),
            patch("ludora.continuous_update_worker._utc_now", return_value=self.now),
            patch("ludora.continuous_update_worker.random.uniform", return_value=1.0),
        ):
            _process_claim(
                browser_fetcher=None,
                claim=replace(self.claim, platform="woocommerce", platform_consecutive_429s=3),
                item_title_extractor=Mock(),
                job_id=17,
                repository=repository,
                request_headers_provider=Mock(),
                run_id="continuous:test",
                throttle=Mock(),
                worker_id="worker-1",
            )

        kwargs = repository.fail_claimed_store_item_update.call_args.kwargs
        self.assertEqual(kwargs["platform_blocked_until"], self.now + timedelta(hours=24))
        self.assertEqual(kwargs["next_update_at"], self.now + timedelta(hours=24))

    def test_non_429_woocommerce_failure_does_not_start_platform_cooldown(self):
        repository = Mock()
        error = TransientProductFetchError("HTTP 503", status_code=503)

        with (
            patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate", side_effect=error),
            patch("ludora.continuous_update_worker._utc_now", return_value=self.now),
            patch("ludora.continuous_update_worker.random.uniform", return_value=1.0),
        ):
            _process_claim(
                browser_fetcher=None,
                claim=replace(self.claim, platform="woocommerce"),
                item_title_extractor=Mock(),
                job_id=17,
                repository=repository,
                request_headers_provider=Mock(),
                run_id="continuous:test",
                throttle=Mock(),
                worker_id="worker-1",
            )

        kwargs = repository.fail_claimed_store_item_update.call_args.kwargs
        self.assertIsNone(kwargs["platform_blocked_until"])
        self.assertEqual(kwargs["next_update_at"], self.now + timedelta(minutes=15))


if __name__ == "__main__":
    unittest.main()
