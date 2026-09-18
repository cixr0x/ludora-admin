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
    main,
    run_continuous_update_worker,
)
from ludora.database import ClaimedStoreItemUpdate, ItemCandidateUpsertResult
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import TransientProductFetchError
from ludora.webfetch import FetchResult


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
            store_consecutive_429s=0,
            store_name="Example",
        )
        self.now = datetime(2026, 8, 4, 18, 0, tzinfo=timezone.utc)

    def test_run_worker_defaults_to_one_second_polling(self):
        with (
            patch("ludora.continuous_update_worker.resolve_database_url", return_value="postgresql://test"),
            patch("ludora.continuous_update_worker._run_worker_session") as run_session,
        ):
            run_continuous_update_worker(env={})

        self.assertEqual(run_session.call_args.kwargs["poll_seconds"], 1.0)

    def test_cli_defaults_to_one_second_polling(self):
        with (
            patch.object(sys, "argv", ["continuous_update_worker.py"]),
            patch("ludora.continuous_update_worker.signal.signal"),
            patch("ludora.continuous_update_worker.run_continuous_update_worker") as run_worker,
        ):
            main()

        self.assertEqual(run_worker.call_args.kwargs["poll_seconds"], 1.0)

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

    def test_redirected_fetch_deactivates_claimed_source_without_a_target_row(self):
        repository = Mock()
        trace_logger = Mock()
        final_url = "https://example.test/product/catan"
        detail_html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Catan",
          "sku": "WRONG-SKU",
          "offers": {"price": "799.00", "priceCurrency": "MXN"}
        }
        </script>
        """

        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=final_url, text=detail_html),
        ) as fetch_html:
            _process_claim(
                browser_fetcher=None,
                claim=replace(
                    self.claim,
                    platform="custom",
                    record=replace(self.record, store_sku="CATAN-ES"),
                ),
                item_title_extractor=Mock(),
                job_id=17,
                repository=repository,
                request_headers_provider=Mock(),
                run_id="continuous:test",
                throttle=Mock(),
                trace_logger=trace_logger,
                worker_id="worker-1",
            )

        fetch_html.assert_called_once_with(
            self.record.source_url,
            headers=None,
            include_http_error_status=True,
        )
        repository.deactivate_claimed_store_item_update.assert_called_once_with(
            replace(self.record, store_sku="CATAN-ES"),
            attempt_id=91,
            job_id=17,
            lease_token=self.claim.lease_token,
            run_id="continuous:test",
            worker_id="worker-1",
            worker_name="continuous",
        )
        repository.complete_claimed_store_item_update.assert_not_called()
        repository.fail_claimed_store_item_update.assert_not_called()
        trace_logger.log.assert_called_once_with(
            "item_update.item.redirect.deactivated",
            final_url=final_url,
            source_store_item_id=501,
            source_url=self.record.source_url,
        )

    def test_exact_and_fragment_only_final_urls_complete_normally(self):
        non_redirect_final_urls = (
            self.record.source_url,
            f"{self.record.source_url}#overview",
        )

        for final_url in non_redirect_final_urls:
            with self.subTest(final_url=final_url):
                repository = Mock()
                repository.complete_claimed_store_item_update.return_value = ItemCandidateUpsertResult(
                    candidate_id=501,
                    listing_status="LISTED",
                    item_id=77,
                    should_process=False,
                    changed=False,
                )
                refreshed = replace(self.record)

                def refresh(_record, **kwargs):
                    kwargs["on_successful_page_fetch"](final_url)
                    return refreshed

                with patch(
                    "ludora.continuous_update_worker.refresh_confirmed_store_item_candidate",
                    side_effect=refresh,
                ):
                    _process_claim(
                        browser_fetcher=None,
                        claim=replace(self.claim, platform="custom"),
                        item_title_extractor=Mock(),
                        job_id=17,
                        repository=repository,
                        request_headers_provider=Mock(),
                        run_id="continuous:test",
                        throttle=Mock(),
                        trace_logger=Mock(),
                        worker_id="worker-1",
                    )

                repository.deactivate_claimed_store_item_update.assert_not_called()
                repository.complete_claimed_store_item_update.assert_called_once()

    def test_server_observable_url_changes_deactivate_claimed_source(self):
        redirect_final_urls = (
            "http://example.test/products/catan",
            "https://shop.example.test/products/catan",
            "https://example.test:8443/products/catan",
            "https://example.test/products/Catan",
            "https://example.test/products/catan/",
            "https://example.test/products/catan;edition=base",
            "https://example.test/products/catan?edition=base",
        )

        for final_url in redirect_final_urls:
            with self.subTest(final_url=final_url):
                repository = Mock()

                def refresh(_record, **kwargs):
                    kwargs["on_successful_page_fetch"](final_url)
                    self.fail("redirect should stop refresh processing")

                with patch(
                    "ludora.continuous_update_worker.refresh_confirmed_store_item_candidate",
                    side_effect=refresh,
                ):
                    _process_claim(
                        browser_fetcher=None,
                        claim=replace(self.claim, platform="custom"),
                        item_title_extractor=Mock(),
                        job_id=17,
                        repository=repository,
                        request_headers_provider=Mock(),
                        run_id="continuous:test",
                        throttle=Mock(),
                        trace_logger=Mock(),
                        worker_id="worker-1",
                    )

                repository.deactivate_claimed_store_item_update.assert_called_once_with(
                    self.record,
                    attempt_id=91,
                    job_id=17,
                    lease_token=self.claim.lease_token,
                    run_id="continuous:test",
                    worker_id="worker-1",
                    worker_name="continuous",
                )
                repository.complete_claimed_store_item_update.assert_not_called()
                repository.fail_claimed_store_item_update.assert_not_called()

    def test_first_shopify_429_pauses_store_and_reschedules_item_for_15_minutes(self):
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
        self.assertEqual(kwargs["store_blocked_until"], expected_retry)
        self.assertEqual(kwargs["next_update_at"], expected_retry)
        repository.complete_claimed_store_item_update.assert_not_called()

    def test_first_woocommerce_429_pauses_store_for_15_minutes(self):
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
        self.assertEqual(kwargs["store_blocked_until"], expected_retry)
        self.assertEqual(kwargs["next_update_at"], expected_retry)

    def test_429_uses_the_claimed_stores_consecutive_count(self):
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
                claim=replace(self.claim, store_consecutive_429s=1),
                item_title_extractor=Mock(),
                job_id=17,
                repository=repository,
                request_headers_provider=Mock(),
                run_id="continuous:test",
                throttle=Mock(),
                worker_id="worker-1",
            )

        kwargs = repository.fail_claimed_store_item_update.call_args.kwargs
        expected_retry = self.now + timedelta(minutes=60)
        self.assertEqual(kwargs["store_blocked_until"], expected_retry)
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
        self.assertEqual(kwargs["store_blocked_until"], self.now + timedelta(minutes=90))
        self.assertEqual(kwargs["next_update_at"], self.now + timedelta(minutes=90))

    def test_woocommerce_429_caps_store_cooldown_at_24_hours(self):
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
                claim=replace(self.claim, platform="woocommerce", store_consecutive_429s=3),
                item_title_extractor=Mock(),
                job_id=17,
                repository=repository,
                request_headers_provider=Mock(),
                run_id="continuous:test",
                throttle=Mock(),
                worker_id="worker-1",
            )

        kwargs = repository.fail_claimed_store_item_update.call_args.kwargs
        self.assertEqual(kwargs["store_blocked_until"], self.now + timedelta(hours=24))
        self.assertEqual(kwargs["next_update_at"], self.now + timedelta(hours=24))

    def test_non_429_woocommerce_failure_does_not_start_store_cooldown(self):
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
        self.assertIsNone(kwargs["store_blocked_until"])
        self.assertEqual(kwargs["next_update_at"], self.now + timedelta(minutes=15))


if __name__ == "__main__":
    unittest.main()
