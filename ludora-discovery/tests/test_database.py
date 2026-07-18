import json
import os
import sys
import unittest
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.database import DiscoveryRepository, ItemSearchEmbeddingSource, TutorialLinkUpsertResult, connect_database
from ludora.models import DiscoveryItemCandidateRecord, StoreRecord


class FakeCursor:
    def __init__(self, fetchone_rows=None, fetchall_rows=None):
        self.executions = []
        self.fetchone_rows = list(fetchone_rows or [])
        self.fetchall_rows = list(fetchall_rows or [])

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params):
        self.executions.append((sql, params))

    def fetchone(self):
        if self.fetchone_rows:
            return self.fetchone_rows.pop(0)
        return None

    def fetchall(self):
        if self.fetchall_rows:
            return self.fetchall_rows.pop(0)
        return []


class FakeConnection:
    def __init__(self, fetchone_rows=None, fetchall_rows=None):
        self.cursor_instance = FakeCursor(fetchone_rows=fetchone_rows, fetchall_rows=fetchall_rows)
        self.commits = 0

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.commits += 1


class DatabaseRepositoryTests(unittest.TestCase):
    def test_connect_database_maps_pgsslmode_no_verify_to_psycopg_require(self):
        fake_psycopg = SimpleNamespace(connect=Mock(return_value="connection"))

        with patch.dict(sys.modules, {"psycopg": fake_psycopg}), patch.dict(os.environ, {"PGSSLMODE": "no-verify"}):
            connection = connect_database("postgresql://ludora")

        self.assertEqual(connection, "connection")
        fake_psycopg.connect.assert_called_once_with("postgresql://ludora", sslmode="require")

    def test_connect_database_rewrites_url_sslmode_no_verify(self):
        fake_psycopg = SimpleNamespace(connect=Mock(return_value="connection"))

        with patch.dict(sys.modules, {"psycopg": fake_psycopg}), patch.dict(os.environ, {"PGSSLMODE": "no-verify"}):
            connect_database("postgresql://ludora.example/db?sslmode=no-verify&application_name=ludora")

        fake_psycopg.connect.assert_called_once_with(
            "postgresql://ludora.example/db?sslmode=require&application_name=ludora"
        )

    def test_upsert_store_candidate_writes_dirty_store_record(self):
        connection = FakeConnection()
        repository = DiscoveryRepository(connection)
        record = StoreRecord(
            store_name="Example",
            canonical_domain="example.mx",
            website_url="https://example.mx/",
            instagram_url="https://instagram.com/example",
            facebook_url="https://facebook.com/example",
            city="Ciudad de Mexico",
            state="CDMX",
            country="Mexico",
            store_logo="https://example.mx/logo.png",
            status="ACCEPTED",
            confidence=0.91,
            source_queries=["juegos de mesa mexico"],
            evidence=["boardgame", "online_store", "mexico"],
        )

        repository.upsert_store_candidate(record)

        sql, params = connection.cursor_instance.executions[0]
        normalized_sql = sql.casefold()
        self.assertIn("insert into discovery_store_candidates", normalized_sql)
        for column_name in StoreRecord.output_fields():
            self.assertIn(column_name, normalized_sql)
        for audit_column_name in ["accepted", "reasons", "title", "description"]:
            self.assertNotIn(audit_column_name, normalized_sql)
        self.assertEqual(params[0], "Example")
        self.assertEqual(params[1], "example.mx")
        self.assertEqual(params[2], "https://example.mx/")
        self.assertEqual(params[3], "https://instagram.com/example")
        self.assertEqual(params[4], "https://facebook.com/example")
        self.assertEqual(params[5], "Ciudad de Mexico")
        self.assertEqual(params[6], "CDMX")
        self.assertEqual(params[7], "Mexico")
        self.assertEqual(params[8], "https://example.mx/logo.png")
        self.assertEqual(params[9], "ACCEPTED")
        self.assertEqual(params[10], 0.91)
        self.assertEqual(json.loads(params[11]), ["juegos de mesa mexico"])
        self.assertEqual(json.loads(params[12]), ["boardgame", "online_store", "mexico"])
        self.assertEqual(connection.commits, 1)

    def test_upsert_item_candidate_writes_dirty_item_record(self):
        connection = FakeConnection()
        repository = DiscoveryRepository(connection)
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/catan",
            source_listing_url="https://example.mx/collections/juegos",
            title="Catan",
            publisher="Devir",
            description="Juego base",
            item_id=None,
            item_type="base_game",
            min_players=3,
            max_players=4,
            min_minutes=60,
            max_minutes=90,
            min_age=10,
            language="es",
            language_source="product_highlights",
            language_evidence="Highlights: 10+ 3-4 jugadores 60-90 min Español",
            image_url="https://example.mx/catan.jpg",
            raw_price="$899",
            price="899.00",
            price_source="json_ld_offer",
            currency="MXN",
            availability="available",
            availability_source="json_ld_offer",
            store_sku="CATAN-ES",
            raw_payload={"json_ld": {"name": "Catan"}},
            is_boardgame=True,
            is_boardgame_confirmed=False,
            category_confidence=0.87,
            classification_reasons=["player count found", "boardgame category found"],
        )

        result = repository.upsert_item_candidate(record)

        sql, params = connection.cursor_instance.executions[1]
        self.assertEqual(sql.count("%s"), len(params))
        self.assertIn("insert into store_items", sql.casefold())
        self.assertNotIn("store_active", sql.casefold())
        self.assertNotIn("on conflict (store_id, source_url)", sql.casefold())
        self.assertNotIn("title = excluded.title", sql.casefold())
        self.assertNotIn("on conflict (store_id, source_url, title)", sql.casefold())
        self.assertNotIn("discovery_listing_candidates", sql.casefold())
        for column_name in [
            "source_listing_url",
            "image_url",
            "item_type",
            "min_minutes",
            "max_minutes",
            "min_age",
            "currency",
            "store_sku",
            "raw_payload",
            "price_source",
            "availability_source",
            "is_boardgame",
            "is_boardgame_confirmed",
            "category_confidence",
            "classification_reasons",
            "language_source",
            "language_evidence",
            "last_seen_at",
            "refreshed_date",
        ]:
            self.assertIn(column_name, sql.casefold())
        self.assertEqual(params[0], 12)
        self.assertEqual(params[2], "https://example.mx/collections/juegos")
        self.assertEqual(params[3], "Catan")
        self.assertEqual(params[4], "Devir")
        self.assertEqual(params[7], "base_game")
        self.assertEqual(params[13], "es")
        self.assertEqual(params[14], "product_highlights")
        self.assertEqual(params[15], "Highlights: 10+ 3-4 jugadores 60-90 min Español")
        self.assertEqual(params[16], "https://example.mx/catan.jpg")
        self.assertEqual(params[18], "$899")
        self.assertEqual(params[19], "899.00")
        self.assertEqual(params[20], "json_ld_offer")
        self.assertEqual(params[21], "MXN")
        self.assertEqual(params[23], "json_ld_offer")
        self.assertEqual(params[24], "CATAN-ES")
        self.assertEqual(json.loads(params[25]), {"json_ld": {"name": "Catan"}})
        self.assertEqual(params[26], True)
        self.assertEqual(params[27], False)
        self.assertEqual(params[28], 0.87)
        self.assertEqual(json.loads(params[29]), ["player count found", "boardgame category found"])
        self.assertEqual(connection.commits, 1)
        self.assertTrue(result.created)

    def test_upsert_tutorial_link_inserts_candidate_when_item_url_is_new(self):
        connection = FakeConnection(fetchone_rows=[None, (101,)])
        repository = DiscoveryRepository(connection)

        result = repository.upsert_tutorial_link(
            item_id=77,
            url="https://www.tiktok.com/@lacaravanacdmx/video/7552741217180716308",
            title="Como jugar Catan #juegosdemesa",
            language="es",
            source="tiktok",
            status="candidate",
        )

        self.assertEqual(result, TutorialLinkUpsertResult(tutorial_link_id=101, action="inserted"))
        select_sql, select_params = connection.cursor_instance.executions[0]
        insert_sql, insert_params = connection.cursor_instance.executions[1]
        self.assertIn("from tutorial_links", select_sql.casefold())
        self.assertIn("item_id = %s", select_sql.casefold())
        self.assertIn("url = %s", select_sql.casefold())
        self.assertEqual(select_params, (77, "https://www.tiktok.com/@lacaravanacdmx/video/7552741217180716308"))
        self.assertIn("insert into tutorial_links", insert_sql.casefold())
        self.assertIn("returning id", insert_sql.casefold())
        self.assertEqual(
            insert_params,
            (
                77,
                "https://www.tiktok.com/@lacaravanacdmx/video/7552741217180716308",
                "Como jugar Catan #juegosdemesa",
                "es",
                "tiktok",
                "candidate",
            ),
        )
        self.assertEqual(connection.commits, 1)

    def test_registers_store_item_discovery_log_start_and_completion(self):
        connection = FakeConnection()
        repository = DiscoveryRepository(connection)
        started_at = datetime(2026, 7, 5, 10, 0, tzinfo=timezone.utc)
        completed_at = datetime(2026, 7, 5, 10, 5, tzinfo=timezone.utc)

        repository.start_store_item_discovery_log(
            run_id="run-123",
            store_id=12,
            website_url="https://example.mx/",
            started_at=started_at,
        )
        repository.complete_store_item_discovery_log(
            run_id="run-123",
            status="completed",
            completed_at=completed_at,
            new_items=3,
            error="",
        )

        insert_sql, insert_params = connection.cursor_instance.executions[0]
        update_sql, update_params = connection.cursor_instance.executions[1]
        self.assertIn("insert into job_store_item_discovery_log", insert_sql.casefold())
        self.assertIn("run_id", insert_sql.casefold())
        self.assertIn("started_at", insert_sql.casefold())
        self.assertEqual(insert_params, ("run-123", 12, "https://example.mx/", "running", "", started_at, None, 0))
        self.assertIn("update job_store_item_discovery_log", update_sql.casefold())
        self.assertIn("completed_at = %s", update_sql.casefold())
        self.assertIn("new_items = %s", update_sql.casefold())
        self.assertEqual(update_params, ("completed", "", completed_at, 3, "run-123"))
        self.assertEqual(connection.commits, 2)

    def test_lists_store_item_discovery_sources_for_selected_stores(self):
        connection = FakeConnection(
            fetchall_rows=[
                [
                    (12, "Alpha Games", "https://alpha.mx/", "shopify"),
                    (34, "Beta Games", "https://beta.mx/", "custom"),
                ]
            ]
        )
        repository = DiscoveryRepository(connection)

        stores = repository.list_store_item_discovery_sources(store_ids=[12, 34])

        sql, params = connection.cursor_instance.executions[0]
        self.assertIn("from stores", sql.casefold())
        self.assertIn("where id in (%s, %s)", sql.casefold())
        self.assertEqual(params, [12, 34])
        self.assertEqual([store.store_id for store in stores], [12, 34])
        self.assertEqual(stores[0].store_name, "Alpha Games")
        self.assertEqual(stores[0].website_url, "https://alpha.mx/")
        self.assertEqual(stores[0].platform, "shopify")

    def test_registers_store_item_update_log_start_and_completion(self):
        connection = FakeConnection(fetchone_rows=[(99,)])
        repository = DiscoveryRepository(connection)
        completed_at = datetime(2026, 7, 5, 10, 5, tzinfo=timezone.utc)

        job_id = repository.start_store_item_update_log(run_id="run-123", store_id=12)
        repository.complete_store_item_update_log(
            job_id=job_id,
            status="completed",
            completed_at=completed_at,
            scanned_items=5,
            updated_items=3,
            error="",
        )

        insert_sql, insert_params = connection.cursor_instance.executions[0]
        update_sql, update_params = connection.cursor_instance.executions[1]
        self.assertEqual(job_id, 99)
        self.assertIn("insert into job_store_item_update_log", insert_sql.casefold())
        self.assertIn("returning id", insert_sql.casefold())
        self.assertIn("store_id", insert_sql.casefold())
        self.assertEqual(insert_params, ("run-123", 12, "running", "", None, 0, 0))
        self.assertIn("update job_store_item_update_log", update_sql.casefold())
        self.assertIn("completed_at = %s", update_sql.casefold())
        self.assertIn("scanned_items = %s", update_sql.casefold())
        self.assertIn("updated_items = %s", update_sql.casefold())
        self.assertEqual(update_params, ("completed", "", completed_at, 5, 3, 99))
        self.assertEqual(connection.commits, 2)

    def test_updates_item_candidate_and_logs_title_and_price_availability_refresh_fields(self):
        connection = FakeConnection()
        repository = DiscoveryRepository(connection)
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://example.mx/products/catan",
            source_listing_url="https://example.mx/sitemap.xml",
            title="Catan",
            publisher="Devir",
            description="Juego base",
            item_id=77,
            raw_price="$899",
            price="899.00",
            availability="available",
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        refreshed_record = replace(
            existing_record,
            title="Catan Nueva Edicion",
            description="Updated detail page text",
            image_url="https://example.mx/catan-new.jpg",
            raw_price="$799",
            price="799.00",
            price_source="json_ld_offer",
            currency="USD",
            availability="out_of_stock",
            availability_source="generic_text",
        )

        result = repository.update_item_candidate_with_change_log(
            existing_record,
            refreshed_record,
            job_id=99,
            run_id="run-123",
        )

        self.assertEqual(result.candidate_id, 56)
        self.assertFalse(result.created)
        update_sql, update_params = connection.cursor_instance.executions[0]
        change_entries = connection.cursor_instance.executions[1:]
        self.assertIn("update store_items", update_sql.casefold())
        self.assertIn("title = %s", update_sql.casefold())
        self.assertNotIn("description = %s", update_sql.casefold())
        self.assertNotIn("image_url = %s", update_sql.casefold())
        self.assertIn("refreshed_date = now()", update_sql.casefold())
        self.assertNotIn("last_updated = now()", update_sql.casefold())
        self.assertEqual(update_params[-1], 56)
        self.assertEqual(len(change_entries), 7)
        self.assertEqual(connection.commits, 1)
        self.assertTrue(result.changed)
        logged_fields = [params[3] for _sql, params in change_entries]
        self.assertEqual(
            logged_fields,
            [
                "title",
                "raw_price",
                "price",
                "price_source",
                "currency",
                "availability",
                "availability_source",
            ],
        )
        for sql, params in change_entries:
            self.assertIn("insert into store_item_update_change_log", sql.casefold())
            self.assertEqual(params[0], 99)
            self.assertEqual(params[1], "run-123")
            self.assertEqual(params[2], 56)
        self.assertEqual(json.loads(change_entries[0][1][4]), "Catan")
        self.assertEqual(json.loads(change_entries[0][1][5]), "Catan Nueva Edicion")
        self.assertEqual(json.loads(change_entries[1][1][4]), "$899")
        self.assertEqual(json.loads(change_entries[1][1][5]), "$799")
        self.assertEqual(json.loads(change_entries[2][1][4]), "899.00")
        self.assertEqual(json.loads(change_entries[2][1][5]), "799.00")

    def test_update_change_log_compares_price_numerically(self):
        connection = FakeConnection()
        repository = DiscoveryRepository(connection)
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://example.mx/products/catan",
            title="Catan",
            raw_price="$700.00",
            price="700.00",
            availability="available",
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        refreshed_record = replace(existing_record, price="700.0")

        result = repository.update_item_candidate_with_change_log(
            existing_record,
            refreshed_record,
            job_id=99,
            run_id="run-123",
        )

        self.assertEqual(result.candidate_id, 56)
        self.assertFalse(result.changed)
        self.assertEqual(len(connection.cursor_instance.executions), 1)
        update_sql, update_params = connection.cursor_instance.executions[0]
        self.assertIn("update store_items", update_sql.casefold())
        self.assertIn("refreshed_date = now()", update_sql.casefold())
        self.assertNotIn("last_updated = now()", update_sql.casefold())
        self.assertEqual(update_params[-1], 56)
        self.assertEqual(connection.commits, 1)

    def test_update_item_candidate_excludes_title_when_disabled(self):
        connection = FakeConnection()
        repository = DiscoveryRepository(connection)
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://www.amazon.com.mx/dp/B0TEST1234",
            title="Stored game title",
            raw_price="$899",
            price="899.00",
            availability="available",
            listing_status="LISTED",
            is_boardgame=True,
            is_boardgame_confirmed=True,
        )
        refreshed_record = replace(
            existing_record,
            title="Amazon merchandising title",
            raw_price="$799",
            price="799.00",
            price_source="amazon_detail",
        )

        result = repository.update_item_candidate_with_change_log(
            existing_record,
            refreshed_record,
            job_id=99,
            run_id="run-amazon",
            include_title=False,
        )

        update_sql, update_params = connection.cursor_instance.executions[0]
        change_entries = connection.cursor_instance.executions[1:]
        self.assertNotIn("title = %s", update_sql.casefold())
        self.assertNotIn("Amazon merchandising title", update_params)
        self.assertEqual(update_params[0], "$799")
        self.assertEqual(update_params[-1], 56)
        self.assertEqual(
            [params[3] for _sql, params in change_entries],
            ["raw_price", "price", "price_source"],
        )
        self.assertTrue(result.changed)
        self.assertEqual(connection.commits, 1)

    def test_update_item_candidate_change_log_requires_store_item_id(self):
        connection = FakeConnection()
        repository = DiscoveryRepository(connection)
        existing_record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/catan",
            title="Catan",
        )

        with self.assertRaisesRegex(ValueError, "store item id is required"):
            repository.update_item_candidate_with_change_log(
                existing_record,
                existing_record,
                job_id=99,
                run_id="run-123",
            )

        self.assertEqual(connection.cursor_instance.executions, [])
        self.assertEqual(connection.commits, 0)

    def test_mark_item_candidate_inactive_updates_flag_and_logs_change(self):
        connection = FakeConnection(fetchone_rows=[(56,)])
        repository = DiscoveryRepository(connection)
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://example.mx/products/catan",
            title="Catan",
            item_id=77,
            listing_status="LISTED",
            store_active=True,
        )

        result = repository.mark_item_candidate_inactive(
            existing_record,
            job_id=99,
            run_id="run-123",
        )

        self.assertTrue(result.changed)
        self.assertFalse(existing_record.store_active)
        self.assertEqual(len(connection.cursor_instance.executions), 2)
        update_sql, update_params = connection.cursor_instance.executions[0]
        self.assertIn("store_active = false", update_sql.casefold())
        self.assertIn("refreshed_date = now()", update_sql.casefold())
        self.assertIn("store_active = true", update_sql.casefold())
        self.assertEqual(update_params, (56,))
        log_sql, log_params = connection.cursor_instance.executions[1]
        self.assertIn("insert into store_item_update_change_log", log_sql.casefold())
        self.assertEqual(log_params[:4], (99, "run-123", 56, "store_active"))
        self.assertEqual(json.loads(log_params[4]), True)
        self.assertEqual(json.loads(log_params[5]), False)
        self.assertEqual(connection.commits, 1)

    def test_mark_item_candidate_inactive_does_not_log_when_already_inactive(self):
        connection = FakeConnection(fetchone_rows=[])
        repository = DiscoveryRepository(connection)
        existing_record = DiscoveryItemCandidateRecord(
            store_item_id=56,
            store_id=12,
            source_url="https://example.mx/products/catan",
            title="Catan",
            store_active=False,
        )

        result = repository.mark_item_candidate_inactive(existing_record, job_id=99, run_id="run-123")

        self.assertFalse(result.changed)
        self.assertEqual(len(connection.cursor_instance.executions), 1)
        self.assertEqual(connection.commits, 1)

    def test_upsert_tutorial_link_refreshes_existing_item_url(self):
        connection = FakeConnection(fetchone_rows=[(44,), (44,)])
        repository = DiscoveryRepository(connection)

        result = repository.upsert_tutorial_link(
            item_id=77,
            url="https://www.tiktok.com/@lacaravanacdmx/video/7552741217180716308",
            title="Catan en TikTok",
            language="es",
            source="tiktok",
            status="candidate",
        )

        self.assertEqual(result, TutorialLinkUpsertResult(tutorial_link_id=44, action="updated"))
        update_sql, update_params = connection.cursor_instance.executions[1]
        normalized_sql = update_sql.casefold()
        self.assertIn("update tutorial_links", normalized_sql)
        self.assertIn("title = %s", normalized_sql)
        self.assertIn("language = %s", normalized_sql)
        self.assertIn("source = %s", normalized_sql)
        self.assertIn("status = %s", normalized_sql)
        self.assertIn("returning id", normalized_sql)
        self.assertEqual(update_params, ("Catan en TikTok", "es", "tiktok", "candidate", 44))
        self.assertEqual(connection.commits, 1)

    def test_upsert_existing_item_candidate_preserves_listing_status_and_refreshes_data(self):
        connection = FakeConnection(fetchone_rows=[(55, "REJECTED", None, "NONE", "2026-05-01T00:00:00Z")])
        repository = DiscoveryRepository(connection)
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/unknown",
            title="Unknown Product",
            image_url="https://example.mx/products/unknown.jpg",
            raw_price="$100",
            price="100.00",
            availability="available",
        )

        result = repository.upsert_item_candidate(record)

        self.assertEqual(result.candidate_id, 55)
        self.assertFalse(result.should_process)
        self.assertFalse(result.created)
        self.assertEqual(len(connection.cursor_instance.executions), 2)
        sql, params = connection.cursor_instance.executions[1]
        normalized_sql = sql.casefold()
        self.assertIn("update store_items", normalized_sql)
        self.assertIn("last_seen_at = now()", normalized_sql)
        self.assertIn("raw_price = %s", normalized_sql)
        self.assertIn("listing_status = %s", normalized_sql)
        self.assertEqual(params[16], "https://example.mx/products/unknown.jpg")
        self.assertEqual(params[17], "REJECTED")

    def test_upsert_linked_store_item_refreshes_store_item_only(self):
        connection = FakeConnection(fetchone_rows=[(56, "LISTED", 7, "LOCAL", "2026-05-01T00:00:00Z")])
        repository = DiscoveryRepository(connection)
        record = DiscoveryItemCandidateRecord(
            store_id=12,
            source_url="https://example.mx/products/catan",
            source_listing_url="https://example.mx/collections/juegos",
            title="Catan",
            language="es",
            publisher="Devir",
            raw_price="$899",
            price="899.00",
            availability="available",
        )

        result = repository.upsert_item_candidate(record)

        self.assertEqual(result.candidate_id, 56)
        self.assertFalse(result.should_process)
        self.assertFalse(result.created)
        self.assertEqual(result.item_id, 7)
        self.assertEqual(len(connection.cursor_instance.executions), 2)
        candidate_sql, candidate_params = connection.cursor_instance.executions[1]
        self.assertIn("update store_items", candidate_sql.casefold())
        self.assertIn("raw_price = %s", candidate_sql.casefold())
        self.assertEqual(candidate_params[17], "LISTED")
        self.assertEqual(candidate_params[6], 7)

    def test_item_candidate_exists_checks_store_and_source_url(self):
        connection = FakeConnection(fetchone_rows=[(1,)])
        repository = DiscoveryRepository(connection)

        exists = repository.item_candidate_exists(12, "https://example.mx/products/catan")

        self.assertTrue(exists)
        sql, params = connection.cursor_instance.executions[0]
        normalized_sql = sql.casefold()
        self.assertIn("from store_items", normalized_sql)
        self.assertIn("store_id is not distinct from %s", normalized_sql)
        self.assertIn("source_url = %s", normalized_sql)
        self.assertEqual(params, (12, "https://example.mx/products/catan"))
        self.assertEqual(connection.commits, 0)

    def test_lists_confirmed_boardgame_item_candidates_for_updates(self):
        connection = FakeConnection(
            fetchall_rows=[
                [
                    (
                        12,
                        "https://example.mx/products/catan",
                        "https://example.mx/sitemap.xml",
                        "Catan",
                        "Devir",
                        "Juego base",
                        77,
                        "base_game",
                        3,
                        4,
                        60,
                        90,
                        10,
                        "es",
                        "product_highlights",
                        "3-4 jugadores",
                        "https://example.mx/catan.jpg",
                        "LISTED",
                        "$899",
                        "899.00",
                        "json_ld_offer",
                        "MXN",
                        "available",
                        "json_ld_offer",
                        True,
                        "CATAN-ES",
                        '{"json_ld": {"name": "Catan"}}',
                        True,
                        True,
                        0.91,
                        '["previously confirmed"]',
                        "LOCAL",
                        13,
                        "Catan",
                        0.96,
                        '["name match"]',
                        '{"source": "local"}',
                        "2026-05-01T00:00:00Z",
                        "2026-05-01T00:00:00Z",
                        "",
                        56,
                    )
                ]
            ]
        )
        repository = DiscoveryRepository(connection)

        records = repository.list_confirmed_boardgame_item_candidates(limit=50)

        sql, params = connection.cursor_instance.executions[0]
        normalized_sql = sql.casefold()
        compact_sql = " ".join(normalized_sql.split())
        self.assertIn("from store_items", normalized_sql)
        self.assertIn("is_boardgame = true", normalized_sql)
        self.assertIn("is_boardgame_confirmed = true", normalized_sql)
        self.assertIn("item_id is not null", normalized_sql)
        self.assertIn("source_url <> ''", normalized_sql)
        self.assertIn("listing_status = 'listed'", normalized_sql)
        self.assertIn("store_active = true", normalized_sql)
        self.assertIn("availability_source, store_active, store_sku", compact_sql)
        self.assertIn("order by refreshed_date asc nulls first, id asc", normalized_sql)
        self.assertIn("limit %s", normalized_sql)
        self.assertEqual(params, (50,))
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].store_item_id, 56)
        self.assertEqual(records[0].store_id, 12)
        self.assertEqual(records[0].source_url, "https://example.mx/products/catan")
        self.assertEqual(records[0].item_id, 77)
        self.assertTrue(records[0].is_boardgame)
        self.assertTrue(records[0].is_boardgame_confirmed)
        self.assertTrue(records[0].store_active)
        self.assertEqual(records[0].raw_payload, {"json_ld": {"name": "Catan"}})
        self.assertEqual(records[0].classification_reasons, ["previously confirmed"])
        self.assertEqual(records[0].match_payload, {"source": "local"})
        self.assertEqual(connection.commits, 0)

    def test_lists_confirmed_boardgame_item_candidates_filters_selected_stores_before_limit(self):
        connection = FakeConnection(fetchall_rows=[[]])
        repository = DiscoveryRepository(connection)

        records = repository.list_confirmed_boardgame_item_candidates(limit=50, store_ids=[12, 34])

        sql, params = connection.cursor_instance.executions[0]
        normalized_sql = sql.casefold()
        self.assertEqual(records, [])
        self.assertIn("store_id in (%s, %s)", normalized_sql)
        self.assertIn("order by refreshed_date asc nulls first, id asc", normalized_sql)
        self.assertIn("limit %s", normalized_sql)
        self.assertEqual(params, (12, 34, 50))
        self.assertEqual(connection.commits, 0)

    def test_marks_processing_state_without_listing_status_changes(self):
        connection = FakeConnection()
        repository = DiscoveryRepository(connection)

        repository.mark_item_candidate_not_boardgame(56, ["non-boardgame terms found: sleeves"])
        repository.mark_item_candidate_match_not_found(57, ["no match above threshold"])
        repository.mark_item_candidate_processing_error(58, "BGG client is not configured")

        status_sql, status_params = connection.cursor_instance.executions[0]
        missing_sql, missing_params = connection.cursor_instance.executions[1]
        error_sql, error_params = connection.cursor_instance.executions[2]
        self.assertNotIn("listing_status", status_sql.casefold())
        self.assertNotIn("status = %s", status_sql.casefold())
        self.assertIn("match_source = 'NONE'", status_sql)
        self.assertEqual(json.loads(status_params[0]), ["non-boardgame terms found: sleeves"])
        self.assertEqual(status_params[-1], 56)
        self.assertEqual(json.loads(missing_params[0]), ["no match above threshold"])
        self.assertEqual(missing_params[-1], 57)
        self.assertIn("processing_error = %s", error_sql.casefold())
        self.assertEqual(error_params, ("BGG client is not configured", 58))
        self.assertEqual(connection.commits, 3)

    def test_lists_item_search_embedding_sources_with_taxonomy(self):
        connection = FakeConnection(
            fetchall_rows=[
                [
                    (
                        77,
                        "Calico",
                        "Calico",
                        "A puzzly tile-laying game about sewing quilts and attracting cats.",
                        "Un juego sobre coser colchas y atraer gatos.",
                        1,
                        4,
                        30,
                        40,
                        "1.8",
                        10,
                        ["Animals", "Puzzle"],
                        ["Animales", "Rompecabezas"],
                        ["Pattern Building", "Tile Placement"],
                        ["Construccion de patrones", "Colocacion de losetas"],
                        ["Cats"],
                        ["Gatos"],
                    )
                ]
            ]
        )
        repository = DiscoveryRepository(connection)

        sources = repository.list_item_search_embedding_sources(refresh_mode="missing")

        sql, params = connection.cursor_instance.executions[0]
        normalized_sql = sql.casefold()
        self.assertIn("from active_item i", normalized_sql)
        self.assertIn("left join item_search_embeddings ise", normalized_sql)
        self.assertIn("where ise.item_id is null", normalized_sql)
        self.assertIn("from item_categories", normalized_sql)
        self.assertIn("bc.name_es", normalized_sql)
        self.assertIn("from item_mechanics", normalized_sql)
        self.assertIn("bm.name_es", normalized_sql)
        self.assertIn("from item_families", normalized_sql)
        self.assertIn("bf.name_es", normalized_sql)
        self.assertEqual(params, ())
        self.assertEqual(
            sources,
            [
                ItemSearchEmbeddingSource(
                    item_id=77,
                    canonical_name="Calico",
                    canonical_name_es="Calico",
                    description="A puzzly tile-laying game about sewing quilts and attracting cats.",
                    description_es="Un juego sobre coser colchas y atraer gatos.",
                    min_players=1,
                    max_players=4,
                    min_minutes=30,
                    max_minutes=40,
                    complexity=1.8,
                    min_age=10,
                    categories=["Animals", "Puzzle"],
                    categories_es=["Animales", "Rompecabezas"],
                    mechanics=["Pattern Building", "Tile Placement"],
                    mechanics_es=["Construccion de patrones", "Colocacion de losetas"],
                    families=["Cats"],
                    families_es=["Gatos"],
                )
            ],
        )

    def test_full_item_search_embedding_source_refresh_includes_all_items(self):
        connection = FakeConnection(fetchall_rows=[[]])
        repository = DiscoveryRepository(connection)

        repository.list_item_search_embedding_sources(refresh_mode="full")

        sql, params = connection.cursor_instance.executions[0]
        self.assertIn("from active_item i", sql.casefold())
        self.assertNotIn("where ise.item_id is null", sql.casefold())
        self.assertEqual(params, ())

    def test_upserts_item_search_embedding(self):
        connection = FakeConnection()
        repository = DiscoveryRepository(connection)

        repository.upsert_item_search_embedding(
            item_id=77,
            embedding=[0.1, -0.2, 0.3],
            source_text="Name: Calico",
            source_hash="source-hash",
            model="text-embedding-3-small",
        )

        sql, params = connection.cursor_instance.executions[0]
        normalized_sql = sql.casefold()
        self.assertIn("insert into item_search_embeddings", normalized_sql)
        self.assertIn("on conflict (item_id) do update", normalized_sql)
        self.assertIn("%s::vector", normalized_sql)
        self.assertEqual(params[0], 77)
        self.assertEqual(params[1], "[0.1,-0.2,0.3]")
        self.assertEqual(params[2], "Name: Calico")
        self.assertEqual(params[3], "source-hash")
        self.assertEqual(params[4], "text-embedding-3-small")
        self.assertEqual(params[5], 3)
        self.assertEqual(connection.commits, 1)


if __name__ == "__main__":
    unittest.main()
