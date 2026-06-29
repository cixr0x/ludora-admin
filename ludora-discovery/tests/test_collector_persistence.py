import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.collector import DomainBucket, collect_stores, _enrich_and_filter_buckets
from ludora.models import SearchResult, SiteMetadata, StoreRecord


class FakeRepository:
    def __init__(self):
        self.store_records = []

    def upsert_store_candidate(self, record):
        self.store_records.append(record)


class FakeBraveClient:
    def __init__(self, api_key):
        self.api_key = api_key

    def search(self, query, count=20, offset=0):
        return [
            SearchResult(
                title="Example juegos de mesa",
                url="https://example.mx/",
                description="Tienda en linea de juegos de mesa con envios a Mexico.",
                query=query,
            )
        ]


class CollectorPersistenceTests(unittest.TestCase):
    def test_enrich_and_filter_persists_store_candidate_when_repository_is_provided(self):
        repository = FakeRepository()
        bucket = DomainBucket(
            domain="example.mx",
            homepage="https://example.mx/",
            results=[
                SearchResult(
                    title="Example juegos de mesa",
                    url="https://example.mx/",
                    description="Tienda en linea de juegos de mesa con envios a Mexico.",
                    query="juegos de mesa mexico",
                )
            ],
            queries={"juegos de mesa mexico"},
        )

        with patch(
            "ludora.collector._enrich_site",
            return_value=(
                SiteMetadata(
                    store_name="Example",
                    instagram_url="https://instagram.com/example",
                    facebook_url="https://facebook.com/example",
                    city="Ciudad de Mexico",
                    state="CDMX",
                    store_logo="https://example.mx/logo.png",
                ),
                "https://example.mx/",
            ),
        ):
            records, audit_records = _enrich_and_filter_buckets(
                buckets={"example.mx": bucket},
                website_delay=0,
                max_enrichment_pages=0,
                include_low_confidence=False,
                verbose=False,
                discovery_repository=repository,
            )

        self.assertEqual(len(records), 1)
        self.assertEqual(len(audit_records), 1)
        persisted = repository.store_records[0]
        self.assertIsInstance(persisted, StoreRecord)
        self.assertEqual(persisted.store_name, "Example")
        self.assertEqual(persisted.canonical_domain, "example.mx")
        self.assertEqual(persisted.website_url, "https://example.mx/")
        self.assertEqual(persisted.instagram_url, "https://instagram.com/example")
        self.assertEqual(persisted.facebook_url, "https://facebook.com/example")
        self.assertEqual(persisted.city, "Ciudad de Mexico")
        self.assertEqual(persisted.state, "CDMX")
        self.assertEqual(persisted.country, "Mexico")
        self.assertEqual(persisted.store_logo, "https://example.mx/logo.png")
        self.assertEqual(persisted.status, "ACCEPTED")
        self.assertEqual(persisted.source_queries, ["juegos de mesa mexico"])
        self.assertIn("boardgame", persisted.evidence)
        self.assertIn("online_store", persisted.evidence)
        self.assertIn("mexico", persisted.evidence)

    def test_enrich_and_filter_marks_low_confidence_candidates_rejected_when_included(self):
        repository = FakeRepository()
        bucket = DomainBucket(
            domain="example.mx",
            homepage="https://example.mx/",
            results=[
                SearchResult(
                    title="Example resenas",
                    url="https://example.mx/",
                    description="Resenas y noticias de juegos de mesa en Mexico.",
                    query="juegos de mesa mexico",
                )
            ],
            queries={"juegos de mesa mexico"},
        )

        with patch(
            "ludora.collector._enrich_site",
            return_value=(SiteMetadata(store_name="Example"), "https://example.mx/"),
        ):
            records, audit_records = _enrich_and_filter_buckets(
                buckets={"example.mx": bucket},
                website_delay=0,
                max_enrichment_pages=0,
                include_low_confidence=True,
                verbose=False,
                discovery_repository=repository,
            )

        self.assertEqual(len(records), 1)
        self.assertEqual(len(audit_records), 1)
        self.assertEqual(repository.store_records[0].status, "REJECTED")

    def test_enrich_and_filter_does_not_persist_rejected_audit_records(self):
        repository = FakeRepository()
        bucket = DomainBucket(
            domain="example.mx",
            homepage="https://example.mx/",
            results=[
                SearchResult(
                    title="Example resenas",
                    url="https://example.mx/",
                    description="Resenas y noticias de juegos de mesa en Mexico.",
                    query="juegos de mesa mexico",
                )
            ],
            queries={"juegos de mesa mexico"},
        )

        with patch(
            "ludora.collector._enrich_site",
            return_value=(SiteMetadata(store_name="Example"), "https://example.mx/"),
        ):
            records, audit_records = _enrich_and_filter_buckets(
                buckets={"example.mx": bucket},
                website_delay=0,
                max_enrichment_pages=0,
                include_low_confidence=False,
                verbose=False,
                discovery_repository=repository,
            )

        self.assertEqual(records, [])
        self.assertEqual(len(audit_records), 1)
        self.assertEqual(repository.store_records, [])

    def test_collect_stores_persists_to_database_without_writing_files_by_default(self):
        repository = FakeRepository()
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch("ludora.collector.BraveSearchClient", FakeBraveClient), patch(
                "ludora.collector._enrich_site",
                return_value=(SiteMetadata(store_name="Example"), "https://example.mx/"),
            ):
                summary = collect_stores(
                    api_key="test",
                    output_dir=temp_dir,
                    query_scope="core",
                    max_queries=1,
                    request_delay=0,
                    website_delay=0,
                    max_enrichment_pages=0,
                    discovery_repository=repository,
                )

            output_files = list(Path(temp_dir).glob("*"))

        self.assertEqual(len(summary.records), 1)
        self.assertEqual(repository.store_records[0].canonical_domain, "example.mx")
        self.assertIsNone(summary.csv_path)
        self.assertIsNone(summary.json_path)
        self.assertIsNone(summary.audit_csv_path)
        self.assertIsNone(summary.audit_json_path)
        self.assertEqual(output_files, [])

    def test_collect_stores_writes_files_only_when_export_files_is_requested(self):
        repository = FakeRepository()
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch("ludora.collector.BraveSearchClient", FakeBraveClient), patch(
                "ludora.collector._enrich_site",
                return_value=(SiteMetadata(store_name="Example"), "https://example.mx/"),
            ):
                summary = collect_stores(
                    api_key="test",
                    output_dir=temp_dir,
                    query_scope="core",
                    max_queries=1,
                    request_delay=0,
                    website_delay=0,
                    max_enrichment_pages=0,
                    discovery_repository=repository,
                    export_files=True,
                )

            self.assertIsNotNone(summary.csv_path)
            self.assertIsNotNone(summary.json_path)
            self.assertIsNotNone(summary.audit_csv_path)
            self.assertIsNotNone(summary.audit_json_path)
            self.assertTrue(summary.csv_path.exists())
            self.assertTrue(summary.json_path.exists())
            self.assertTrue(summary.audit_csv_path.exists())
            self.assertTrue(summary.audit_json_path.exists())


if __name__ == "__main__":
    unittest.main()
