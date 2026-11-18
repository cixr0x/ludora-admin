import sys
import threading
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
from ludora.admin_matching import AdminItemMatcher
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import ProductPageRemovedError, TransientProductFetchError
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

    def test_run_worker_defaults_to_three_slots(self):
        with (
            patch("ludora.continuous_update_worker.resolve_database_url", return_value="postgresql://test"),
            patch("ludora.continuous_update_worker._run_worker_session") as run_session,
        ):
            run_continuous_update_worker(env={})

        self.assertEqual(run_session.call_args.kwargs.get("concurrency"), 3)

    def test_worker_overlaps_three_stores_with_separate_connections_and_browser_threads(self):
        claims = [
            replace(self.claim, attempt_id=i, record=replace(self.record, store_id=i, store_item_id=500 + i))
            for i in (1, 2, 3)
        ]
        release = threading.Event()
        all_started = threading.Event()
        connection_owners = {}
        browser_threads = {}
        active = []

        def connect(_url):
            connection = Mock()
            connection_owners[connection] = threading.get_ident()
            return connection

        def create_browser(_trace_logger):
            browser = Mock()
            owner = threading.get_ident()
            browser_threads[browser.fetch] = owner
            browser.__enter__ = Mock(return_value=browser)
            browser.__exit__ = Mock(side_effect=lambda *_args: self.assertEqual(threading.get_ident(), owner))
            return browser

        def process(*, claim, repository, browser_fetcher, **_kwargs):
            active.append((claim.record.store_id, repository, browser_fetcher, threading.get_ident()))
            if len(active) == 3:
                all_started.set()
            release.wait(2)

        repository = Mock()
        repository.claim_due_store_item_update.side_effect = claims + [None] * 300
        with (
            patch("ludora.continuous_update_worker.connect_database", side_effect=connect),
            patch("ludora.continuous_update_worker.DiscoveryRepository", side_effect=lambda conn: repository if len(connection_owners) == 1 else conn),
            patch("ludora.continuous_update_worker.create_item_update_trace_logger"),
            patch("ludora.continuous_update_worker._create_continuous_browser_session", side_effect=create_browser),
            patch("ludora.continuous_update_worker._process_claim", side_effect=process),
            patch("ludora.continuous_update_worker._log"),
        ):
            stop_event = threading.Event()
            worker = self.start_worker(stop_event, browser_enabled=True)
            try:
                self.assertTrue(all_started.wait(1), "three distinct stores should overlap")
            finally:
                stop_event.set()
                release.set()
                worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual({store_id for store_id, *_rest in active}, {1, 2, 3})
        self.assertEqual(len({owner for *_rest, owner in active}), 3)
        for _, connection, browser_fetcher, owner in active:
            self.assertEqual(connection_owners[connection], owner)
            self.assertEqual(browser_threads[browser_fetcher], owner)
            connection.close.assert_called_once()
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["status"], "completed")

    def test_store_remains_excluded_while_persistence_drains_on_shutdown(self):
        other_store = replace(self.claim, attempt_id=92, record=replace(self.record, store_id=17, store_item_id=502))
        same_store = replace(self.claim, attempt_id=93, record=replace(self.record, store_item_id=503))
        pending = [self.claim, same_store, other_store]
        release_persistence = threading.Event()
        persistence_started = threading.Event()
        other_store_finished = threading.Event()
        heartbeat_after_completion = threading.Event()
        allow_observation = threading.Event()
        observed_exclusions = []
        repository = Mock()

        def claim_due(*, excluded_store_ids=(), **_kwargs):
            observed_exclusions.append(tuple(excluded_store_ids))
            for claim in pending:
                if claim.record.store_id not in excluded_store_ids:
                    pending.remove(claim)
                    return claim
            return None

        def persist(record, *_args, **_kwargs):
            if record.store_item_id == 501:
                persistence_started.set()
                release_persistence.wait(2)
            if record.store_item_id == 502:
                other_store_finished.set()
            return ItemCandidateUpsertResult(record.store_item_id, "LISTED", 77, False, False)

        def heartbeat(*, current_store_item_id=None, **_kwargs):
            if current_store_item_id == 501 and allow_observation.is_set():
                heartbeat_after_completion.set()

        repository.claim_due_store_item_update.side_effect = claim_due
        repository.complete_claimed_store_item_update.side_effect = persist
        repository.heartbeat_continuous_update_worker.side_effect = heartbeat
        with (
            patch("ludora.continuous_update_worker.connect_database"),
            patch("ludora.continuous_update_worker.DiscoveryRepository", return_value=repository),
            patch("ludora.continuous_update_worker.create_item_update_trace_logger"),
            patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate", side_effect=lambda record, **_kwargs: record),
            patch("ludora.continuous_update_worker._log"),
        ):
            stop_event = threading.Event()
            worker = self.start_worker(stop_event)
            try:
                self.assertTrue(persistence_started.wait(1))
                self.assertTrue(other_store_finished.wait(1), "other stores should progress during persistence")
                allow_observation.set()
                self.assertTrue(heartbeat_after_completion.wait(1), "an active claim should remain in the heartbeat")
                stop_event.set()
                self.assertTrue(worker.is_alive(), "shutdown should wait for persistence")
                repository.mark_continuous_update_worker_stopped.assert_not_called()
            finally:
                stop_event.set()
                release_persistence.set()
                worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertIn((12,), observed_exclusions)
        self.assertEqual(pending, [same_store])
        repository.mark_continuous_update_worker_stopped.assert_called_once()

    def test_one_slot_reuses_the_same_connection_for_consecutive_claims(self):
        stop_event = threading.Event()
        coordinator = Mock()
        repository = Mock()
        other_store = replace(self.claim, record=replace(self.record, store_id=17, store_item_id=502))
        coordinator.claim_due_store_item_update.side_effect = [self.claim, other_store, None]
        release_first = threading.Event()
        first_started = threading.Event()
        heartbeat_while_busy = threading.Event()
        coordinators_heartbeats = []
        seen_slots = []

        def process(*, claim, repository, **_kwargs):
            seen_slots.append(repository)
            if claim is self.claim:
                first_started.set()
                release_first.wait(2)
            else:
                stop_event.set()

        def heartbeat(**kwargs):
            coordinators_heartbeats.append(kwargs["current_store_item_id"])
            if coordinators_heartbeats.count(501) >= 2:
                heartbeat_while_busy.set()

        coordinator.heartbeat_continuous_update_worker.side_effect = heartbeat
        with (
            patch("ludora.continuous_update_worker.connect_database"),
            patch("ludora.continuous_update_worker.DiscoveryRepository", side_effect=[coordinator, repository]),
            patch("ludora.continuous_update_worker.create_item_update_trace_logger"),
            patch("ludora.continuous_update_worker._process_claim", side_effect=process),
            patch("ludora.continuous_update_worker._log"),
        ):
            worker = self.start_worker(stop_event, concurrency=1)
            try:
                self.assertTrue(first_started.wait(1))
                self.assertTrue(heartbeat_while_busy.wait(1))
                coordinator.claim_due_store_item_update.assert_called_once()
                release_first.set()
                worker.join(2)
            finally:
                stop_event.set()
                release_first.set()
                worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(seen_slots, [repository, repository])
        self.assertEqual(coordinator.claim_due_store_item_update.call_count, 2)

    def test_slot_setup_failure_closes_its_watchdog_scope(self):
        stop_event = threading.Event()
        coordinator = Mock()
        coordinator.claim_due_store_item_update.side_effect = [self.claim, None]
        events = []
        coordinator_connection = Mock()
        slot_connection = Mock()
        slot_connection.close.side_effect = lambda: events.append(("slot.closed", None))

        def log(event, **payload):
            events.append((event, payload.get("attempt_id")))
            if event == "worker.session.failed":
                stop_event.set()

        with (
            patch("ludora.continuous_update_worker.connect_database", side_effect=[coordinator_connection, slot_connection]),
            patch("ludora.continuous_update_worker.DiscoveryRepository", side_effect=[coordinator, RuntimeError("slot setup failed")]),
            patch("ludora.continuous_update_worker._log", side_effect=log),
        ):
            worker = self.start_worker(stop_event)
            worker.join(2)
            stop_event.set()
            worker.join(2)

        self.assertIn(("worker.session.draining", None), events)
        self.assertEqual([event for event in events if event[0] != "worker.session.draining"], [
            ("worker.session.started", None),
            ("worker.item.started", 91),
            ("slot.closed", None),
            ("worker.item.failed", 91),
            ("worker.session.failed", None),
        ])

    def test_coordinator_arms_drain_watchdog_before_rolling_back(self):
        stop_event = threading.Event()
        coordinator = Mock()
        coordinator.claim_due_store_item_update.side_effect = RuntimeError("coordinator query failed")
        events = []
        coordinator.connection.rollback.side_effect = lambda: events.append("coordinator.rollback")

        def log(event, **_payload):
            events.append(event)
            if event == "worker.session.failed":
                stop_event.set()

        with (
            patch("ludora.continuous_update_worker.connect_database"),
            patch("ludora.continuous_update_worker.DiscoveryRepository", return_value=coordinator),
            patch("ludora.continuous_update_worker._log", side_effect=log),
        ):
            run_continuous_update_worker(
                env={"LUDORA_DATABASE_URL": "postgresql://test"},
                concurrency=1,
                stop_event=stop_event,
            )

        self.assertEqual(events, [
            "worker.session.started",
            "worker.session.draining",
            "coordinator.rollback",
            "worker.session.failed",
        ])

    def test_recovered_pending_claim_cannot_start_after_coordinator_disconnects(self):
        stop_event = threading.Event()
        coordinator = Mock()
        slot = Mock()
        coordinator.claim_due_store_item_update.side_effect = [self.claim]
        slot.try_acquire_store_item_update_shared_lock.return_value = True
        # A replacement could have acquired exclusive ownership and recovered the
        # pending claim before this old slot opened its own shared session.
        slot.continuous_update_claim_is_owned.return_value = False

        def log(event, **_payload):
            if event == "worker.session.failed":
                stop_event.set()

        with (
            patch("ludora.continuous_update_worker.connect_database"),
            patch("ludora.continuous_update_worker.DiscoveryRepository", side_effect=[coordinator, slot]),
            patch("ludora.continuous_update_worker.create_item_update_trace_logger"),
            patch("ludora.continuous_update_worker._log", side_effect=log),
            patch("ludora.continuous_update_worker._create_continuous_browser_session") as browser,
            patch("ludora.continuous_update_worker._process_claim") as process,
        ):
            worker = self.start_worker(stop_event, browser_enabled=True)
            worker.join(2)
            stop_event.set()
            worker.join(2)

        coordinator.downgrade_store_item_update_coordinator_lock.assert_called_once()
        slot.try_acquire_store_item_update_shared_lock.assert_called_once()
        self.assertEqual(slot.continuous_update_claim_is_owned.call_args.kwargs["claim"], self.claim)
        browser.assert_not_called()
        process.assert_not_called()

    def start_worker(self, stop_event, *, browser_enabled=False, **worker_options):
        worker = threading.Thread(
            target=run_continuous_update_worker,
            kwargs={
                "env": {
                    "LUDORA_DATABASE_URL": "postgresql://test",
                    "LUDORA_BROWSER_FETCH_ENABLED": "true" if browser_enabled else "false",
                },
                "poll_seconds": 0.01,
                "stop_event": stop_event,
                **worker_options,
            },
        )
        worker.start()
        return worker

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

    def test_claim_trace_context_reaches_redirect_matcher_request(self):
        trace = _ContextTraceLogger(Mock(run_id="continuous:test"), store_item_id=501, update_attempt_id=91)
        record = replace(self.record, store_item_id=502, item_id=None)
        with patch("ludora.admin_matching.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = b'{"data":{"id":502}}'
            AdminItemMatcher("http://admin.test", Mock(), trace_logger=trace).process_candidate(502, record)
        self.assertEqual(urlopen.call_args.args[0].headers.get("X-ludora-trace-run-id"), "continuous:test")

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

    def test_removed_item_terminal_event_names_its_attempt(self):
        with (
            patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate", side_effect=ProductPageRemovedError("gone")),
            patch("ludora.continuous_update_worker._log") as log,
        ):
            _process_claim(
                browser_fetcher=None, claim=self.claim, item_title_extractor=None,
                job_id=17, repository=Mock(), request_headers_provider=None,
                run_id="continuous:test", throttle=Mock(), worker_id="worker-1",
            )

        self.assertEqual(log.call_args.args, ("worker.item.deactivated",))
        self.assertEqual(log.call_args.kwargs.get("attempt_id"), 91)

    def test_amazon_exact_invalid_browser_attempt_retries_and_completes(self):
        source_url = "https://www.amazon.com.mx/dp/B0D36CJG5N"
        invalid_shell_html = """
        <html><head><title>Amazon.com.mx</title></head><body></body></html>
        """
        valid_product_html = """
        <html><head><title>Mi Villano Favorito 4</title></head><body>
          <span id="productTitle">Mi Villano Favorito 4</span>
          <span class="a-offscreen">$399.00</span>
          <div id="availability">Disponible</div>
          <input id="add-to-cart-button" type="submit" value="Agregar al carrito">
          <div>ASIN: B0D36CJG5N</div>
        </body></html>
        """
        amazon_record = replace(
            self.record,
            source_url=source_url,
            source_listing_url=source_url,
            title="Mi Villano Favorito 4",
            original_title="Mi Villano Favorito 4",
        )
        amazon_claim = replace(self.claim, platform="amazon", record=amazon_record)
        repository = Mock()
        repository.complete_claimed_store_item_update.return_value = ItemCandidateUpsertResult(
            candidate_id=501,
            listing_status="LISTED",
            item_id=77,
            should_process=False,
            changed=True,
        )
        trace_logger = Mock()

        class BrowserFetcher:
            def __init__(self):
                self.fetches = []
                self.reset_count = 0

            def fetch(self, url):
                self.fetches.append(url)
                html = invalid_shell_html if len(self.fetches) == 1 else valid_product_html
                return FetchResult(url=source_url, text=html, status_code=200)

            def reset_context(self):
                self.reset_count += 1

        browser = BrowserFetcher()
        with patch(
            "ludora.product_crawler.fetch_html",
            return_value=FetchResult(url=source_url, text="", status_code=500),
        ):
            _process_claim(
                browser_fetcher=browser.fetch,
                claim=amazon_claim,
                item_title_extractor=Mock(),
                job_id=17,
                repository=repository,
                request_headers_provider=Mock(),
                run_id="continuous:test",
                throttle=Mock(),
                trace_logger=trace_logger,
                worker_id="worker-1",
            )

        self.assertEqual(browser.fetches, [source_url, source_url])
        self.assertEqual(browser.reset_count, 1)
        repository.deactivate_claimed_store_item_update.assert_not_called()
        repository.complete_claimed_store_item_update.assert_called_once()
        repository.fail_claimed_store_item_update.assert_not_called()
        self.assertFalse(
            any(
                entry.args == ("item_update.item.redirect.deactivated",)
                for entry in trace_logger.log.call_args_list
            )
        )

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
