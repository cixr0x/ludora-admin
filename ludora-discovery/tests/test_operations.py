import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, MagicMock, Mock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.collector import CollectionSummary
from ludora.database import ItemCandidateUpsertResult
from ludora.item_classification import apply_item_classification
from ludora.models import DiscoveryItemCandidateRecord
from ludora.operations import (
    ItemEmbeddingRunResult,
    ItemDiscoveryBatchError,
    ItemDiscoveryRunResult,
    ItemUpdateRunResult,
    OperationAlreadyRunning,
    OperationNotRunning,
    StoreDiscoveryRunManager,
    StoreDiscoveryRunResult,
    run_item_discovery_batch,
    run_item_embeddings,
    run_item_discovery,
    run_item_update,
    run_store_discovery,
)
from ludora.cancellation import OperationCancelled
from ludora.product_discovery_throttle import ProductDiscoveryRequestThrottle


class StoreDiscoveryOperationsTests(unittest.TestCase):
    def test_run_store_discovery_uses_existing_collector_and_closes_database(self):
        connection = Mock()
        repository = Mock()
        summary = CollectionSummary(
            records=[object(), object()],
            csv_path=None,
            json_path=None,
            audit_csv_path=None,
            audit_json_path=None,
            searched_queries=4,
            candidate_domains=7,
        )

        with patch("ludora.operations.resolve_brave_api_key", return_value="brave-key") as resolve_key, patch(
            "ludora.operations.resolve_database_url", return_value="postgresql://ludora"
        ) as resolve_database_url, patch(
            "ludora.operations.connect_database", return_value=connection
        ) as connect_database, patch(
            "ludora.operations.DiscoveryRepository", return_value=repository
        ), patch(
            "ludora.operations.collect_stores", return_value=summary
        ) as collect_stores:
            result = run_store_discovery(env_file="custom.env")

        resolve_key.assert_called_once()
        self.assertEqual(resolve_key.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_database_url.assert_called_once()
        self.assertEqual(resolve_database_url.call_args.kwargs["dotenv_path"], "custom.env")
        connect_database.assert_called_once_with("postgresql://ludora")
        collect_stores.assert_called_once()
        self.assertEqual(collect_stores.call_args.kwargs["api_key"], "brave-key")
        self.assertIs(collect_stores.call_args.kwargs["discovery_repository"], repository)
        self.assertFalse(collect_stores.call_args.kwargs["export_files"])
        connection.close.assert_called_once_with()
        self.assertEqual(result.searched_queries, 4)
        self.assertEqual(result.candidate_domains, 7)
        self.assertEqual(result.accepted_stores, 2)

    def test_run_store_discovery_requires_brave_key_and_database_url(self):
        with patch("ludora.operations.resolve_brave_api_key", return_value=""), patch(
            "ludora.operations.resolve_database_url", return_value="postgresql://ludora"
        ):
            with self.assertRaisesRegex(RuntimeError, "Missing Brave API key"):
                run_store_discovery()

        with patch("ludora.operations.resolve_brave_api_key", return_value="brave-key"), patch(
            "ludora.operations.resolve_database_url", return_value=""
        ):
            with self.assertRaisesRegex(RuntimeError, "Missing database URL"):
                run_store_discovery()

    def test_run_item_discovery_crawls_one_store_and_closes_database(self):
        coordinator_connection = Mock()
        connection = Mock()
        coordinator_repository = Mock()
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.return_value = True
        repository = Mock()

        item_processor = Mock()
        item_processor.process_candidate.side_effect = (
            lambda _candidate_id, record: setattr(record, "is_boardgame_confirmed", True)
        )
        ai_classifier = Mock()
        ai_classifier.apply_item_classification = object()

        product_urls = ["https://example.mx/products/catan", "https://example.mx/products/sleeves"]

        def collect_inventory(_website_url, _store_id, inventory_repository, **_kwargs):
            for product_url in product_urls:
                _kwargs["before_product_request"](product_url)
            catan = DiscoveryItemCandidateRecord(
                store_id=12,
                source_url="https://example.mx/products/catan",
                title="Catan",
                is_boardgame=True,
            )
            catan_result = inventory_repository.upsert_item_candidate(catan)
            _kwargs["item_processor"].process_candidate(catan_result.candidate_id, catan)

            sleeves = DiscoveryItemCandidateRecord(
                store_id=12,
                source_url="https://example.mx/products/sleeves",
                title="Card Sleeves",
                is_boardgame=False,
                is_boardgame_confirmed=True,
            )
            inventory_repository.upsert_item_candidate(
                sleeves
            )
            return [catan, sleeves]

        repository.upsert_item_candidate.side_effect = [
            ItemCandidateUpsertResult(candidate_id=101, listing_status="PENDING", item_id=None, should_process=True, created=True),
            ItemCandidateUpsertResult(candidate_id=102, listing_status="PENDING", item_id=None, should_process=False, created=False),
        ]

        injected_throttle = Mock()
        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora") as resolve_database_url, patch(
            "ludora.operations.resolve_browser_fetch_enabled", return_value=True
        ) as resolve_browser_fetch_enabled, patch(
            "ludora.operations.resolve_admin_api_url", return_value="http://admin.test"
        ) as resolve_admin_api_url, patch(
            "ludora.operations.resolve_internal_api_token", return_value="internal-token"
        ) as resolve_internal_api_token, patch(
            "ludora.operations.resolve_ai_classifier_enabled", return_value=True
        ) as resolve_ai_classifier_enabled, patch(
            "ludora.operations.resolve_openai_api_key", return_value="openai-key"
        ) as resolve_openai_api_key, patch(
            "ludora.operations.resolve_classifier_model", return_value="classifier-model"
        ) as resolve_classifier_model, patch(
            "ludora.operations.resolve_openai_base_url", return_value="http://ai.test/v1"
        ) as resolve_openai_base_url, patch(
            "ludora.operations.connect_database", side_effect=[coordinator_connection, connection]
        ) as connect_database, patch(
            "ludora.operations.DiscoveryRepository", side_effect=[coordinator_repository, repository]
        ), patch(
            "ludora.operations.AdminItemMatcher", return_value=item_processor
        ) as admin_item_matcher, patch(
            "ludora.operations.AdminAmazonTitleExtractor"
        ) as admin_title_extractor, patch(
            "ludora.operations.OpenAIItemClassifier", return_value=ai_classifier
        ) as openai_item_classifier, patch(
            "ludora.operations.collect_store_inventory", side_effect=collect_inventory
        ) as collect_store_inventory:
            result = run_item_discovery(
                store_id=12,
                website_url="https://example.mx/",
                platform="amazon_brand",
                store_name="Hasbro Gaming",
                env_file="custom.env",
                run_id="run-123",
                product_request_throttle=injected_throttle,
            )

        resolve_database_url.assert_called_once()
        self.assertEqual(resolve_database_url.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_browser_fetch_enabled.assert_called_once()
        self.assertEqual(resolve_browser_fetch_enabled.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_admin_api_url.assert_called_once()
        self.assertEqual(resolve_admin_api_url.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_internal_api_token.assert_called_once()
        self.assertEqual(resolve_internal_api_token.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_ai_classifier_enabled.assert_called_once()
        self.assertEqual(resolve_ai_classifier_enabled.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_openai_api_key.assert_called_once()
        self.assertEqual(resolve_openai_api_key.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_classifier_model.assert_called_once()
        self.assertEqual(resolve_classifier_model.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_openai_base_url.assert_called_once()
        self.assertEqual(resolve_openai_base_url.call_args.kwargs["dotenv_path"], "custom.env")
        self.assertEqual(connect_database.call_args_list, [
            unittest.mock.call("postgresql://ludora"),
            unittest.mock.call("postgresql://ludora"),
        ])
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.assert_called_once_with()
        admin_item_matcher.assert_called_once_with(
            "http://admin.test",
            repository,
            internal_api_token="internal-token",
            trace_logger=ANY,
        )
        admin_title_extractor.assert_called_once_with("http://admin.test", internal_api_token="internal-token")
        openai_item_classifier.assert_called_once_with(
            api_key="openai-key",
            model="classifier-model",
            base_url="http://ai.test/v1",
        )
        collect_store_inventory.assert_called_once()
        self.assertEqual(collect_store_inventory.call_args.args[:2], ("https://example.mx/", 12))
        inventory_repository = collect_store_inventory.call_args.args[2]
        self.assertIs(inventory_repository.repository, repository)
        self.assertEqual(collect_store_inventory.call_args.kwargs["platform"], "amazon_brand")
        self.assertEqual(collect_store_inventory.call_args.kwargs["store_name"], "Hasbro Gaming")
        self.assertTrue(collect_store_inventory.call_args.kwargs["browser_sitemap_fetch_enabled"])
        self.assertIs(collect_store_inventory.call_args.kwargs["item_classifier"], ai_classifier.apply_item_classification)
        tracking_processor = collect_store_inventory.call_args.kwargs["item_processor"]
        self.assertIs(tracking_processor.processor, item_processor)
        self.assertIs(
            collect_store_inventory.call_args.kwargs["item_title_extractor"],
            admin_title_extractor.return_value.extract_title,
        )
        self.assertEqual(
            [call.args[0] for call in injected_throttle.wait_before_request.call_args_list],
            [None, None],
        )
        repository.start_store_item_discovery_log.assert_called_once()
        self.assertEqual(repository.start_store_item_discovery_log.call_args.kwargs["run_id"], "run-123")
        self.assertEqual(repository.start_store_item_discovery_log.call_args.kwargs["store_id"], 12)
        self.assertEqual(repository.start_store_item_discovery_log.call_args.kwargs["website_url"], "https://example.mx/")
        repository.complete_store_item_discovery_log.assert_called_once()
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["run_id"], "run-123")
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["status"], "completed")
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["new_items"], 1)
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["items_discovered"], 2)
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["confirmed_boardgames"], 1)
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["confirmed_non_boardgames"], 1)
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["unconfirmed_boardgames"], 0)
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["unconfirmed_non_boardgames"], 0)
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["error"], "")
        self.assertEqual(repository.update_store_item_discovery_progress.call_count, 3)
        self.assertEqual(
            repository.update_store_item_discovery_progress.call_args_list[0].kwargs,
            {
                "run_id": "run-123",
                "new_items": 1,
                "items_discovered": 1,
                "confirmed_boardgames": 0,
                "confirmed_non_boardgames": 0,
                "unconfirmed_boardgames": 1,
                "unconfirmed_non_boardgames": 0,
            },
        )
        self.assertEqual(
            repository.update_store_item_discovery_progress.call_args_list[1].kwargs,
            {
                "run_id": "run-123",
                "new_items": 1,
                "items_discovered": 1,
                "confirmed_boardgames": 1,
                "confirmed_non_boardgames": 0,
                "unconfirmed_boardgames": 0,
                "unconfirmed_non_boardgames": 0,
            },
        )
        self.assertEqual(
            repository.update_store_item_discovery_progress.call_args_list[2].kwargs,
            {
                "run_id": "run-123",
                "new_items": 1,
                "items_discovered": 2,
                "confirmed_boardgames": 1,
                "confirmed_non_boardgames": 1,
                "unconfirmed_boardgames": 0,
                "unconfirmed_non_boardgames": 0,
            },
        )
        connection.close.assert_called_once_with()
        coordinator_connection.close.assert_called_once_with()
        self.assertEqual(result.store_id, 12)
        self.assertEqual(result.website_url, "https://example.mx/")
        self.assertEqual(result.item_candidates, 2)
        self.assertEqual(result.new_items, 1)
        self.assertEqual(result.items_discovered, 2)
        self.assertEqual(result.confirmed_boardgames, 1)
        self.assertEqual(result.confirmed_non_boardgames, 1)
        self.assertEqual(result.unconfirmed_boardgames, 0)
        self.assertEqual(result.unconfirmed_non_boardgames, 0)

    def test_run_item_discovery_writes_database_trace_events(self):
        coordinator_connection = Mock()
        connection = MagicMock()
        cursor = connection.cursor.return_value.__enter__.return_value
        coordinator_repository = Mock()
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.return_value = True
        repository = Mock()
        repository.upsert_item_candidate.return_value = ItemCandidateUpsertResult(
            candidate_id=101,
            listing_status="PENDING",
            item_id=None,
            should_process=False,
            created=True,
        )

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.resolve_browser_fetch_enabled", return_value=False
        ), patch(
            "ludora.operations.resolve_admin_api_url", return_value="http://admin.test"
        ), patch(
            "ludora.operations.resolve_internal_api_token", return_value="internal-token"
        ), patch(
            "ludora.operations.resolve_ai_classifier_enabled", return_value=False
        ), patch(
            "ludora.operations.connect_database", side_effect=[coordinator_connection, connection]
        ), patch(
            "ludora.operations.DiscoveryRepository", side_effect=[coordinator_repository, repository]
        ), patch(
            "ludora.operations.collect_store_inventory", return_value=[]
        ):
            run_item_discovery(
                store_id=12,
                website_url="https://example.mx/",
                run_id="run-123",
            )

        trace_calls = [
            call
            for call in cursor.execute.call_args_list
            if "insert into store_item_discovery_trace_log" in call.args[0]
        ]
        events = [call.args[1][2] for call in trace_calls]
        self.assertTrue(events)
        self.assertEqual(events[0], "item_discovery.run.start")
        self.assertEqual(trace_calls[0].args[1][0], "run-123")
        self.assertEqual(trace_calls[0].args[1][1], "discovery")
        self.assertIn('"store_id":12', trace_calls[0].args[1][3])
        self.assertIn('"website_url":"https://example.mx/"', trace_calls[0].args[1][3])
        self.assertIn("item_discovery.config.resolved", events)
        self.assertEqual(events[-1], "item_discovery.run.completed")
        coordinator_connection.close.assert_called_once_with()

    def test_run_item_discovery_logs_failed_run(self):
        coordinator_connection = Mock()
        connection = Mock()
        coordinator_repository = Mock()
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.return_value = True
        repository = Mock()

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.resolve_browser_fetch_enabled", return_value=False
        ), patch(
            "ludora.operations.resolve_admin_api_url", return_value="http://admin.test"
        ), patch(
            "ludora.operations.resolve_ai_classifier_enabled", return_value=False
        ), patch(
            "ludora.operations.connect_database", side_effect=[coordinator_connection, connection]
        ), patch(
            "ludora.operations.DiscoveryRepository", side_effect=[coordinator_repository, repository]
        ), patch(
            "ludora.operations.AdminItemMatcher", return_value=object()
        ), patch(
            "ludora.operations.collect_store_inventory", side_effect=RuntimeError("crawl failed")
        ):
            with self.assertRaisesRegex(RuntimeError, "crawl failed"):
                run_item_discovery(
                    store_id=12,
                    website_url="https://example.mx/",
                    env_file="custom.env",
                    run_id="run-123",
                )

        repository.start_store_item_discovery_log.assert_called_once()
        repository.complete_store_item_discovery_log.assert_called_once()
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["run_id"], "run-123")
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["status"], "failed")
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["new_items"], 0)
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["items_discovered"], 0)
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["error"], "crawl failed")
        connection.close.assert_called_once_with()
        coordinator_connection.close.assert_called_once_with()

    def test_run_item_discovery_bounds_failed_trace_and_persisted_job_error(self):
        coordinator_connection = Mock()
        connection = Mock()
        coordinator_repository = Mock()
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.return_value = True
        repository = Mock()
        trace_logger = Mock()
        failure = RuntimeError("upstream GraphQL failure: " + ("x" * 10_000))

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.resolve_browser_fetch_enabled", return_value=False
        ), patch(
            "ludora.operations.resolve_admin_api_url", return_value="http://admin.test"
        ), patch(
            "ludora.operations.resolve_ai_classifier_enabled", return_value=False
        ), patch(
            "ludora.operations.connect_database", side_effect=[coordinator_connection, connection]
        ), patch(
            "ludora.operations.DiscoveryRepository", side_effect=[coordinator_repository, repository]
        ), patch(
            "ludora.operations.create_item_discovery_trace_logger", return_value=trace_logger
        ), patch(
            "ludora.operations.AdminItemMatcher", return_value=object()
        ), patch(
            "ludora.operations.collect_store_inventory", side_effect=failure
        ):
            with self.assertRaises(RuntimeError) as raised:
                run_item_discovery(
                    store_id=12,
                    website_url="https://example.mx/",
                    env_file="custom.env",
                    run_id="run-123",
                )

        self.assertIs(raised.exception, failure)
        failed_trace = next(
            trace_call.kwargs
            for trace_call in trace_logger.log.call_args_list
            if trace_call.args[0] == "item_discovery.run.failed"
        )
        self.assertEqual(failed_trace["store_id"], 12)
        self.assertLessEqual(len(failed_trace["error"]), 2_000)
        self.assertEqual(failed_trace["error_type"], "RuntimeError")
        self.assertTrue(failed_trace["error"].endswith("..."))
        repository.complete_store_item_discovery_log.assert_called_once()
        persisted_error = repository.complete_store_item_discovery_log.call_args.kwargs["error"]
        self.assertLessEqual(len(persisted_error), 2_000)
        self.assertTrue(persisted_error.endswith("..."))
        connection.close.assert_called_once_with()
        coordinator_connection.close.assert_called_once_with()

    def test_run_item_discovery_uses_heuristic_classifier_when_ai_disabled(self):
        coordinator_connection = Mock()
        connection = Mock()
        coordinator_repository = Mock()
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.return_value = True
        repository = Mock()

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.resolve_browser_fetch_enabled", return_value=False
        ), patch(
            "ludora.operations.resolve_admin_api_url", return_value="http://admin.test"
        ), patch(
            "ludora.operations.resolve_ai_classifier_enabled", return_value=False
        ), patch(
            "ludora.operations.resolve_openai_api_key"
        ) as resolve_openai_api_key, patch(
            "ludora.operations.OpenAIItemClassifier"
        ) as openai_item_classifier, patch(
            "ludora.operations.connect_database", side_effect=[coordinator_connection, connection]
        ), patch(
            "ludora.operations.DiscoveryRepository", side_effect=[coordinator_repository, repository]
        ), patch(
            "ludora.operations.AdminItemMatcher", return_value=object()
        ), patch(
            "ludora.operations.collect_store_inventory", return_value=[]
        ) as collect_store_inventory:
            run_item_discovery(store_id=12, website_url="https://example.mx/")

        resolve_openai_api_key.assert_not_called()
        openai_item_classifier.assert_not_called()
        self.assertIs(collect_store_inventory.call_args.kwargs["item_classifier"], apply_item_classification)
        connection.close.assert_called_once_with()
        coordinator_connection.close.assert_called_once_with()

    def test_run_item_discovery_requires_openai_key_when_ai_classifier_enabled(self):
        coordinator_connection = Mock()
        connection = Mock()
        coordinator_repository = Mock()
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.return_value = True
        repository = Mock()

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.resolve_browser_fetch_enabled", return_value=False
        ), patch(
            "ludora.operations.resolve_admin_api_url", return_value="http://admin.test"
        ), patch(
            "ludora.operations.resolve_ai_classifier_enabled", return_value=True
        ), patch(
            "ludora.operations.resolve_openai_api_key", return_value=""
        ), patch(
            "ludora.operations.connect_database", side_effect=[coordinator_connection, connection]
        ) as connect_database, patch(
            "ludora.operations.DiscoveryRepository", side_effect=[coordinator_repository, repository]
        ):
            with self.assertRaisesRegex(RuntimeError, "Missing OpenAI API key for AI item classifier"):
                run_item_discovery(store_id=12, website_url="https://example.mx/", run_id="run-123")

        self.assertEqual(connect_database.call_count, 2)
        repository.start_store_item_discovery_log.assert_called_once()
        repository.complete_store_item_discovery_log.assert_called_once()
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["run_id"], "run-123")
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["status"], "failed")
        self.assertEqual(
            repository.complete_store_item_discovery_log.call_args.kwargs["error"],
            "Missing OpenAI API key for AI item classifier",
        )
        connection.close.assert_called_once_with()
        coordinator_connection.close.assert_called_once_with()

    def test_run_item_discovery_rejects_unavailable_coordinator_before_starting_job(self):
        coordinator_connection = Mock()
        coordinator_repository = Mock()
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.return_value = False
        accepted = Mock()

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.resolve_browser_fetch_enabled", return_value=False
        ), patch(
            "ludora.operations.resolve_admin_api_url", return_value="http://admin.test"
        ), patch(
            "ludora.operations.resolve_ai_classifier_enabled", return_value=False
        ), patch(
            "ludora.operations.connect_database", return_value=coordinator_connection
        ) as connect_database, patch(
            "ludora.operations.DiscoveryRepository", return_value=coordinator_repository
        ), patch(
            "ludora.operations.collect_store_inventory", return_value=[]
        ) as collect_store_inventory:
            with self.assertRaisesRegex(OperationAlreadyRunning, "Item discovery is already running"):
                try:
                    run_item_discovery(
                        store_id=12,
                        website_url="https://example.mx/",
                        on_accepted=accepted,
                    )
                except TypeError as exc:
                    self.fail(f"item discovery lacks the acceptance callback contract: {exc}")

        connect_database.assert_called_once_with("postgresql://ludora")
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.assert_called_once_with()
        coordinator_repository.start_store_item_discovery_log.assert_not_called()
        collect_store_inventory.assert_not_called()
        accepted.assert_not_called()
        coordinator_connection.close.assert_called_once_with()

    def test_run_item_discovery_enables_coordinator_autocommit_before_lock_and_store_work(self):
        """Removing or delaying coordinator autocommit must fail this test."""
        events = []

        class RecordingCoordinatorConnection:
            @property
            def autocommit(self):
                return False

            @autocommit.setter
            def autocommit(self, value):
                events.append(("autocommit", value))

            def close(self):
                events.append(("close", None))

        class RecordingCoordinatorRepository:
            def try_acquire_item_discovery_coordinator_lock(self):
                events.append(("lock", None))
                return True

        result = ItemDiscoveryRunResult(store_id=12, website_url="https://example.mx/", item_candidates=0)
        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.connect_database", return_value=RecordingCoordinatorConnection()
        ), patch(
            "ludora.operations.DiscoveryRepository", return_value=RecordingCoordinatorRepository()
        ), patch(
            "ludora.operations._run_item_discovery_for_store",
            side_effect=lambda **_kwargs: events.append(("store_work", None)) or result,
        ):
            try:
                run_item_discovery(
                    store_id=12,
                    website_url="https://example.mx/",
                    on_accepted=lambda: events.append(("accepted", None)),
                )
            except TypeError as exc:
                self.fail(f"item discovery lacks the acceptance callback contract: {exc}")

        self.assertEqual(
            events,
            [
                ("autocommit", True),
                ("lock", None),
                ("accepted", None),
                ("store_work", None),
                ("close", None),
            ],
        )

    def test_run_item_discovery_closes_coordinator_after_cancellation(self):
        coordinator_connection = Mock()
        operation_connection = Mock()
        coordinator_repository = Mock()
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.return_value = True
        operation_repository = Mock()

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.resolve_browser_fetch_enabled", return_value=False
        ), patch(
            "ludora.operations.resolve_admin_api_url", return_value="http://admin.test"
        ), patch(
            "ludora.operations.resolve_ai_classifier_enabled", return_value=False
        ), patch(
            "ludora.operations.connect_database", side_effect=[coordinator_connection, operation_connection]
        ), patch(
            "ludora.operations.DiscoveryRepository", side_effect=[coordinator_repository, operation_repository]
        ), patch(
            "ludora.operations.collect_store_inventory", side_effect=OperationCancelled("cancelled")
        ):
            with self.assertRaisesRegex(OperationCancelled, "cancelled"):
                run_item_discovery(store_id=12, website_url="https://example.mx/")

        coordinator_repository.try_acquire_item_discovery_coordinator_lock.assert_called_once_with()
        operation_connection.close.assert_called_once_with()
        coordinator_connection.close.assert_called_once_with()

    def test_run_item_discovery_batch_rejects_unavailable_coordinator_before_listing_stores(self):
        coordinator_connection = Mock()
        coordinator_repository = Mock()
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.return_value = False
        coordinator_repository.list_store_item_discovery_sources.return_value = []
        accepted = Mock()

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.connect_database", return_value=coordinator_connection
        ) as connect_database, patch(
            "ludora.operations.DiscoveryRepository", return_value=coordinator_repository
        ), patch(
            "ludora.operations._run_item_discovery_for_store"
        ) as run_item_discovery_for_store:
            with self.assertRaisesRegex(OperationAlreadyRunning, "Item discovery is already running"):
                try:
                    run_item_discovery_batch(on_accepted=accepted)
                except TypeError as exc:
                    self.fail(f"item discovery batch lacks the acceptance callback contract: {exc}")

        connect_database.assert_called_once_with("postgresql://ludora")
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.assert_called_once_with()
        coordinator_repository.list_store_item_discovery_sources.assert_not_called()
        run_item_discovery_for_store.assert_not_called()
        accepted.assert_not_called()
        coordinator_connection.close.assert_called_once_with()

    def test_run_item_discovery_batch_enables_coordinator_autocommit_before_lock_and_store_listing(self):
        """Moving autocommit after lock acquisition or listing must fail this test."""
        events = []

        class RecordingCoordinatorConnection:
            @property
            def autocommit(self):
                return False

            @autocommit.setter
            def autocommit(self, value):
                events.append(("autocommit", value))

            def close(self):
                events.append(("close", None))

        class RecordingCoordinatorRepository:
            def try_acquire_item_discovery_coordinator_lock(self):
                events.append(("lock", None))
                return True

        listing_connection = Mock()
        listing_repository = Mock()
        listing_repository.list_store_item_discovery_sources.side_effect = (
            lambda **_kwargs: events.append(("store_listing", None)) or []
        )
        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.connect_database",
            side_effect=[RecordingCoordinatorConnection(), listing_connection],
        ), patch(
            "ludora.operations.DiscoveryRepository",
            side_effect=[RecordingCoordinatorRepository(), listing_repository],
        ):
            try:
                run_item_discovery_batch(on_accepted=lambda: events.append(("accepted", None)))
            except TypeError as exc:
                self.fail(f"item discovery batch lacks the acceptance callback contract: {exc}")

        self.assertEqual(
            events,
            [
                ("autocommit", True),
                ("lock", None),
                ("accepted", None),
                ("store_listing", None),
                ("close", None),
            ],
        )

    def test_run_item_discovery_batch_runs_selected_stores_and_closes_database(self):
        coordinator_connection = Mock()
        listing_connection = Mock()
        coordinator_repository = Mock()
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.return_value = True
        listing_repository = Mock()
        stores = [
            SimpleNamespace(store_id=12, store_name="Alpha Games", website_url="https://alpha.mx/", platform="shopify"),
            SimpleNamespace(store_id=34, store_name="Beta Games", website_url="https://beta.mx/", platform="custom"),
        ]
        coordinator_repository.list_store_item_discovery_sources.return_value = stores
        listing_repository.list_store_item_discovery_sources.return_value = stores

        class FakeClock:
            def __init__(self):
                self.now = 100.0
                self.waits = []

            def monotonic(self):
                return self.now

            def wait(self, seconds, _cancellation_token):
                self.waits.append(seconds)
                self.now += seconds

        fake_clock = FakeClock()
        injected_throttle = ProductDiscoveryRequestThrottle(clock=fake_clock.monotonic, waiter=fake_clock.wait)
        item_discovery_results = [
            ItemDiscoveryRunResult(
                store_id=12,
                website_url="https://alpha.mx/",
                item_candidates=4,
                new_items=3,
                items_discovered=4,
                confirmed_boardgames=2,
                confirmed_non_boardgames=1,
                unconfirmed_boardgames=1,
            ),
            ItemDiscoveryRunResult(
                store_id=34,
                website_url="https://beta.mx/",
                item_candidates=2,
                new_items=1,
                items_discovered=2,
                confirmed_boardgames=1,
                unconfirmed_non_boardgames=1,
            ),
        ]

        def run_item_discovery_with_throttle(**kwargs):
            kwargs["product_request_throttle"].wait_before_request()
            return item_discovery_results.pop(0)

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.connect_database", side_effect=[coordinator_connection, listing_connection]
        ), patch(
            "ludora.operations.DiscoveryRepository", side_effect=[coordinator_repository, listing_repository]
        ), patch(
            "ludora.operations.run_item_discovery",
            side_effect=run_item_discovery_with_throttle,
        ) as coordinated_run_item_discovery, patch(
            "ludora.operations._run_item_discovery_for_store",
            side_effect=run_item_discovery_with_throttle,
        ) as run_item_discovery_for_store:
            result = run_item_discovery_batch(
                env_file="custom.env",
                run_id="batch-run",
                store_ids=[12, 34],
                product_request_throttle=injected_throttle,
            )

        coordinator_repository.try_acquire_item_discovery_coordinator_lock.assert_called_once_with()
        listing_repository.list_store_item_discovery_sources.assert_called_once_with(store_ids=[12, 34])
        coordinated_run_item_discovery.assert_not_called()
        self.assertEqual(run_item_discovery_for_store.call_count, 2)
        self.assertEqual(
            [entry.kwargs["store_id"] for entry in run_item_discovery_for_store.call_args_list],
            [12, 34],
        )
        first_call = run_item_discovery_for_store.call_args_list[0].kwargs
        second_call = run_item_discovery_for_store.call_args_list[1].kwargs
        self.assertEqual(first_call["store_id"], 12)
        self.assertEqual(first_call["website_url"], "https://alpha.mx/")
        self.assertEqual(first_call["store_name"], "Alpha Games")
        self.assertEqual(first_call["platform"], "shopify")
        self.assertEqual(first_call["run_id"], "batch-run:12")
        self.assertEqual(second_call["store_id"], 34)
        self.assertEqual(second_call["run_id"], "batch-run:34")
        first_throttle = run_item_discovery_for_store.call_args_list[0].kwargs["product_request_throttle"]
        second_throttle = run_item_discovery_for_store.call_args_list[1].kwargs["product_request_throttle"]
        self.assertIs(first_throttle, second_throttle)
        self.assertIs(first_throttle, injected_throttle)
        self.assertEqual(fake_clock.waits, [3.0])
        self.assertIsNone(result.store_id)
        self.assertEqual(result.website_url, "")
        self.assertEqual(result.item_candidates, 6)
        self.assertEqual(result.new_items, 4)
        self.assertEqual(result.items_discovered, 6)
        self.assertEqual(result.confirmed_boardgames, 3)
        self.assertEqual(result.confirmed_non_boardgames, 1)
        self.assertEqual(result.unconfirmed_boardgames, 1)
        self.assertEqual(result.unconfirmed_non_boardgames, 1)
        self.assertEqual(result.stores_scanned, 2)
        listing_connection.close.assert_called_once_with()
        coordinator_connection.close.assert_called_once_with()

    def test_run_item_discovery_batch_continues_after_store_failures_and_raises_aggregate_error(self):
        """Removing the per-store exception handler must fail this test."""
        coordinator_connection = Mock()
        listing_connection = Mock()
        trace_connection = Mock()
        coordinator_repository = Mock()
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.return_value = True
        listing_repository = Mock()
        stores = [
            SimpleNamespace(store_id=12, store_name="Alpha Games", website_url="https://alpha.mx/", platform="shopify"),
            SimpleNamespace(store_id=34, store_name="Beta Games", website_url="https://beta.mx/", platform="custom"),
            SimpleNamespace(store_id=56, store_name="Gamma Games", website_url="https://gamma.mx/", platform="shopify"),
        ]
        coordinator_repository.list_store_item_discovery_sources.return_value = stores
        listing_repository.list_store_item_discovery_sources.return_value = stores
        throttle = ProductDiscoveryRequestThrottle()
        trace_logger = Mock()

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.connect_database", side_effect=[coordinator_connection, listing_connection, trace_connection]
        ), patch(
            "ludora.operations.DiscoveryRepository", side_effect=[coordinator_repository, listing_repository]
        ), patch(
            "ludora.operations.create_item_discovery_trace_logger", return_value=trace_logger
        ), patch(
            "ludora.operations.run_item_discovery",
            side_effect=[
                RuntimeError("Alpha failure " + "x" * 600),
                ItemDiscoveryRunResult(store_id=34, website_url="https://beta.mx/", item_candidates=2),
                RuntimeError("Gamma failure"),
            ],
        ) as coordinated_run_item_discovery, patch(
            "ludora.operations._run_item_discovery_for_store",
            side_effect=[
                RuntimeError("Alpha failure " + "x" * 600),
                ItemDiscoveryRunResult(store_id=34, website_url="https://beta.mx/", item_candidates=2),
                RuntimeError("Gamma failure"),
            ],
        ) as run_item_discovery_for_store:
            with self.assertRaises(ItemDiscoveryBatchError) as raised:
                run_item_discovery_batch(
                    run_id="batch-run",
                    product_request_throttle=throttle,
                )

        self.assertEqual(
            [call.kwargs["store_id"] for call in run_item_discovery_for_store.call_args_list],
            [12, 34, 56],
        )
        self.assertTrue(
            all(call.kwargs["product_request_throttle"] is throttle for call in run_item_discovery_for_store.call_args_list)
        )
        coordinated_run_item_discovery.assert_not_called()
        self.assertEqual(
            [(failure.store_id, failure.store_name) for failure in raised.exception.failures],
            [(12, "Alpha Games"), (56, "Gamma Games")],
        )
        self.assertEqual(raised.exception.failures[0].error, "Alpha failure " + "x" * 486)
        self.assertIn("Alpha Games", str(raised.exception))
        self.assertIn("Gamma Games", str(raised.exception))
        self.assertLessEqual(len(str(raised.exception)), 4000)
        trace_logger.log.assert_called_once_with(
            "item_discovery.batch.failed",
            failed_store_count=2,
            failed_stores=[
                {"store_id": 12, "store_name": "Alpha Games", "error": "Alpha failure " + "x" * 486},
                {"store_id": 56, "store_name": "Gamma Games", "error": "Gamma failure"},
            ],
            stores_attempted=3,
        )
        listing_connection.close.assert_called_once_with()
        trace_connection.close.assert_called_once_with()
        coordinator_connection.close.assert_called_once_with()

    def test_run_item_discovery_batch_normalizes_empty_store_name_in_failure(self):
        """Removing the empty-name fallback must fail this test."""
        coordinator_connection = Mock()
        listing_connection = Mock()
        trace_connection = Mock()
        coordinator_repository = Mock()
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.return_value = True
        listing_repository = Mock()
        stores = [
            SimpleNamespace(store_id=12, store_name="  ", website_url="https://alpha.mx/", platform="shopify"),
        ]
        coordinator_repository.list_store_item_discovery_sources.return_value = stores
        listing_repository.list_store_item_discovery_sources.return_value = stores

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.connect_database", side_effect=[coordinator_connection, listing_connection, trace_connection]
        ), patch(
            "ludora.operations.DiscoveryRepository", side_effect=[coordinator_repository, listing_repository]
        ), patch(
            "ludora.operations.run_item_discovery", side_effect=RuntimeError()
        ) as coordinated_run_item_discovery, patch(
            "ludora.operations._run_item_discovery_for_store", side_effect=RuntimeError()
        ):
            with self.assertRaises(ItemDiscoveryBatchError) as raised:
                run_item_discovery_batch(run_id="batch-run")

        self.assertEqual(raised.exception.failures[0].store_name, "Store 12")
        self.assertEqual(raised.exception.failures[0].error, "RuntimeError")
        coordinated_run_item_discovery.assert_not_called()
        coordinator_connection.close.assert_called_once_with()

    def test_run_item_discovery_batch_cancellation_aborts_before_later_stores(self):
        """Catching OperationCancelled as a store failure must fail this test."""
        coordinator_connection = Mock()
        listing_connection = Mock()
        coordinator_repository = Mock()
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.return_value = True
        listing_repository = Mock()
        stores = [
            SimpleNamespace(store_id=12, store_name="Alpha Games", website_url="https://alpha.mx/", platform="shopify"),
            SimpleNamespace(store_id=34, store_name="Beta Games", website_url="https://beta.mx/", platform="custom"),
        ]
        coordinator_repository.list_store_item_discovery_sources.return_value = stores
        listing_repository.list_store_item_discovery_sources.return_value = stores

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.connect_database", side_effect=[coordinator_connection, listing_connection]
        ), patch(
            "ludora.operations.DiscoveryRepository", side_effect=[coordinator_repository, listing_repository]
        ), patch(
            "ludora.operations.run_item_discovery", side_effect=OperationCancelled("cancelled")
        ) as coordinated_run_item_discovery, patch(
            "ludora.operations._run_item_discovery_for_store",
            side_effect=OperationCancelled("cancelled"),
        ) as run_item_discovery_for_store:
            with self.assertRaises(OperationCancelled):
                run_item_discovery_batch(run_id="batch-run")

        coordinated_run_item_discovery.assert_not_called()
        self.assertEqual(run_item_discovery_for_store.call_count, 1)
        self.assertEqual(run_item_discovery_for_store.call_args.kwargs["store_id"], 12)
        listing_connection.close.assert_called_once_with()
        coordinator_connection.close.assert_called_once_with()

    def test_run_item_discovery_batch_preserves_aggregate_error_when_batch_trace_fails(self):
        """Letting trace failures mask store failures must fail this test."""
        coordinator_connection = Mock()
        listing_connection = Mock()
        trace_connection = Mock()
        coordinator_repository = Mock()
        coordinator_repository.try_acquire_item_discovery_coordinator_lock.return_value = True
        listing_repository = Mock()
        stores = [
            SimpleNamespace(store_id=12, store_name="Alpha Games", website_url="https://alpha.mx/", platform="shopify"),
        ]
        coordinator_repository.list_store_item_discovery_sources.return_value = stores
        listing_repository.list_store_item_discovery_sources.return_value = stores

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.connect_database", side_effect=[coordinator_connection, listing_connection, trace_connection]
        ), patch(
            "ludora.operations.DiscoveryRepository", side_effect=[coordinator_repository, listing_repository]
        ), patch(
            "ludora.operations.create_item_discovery_trace_logger", side_effect=RuntimeError("trace unavailable")
        ), patch(
            "ludora.operations.run_item_discovery", side_effect=RuntimeError("store failure")
        ) as coordinated_run_item_discovery, patch(
            "ludora.operations._run_item_discovery_for_store",
            side_effect=RuntimeError("store failure"),
        ):
            with self.assertRaises(ItemDiscoveryBatchError) as raised:
                run_item_discovery_batch(run_id="batch-run")

        self.assertEqual(raised.exception.failures[0].error, "store failure")
        coordinated_run_item_discovery.assert_not_called()
        trace_connection.close.assert_called_once_with()
        coordinator_connection.close.assert_called_once_with()

    def test_run_item_update_refreshes_confirmed_boardgames_and_closes_database(self):
        connection = Mock()
        repository = Mock()
        repository.start_store_item_update_log.return_value = 99

        class UpdateRecords(list):
            updated_items = 1

        records = UpdateRecords([object(), object()])

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora") as resolve_database_url, patch(
            "ludora.operations.resolve_browser_fetch_enabled", return_value=True
        ) as resolve_browser_fetch_enabled, patch(
            "ludora.operations.resolve_admin_api_url", return_value="http://admin.test"
        ) as resolve_admin_api_url, patch(
            "ludora.operations.resolve_internal_api_token", return_value="internal-token"
        ) as resolve_internal_api_token, patch(
            "ludora.operations.connect_database", return_value=connection
        ) as connect_database, patch(
            "ludora.operations.DiscoveryRepository", return_value=repository
        ), patch(
            "ludora.operations.AdminAmazonTitleExtractor"
        ) as admin_title_extractor, patch(
            "ludora.operations.update_confirmed_store_items", return_value=records
        ) as update_confirmed_store_items:
            result = run_item_update(env_file="custom.env", store_ids=[12, 34])

        resolve_database_url.assert_called_once()
        self.assertEqual(resolve_database_url.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_browser_fetch_enabled.assert_called_once()
        self.assertEqual(resolve_browser_fetch_enabled.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_admin_api_url.assert_called_once()
        self.assertEqual(resolve_admin_api_url.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_internal_api_token.assert_called_once()
        self.assertEqual(resolve_internal_api_token.call_args.kwargs["dotenv_path"], "custom.env")
        self.assertEqual(connect_database.call_count, 2)
        connect_database.assert_called_with("postgresql://ludora")
        admin_title_extractor.assert_called_once_with("http://admin.test", internal_api_token="internal-token")
        update_confirmed_store_items.assert_called_once_with(
            repository,
            browser_fetch_enabled=True,
            job_id=99,
            run_id=ANY,
            store_ids=[12, 34],
            item_title_extractor=ANY,
            request_headers_provider=None,
            trace_logger=ANY,
        )
        repository.start_store_item_update_log.assert_called_once()
        update_run_id = repository.start_store_item_update_log.call_args.kwargs["run_id"]
        self.assertIsNone(repository.start_store_item_update_log.call_args.kwargs["store_id"])
        self.assertEqual(update_confirmed_store_items.call_args.kwargs["run_id"], update_run_id)
        repository.complete_store_item_update_log.assert_called_once()
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["job_id"], 99)
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["status"], "completed")
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["scanned_items"], 2)
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["updated_items"], 1)
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["error"], "")
        connection.close.assert_called_once_with()
        self.assertEqual(result.updated_items, 1)

    def test_run_item_update_logs_failed_run(self):
        connection = Mock()
        repository = Mock()
        repository.start_store_item_update_log.return_value = 99

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.resolve_browser_fetch_enabled", return_value=True
        ), patch(
            "ludora.operations.connect_database", return_value=connection
        ), patch(
            "ludora.operations.DiscoveryRepository", return_value=repository
        ), patch(
            "ludora.operations.update_confirmed_store_items", side_effect=RuntimeError("update failed")
        ):
            with self.assertRaisesRegex(RuntimeError, "update failed"):
                run_item_update(env_file="custom.env", run_id="run-123")

        repository.start_store_item_update_log.assert_called_once_with(run_id="run-123", store_id=None)
        repository.complete_store_item_update_log.assert_called_once()
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["job_id"], 99)
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["status"], "failed")
        self.assertNotIn("scanned_items", repository.complete_store_item_update_log.call_args.kwargs)
        self.assertNotIn("updated_items", repository.complete_store_item_update_log.call_args.kwargs)
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["error"], "update failed")
        connection.close.assert_called_once_with()

    def test_run_item_update_logs_single_selected_store_id(self):
        connection = Mock()
        repository = Mock()
        repository.start_store_item_update_log.return_value = 99

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.resolve_browser_fetch_enabled", return_value=True
        ), patch(
            "ludora.operations.connect_database", return_value=connection
        ), patch(
            "ludora.operations.DiscoveryRepository", return_value=repository
        ), patch(
            "ludora.operations.update_confirmed_store_items", return_value=[]
        ):
            run_item_update(env_file="custom.env", run_id="run-123", store_ids=[12])

        repository.start_store_item_update_log.assert_called_once_with(run_id="run-123", store_id=12)

    def test_run_item_embeddings_embeds_selected_sources_and_closes_database(self):
        connection = Mock()
        repository = Mock()
        source = Mock(item_id=77)
        repository.list_item_search_embedding_sources.return_value = [source]
        client = Mock()
        client.create_embedding.return_value = [0.1, 0.2, 0.3]

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora") as resolve_database_url, patch(
            "ludora.operations.resolve_openai_api_key", return_value="openai-key"
        ) as resolve_openai_api_key, patch(
            "ludora.operations.resolve_embedding_model", return_value="text-embedding-3-small"
        ) as resolve_embedding_model, patch(
            "ludora.operations.connect_database", return_value=connection
        ) as connect_database, patch(
            "ludora.operations.DiscoveryRepository", return_value=repository
        ), patch(
            "ludora.operations.OpenAIEmbeddingClient", return_value=client
        ) as embedding_client, patch(
            "ludora.operations.build_item_embedding_text", return_value="Name: Calico"
        ), patch(
            "ludora.operations.source_text_hash", return_value="source-hash"
        ):
            result = run_item_embeddings(refresh_mode="missing", env_file="custom.env")

        resolve_database_url.assert_called_once()
        self.assertEqual(resolve_database_url.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_openai_api_key.assert_called_once()
        self.assertEqual(resolve_openai_api_key.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_embedding_model.assert_called_once()
        self.assertEqual(resolve_embedding_model.call_args.kwargs["dotenv_path"], "custom.env")
        connect_database.assert_called_once_with("postgresql://ludora")
        embedding_client.assert_called_once_with(api_key="openai-key", model="text-embedding-3-small")
        repository.list_item_search_embedding_sources.assert_called_once_with(refresh_mode="missing")
        client.create_embedding.assert_called_once_with("Name: Calico")
        repository.upsert_item_search_embedding.assert_called_once_with(
            item_id=77,
            embedding=[0.1, 0.2, 0.3],
            source_text="Name: Calico",
            source_hash="source-hash",
            model="text-embedding-3-small",
        )
        connection.close.assert_called_once_with()
        self.assertEqual(result.refresh_mode, "missing")
        self.assertEqual(result.selected_items, 1)
        self.assertEqual(result.embedded_items, 1)
        self.assertEqual(result.model, "text-embedding-3-small")

    def test_run_item_embeddings_requires_openai_key(self):
        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.resolve_openai_api_key", return_value=""
        ):
            with self.assertRaisesRegex(RuntimeError, "Missing OpenAI API key"):
                run_item_embeddings()

    def test_manager_records_successful_run_result(self):
        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(
                searched_queries=1,
                candidate_domains=2,
                accepted_stores=3,
            ),
            background=False,
        )

        run = manager.start_store_discovery()

        self.assertEqual(run.status, "completed")
        self.assertEqual(run.result.accepted_stores, 3)
        self.assertIsNone(run.error)
        self.assertEqual(manager.get_latest_run().id, run.id)

    def test_manager_records_successful_item_discovery_run_result(self):
        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            item_runner=lambda store_id, website_url, platform: ItemDiscoveryRunResult(
                store_id=store_id,
                website_url=website_url,
                item_candidates=4,
            ),
            background=False,
        )

        run = manager.start_item_discovery(12, "https://example.mx/", "amazon")

        self.assertEqual(run.status, "completed")
        self.assertEqual(run.run_type, "item_discovery")
        self.assertEqual(run.result.item_candidates, 4)
        self.assertEqual(run.result.store_id, 12)
        self.assertEqual(manager.get_latest_run().id, run.id)

    def test_manager_records_successful_item_update_run_result(self):
        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            item_update_runner=lambda: ItemUpdateRunResult(updated_items=6),
            background=False,
        )

        run = manager.start_item_update()

        self.assertEqual(run.status, "completed")
        self.assertEqual(run.run_type, "item_update")
        self.assertEqual(run.result.updated_items, 6)
        self.assertEqual(manager.get_latest_run().id, run.id)

    def test_manager_passes_selected_store_ids_to_custom_item_update_runner(self):
        calls = []

        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            item_update_runner=lambda *, store_ids: calls.append(store_ids) or ItemUpdateRunResult(updated_items=6),
            background=False,
        )

        run = manager.start_item_update(store_ids=[12, 34])

        self.assertEqual(run.status, "completed")
        self.assertEqual(run.result.updated_items, 6)
        self.assertEqual(calls, [[12, 34]])

    def test_manager_passes_selected_store_ids_to_custom_item_discovery_batch_runner(self):
        calls = []

        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            item_batch_runner=lambda *, store_ids: calls.append(store_ids)
            or ItemDiscoveryRunResult(store_id=None, website_url="", item_candidates=7, new_items=5, stores_scanned=2),
            background=False,
        )

        run = manager.start_item_discovery_batch(store_ids=[12, 34])

        self.assertEqual(run.status, "completed")
        self.assertEqual(run.run_type, "item_discovery")
        self.assertEqual(run.result.item_candidates, 7)
        self.assertEqual(run.result.stores_scanned, 2)
        self.assertEqual(calls, [[12, 34]])

    def test_manager_records_successful_item_embedding_run_result(self):
        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            item_embedding_runner=lambda refresh_mode: ItemEmbeddingRunResult(
                refresh_mode=refresh_mode,
                selected_items=7,
                embedded_items=7,
                model="text-embedding-3-small",
            ),
            background=False,
        )

        run = manager.start_item_embeddings("full")

        self.assertEqual(run.status, "completed")
        self.assertEqual(run.run_type, "item_embeddings")
        self.assertEqual(run.result.refresh_mode, "full")
        self.assertEqual(run.result.embedded_items, 7)
        self.assertEqual(manager.get_latest_run().id, run.id)

    def test_manager_passes_env_file_to_default_runners(self):
        with patch(
            "ludora.operations.run_store_discovery",
            return_value=StoreDiscoveryRunResult(1, 2, 3),
        ) as store_runner, patch(
            "ludora.operations.run_item_discovery",
            return_value=ItemDiscoveryRunResult(12, "https://example.mx/", 4),
        ) as item_runner, patch(
            "ludora.operations.run_item_update",
            return_value=ItemUpdateRunResult(5),
        ) as item_update_runner, patch(
            "ludora.operations.run_item_embeddings",
            return_value=ItemEmbeddingRunResult("missing", 6, 6, "text-embedding-3-small"),
        ) as item_embedding_runner:
            manager = StoreDiscoveryRunManager(env_file="custom.env", background=False)

            manager.start_store_discovery()
            manager.start_item_discovery(12, "https://example.mx/", "amazon")
            manager.start_item_update([12, 34])
            manager.start_item_embeddings("missing")

        store_runner.assert_called_once_with(env_file="custom.env", cancellation_token=ANY)
        item_runner.assert_called_once_with(
            store_id=12,
            website_url="https://example.mx/",
            platform="amazon",
            store_name="",
            env_file="custom.env",
            cancellation_token=ANY,
            run_id=ANY,
            started_at=ANY,
        )
        item_update_runner.assert_called_once_with(
            env_file="custom.env",
            cancellation_token=ANY,
            run_id=ANY,
            store_ids=[12, 34],
        )
        item_embedding_runner.assert_called_once_with(refresh_mode="missing", env_file="custom.env", cancellation_token=ANY)

    def test_manager_records_failed_run_error(self):
        manager = StoreDiscoveryRunManager(
            runner=lambda: (_ for _ in ()).throw(RuntimeError("collector failed")),
            background=False,
        )

        run = manager.start_store_discovery()

        self.assertEqual(run.status, "failed")
        self.assertEqual(run.error, "collector failed")
        self.assertIsNone(run.result)

    def test_manager_rejects_second_active_run(self):
        release_runner = threading.Event()

        def blocking_runner():
            release_runner.wait(timeout=2)
            return StoreDiscoveryRunResult(
                searched_queries=0,
                candidate_domains=0,
                accepted_stores=0,
            )

        manager = StoreDiscoveryRunManager(
            runner=blocking_runner,
            background=True,
        )
        run = manager.start_store_discovery()

        try:
            self.assertEqual(run.status, "running")
            with self.assertRaises(OperationAlreadyRunning):
                manager.start_store_discovery()
        finally:
            release_runner.set()

    def test_manager_cancels_running_run_when_runner_observes_token(self):
        observed_cancel = threading.Event()

        def cancellable_runner(cancellation_token):
            while not cancellation_token.is_cancelled():
                time.sleep(0.01)
            observed_cancel.set()
            cancellation_token.raise_if_cancelled()
            return StoreDiscoveryRunResult(1, 1, 1)

        manager = StoreDiscoveryRunManager(
            runner=cancellable_runner,
            background=True,
        )
        run = manager.start_store_discovery()

        cancelling_run = manager.cancel_run(run.id)

        self.assertEqual(cancelling_run.status, "cancelling")
        self.assertTrue(observed_cancel.wait(timeout=1))
        cancelled_run = _wait_for_run_status(manager, run.id, "cancelled")
        self.assertEqual(cancelled_run.status, "cancelled")
        self.assertIsNone(cancelled_run.result)
        self.assertIsNone(manager.active_run_id)

    def test_manager_keeps_cancelling_run_active_until_worker_exits(self):
        release_runner = threading.Event()

        def slow_runner(cancellation_token):
            release_runner.wait(timeout=1)
            return StoreDiscoveryRunResult(1, 1, 1)

        manager = StoreDiscoveryRunManager(
            runner=slow_runner,
            background=True,
        )
        run = manager.start_store_discovery()

        manager.cancel_run(run.id)

        with self.assertRaises(OperationAlreadyRunning):
            manager.start_store_discovery()

        release_runner.set()
        cancelled_run = _wait_for_run_status(manager, run.id, "cancelled")
        self.assertEqual(cancelled_run.status, "cancelled")
        self.assertIsNone(cancelled_run.result)

    def test_manager_rejects_cancel_for_non_running_run(self):
        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            background=False,
        )
        run = manager.start_store_discovery()

        with self.assertRaisesRegex(OperationNotRunning, "Run is not running"):
            manager.cancel_run(run.id)


def _wait_for_run_status(manager, run_id, status):
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        run = manager.get_run(run_id)
        if run is not None and run.status == status:
            return run
        time.sleep(0.01)
    run = manager.get_run(run_id)
    raise AssertionError(f"Expected run {run_id} to reach {status}, got {run.status if run else None}")


if __name__ == "__main__":
    unittest.main()
