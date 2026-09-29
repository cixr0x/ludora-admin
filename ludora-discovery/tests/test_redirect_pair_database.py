import sys
import unittest
from dataclasses import astuple
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.database import DiscoveryRepository
from ludora.discovery_pairs import DiscoveryPairState
from ludora.models import DiscoveryItemCandidateRecord
from test_database import FakeConnection


A = "https://example.mx/product/old"
B = "https://example.mx/product/catan"


class DiscoveryPairPersistenceTests(unittest.TestCase):
    def test_new_pair_is_persisted_inactive_and_activation_is_run_scoped(self):
        connection = FakeConnection(fetchone_rows=[None, (7, "PENDING", None)])
        record = DiscoveryItemCandidateRecord(store_id=12, source_url=B, source_url_origin=A, title="Catan")
        result = DiscoveryRepository(connection).prepare_discovery_pair(record)
        self.assertTrue(result.created)
        self.assertTrue(result.should_process)
        self.assertTrue(result.activate_if_ready)
        insert_sql, insert_params = connection.cursor_instance.executions[2]
        self.assertIn("insert into store_items", insert_sql)
        self.assertEqual(insert_params[-2:], (A, False))
        self.assertEqual(record.store_item_id, 7)
        self.assertEqual(connection.commits, 1)

    def test_persisted_matcher_failure_prevents_activation(self):
        connection = FakeConnection(fetchone_rows=[(12,), (None, B, "Importer unavailable", "2026-09-01", True)])
        self.assertFalse(DiscoveryRepository(connection).complete_discovery_pair(7, activate_if_ready=True))
        self.assertFalse(any("update store_items" in sql for sql, _params in connection.cursor_instance.executions))

    def test_failed_matcher_then_non_boardgame_retry_clears_stale_error(self):
        candidate = DiscoveryPairState(7, B, None, False, "PENDING", processed_at="2026-09-02")
        connection = FakeConnection(
            fetchone_rows=[(12,), (None, B, "Importer unavailable", "2026-09-01", False)],
            fetchall_rows=[[astuple(candidate)]],
        )
        self.assertTrue(DiscoveryRepository(connection).complete_discovery_pair(
            7, activate_if_ready=True, non_boardgame_success=True
        ))
        writes = [sql for sql, _params in connection.cursor_instance.executions if "update store_items" in sql]
        self.assertTrue(any("processing_error = ''" in sql for sql in writes))
        self.assertTrue(any("store_active = %s" in sql for sql in writes))

    def test_failed_or_unfinished_row_can_retry_but_completed_hidden_row_cannot_activate(self):
        for processed_at, error, expected in [(None, "", True), ("2026-09-01", "Importer unavailable", True), ("2026-09-01", "", False)]:
            with self.subTest(processed_at=processed_at, error=error):
                connection = FakeConnection(fetchone_rows=[(7, "PENDING", None, "NONE", processed_at, error)])
                result = DiscoveryRepository(connection).prepare_discovery_pair(
                    DiscoveryItemCandidateRecord(store_id=12, source_url=B, title="Catan")
                )
                self.assertEqual(result.activate_if_ready, expected)

    def test_hidden_unfinished_or_failed_row_can_activate_after_successful_retry(self):
        # A manual hide has no distinct marker in the one-column design.
        for processed_at, error in [(None, ""), ("2026-09-01", "Importer unavailable")]:
            with self.subTest(processed_at=processed_at, error=error):
                observed = FakeConnection(fetchone_rows=[(7, processed_at, error)])
                self.assertFalse(DiscoveryRepository(observed).observe_discovery_pair(12, B, B))

                prepared = FakeConnection(fetchone_rows=[(7, "PENDING", None, "NONE", processed_at, error)])
                result = DiscoveryRepository(prepared).prepare_discovery_pair(
                    DiscoveryItemCandidateRecord(store_id=12, source_url=B, title="Catan")
                )
                self.assertTrue(result.should_process)
                self.assertTrue(result.activate_if_ready)

                completed_state = DiscoveryPairState(7, B, None, False, "PENDING", processed_at="2026-09-02")
                completed = FakeConnection(
                    fetchone_rows=[(12,), (None, B, error, processed_at, False)],
                    fetchall_rows=[[astuple(completed_state)]],
                )
                self.assertTrue(DiscoveryRepository(completed).complete_discovery_pair(
                    7, activate_if_ready=result.activate_if_ready, non_boardgame_success=True
                ))
                writes = [(sql, params) for sql, params in completed.cursor_instance.executions
                          if "update store_items set store_active" in sql]
                self.assertEqual(writes[-1][1], (True, 7))

    def test_winner_replacement_disables_loser_before_activation(self):
        redirect = DiscoveryPairState(1, B, A, True, "LISTED", item_id=9, is_boardgame_confirmed=True, is_boardgame=True, processed_at="2026-09-01")
        direct = DiscoveryPairState(2, B, None, False, "LISTED", item_id=9, is_boardgame_confirmed=True, is_boardgame=True, processed_at="2026-09-02")
        connection = FakeConnection(fetchone_rows=[(12,), (None, B, "", "2026-09-02")], fetchall_rows=[[astuple(redirect), astuple(direct)]])
        self.assertTrue(DiscoveryRepository(connection).complete_discovery_pair(2, activate_if_ready=True))
        writes = [(sql, params) for sql, params in connection.cursor_instance.executions if "update store_items set store_active" in sql]
        self.assertEqual([params[-1] for _sql, params in writes], [1, 2])
        self.assertEqual([params[0] for _sql, params in writes], [False, True])

    def test_non_boardgame_completion_marks_processed_and_manual_hide_stays_hidden(self):
        completion = FakeConnection(fetchone_rows=[(12,), (None, B, "", None)], fetchall_rows=[[astuple(
            DiscoveryPairState(2, B, None, False, "PENDING", processed_at="2026-09-02")
        )]])
        self.assertTrue(DiscoveryRepository(completion).complete_discovery_pair(2, activate_if_ready=True))
        self.assertTrue(any("set processed_at = now()" in sql for sql, _params in completion.cursor_instance.executions))
        hidden = DiscoveryPairState(2, B, None, False, "PENDING", processed_at="2026-09-02")
        rediscovery = FakeConnection(fetchone_rows=[(2, "2026-09-02", "")], fetchall_rows=[[astuple(hidden)]])
        self.assertTrue(DiscoveryRepository(rediscovery).observe_discovery_pair(12, B, B))
        self.assertFalse(any("store_active =" in sql for sql, _params in rediscovery.cursor_instance.executions))

    def test_reappearing_historical_pair_hides_old_target_without_reactivation(self):
        historical = DiscoveryPairState(1, B, A, False, "LISTED", processed_at="2026-09-01")
        latest = DiscoveryPairState(2, "https://example.mx/product/new", A, True, "LISTED", processed_at="2026-09-02")
        connection = FakeConnection(fetchone_rows=[(1, "2026-09-01", "")], fetchall_rows=[[astuple(historical), astuple(latest)]])
        self.assertTrue(DiscoveryRepository(connection).observe_discovery_pair(12, A, B))
        writes = [(sql, params) for sql, params in connection.cursor_instance.executions if "update store_items set store_active" in sql]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0][1], (False, 2))

    def test_both_unavailable_paths_preserve_concurrent_hidden_visibility(self):
        # Input snapshot is visible; SQL must neither read nor overwrite visibility.
        record = DiscoveryItemCandidateRecord(store_id=12, store_item_id=7, source_url=B, title="Catan", availability="available", store_active=True)
        for claimed in (False, True):
            with self.subTest(claimed=claimed):
                connection = FakeConnection(fetchone_rows=[("out_of_stock",)])
                repository = DiscoveryRepository(connection)
                if claimed:
                    repository.deactivate_claimed_store_item_update(record, attempt_id=1, job_id=2, lease_token="00000000-0000-0000-0000-000000000001", run_id="test", worker_id="test", worker_name="test")
                else:
                    repository.mark_item_candidate_inactive(record, job_id=2, run_id="test")
                sql = connection.cursor_instance.executions[0][0]
                self.assertIn("for update", sql)
                self.assertIn("returning previous.availability", sql)
                self.assertNotIn("store_active", sql)
                log_params = connection.cursor_instance.executions[1][1]
                self.assertIn('"out_of_stock"', log_params)
                self.assertIn('"unavailable"', log_params)
                self.assertEqual(record.availability, "unavailable")
                self.assertTrue(record.store_active)

    def test_already_unavailable_claim_completes_without_false_change(self):
        record = DiscoveryItemCandidateRecord(store_id=12, store_item_id=7, source_url=B, title="Catan", store_active=False)
        connection = FakeConnection(fetchone_rows=[("unavailable",)])
        DiscoveryRepository(connection).deactivate_claimed_store_item_update(record, attempt_id=1, job_id=2, lease_token="00000000-0000-0000-0000-000000000001", run_id="test", worker_id="test", worker_name="test")
        self.assertFalse(any("insert into store_item_update_change_log" in sql for sql, _params in connection.cursor_instance.executions))
        self.assertEqual(connection.cursor_instance.executions[1][1], (False, 1))
        self.assertEqual(connection.cursor_instance.executions[-1][1], (0, 2))
        self.assertFalse(record.store_active)


if __name__ == "__main__":
    unittest.main()
