import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import ANY, Mock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.collector import CollectionSummary
from ludora.database import ItemCandidateUpsertResult
from ludora.item_classification import apply_item_classification
from ludora.models import DiscoveryItemCandidateRecord
from ludora.operations import (
    ItemEmbeddingRunResult,
    ItemDiscoveryRunResult,
    ItemUpdateRunResult,
    OperationAlreadyRunning,
    OperationNotRunning,
    StoreDiscoveryRunManager,
    StoreDiscoveryRunResult,
    run_item_embeddings,
    run_item_discovery,
    run_item_update,
    run_store_discovery,
)


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
        connection = Mock()
        repository = Mock()
        records = [object(), object(), object()]

        item_processor = object()
        ai_classifier = Mock()
        ai_classifier.apply_item_classification = object()

        def collect_inventory(_website_url, _store_id, inventory_repository, **_kwargs):
            inventory_repository.upsert_item_candidate(
                DiscoveryItemCandidateRecord(
                    store_id=12,
                    source_url="https://example.mx/products/catan",
                    title="Catan",
                )
            )
            inventory_repository.upsert_item_candidate(
                DiscoveryItemCandidateRecord(
                    store_id=12,
                    source_url="https://example.mx/products/pandemic",
                    title="Pandemic",
                )
            )
            return records

        repository.upsert_item_candidate.side_effect = [
            ItemCandidateUpsertResult(candidate_id=101, listing_status="PENDING", item_id=None, should_process=True, created=True),
            ItemCandidateUpsertResult(candidate_id=102, listing_status="PENDING", item_id=None, should_process=False, created=False),
        ]

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora") as resolve_database_url, patch(
            "ludora.operations.resolve_browser_fetch_enabled", return_value=True
        ) as resolve_browser_fetch_enabled, patch(
            "ludora.operations.resolve_admin_api_url", return_value="http://admin.test"
        ) as resolve_admin_api_url, patch(
            "ludora.operations.resolve_ai_classifier_enabled", return_value=True
        ) as resolve_ai_classifier_enabled, patch(
            "ludora.operations.resolve_openai_api_key", return_value="openai-key"
        ) as resolve_openai_api_key, patch(
            "ludora.operations.resolve_classifier_model", return_value="classifier-model"
        ) as resolve_classifier_model, patch(
            "ludora.operations.resolve_openai_base_url", return_value="http://ai.test/v1"
        ) as resolve_openai_base_url, patch(
            "ludora.operations.connect_database", return_value=connection
        ) as connect_database, patch(
            "ludora.operations.DiscoveryRepository", return_value=repository
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
            )

        resolve_database_url.assert_called_once()
        self.assertEqual(resolve_database_url.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_browser_fetch_enabled.assert_called_once()
        self.assertEqual(resolve_browser_fetch_enabled.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_admin_api_url.assert_called_once()
        self.assertEqual(resolve_admin_api_url.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_ai_classifier_enabled.assert_called_once()
        self.assertEqual(resolve_ai_classifier_enabled.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_openai_api_key.assert_called_once()
        self.assertEqual(resolve_openai_api_key.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_classifier_model.assert_called_once()
        self.assertEqual(resolve_classifier_model.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_openai_base_url.assert_called_once()
        self.assertEqual(resolve_openai_base_url.call_args.kwargs["dotenv_path"], "custom.env")
        connect_database.assert_called_once_with("postgresql://ludora")
        admin_item_matcher.assert_called_once_with("http://admin.test", repository)
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
        self.assertIs(collect_store_inventory.call_args.kwargs["item_processor"], item_processor)
        self.assertIs(
            collect_store_inventory.call_args.kwargs["item_title_extractor"],
            admin_title_extractor.return_value.extract_title,
        )
        repository.start_store_item_discovery_log.assert_called_once()
        self.assertEqual(repository.start_store_item_discovery_log.call_args.kwargs["run_id"], "run-123")
        self.assertEqual(repository.start_store_item_discovery_log.call_args.kwargs["store_id"], 12)
        self.assertEqual(repository.start_store_item_discovery_log.call_args.kwargs["website_url"], "https://example.mx/")
        repository.complete_store_item_discovery_log.assert_called_once()
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["run_id"], "run-123")
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["status"], "completed")
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["new_items"], 1)
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["error"], "")
        connection.close.assert_called_once_with()
        self.assertEqual(result.store_id, 12)
        self.assertEqual(result.website_url, "https://example.mx/")
        self.assertEqual(result.item_candidates, 3)
        self.assertEqual(result.new_items, 1)

    def test_run_item_discovery_logs_failed_run(self):
        connection = Mock()
        repository = Mock()

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora"), patch(
            "ludora.operations.resolve_browser_fetch_enabled", return_value=False
        ), patch(
            "ludora.operations.resolve_admin_api_url", return_value="http://admin.test"
        ), patch(
            "ludora.operations.resolve_ai_classifier_enabled", return_value=False
        ), patch(
            "ludora.operations.connect_database", return_value=connection
        ), patch(
            "ludora.operations.DiscoveryRepository", return_value=repository
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
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["error"], "crawl failed")
        connection.close.assert_called_once_with()

    def test_run_item_discovery_uses_heuristic_classifier_when_ai_disabled(self):
        connection = Mock()
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
            "ludora.operations.connect_database", return_value=connection
        ), patch(
            "ludora.operations.DiscoveryRepository", return_value=repository
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

    def test_run_item_discovery_requires_openai_key_when_ai_classifier_enabled(self):
        connection = Mock()
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
            "ludora.operations.connect_database", return_value=connection
        ) as connect_database, patch(
            "ludora.operations.DiscoveryRepository", return_value=repository
        ):
            with self.assertRaisesRegex(RuntimeError, "Missing OpenAI API key for AI item classifier"):
                run_item_discovery(store_id=12, website_url="https://example.mx/", run_id="run-123")

        connect_database.assert_called_once_with("postgresql://ludora")
        repository.start_store_item_discovery_log.assert_called_once()
        repository.complete_store_item_discovery_log.assert_called_once()
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["run_id"], "run-123")
        self.assertEqual(repository.complete_store_item_discovery_log.call_args.kwargs["status"], "failed")
        self.assertEqual(
            repository.complete_store_item_discovery_log.call_args.kwargs["error"],
            "Missing OpenAI API key for AI item classifier",
        )
        connection.close.assert_called_once_with()

    def test_run_item_update_refreshes_confirmed_boardgames_and_closes_database(self):
        connection = Mock()
        repository = Mock()
        repository.start_store_item_update_log.return_value = 99
        records = [object(), object()]

        with patch("ludora.operations.resolve_database_url", return_value="postgresql://ludora") as resolve_database_url, patch(
            "ludora.operations.resolve_browser_fetch_enabled", return_value=True
        ) as resolve_browser_fetch_enabled, patch(
            "ludora.operations.connect_database", return_value=connection
        ) as connect_database, patch(
            "ludora.operations.DiscoveryRepository", return_value=repository
        ), patch(
            "ludora.operations.update_confirmed_store_items", return_value=records
        ) as update_confirmed_store_items:
            result = run_item_update(env_file="custom.env", store_ids=[12, 34])

        resolve_database_url.assert_called_once()
        self.assertEqual(resolve_database_url.call_args.kwargs["dotenv_path"], "custom.env")
        resolve_browser_fetch_enabled.assert_called_once()
        self.assertEqual(resolve_browser_fetch_enabled.call_args.kwargs["dotenv_path"], "custom.env")
        connect_database.assert_called_once_with("postgresql://ludora")
        update_confirmed_store_items.assert_called_once_with(
            repository,
            browser_fetch_enabled=True,
            job_id=99,
            run_id=ANY,
            store_ids=[12, 34],
        )
        repository.start_store_item_update_log.assert_called_once()
        update_run_id = repository.start_store_item_update_log.call_args.kwargs["run_id"]
        self.assertEqual(update_confirmed_store_items.call_args.kwargs["run_id"], update_run_id)
        repository.complete_store_item_update_log.assert_called_once()
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["job_id"], 99)
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["status"], "completed")
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["scanned_items"], 2)
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["updated_items"], 2)
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["error"], "")
        connection.close.assert_called_once_with()
        self.assertEqual(result.updated_items, 2)

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

        repository.start_store_item_update_log.assert_called_once_with(run_id="run-123")
        repository.complete_store_item_update_log.assert_called_once()
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["job_id"], 99)
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["status"], "failed")
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["scanned_items"], 0)
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["updated_items"], 0)
        self.assertEqual(repository.complete_store_item_update_log.call_args.kwargs["error"], "update failed")
        connection.close.assert_called_once_with()

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
