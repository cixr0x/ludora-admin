import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.cli import build_parser, main
from ludora.collector import CollectionSummary


class CliTests(unittest.TestCase):
    def test_parser_accepts_database_and_inventory_options(self):
        parser = build_parser()
        args = parser.parse_args(
            [
                "--database-url",
                "postgresql://ludora",
                "--collect-listings",
                "--listing-limit",
                "25",
                "--export-files",
            ]
        )

        self.assertEqual(args.database_url, "postgresql://ludora")
        self.assertTrue(args.collect_listings)
        self.assertEqual(args.listing_limit, 25)
        self.assertTrue(args.export_files)

    def test_main_requires_database_url_for_store_collection(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            env_file = Path(temp_dir) / ".env"
            env_file.write_text("BRAVE_SEARCH_API_KEY=test-key\n", encoding="utf-8")

            with patch.dict("os.environ", {}, clear=True):
                exit_code = main(["--env-file", str(env_file), "--max-queries", "0"])

        self.assertEqual(exit_code, 2)

    def test_main_uses_database_repository_by_default(self):
        connection = Mock()
        repository = Mock()
        summary = CollectionSummary(
            records=[],
            csv_path=None,
            json_path=None,
            audit_csv_path=None,
            audit_json_path=None,
            searched_queries=0,
            candidate_domains=0,
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            env_file = Path(temp_dir) / ".env"
            env_file.write_text(
                "\n".join(
                    [
                        "BRAVE_SEARCH_API_KEY=test-key",
                        "LUDORA_DATABASE_URL=postgresql://user:password@localhost:5432/ludora",
                    ]
                ),
                encoding="utf-8",
            )

            with patch.dict("os.environ", {}, clear=True), patch(
                "ludora.cli.connect_database",
                return_value=connection,
            ) as connect_database, patch(
                "ludora.cli.DiscoveryRepository",
                return_value=repository,
            ), patch(
                "ludora.cli.collect_stores",
                return_value=summary,
            ) as collect_stores:
                exit_code = main(["--env-file", str(env_file), "--max-queries", "0"])

        self.assertEqual(exit_code, 0)
        connect_database.assert_called_once_with("postgresql://user:password@localhost:5432/ludora")
        collect_stores.assert_called_once()
        self.assertIs(collect_stores.call_args.kwargs["discovery_repository"], repository)
        self.assertFalse(collect_stores.call_args.kwargs["export_files"])
        connection.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
