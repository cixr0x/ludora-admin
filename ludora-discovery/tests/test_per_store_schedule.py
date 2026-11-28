from datetime import datetime, timezone
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, patch

from ludora.continuous_update_worker import _dispatch_claims, run_continuous_update_worker
from ludora.database import DiscoveryRepository
from test_database import FakeConnection, confirmed_store_item_row


TOKEN = "ee2bf2df-2330-430b-8f65-ad41dad4dc62"
WINDOW_START = datetime(2026, 11, 27, 9, tzinfo=timezone.utc)


class PerStoreScheduleTests(TestCase):
    def test_worker_passes_the_schedule_mode_to_its_session(self):
        with patch("ludora.continuous_update_worker._run_worker_session") as session:
            run_continuous_update_worker(
                env={"LUDORA_DATABASE_URL": "postgresql://unused"},
                per_store_schedule=True,
            )
        self.assertTrue(session.call_args.kwargs["per_store_schedule"])

    def test_dispatch_uses_the_per_store_claim_at_poll_time(self):
        repository = Mock(spec=DiscoveryRepository)
        repository.claim_due_per_store_item_update.return_value = None
        stop_event = Mock()
        stop_event.wait.side_effect = [False, True]
        stop_event.is_set.return_value = False

        _dispatch_claims(
            executor=Mock(), process_slot=Mock(), repository=repository, worker_id="worker-1",
            lease_seconds=300, poll_seconds=1, concurrency=1, stop_event=stop_event,
            verified_sitemap_store_ids=(42,), per_store_schedule=True,
        )

        repository.claim_due_per_store_item_update.assert_called_once()
        self.assertEqual(repository.claim_due_per_store_item_update.call_args.kwargs["verified_sitemap_store_ids"], (42,))
        repository.claim_due_store_item_update.assert_not_called()

    def test_claim_selects_due_store_then_leases_stalest_unattempted_item(self):
        connection = FakeConnection(fetchone_rows=[
            (42, WINDOW_START, False),
            (777,),
            confirmed_store_item_row(store_item_id=777),
            ("Example", "woocommerce", 0, 2, "example.mx"),
            (91,),
        ])
        repository = DiscoveryRepository(connection)

        claim = repository.claim_due_per_store_item_update(
            worker_name="continuous", worker_id="worker-1", lease_token=TOKEN,
            lease_seconds=300, excluded_store_ids=(7,), verified_sitemap_store_ids=(42,),
        )

        commands = [" ".join(sql.casefold().split()) for sql, _ in connection.cursor_instance.executions]
        self.assertIn("order by schedule.next_due_at, schedule.store_id", commands[0])
        self.assertIn("stores.update_active", commands[0])
        self.assertIn("schedule.window_end > now()", commands[0])
        self.assertIn("cooldown.blocked_until > now()", commands[0])
        self.assertIn("schedule.store_id <> all", commands[0])
        self.assertIn("order by store_items.refreshed_date, store_items.id", commands[1])
        self.assertIn("last_update_attempt_at < %s", commands[1])
        self.assertIn("store_items.availability <> 'unavailable'", commands[1])
        self.assertIn("store_items.availability = 'unavailable'", commands[1])
        self.assertEqual(commands[1].count("order by store_items.refreshed_date, store_items.id for update of store_items skip locked limit 1"), 2)
        self.assertIn("order by refreshed_date, id limit 1", commands[1])
        self.assertNotIn("order by random()", " ".join(commands))
        self.assertIn("update store_item_update_store_schedules", commands[2])
        self.assertIn("insert into store_item_update_attempt_log", commands[5])
        self.assertEqual(claim.attempt_id, 91)
        self.assertEqual(claim.lease_token, TOKEN)
        self.assertEqual(connection.commits, 1)

    def test_claim_rolls_back_the_lease_and_slot_when_attempt_logging_fails(self):
        connection = FakeConnection(fetchone_rows=[
            (42, WINDOW_START, False),
            (777,),
            confirmed_store_item_row(store_item_id=777),
            ("Example", "woocommerce", 0, 2, "example.mx"),
        ])
        repository = DiscoveryRepository(connection)
        execute = connection.cursor_instance.execute

        def fail_attempt_log(sql, params):
            if "insert into store_item_update_attempt_log" in sql:
                raise RuntimeError("attempt logging failed")
            return execute(sql, params)

        with patch.object(connection.cursor_instance, "execute", side_effect=fail_attempt_log):
            with self.assertRaisesRegex(RuntimeError, "attempt logging failed"):
                repository.claim_due_per_store_item_update(
                    worker_name="continuous", worker_id="worker-1", lease_token=TOKEN, lease_seconds=300
                )
        commands = [sql for sql, _ in connection.cursor_instance.executions]
        self.assertIn("set update_lease_token", commands[1])
        self.assertIn("update store_item_update_store_schedules", commands[2])
        self.assertEqual(connection.commits, 0)
        self.assertEqual(connection.rollbacks, 1)

    def test_no_due_cursor_finishes_the_poll_without_the_listing_query(self):
        connection = FakeConnection()
        repository = DiscoveryRepository(connection)
        self.assertIsNone(repository.claim_due_per_store_item_update(
            worker_name="continuous", worker_id="worker-1", lease_token=TOKEN, lease_seconds=300
        ))
        self.assertEqual(connection.commits, 1)
        self.assertEqual(len(connection.cursor_instance.executions), 1)

    def test_one_poll_releases_each_missed_or_empty_cursor_before_claiming_a_third_store(self):
        connection = FakeConnection(fetchone_rows=[
            (42, WINDOW_START, True),
            (43, WINDOW_START, False), None, None,
            (44, WINDOW_START, False), (777,),
            confirmed_store_item_row(store_item_id=777),
            ("Example", "woocommerce", 0, 2, "example.mx"),
            (91,),
        ])
        repository = DiscoveryRepository(connection)
        execute = connection.cursor_instance.execute
        commit = connection.commit
        events = []

        def record_execute(sql, params):
            if "select schedule.store_id" in sql:
                events.append("scan")
            elif "update store_item_update_store_schedules" in sql:
                events.append(params[0])
            return execute(sql, params)

        def record_commit():
            events.append("commit")
            commit()

        with patch.object(connection.cursor_instance, "execute", side_effect=record_execute):
            with patch.object(connection, "commit", side_effect=record_commit):
                claim = repository.claim_due_per_store_item_update(
                    worker_name="continuous", worker_id="worker-1", lease_token=TOKEN, lease_seconds=300
                )
        self.assertEqual(claim.attempt_id, 91)
        self.assertEqual(events, ["scan", 42, "commit", "scan", 43, "commit", "scan", 44, "commit"])

    def test_poll_bounds_the_number_of_missed_cursors_advanced(self):
        connection = FakeConnection(fetchone_rows=[
            (store_id, WINDOW_START, True) for store_id in range(1, 10)
        ])
        repository = DiscoveryRepository(connection)
        self.assertIsNone(repository.claim_due_per_store_item_update(
            worker_name="continuous", worker_id="worker-1", lease_token=TOKEN, lease_seconds=300
        ))
        self.assertEqual(connection.commits, 8)
        self.assertEqual(len(connection.cursor_instance.executions), 16)
        self.assertEqual(len(connection.cursor_instance.fetchone_rows), 1)

    def test_reference_schema_defines_store_before_its_schedule_cursor(self):
        schema = (Path(__file__).resolve().parents[2] / "database/schema.sql").read_text(encoding="utf-8")
        self.assertLess(schema.index("create table if not exists stores ("),
                        schema.index("create table if not exists store_item_update_store_schedules ("))

    def test_missed_slot_advances_only_the_store_schedule(self):
        connection = FakeConnection(fetchone_rows=[(42, WINDOW_START, True)])
        repository = DiscoveryRepository(connection)

        self.assertIsNone(repository.claim_due_per_store_item_update(
            worker_name="continuous", worker_id="worker-1", lease_token=TOKEN, lease_seconds=300
        ))
        commands = [" ".join(sql.casefold().split()) for sql, _ in connection.cursor_instance.executions]
        self.assertEqual(len(commands), 3)
        self.assertIn("update store_item_update_store_schedules", commands[1])
        self.assertIn("select schedule.store_id", commands[2])
        self.assertEqual(connection.commits, 2)

    def test_empty_slot_checks_due_retries_and_advances_without_leasing(self):
        connection = FakeConnection(fetchone_rows=[(42, WINDOW_START, False), None, None])
        repository = DiscoveryRepository(connection)

        self.assertIsNone(repository.claim_due_per_store_item_update(
            worker_name="continuous", worker_id="worker-1", lease_token=TOKEN, lease_seconds=300
        ))
        commands = [" ".join(sql.casefold().split()) for sql, _ in connection.cursor_instance.executions]
        self.assertEqual(len(commands), 5)
        self.assertIn("last_update_attempt_at < %s", commands[1])
        self.assertIn("last_update_attempt_at >= %s", commands[2])
        self.assertIn("consecutive_update_failures > 0", commands[2])
        self.assertIn("first_attempt_waiting as ( select 1 from store_items", commands[2])
        self.assertIn("and not exists (select 1 from first_attempt_waiting)", commands[2])
        self.assertIn("next_update_at <= now()", commands[2])
        self.assertIn("update store_item_update_store_schedules", commands[3])
        self.assertIn("select schedule.store_id", commands[4])
        self.assertEqual(connection.commits, 2)
