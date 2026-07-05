import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.api import route_request
from ludora.operations import (
    ItemEmbeddingRunResult,
    ItemDiscoveryRunResult,
    ItemUpdateRunResult,
    OperationAlreadyRunning,
    OperationNotRunning,
    StoreDiscoveryRunManager,
    StoreDiscoveryRunResult,
)


class DiscoveryApiTests(unittest.TestCase):
    def test_health_route_returns_service_status(self):
        status, payload = route_request(
            "GET",
            "/health",
            StoreDiscoveryRunManager(
                runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
                background=False,
            ),
        )

        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["service"], "ludora-discovery-api")

    def test_starts_and_reads_store_discovery_run(self):
        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(
                searched_queries=2,
                candidate_domains=5,
                accepted_stores=3,
            ),
            background=False,
        )

        status, payload = route_request("POST", "/operations/store-discovery-runs", manager)

        self.assertEqual(status, 202)
        self.assertEqual(payload["data"]["type"], "store_discovery")
        self.assertEqual(payload["data"]["status"], "completed")
        self.assertEqual(payload["data"]["result"]["accepted_stores"], 3)

        run_id = payload["data"]["id"]
        get_status, get_payload = route_request("GET", f"/operations/store-discovery-runs/{run_id}", manager)

        self.assertEqual(get_status, 200)
        self.assertEqual(get_payload["data"]["id"], run_id)

    def test_starts_item_discovery_run_for_one_store(self):
        calls = []

        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            item_runner=lambda store_id, website_url, platform, store_name: (
                calls.append((store_id, website_url, platform, store_name))
                or ItemDiscoveryRunResult(
                    store_id=store_id,
                    website_url=website_url,
                    item_candidates=5,
                )
            ),
            background=False,
        )

        status, payload = route_request(
            "POST",
            "/operations/stores/12/item-discovery-runs",
            manager,
            {"website_url": "https://example.mx/", "store_name": "Hasbro Gaming", "platform": "amazon_brand"},
        )

        self.assertEqual(status, 202)
        self.assertEqual(payload["data"]["type"], "item_discovery")
        self.assertEqual(payload["data"]["status"], "completed")
        self.assertEqual(payload["data"]["result"]["store_id"], 12)
        self.assertEqual(payload["data"]["result"]["website_url"], "https://example.mx/")
        self.assertEqual(payload["data"]["result"]["item_candidates"], 5)
        self.assertEqual(calls, [(12, "https://example.mx/", "amazon_brand", "Hasbro Gaming")])

    def test_starts_item_discovery_run_for_selected_stores(self):
        calls = []

        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            item_batch_runner=lambda *, store_ids: calls.append(store_ids)
            or ItemDiscoveryRunResult(store_id=None, website_url="", item_candidates=7, new_items=5, stores_scanned=2),
            background=False,
        )

        status, payload = route_request("POST", "/operations/item-discovery-runs", manager, {"store_ids": [12, 34]})

        self.assertEqual(status, 202)
        self.assertEqual(payload["data"]["type"], "item_discovery")
        self.assertEqual(payload["data"]["status"], "completed")
        self.assertEqual(payload["data"]["result"]["item_candidates"], 7)
        self.assertEqual(payload["data"]["result"]["stores_scanned"], 2)
        self.assertEqual(calls, [[12, 34]])

    def test_starts_item_update_run(self):
        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            item_update_runner=lambda: ItemUpdateRunResult(updated_items=8),
            background=False,
        )

        status, payload = route_request("POST", "/operations/item-update-runs", manager)

        self.assertEqual(status, 202)
        self.assertEqual(payload["data"]["type"], "item_update")
        self.assertEqual(payload["data"]["status"], "completed")
        self.assertEqual(payload["data"]["result"]["updated_items"], 8)

    def test_starts_item_update_run_for_selected_stores(self):
        calls = []

        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            item_update_runner=lambda *, store_ids: calls.append(store_ids) or ItemUpdateRunResult(updated_items=8),
            background=False,
        )

        status, payload = route_request("POST", "/operations/item-update-runs", manager, {"store_ids": [12, 34]})

        self.assertEqual(status, 202)
        self.assertEqual(payload["data"]["type"], "item_update")
        self.assertEqual(payload["data"]["status"], "completed")
        self.assertEqual(payload["data"]["result"]["updated_items"], 8)
        self.assertEqual(calls, [[12, 34]])

    def test_item_update_run_treats_empty_body_and_all_stores_as_unscoped(self):
        calls = []

        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            item_update_runner=lambda *, store_ids: calls.append(store_ids) or ItemUpdateRunResult(updated_items=8),
            background=False,
        )

        no_body_status, _no_body_payload = route_request("POST", "/operations/item-update-runs", manager)
        all_stores_status, _all_stores_payload = route_request(
            "POST",
            "/operations/item-update-runs",
            manager,
            {"all_stores": True},
        )

        self.assertEqual(no_body_status, 202)
        self.assertEqual(all_stores_status, 202)
        self.assertEqual(calls, [None, None])

    def test_item_update_run_rejects_invalid_scope(self):
        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            item_update_runner=lambda **_kwargs: ItemUpdateRunResult(updated_items=0),
            background=False,
        )

        invalid_cases = [
            (
                {"all_stores": True, "store_ids": [12]},
                "Specify either all_stores or store_ids, not both",
            ),
            ({"store_ids": []}, "store_ids must be a non-empty array"),
            ({"store_ids": "12"}, "store_ids must be a non-empty array"),
            ({"store_ids": [12, 0]}, "store_ids must contain positive integers"),
            ({"store_ids": [12, "34"]}, "store_ids must contain positive integers"),
            ({"store_ids": [True]}, "store_ids must contain positive integers"),
            ({"store_ids": [[12]]}, "store_ids must contain positive integers"),
            ({"store_ids": [12, 12]}, "store_ids must not contain duplicates"),
            ({"store_id": [12]}, "Item update scope must include all_stores or store_ids"),
            ({"all_stores": False}, "all_stores must be true when provided"),
        ]

        for body, message in invalid_cases:
            with self.subTest(body=body):
                status, payload = route_request("POST", "/operations/item-update-runs", manager, body)

                self.assertEqual(status, 400)
                self.assertEqual(payload, {"error": {"message": message}})

    def test_starts_item_embedding_run(self):
        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            item_embedding_runner=lambda refresh_mode: ItemEmbeddingRunResult(
                refresh_mode=refresh_mode,
                selected_items=4,
                embedded_items=4,
                model="text-embedding-3-small",
            ),
            background=False,
        )

        status, payload = route_request(
            "POST",
            "/operations/item-embedding-runs",
            manager,
            {"refresh_mode": "full"},
        )

        self.assertEqual(status, 202)
        self.assertEqual(payload["data"]["type"], "item_embeddings")
        self.assertEqual(payload["data"]["status"], "completed")
        self.assertEqual(payload["data"]["result"]["refresh_mode"], "full")
        self.assertEqual(payload["data"]["result"]["selected_items"], 4)
        self.assertEqual(payload["data"]["result"]["embedded_items"], 4)
        self.assertEqual(payload["data"]["result"]["model"], "text-embedding-3-small")

    def test_item_embedding_run_rejects_invalid_refresh_mode(self):
        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            background=False,
        )

        status, payload = route_request(
            "POST",
            "/operations/item-embedding-runs",
            manager,
            {"refresh_mode": "everything"},
        )

        self.assertEqual(status, 400)
        self.assertEqual(payload, {"error": {"message": "refresh_mode must be missing or full"}})

    def test_item_discovery_requires_valid_store_and_website_url(self):
        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            background=False,
        )

        invalid_id_status, invalid_id_payload = route_request(
            "POST",
            "/operations/stores/not-a-number/item-discovery-runs",
            manager,
            {"website_url": "https://example.mx/"},
        )
        missing_url_status, missing_url_payload = route_request(
            "POST",
            "/operations/stores/12/item-discovery-runs",
            manager,
            {},
        )

        self.assertEqual(invalid_id_status, 400)
        self.assertEqual(invalid_id_payload, {"error": {"message": "store id must be a positive integer"}})
        self.assertEqual(missing_url_status, 400)
        self.assertEqual(missing_url_payload, {"error": {"message": "website_url is required"}})

    def test_latest_run_route_returns_null_before_any_run(self):
        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            background=False,
        )

        status, payload = route_request("GET", "/operations/store-discovery-runs/latest", manager)

        self.assertEqual(status, 200)
        self.assertIsNone(payload["data"])

    def test_returns_conflict_when_discovery_is_already_running(self):
        class ConflictManager:
            def start_store_discovery(self):
                raise OperationAlreadyRunning("Store discovery is already running")

        status, payload = route_request("POST", "/operations/store-discovery-runs", ConflictManager())

        self.assertEqual(status, 409)
        self.assertEqual(payload, {"error": {"message": "Store discovery is already running"}})

    def test_unknown_run_returns_404(self):
        manager = StoreDiscoveryRunManager(
            runner=lambda: StoreDiscoveryRunResult(0, 0, 0),
            background=False,
        )

        status, payload = route_request("GET", "/operations/store-discovery-runs/missing", manager)

        self.assertEqual(status, 404)
        self.assertEqual(payload, {"error": {"message": "Run not found"}})

    def test_cancel_running_operation(self):
        class CancelManager:
            def cancel_run(self, run_id):
                self.cancelled_run_id = run_id

                class Run:
                    def to_dict(self):
                        return {
                            "completed_at": None,
                            "error": None,
                            "id": run_id,
                            "result": None,
                            "started_at": "2026-06-27T08:00:00Z",
                            "status": "cancelling",
                            "type": "item_discovery",
                        }

                return Run()

        manager = CancelManager()

        status, payload = route_request("POST", "/operations/store-discovery-runs/run-123/cancel", manager)

        self.assertEqual(status, 202)
        self.assertEqual(manager.cancelled_run_id, "run-123")
        self.assertEqual(payload["data"]["status"], "cancelling")

    def test_cancel_unknown_operation_returns_404(self):
        class MissingCancelManager:
            def cancel_run(self, run_id):
                return None

        status, payload = route_request("POST", "/operations/store-discovery-runs/missing/cancel", MissingCancelManager())

        self.assertEqual(status, 404)
        self.assertEqual(payload, {"error": {"message": "Run not found"}})

    def test_cancel_non_running_operation_returns_conflict(self):
        class CompletedCancelManager:
            def cancel_run(self, run_id):
                raise OperationNotRunning("Run is not running")

        status, payload = route_request("POST", "/operations/store-discovery-runs/run-1/cancel", CompletedCancelManager())

        self.assertEqual(status, 409)
        self.assertEqual(payload, {"error": {"message": "Run is not running"}})


if __name__ == "__main__":
    unittest.main()
