import os
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.config import (
    load_dotenv_values,
    resolve_ai_classifier_enabled,
    resolve_admin_api_url,
    resolve_bgg_api_base_url,
    resolve_bgg_api_token,
    resolve_brave_api_key,
    resolve_browser_fetch_enabled,
    resolve_classifier_model,
    resolve_database_url,
    resolve_embedding_model,
    resolve_internal_api_token,
    resolve_openai_base_url,
    resolve_openai_api_key,
)


class ConfigTests(unittest.TestCase):
    def test_load_dotenv_values_reads_key_value_pairs(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dotenv_path = Path(temp_dir) / ".env"
            dotenv_path.write_text(
                "\n".join(
                    [
                        "# local secrets",
                        "BRAVE_SEARCH_API_KEY=from_dotenv",
                        "QUOTED_VALUE=\"quoted value\"",
                    ]
                ),
                encoding="utf-8",
            )

            values = load_dotenv_values(dotenv_path)

        self.assertEqual(values["BRAVE_SEARCH_API_KEY"], "from_dotenv")
        self.assertEqual(values["QUOTED_VALUE"], "quoted value")

    def test_resolve_brave_api_key_prefers_cli_then_environment_then_dotenv(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dotenv_path = Path(temp_dir) / ".env"
            dotenv_path.write_text("BRAVE_SEARCH_API_KEY=from_dotenv\n", encoding="utf-8")

            self.assertEqual(
                resolve_brave_api_key("from_cli", env={"BRAVE_SEARCH_API_KEY": "from_env"}, dotenv_path=dotenv_path),
                "from_cli",
            )
            self.assertEqual(
                resolve_brave_api_key(None, env={"BRAVE_SEARCH_API_KEY": "from_env"}, dotenv_path=dotenv_path),
                "from_env",
            )
            self.assertEqual(
                resolve_brave_api_key(None, env={}, dotenv_path=dotenv_path),
                "from_dotenv",
            )

    def test_resolve_brave_api_key_returns_empty_string_when_missing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            self.assertEqual(resolve_brave_api_key(None, env={}, dotenv_path=Path(temp_dir) / ".env"), "")

    def test_resolve_database_url_prefers_cli_then_environment_then_dotenv(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dotenv_path = Path(temp_dir) / ".env"
            dotenv_path.write_text("LUDORA_DATABASE_URL=postgresql://dotenv\n", encoding="utf-8")

            self.assertEqual(
                resolve_database_url(
                    "postgresql://cli",
                    env={"LUDORA_DATABASE_URL": "postgresql://env"},
                    dotenv_path=dotenv_path,
                ),
                "postgresql://cli",
            )
            self.assertEqual(
                resolve_database_url(None, env={"LUDORA_DATABASE_URL": "postgresql://env"}, dotenv_path=dotenv_path),
                "postgresql://env",
            )
            self.assertEqual(
                resolve_database_url(None, env={}, dotenv_path=dotenv_path),
                "postgresql://dotenv",
            )

    def test_resolve_browser_fetch_enabled_prefers_environment_then_dotenv(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dotenv_path = Path(temp_dir) / ".env"
            dotenv_path.write_text("LUDORA_BROWSER_FETCH_ENABLED=true\n", encoding="utf-8")

            self.assertTrue(
                resolve_browser_fetch_enabled(
                    env={"LUDORA_BROWSER_FETCH_ENABLED": "yes"},
                    dotenv_path=dotenv_path,
                )
            )
            self.assertFalse(
                resolve_browser_fetch_enabled(
                    env={"LUDORA_BROWSER_FETCH_ENABLED": "false"},
                    dotenv_path=dotenv_path,
                )
            )
            self.assertTrue(resolve_browser_fetch_enabled(env={}, dotenv_path=dotenv_path))

    def test_resolve_browser_fetch_enabled_is_false_when_missing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            self.assertFalse(resolve_browser_fetch_enabled(env={}, dotenv_path=Path(temp_dir) / ".env"))

    def test_resolve_admin_api_url_prefers_environment_then_dotenv_then_local_default(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dotenv_path = Path(temp_dir) / ".env"
            dotenv_path.write_text("LUDORA_ADMIN_API_URL=http://admin-dotenv.test\n", encoding="utf-8")

            self.assertEqual(
                resolve_admin_api_url(env={"LUDORA_ADMIN_API_URL": "http://admin-env.test"}, dotenv_path=dotenv_path),
                "http://admin-env.test",
            )
            self.assertEqual(resolve_admin_api_url(env={}, dotenv_path=dotenv_path), "http://admin-dotenv.test")
            self.assertEqual(resolve_admin_api_url(env={}, dotenv_path=Path(temp_dir) / "missing.env"), "http://127.0.0.1:4001")

    def test_resolve_internal_api_token_prefers_environment_then_dotenv(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dotenv_path = Path(temp_dir) / ".env"
            dotenv_path.write_text("LUDORA_INTERNAL_API_TOKEN=from-dotenv\n", encoding="utf-8")

            self.assertEqual(
                resolve_internal_api_token(env={"LUDORA_INTERNAL_API_TOKEN": "from-env"}, dotenv_path=dotenv_path),
                "from-env",
            )
            self.assertEqual(resolve_internal_api_token(env={}, dotenv_path=dotenv_path), "from-dotenv")
            self.assertEqual(resolve_internal_api_token(env={}, dotenv_path=Path(temp_dir) / "missing.env"), "")

    def test_resolve_bgg_api_token_prefers_cli_then_environment_then_dotenv(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dotenv_path = Path(temp_dir) / ".env"
            dotenv_path.write_text("BGG_API_TOKEN=from_dotenv\n", encoding="utf-8")

            self.assertEqual(
                resolve_bgg_api_token("from_cli", env={"BGG_API_TOKEN": "from_env"}, dotenv_path=dotenv_path),
                "from_cli",
            )
            self.assertEqual(resolve_bgg_api_token(None, env={"BGG_API_TOKEN": "from_env"}, dotenv_path=dotenv_path), "from_env")
            self.assertEqual(resolve_bgg_api_token(None, env={}, dotenv_path=dotenv_path), "from_dotenv")

    def test_resolve_bgg_api_base_url_defaults_to_xmlapi2(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            self.assertEqual(
                resolve_bgg_api_base_url(env={}, dotenv_path=Path(temp_dir) / ".env"),
                "https://boardgamegeek.com/xmlapi2",
            )

    def test_resolves_openai_key_and_embedding_model(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dotenv_path = Path(temp_dir) / ".env"
            dotenv_path.write_text(
                "OPENAI_API_KEY=from_dotenv\nOPENAI_EMBEDDING_MODEL=text-embedding-3-small\n",
                encoding="utf-8",
            )

            self.assertEqual(resolve_openai_api_key(env={"OPENAI_API_KEY": "from_env"}, dotenv_path=dotenv_path), "from_env")
            self.assertEqual(resolve_openai_api_key(env={}, dotenv_path=dotenv_path), "from_dotenv")
            self.assertEqual(
                resolve_embedding_model(env={"OPENAI_EMBEDDING_MODEL": "embedding-env"}, dotenv_path=dotenv_path),
                "embedding-env",
            )
            self.assertEqual(resolve_embedding_model(env={}, dotenv_path=dotenv_path), "text-embedding-3-small")
            self.assertEqual(resolve_embedding_model(env={}, dotenv_path=Path(temp_dir) / "missing.env"), "text-embedding-3-small")

    def test_ai_classifier_enabled_defaults_to_true_and_can_be_disabled(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dotenv_path = Path(temp_dir) / ".env"
            dotenv_path.write_text("AI_ENABLED_CLASSIFIER=true\n", encoding="utf-8")

            self.assertTrue(resolve_ai_classifier_enabled(env={}, dotenv_path=Path(temp_dir) / "missing.env"))
            self.assertTrue(resolve_ai_classifier_enabled(env={}, dotenv_path=dotenv_path))
            self.assertFalse(resolve_ai_classifier_enabled(env={"AI_ENABLED_CLASSIFIER": "false"}, dotenv_path=dotenv_path))

    def test_resolves_ai_classifier_model_and_openai_base_url(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dotenv_path = Path(temp_dir) / ".env"
            dotenv_path.write_text(
                "OPENAI_CLASSIFIER_MODEL=model-dotenv\nOPENAI_BASE_URL=http://dotenv.test/v1\n",
                encoding="utf-8",
            )

            self.assertEqual(
                resolve_classifier_model(env={"OPENAI_CLASSIFIER_MODEL": "model-env"}, dotenv_path=dotenv_path),
                "model-env",
            )
            self.assertEqual(resolve_classifier_model(env={}, dotenv_path=dotenv_path), "model-dotenv")
            self.assertEqual(resolve_classifier_model(env={}, dotenv_path=Path(temp_dir) / "missing.env"), "gpt-5.4-mini")
            self.assertEqual(
                resolve_openai_base_url(env={"OPENAI_BASE_URL": "http://env.test/v1"}, dotenv_path=dotenv_path),
                "http://env.test/v1",
            )
            self.assertEqual(resolve_openai_base_url(env={}, dotenv_path=dotenv_path), "http://dotenv.test/v1")
            self.assertEqual(resolve_openai_base_url(env={}, dotenv_path=Path(temp_dir) / "missing.env"), "http://127.0.0.1:3001/v1")


if __name__ == "__main__":
    unittest.main()
