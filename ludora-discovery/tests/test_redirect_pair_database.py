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
    def test_new_pair_is_persisted_inactive_and_still_requests_matching(self):
        connection = FakeConnection(fetchone_rows=[None, (7, "PENDING", None)])
        repository = DiscoveryRepository(connection)
        record = DiscoveryItemCandidateRecord(store_id=12, source_url=B, source_url_origin=A, title="Catan")
        result = repository.prepare_discovery_pair(record)
        self.assertTrue(result.created)
        self.assertTrue(result.should_process)
        insert_sql, insert_params = connection.cursor_instance.executions[2]
        self.assertIn("insert into store_items", insert_sql)
        self.assertEqual(insert_params[-2:], (A, False))
        pending_sql, pending_params = connection.cursor_instance.executions[3]
        self.assertIn("discovery_disabled_reason = 'pending'", pending_sql)
        self.assertEqual(pending_params, (True, 7))
        self.assertEqual(record.store_item_id, 7)
        self.assertEqual(connection.commits, 1)

    def test_nonthrowing_matcher_failure_remains_pending(self):
        connection = FakeConnection(fetchone_rows=[(12,), (None, B, "Importer unavailable")])
        repository = DiscoveryRepository(connection)
        self.assertFalse(repository.complete_discovery_pair(7))
        self.assertFalse(any("update store_items" in sql for sql, _params in connection.cursor_instance.executions))

    def test_errored_completed_row_requests_matching_again(self):
        connection = FakeConnection(fetchone_rows=[(7, "PENDING", None, "NONE", "2026-09-01", None, "Importer unavailable")])
        result = DiscoveryRepository(connection).prepare_discovery_pair(DiscoveryItemCandidateRecord(store_id=12, source_url=B, title="Catan"))
        self.assertTrue(result.should_process)
        self.assertIn("for update", connection.cursor_instance.executions[1][0])

    def test_winner_replacement_disables_loser_before_activation(self):
        redirect = DiscoveryPairState(1, B, A, True, "LISTED", item_id=9, is_boardgame_confirmed=True, is_boardgame=True)
        direct = DiscoveryPairState(2, B, None, False, "LISTED", "pending", active_before_suppression=True, item_id=9, is_boardgame_confirmed=True, is_boardgame=True)
        connection = FakeConnection(fetchone_rows=[(12,), (None, B, "")], fetchall_rows=[[astuple(redirect), astuple(direct)]])
        self.assertTrue(DiscoveryRepository(connection).complete_discovery_pair(2))
        writes = [(sql, params) for sql, params in connection.cursor_instance.executions if "update store_items set" in sql]
        self.assertEqual([params[-1] for _sql, params in writes], [1, 2])
        self.assertEqual([params[-2] for _sql, params in writes], [False, True])
        self.assertEqual(writes[0][1][0:2], ("duplicate", 2))

    def test_repeat_disabled_pair_touches_without_erasing_saved_eligibility(self):
        redirect = DiscoveryPairState(1, B, A, False, "LISTED", "duplicate", 2, active_before_suppression=True)
        direct = DiscoveryPairState(2, B, None, True, "LISTED")
        connection = FakeConnection(fetchone_rows=[(1, "duplicate", "", True)], fetchall_rows=[[astuple(redirect), astuple(direct)]])
        self.assertTrue(DiscoveryRepository(connection).observe_discovery_pair(12, A, B))
        self.assertEqual(connection.cursor_instance.executions[1][1], (12, A, B))
        writes = [sql for sql, _params in connection.cursor_instance.executions if "update store_items" in sql]
        self.assertEqual(len(writes), 1)
        self.assertNotIn("store_active", writes[0])

    def test_independently_inactive_direct_pair_is_recorded_without_reactivation(self):
        direct = DiscoveryPairState(2, B, None, False, "LISTED")
        connection = FakeConnection(fetchone_rows=[(2, None, "", True)], fetchall_rows=[[astuple(direct)]])
        self.assertTrue(DiscoveryRepository(connection).observe_discovery_pair(13, B, B))
        self.assertEqual(connection.cursor_instance.executions[1][1], (13, None, B))
        self.assertFalse(any("store_active =" in sql for sql, _params in connection.cursor_instance.executions))

    def test_error_or_pending_pair_is_not_skipped(self):
        for row in [(7, "pending", "", False), (7, None, "Importer unavailable", True), (7, "superseded", "", False)]:
            with self.subTest(row=row):
                connection = FakeConnection(fetchone_rows=[row])
                self.assertFalse(DiscoveryRepository(connection).observe_discovery_pair(12, A, B))
                self.assertFalse(any("update store_items" in sql for sql, _params in connection.cursor_instance.executions))

    def test_both_update_deactivation_paths_reach_suppressed_rows(self):
        record = DiscoveryItemCandidateRecord(store_id=12, store_item_id=7, source_url=B, title="Catan")
        connection = FakeConnection(fetchone_rows=[(7,)])
        repository = DiscoveryRepository(connection)
        repository.mark_item_candidate_inactive(record)
        self.assertIn("store_active = true or discovery_disabled_reason is not null", connection.cursor_instance.executions[0][0])
        connection = FakeConnection(fetchone_rows=[(7,)])
        repository = DiscoveryRepository(connection)
        repository.deactivate_claimed_store_item_update(record, attempt_id=1, job_id=2, lease_token="00000000-0000-0000-0000-000000000001", run_id="test", worker_id="test", worker_name="test")
        self.assertIn("store_active = true or discovery_disabled_reason is not null", connection.cursor_instance.executions[0][0])


if __name__ == "__main__":
    unittest.main()
