import json
import sys
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.continuous_update_worker import _process_claim, run_continuous_update_worker
from ludora.database import DiscoveryRepository, ItemCandidateUpsertResult, StoreItemDiscoverySource
from ludora.operations import run_item_update
from ludora.update_sitemap import UpdateSitemapChecker
from ludora.webfetch import FetchResult
from ludora.woocommerce_batch_refresh import ChocitaBatchRefresher
from test_database import FakeConnection, confirmed_store_item_record
from test_update_sitemap import ENV_KEY, urlset
from test_woocommerce_batch_refresh import ORIGIN, Targets, Transport, claim, product


class UpdateSitemapIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.present = claim()
        self.absent = replace(claim("catan", 502), attempt_id=92)
        self.sitemap_url = ORIGIN + "/sitemap.xml"
        self.env = {
            "LUDORA_DATABASE_URL": "postgresql://test",
            "LUDORA_BROWSER_FETCH_ENABLED": "false",
            ENV_KEY: json.dumps({"17": {"url": self.sitemap_url, "min_urls": 1}}),
        }
        self.snapshot = FetchResult(self.sitemap_url, urlset(self.present.record.source_url))
        self.sitemap_requests = []

    def fetch_sitemap(self, url, timeout):
        self.sitemap_requests.append(url)
        return self.snapshot

    def process(self, target, repository, trace, *, batch=None, checker=None):
        _process_claim(
            browser_fetcher=None, claim=target, item_title_extractor=None, job_id=17,
            repository=repository, request_headers_provider=None, run_id="continuous:test",
            throttle=Mock(), trace_logger=trace, worker_id="worker-1", batch_refresher=batch,
            sitemap_checker=checker or UpdateSitemapChecker.from_environment(
                self.env, ".env", fetcher=self.fetch_sitemap),
        )

    def test_continuous_sitemap_miss_skips_transport_before_platform_dispatch(self):
        for platform in ("custom", "shopify", "woocommerce"):
            with self.subTest(platform=platform):
                repository = Mock()
                repository.mark_item_candidate_sitemap_missing.return_value = True
                trace = Mock()
                target = replace(self.absent, platform=platform)
                batch = Mock()
                with patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate") as refresh:
                    self.process(target, repository, trace, batch=batch)
                refresh.assert_not_called()
                batch.supports.assert_not_called()
                repository.mark_item_candidate_sitemap_missing.assert_called_once_with(
                    target.record, job_id=17, run_id="continuous:test", claim=target,
                    worker_id="worker-1", worker_name="continuous")
                repository.fail_claimed_store_item_update.assert_not_called()
                self.assertIn("sitemap_missing", [call.kwargs.get("reason") for call in trace.log.call_args_list])

    def test_continuous_worker_session_loads_store_enrollment_from_environment(self):
        repository = Mock()
        repository.start_store_item_update_log.return_value = 17
        repository.claim_due_store_item_update.return_value = self.absent
        repository.mark_item_candidate_sitemap_missing.return_value = True
        stop_event = Mock()
        stop_event.is_set.return_value = False
        stop_event.wait.side_effect = [False, True]
        with (
            patch("ludora.continuous_update_worker.connect_database"),
            patch("ludora.continuous_update_worker.DiscoveryRepository", return_value=repository),
            patch("ludora.continuous_update_worker.create_item_update_trace_logger"),
            patch("ludora.continuous_update_worker._log"),
            patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate") as refresh,
            patch.object(UpdateSitemapChecker, "_fetch", side_effect=self.fetch_sitemap),
        ):
            run_continuous_update_worker(env=self.env, stop_event=stop_event)
        self.assertEqual(self.sitemap_requests, [self.sitemap_url])
        repository.mark_item_candidate_sitemap_missing.assert_called_once()
        repository.list_store_item_update_batch_targets.assert_not_called()
        refresh.assert_not_called()
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["status"], "completed")

    def test_woocommerce_requests_only_present_lookahead_and_writes_only_claimed_rows(self):
        repository = Mock()
        repository.mark_item_candidate_sitemap_missing.return_value = True
        repository.complete_claimed_store_item_update.return_value = ItemCandidateUpsertResult(
            501, "LISTED", 77, False, changed=True)
        transport = Transport([product("long-shot")])
        batch = ChocitaBatchRefresher(Targets([self.present, self.absent]), fetcher=transport)
        checker = UpdateSitemapChecker.from_environment(self.env, ".env", fetcher=self.fetch_sitemap)
        self.process(self.present, repository, Mock(), batch=batch, checker=checker)
        self.assertEqual(parse_qs(urlsplit(transport.urls[0]).query)["slug"], ["long-shot"])
        repository.mark_item_candidate_sitemap_missing.assert_not_called()
        repository.complete_claimed_store_item_update.assert_called_once()
        self.process(self.absent, repository, Mock(), batch=batch, checker=checker)
        repository.mark_item_candidate_sitemap_missing.assert_called_once()
        self.assertIs(repository.mark_item_candidate_sitemap_missing.call_args.args[0], self.absent.record)
        self.assertEqual(len(transport.urls), 1)
        self.assertEqual(self.sitemap_requests, [self.sitemap_url])

    def test_continuous_sitemap_failure_falls_through_to_existing_fetch(self):
        self.snapshot = replace(self.snapshot, status_code=503)
        repository = Mock()
        with patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate") as refresh:
            self.process(self.absent, repository, Mock())
        refresh.assert_called_once()
        repository.mark_item_candidate_sitemap_missing.assert_not_called()
        repository.complete_claimed_store_item_update.assert_called_once()

    def test_continuous_guard_rejection_emits_a_terminal_watchdog_event_without_fetch(self):
        repository = Mock()
        repository.mark_item_candidate_sitemap_missing.return_value = None
        with (
            patch("ludora.continuous_update_worker._log") as log,
            patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate") as refresh,
        ):
            self.process(self.absent, repository, Mock())
        refresh.assert_not_called()
        repository.fail_claimed_store_item_update.assert_not_called()
        event = log.call_args_list[-1]
        self.assertEqual(event.args[0], "worker.item.failed")
        self.assertEqual(event.kwargs["reason"], "sitemap_ownership_lost")

    def run_manual(self, repository, trace, env=None):
        repository.start_store_item_update_log.return_value = 17
        repository.list_store_item_discovery_sources.return_value = [
            StoreItemDiscoverySource(17, "Chocita Juegos", ORIGIN, "woocommerce")
        ]
        with (
            patch("ludora.operations.connect_database"),
            patch("ludora.operations.DiscoveryRepository", return_value=repository),
            patch("ludora.operations.create_item_update_trace_logger", return_value=trace),
            patch.object(UpdateSitemapChecker, "_fetch", side_effect=self.fetch_sitemap),
            patch("ludora.product_crawler._fetch_detail_candidate", return_value=replace(self.present.record)) as fetch,
        ):
            result = run_item_update(env=env or self.env, store_ids=[17], run_id="manual:test")
        return result, fetch

    def test_manual_update_checks_each_candidate_before_fetch_and_counts_terminal_progress(self):
        repository = Mock()
        repository.list_confirmed_boardgame_item_candidates.return_value = [self.absent.record, self.present.record]
        repository.mark_item_candidate_sitemap_missing.return_value = True
        repository.update_item_candidate_with_change_log.return_value = ItemCandidateUpsertResult(
            501, "LISTED", 77, False, changed=False)
        trace = Mock()
        result, fetch = self.run_manual(repository, trace)
        fetch.assert_called_once()
        self.assertIs(fetch.call_args.kwargs["listing_candidate"], self.present.record)
        repository.mark_item_candidate_sitemap_missing.assert_called_once_with(
            self.absent.record, job_id=17, run_id="manual:test")
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["scanned_items"], 2)
        self.assertEqual(result.updated_items, 1)
        self.assertIn("sitemap_missing", [call.kwargs.get("reason") for call in trace.log.call_args_list])

    def test_manual_update_falls_through_for_unknown_or_disabled_sitemap(self):
        self.snapshot = replace(self.snapshot, status_code=429)
        for config, request_count in ((self.env[ENV_KEY], 1), ("{}", 0)):
            with self.subTest(config=config):
                self.sitemap_requests.clear()
                repository = Mock()
                repository.list_confirmed_boardgame_item_candidates.return_value = [self.absent.record]
                _, fetch = self.run_manual(repository, Mock(), {**self.env, ENV_KEY: config})
                fetch.assert_called_once()
                repository.mark_item_candidate_sitemap_missing.assert_not_called()
                self.assertEqual(len(self.sitemap_requests), request_count)

    def test_manual_stale_identity_counts_scan_without_claiming_a_change(self):
        repository = Mock()
        repository.list_confirmed_boardgame_item_candidates.return_value = [self.absent.record]
        repository.mark_item_candidate_sitemap_missing.return_value = None
        trace = Mock()
        result, fetch = self.run_manual(repository, trace)
        fetch.assert_not_called()
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["scanned_items"], 1)
        self.assertEqual(result.updated_items, 0)
        self.assertTrue(self.absent.record.store_active)


