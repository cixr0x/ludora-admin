import json
import sys
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.operations import (
    ItemDiscoveryRunResult,
    ItemEmbeddingRunResult,
    ItemUpdateRunResult,
    StoreDiscoveryRunResult,
)
from ludora.operation_cli import main


class OperationCliTests(unittest.TestCase):
    def test_runs_store_discovery_and_prints_result_json(self):
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "ludora.operation_cli.run_store_discovery",
            return_value=StoreDiscoveryRunResult(searched_queries=3, candidate_domains=4, accepted_stores=2),
        ) as runner:
            exit_code = main(["--env-file", "admin.env", "store-discovery"])

        self.assertEqual(exit_code, 0)
        runner.assert_called_once()
        self.assertEqual(runner.call_args.kwargs["env_file"], "admin.env")
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["result"]["accepted_stores"], 2)

    def test_runs_item_discovery_with_store_id_and_website_url(self):
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "ludora.operation_cli.run_item_discovery",
            return_value=ItemDiscoveryRunResult(store_id=12, website_url="https://store.test", item_candidates=5),
        ) as runner:
            exit_code = main(
                [
                    "--env-file",
                    "admin.env",
                    "item-discovery",
                    "--store-id",
                    "12",
                    "--website-url",
                    "https://store.test",
                    "--store-name",
                    "Hasbro Gaming",
                    "--platform",
                    "amazon_brand",
                ]
            )

        self.assertEqual(exit_code, 0)
        runner.assert_called_once()
        self.assertEqual(runner.call_args.kwargs["store_id"], 12)
        self.assertEqual(runner.call_args.kwargs["website_url"], "https://store.test")
        self.assertEqual(runner.call_args.kwargs["store_name"], "Hasbro Gaming")
        self.assertEqual(runner.call_args.kwargs["platform"], "amazon_brand")
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["result"]["item_candidates"], 5)

    def test_runs_item_update(self):
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "ludora.operation_cli.run_item_update",
            return_value=ItemUpdateRunResult(updated_items=7),
        ) as runner:
            exit_code = main(["item-update"])

        self.assertEqual(exit_code, 0)
        self.assertIsNone(runner.call_args.kwargs["store_ids"])
        self.assertEqual(json.loads(stdout.getvalue())["result"]["updated_items"], 7)

    def test_runs_item_update_with_repeatable_store_id(self):
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "ludora.operation_cli.run_item_update",
            return_value=ItemUpdateRunResult(updated_items=7),
        ) as runner:
            exit_code = main(["item-update", "--store-id", "12", "--store-id", "34"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(runner.call_args.kwargs["store_ids"], [12, 34])
        self.assertEqual(json.loads(stdout.getvalue())["result"]["updated_items"], 7)

    def test_item_update_rejects_invalid_store_ids(self):
        invalid_cases = [
            (["item-update", "--store-id", "0"], "store ids must be positive integers"),
            (["item-update", "--store-id", "-2"], "store ids must be positive integers"),
            (["item-update", "--store-id", "12", "--store-id", "12"], "store ids must not contain duplicates"),
        ]

        for argv, message in invalid_cases:
            with self.subTest(argv=argv), patch("sys.stderr", StringIO()) as stderr, patch(
                "ludora.operation_cli.run_item_update",
                return_value=ItemUpdateRunResult(updated_items=7),
            ) as runner:
                exit_code = main(argv)

                self.assertEqual(exit_code, 1)
                self.assertEqual(json.loads(stderr.getvalue())["error"]["message"], message)
                runner.assert_not_called()

    def test_runs_item_embeddings_with_refresh_mode(self):
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "ludora.operation_cli.run_item_embeddings",
            return_value=ItemEmbeddingRunResult(
                refresh_mode="full",
                selected_items=10,
                embedded_items=9,
                model="text-embedding-3-small",
            ),
        ) as runner:
            exit_code = main(["item-embeddings", "--refresh-mode", "full"])

        self.assertEqual(exit_code, 0)
        runner.assert_called_once()
        self.assertEqual(runner.call_args.kwargs["refresh_mode"], "full")
        self.assertEqual(json.loads(stdout.getvalue())["result"]["embedded_items"], 9)

    def test_runtime_error_prints_json_error_to_stderr(self):
        stderr = StringIO()
        with patch("sys.stderr", stderr), patch(
            "ludora.operation_cli.run_store_discovery",
            side_effect=RuntimeError("Missing Brave API key"),
        ):
            exit_code = main(["store-discovery"])

        self.assertEqual(exit_code, 1)
        self.assertEqual(json.loads(stderr.getvalue())["error"]["message"], "Missing Brave API key")


if __name__ == "__main__":
    unittest.main()