class UpdateSitemapPersistenceTests(unittest.TestCase):
    def test_manual_transition_guards_identity_and_live_lease_and_logs_actual_changes(self):
        record = confirmed_store_item_record()
        connection = FakeConnection(fetchone_rows=[("unavailable", "html", True)])
        result = DiscoveryRepository(connection).mark_item_candidate_sitemap_missing(
            record, job_id=17, run_id="manual:test")
        self.assertTrue(result)
        sql, params = connection.cursor_instance.executions[0]
        self.assertIn("store_id = %s", sql)
        self.assertIn("source_url = %s", sql)
        self.assertIn("source_url_origin is not distinct from %s", sql)
        self.assertIn("update_lease_token is null", sql)
        self.assertIn("update_lease_expires_at <= clock_timestamp()", sql)
        self.assertEqual(params[:4], (record.store_item_id, record.store_id, record.source_url, record.source_url_origin))
        for assignment in ("availability = 'unavailable'", "availability_source = 'sitemap_missing'",
                           "store_active = false", "next_update_at = null"):
            self.assertIn(assignment, sql)
        for untouched in ("refreshed_date =", "last_seen_at =", "price =", "item_id =", "listing_status ="):
            self.assertNotIn(untouched, sql)
        changes = [params[3:] for sql, params in connection.cursor_instance.executions
                   if "insert into store_item_update_change_log" in sql]
        self.assertEqual(changes, [("availability_source", '"html"', '"sitemap_missing"'),
                                   ("store_active", "true", "false")])
        self.assertEqual(connection.commits, 1)

    def test_manual_guard_rejection_writes_no_changes_and_preserves_record(self):
        record = confirmed_store_item_record()
        connection = FakeConnection()
        result = DiscoveryRepository(connection).mark_item_candidate_sitemap_missing(
            record, job_id=17, run_id="manual:test")
        self.assertIsNone(result)
        self.assertEqual(len(connection.cursor_instance.executions), 1)
        self.assertTrue(record.store_active)

    def test_continuous_transition_guards_attempt_ownership_and_finalizes_with_reason(self):
        target = claim()
        connection = FakeConnection(fetchone_rows=[("available", "html", True), (target.attempt_id,)])
        result = DiscoveryRepository(connection).mark_item_candidate_sitemap_missing(
            target.record, job_id=17, run_id="continuous:test", claim=target,
            worker_id="worker-1", worker_name="continuous")
        self.assertTrue(result)
        queries = connection.cursor_instance.executions
        sql, params = queries[0]
        self.assertIn("update_lease_token = %s::uuid", sql)
        self.assertIn("update_lease_expires_at > clock_timestamp()", sql)
        self.assertIn(target.lease_token, params)
        self.assertIn(target.record.source_url, params)
        self.assertIn("worker-1", params)
        attempt = [(sql, params) for sql, params in queries if "set status = 'deactivated'" in sql]
        self.assertEqual(len(attempt), 1)
        self.assertIn("sitemap_missing", attempt[0][1])
        self.assertNotIn("http_status =", attempt[0][0])
        self.assertEqual(connection.commits, 1)

    def test_continuous_lost_guard_does_not_finish_as_deactivated(self):
        target = claim()
        connection = FakeConnection()
        result = DiscoveryRepository(connection).mark_item_candidate_sitemap_missing(
            target.record, job_id=17, run_id="continuous:test", claim=target,
            worker_id="worker-1", worker_name="continuous")
        self.assertIsNone(result)
        sql = "\n".join(sql for sql, _ in connection.cursor_instance.executions)
        self.assertIn("status = 'lease_lost'", sql)
        self.assertNotIn("set status = 'deactivated'", sql)
        self.assertNotIn("insert into store_item_update_change_log", sql)
        self.assertTrue(target.record.store_active)
