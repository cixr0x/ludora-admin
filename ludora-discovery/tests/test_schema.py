import unittest
from pathlib import Path


class SchemaTests(unittest.TestCase):
    def test_schema_contains_mvp_lifecycle_tables(self):
        schema_path = Path(__file__).resolve().parents[2] / "database" / "schema.sql"
        schema = schema_path.read_text(encoding="utf-8")

        for table_name in [
            "discovery_store_candidates",
            "store_items",
            "discovery_evidence",
            "admin_review_tasks",
            "stores",
            "items",
            "item_match_candidates",
            "translation_jobs",
            "publishers",
        ]:
            self.assertIn(f"create table if not exists {table_name}", schema.casefold())

    def test_discovery_store_candidates_matches_store_csv_shape(self):
        schema_path = Path(__file__).resolve().parents[2] / "database" / "schema.sql"
        schema = schema_path.read_text(encoding="utf-8").casefold()
        store_table = schema.split("create table if not exists discovery_store_candidates", 1)[1].split(");", 1)[0]

        for column_name in [
            "store_name",
            "canonical_domain",
            "website_url",
            "instagram_url",
            "facebook_url",
            "city",
            "state",
            "country",
            "store_logo",
            "status",
            "confidence",
            "source_queries",
            "evidence",
        ]:
            self.assertIn(column_name, store_table)

        self.assertIn("status text not null default 'pending'", store_table)
        self.assertIn("status in ('pending', 'accepted', 'rejected')", schema)

        for audit_column in ["accepted boolean", "reasons jsonb", "title text", "description text"]:
            self.assertNotIn(audit_column, store_table)

        for existing_database_column in [
            "instagram_url",
            "facebook_url",
            "city",
            "state",
            "country",
            "store_logo",
            "status",
            "evidence",
        ]:
            self.assertIn(
                f"alter table discovery_store_candidates add column if not exists {existing_database_column}",
                schema,
            )
        self.assertIn("alter table discovery_store_candidates drop column if exists accepted", schema)

    def test_schema_keeps_bgg_optional_but_unique_when_present(self):
        schema_path = Path(__file__).resolve().parents[2] / "database" / "schema.sql"
        schema = schema_path.read_text(encoding="utf-8").casefold()

        self.assertIn("bgg_id bigint", schema)
        self.assertIn("where bgg_id is not null", schema)

    def test_items_table_stores_spanish_description(self):
        schema_path = Path(__file__).resolve().parents[2] / "database" / "schema.sql"
        schema = schema_path.read_text(encoding="utf-8").casefold()
        items_table = schema.split("create table if not exists items", 1)[1].split(");", 1)[0]

        self.assertIn("canonical_name_es text not null default ''", items_table)
        self.assertIn("normalized_name_es text not null default ''", items_table)
        self.assertIn("description_es text not null default ''", items_table)
        self.assertIn("image_url_es text not null default ''", items_table)
        self.assertIn("alter table if exists items add column if not exists canonical_name_es text not null default ''", schema)
        self.assertIn("alter table if exists items add column if not exists normalized_name_es text not null default ''", schema)
        self.assertIn("alter table if exists items add column if not exists description_es text not null default ''", schema)
        self.assertIn("alter table if exists items add column if not exists image_url_es text not null default ''", schema)

    def test_store_items_replaces_listing_candidates(self):
        schema_path = Path(__file__).resolve().parents[2] / "database" / "schema.sql"
        schema = schema_path.read_text(encoding="utf-8").casefold()
        item_candidate_table = schema.split("create table if not exists store_items", 1)[1].split(");", 1)[0]

        self.assertNotIn("create table if not exists discovery_listing_candidates", schema)
        self.assertIn("drop table if exists discovery_listing_candidates", schema)
        self.assertIn("alter table discovery_item_candidates rename to store_items", schema)

        for column_name in [
            "store_id",
            "source_listing_url",
            "title",
            "publisher",
            "description",
            "item_id",
            "item_type",
            "min_players",
            "max_players",
            "min_minutes",
            "max_minutes",
            "min_age",
            "language",
            "language_source",
            "language_evidence",
            "image_url",
            "status",
            "raw_price",
            "price",
            "price_source",
            "currency",
            "availability",
            "availability_source",
            "store_sku",
            "raw_payload",
            "is_boardgame",
            "is_boardgame_confirmed",
            "category_confidence",
            "classification_reasons",
            "match_source",
            "matched_bgg_id",
            "matched_name",
            "match_score",
            "match_reasons",
            "match_payload",
            "matched_at",
            "processed_at",
            "processing_error",
            "last_seen_at",
            "last_updated",
        ]:
            self.assertIn(column_name, item_candidate_table)

        self.assertIn("store_id bigint", item_candidate_table)
        self.assertIn("item_id bigint", item_candidate_table)
        self.assertNotIn("match_item_id", item_candidate_table)
        self.assertNotIn("candidate_category", item_candidate_table)
        self.assertIn("is_boardgame boolean not null default false", item_candidate_table)
        self.assertIn("is_boardgame_confirmed boolean not null default false", item_candidate_table)
        self.assertIn(
            "update store_items set is_boardgame = candidate_category in ('likely_boardgame', 'likely_expansion')",
            schema,
        )
        self.assertIn(
            "update store_items set is_boardgame_confirmed = is_boardgame is true and item_id is not null",
            schema,
        )
        self.assertIn("alter table if exists store_items drop column if exists candidate_category", schema)
        self.assertIn(
            "update store_items set item_id = match_item_id where item_id is null and match_item_id is not null",
            schema,
        )
        self.assertIn("alter table if exists store_items drop column if exists match_item_id", schema)
        self.assertIn("item_type text not null default 'unknown'", item_candidate_table)
        self.assertIn("item_type in ('unknown', 'base_game', 'expansion')", schema)
        self.assertIn("price numeric(12, 2)", item_candidate_table)
        self.assertIn("price_source text not null default 'none'", item_candidate_table)
        self.assertIn("currency text not null default 'mxn'", item_candidate_table)
        self.assertIn("availability_source text not null default 'none'", item_candidate_table)
        self.assertIn("raw_payload jsonb not null default '{}'::jsonb", item_candidate_table)
        self.assertIn("category_confidence numeric(4, 2)", item_candidate_table)
        self.assertIn("classification_reasons jsonb not null default '[]'::jsonb", item_candidate_table)
        self.assertIn("last_seen_at timestamptz not null default now()", item_candidate_table)
        self.assertIn("last_updated timestamptz not null default now()", item_candidate_table)
        self.assertNotIn("status text not null default 'new'", item_candidate_table)
        self.assertIn("listing_status text not null default 'pending'", item_candidate_table)
        self.assertIn(
            "listing_status in ('pending', 'listed', 'unlisted', 'rejected')",
            schema,
        )
        self.assertIn("update store_items set listing_status = 'pending'", schema)
        self.assertIn("alter table if exists store_items drop column if exists status", schema)
        self.assertIn("unique (store_id, source_url)", item_candidate_table)
        self.assertIn(
            "alter table if exists store_items drop constraint if exists discovery_item_candidates_store_id_source_url_title_key",
            schema,
        )
        self.assertIn("store_items_store_id_source_url_key", schema)
        self.assertIn("alter table if exists store_items drop column if exists offer_id", schema)

    def test_schema_contains_active_item_view(self):
        schema_path = Path(__file__).resolve().parents[2] / "database" / "schema.sql"
        schema = schema_path.read_text(encoding="utf-8").casefold()

        self.assertIn("create or replace view active_item as", schema)
        self.assertLess(schema.index("create table if not exists item_relationships"), schema.index("create or replace view active_item as"))
        view = schema.split("create or replace view active_item as", 1)[1].split(";", 1)[0]

        self.assertIn("i.*", view)
        self.assertIn("from items i", view)
        self.assertIn("where exists", view)
        self.assertIn("from store_items si", view)
        self.assertIn("si.item_id = i.id", view)
        self.assertIn("si.is_boardgame = true", view)
        self.assertIn("si.is_boardgame_confirmed = true", view)
        self.assertIn("as has_approved_listing", view)
        self.assertIn("si.listing_status = 'listed'", view)
        self.assertIn("as is_expansion", view)
        self.assertIn("ir.link_type = 'extension' and ir.item_a_id = i.id", view)
        self.assertIn("ir.link_type = 'expansion' and ir.item_b_id = i.id", view)

    def test_schema_removes_offers_and_keeps_item_relationships(self):
        schema_path = Path(__file__).resolve().parents[2] / "database" / "schema.sql"
        schema = schema_path.read_text(encoding="utf-8").casefold()

        self.assertIn("drop table if exists offers", schema)
        self.assertNotIn("create table if not exists offers", schema)

        self.assertIn("create table if not exists item_relationships", schema)
        self.assertIn("item_a_id bigint not null references items(id)", schema)
        self.assertIn("link_type text not null", schema)
        self.assertIn("item_b_id bigint not null references items(id)", schema)
        self.assertIn("unique (item_a_id, link_type, item_b_id)", schema)

    def test_schema_contains_item_match_candidates(self):
        schema_path = Path(__file__).resolve().parents[2] / "database" / "schema.sql"
        schema = schema_path.read_text(encoding="utf-8").casefold()
        table = schema.split("create table if not exists item_match_candidates", 1)[1].split(");", 1)[0]

        for column_name in [
            "discovery_item_candidate_id",
            "source",
            "item_id",
            "bgg_id",
            "matched_name",
            "match_score",
            "match_reasons",
            "status",
            "raw_payload",
            "created_at",
            "updated_at",
        ]:
            self.assertIn(column_name, table)

        self.assertIn("discovery_item_candidate_id bigint not null references store_items(id)", table)
        self.assertIn("source text not null check (source in ('local', 'bgg'))", table)
        self.assertIn("item_id bigint references items(id)", table)
        self.assertIn("match_score numeric(5, 4) not null default 0", table)
        self.assertIn("match_reasons jsonb not null default '[]'::jsonb", table)
        self.assertIn("status text not null default 'pending'", table)
        self.assertIn("status in ('pending', 'accepted', 'rejected')", table)
        self.assertIn("raw_payload jsonb not null default '{}'::jsonb", table)
        self.assertIn("item_match_candidates_discovery_item_candidate_id_idx", schema)
        self.assertIn("item_match_candidates_status_idx", schema)

    def test_schema_contains_translation_jobs(self):
        schema_path = Path(__file__).resolve().parents[2] / "database" / "schema.sql"
        schema = schema_path.read_text(encoding="utf-8").casefold()
        table = schema.split("create table if not exists translation_jobs", 1)[1].split(");", 1)[0]

        for column_name in [
            "source_type",
            "source_id",
            "source_field",
            "source_language",
            "target_language",
            "purpose",
            "source_text_hash",
            "source_text",
            "translated_text",
            "alternates",
            "metadata",
            "model",
            "prompt_version",
            "status",
            "error_message",
            "created_at",
            "updated_at",
        ]:
            self.assertIn(column_name, table)

        self.assertIn("source_text_hash text not null", table)
        self.assertIn("alternates jsonb not null default '[]'::jsonb", table)
        self.assertIn("metadata jsonb not null default '{}'::jsonb", table)
        self.assertIn("status text not null default 'pending'", table)
        self.assertIn("status in ('pending', 'completed', 'failed')", schema)
        self.assertIn("translation_jobs_cache_key_idx", schema)
        self.assertIn("translation_jobs_cache_context_idx", schema)
        self.assertIn(
            "on translation_jobs (source_text_hash, source_language, target_language, purpose, model, prompt_version, status)",
            schema,
        )
        self.assertIn("translation_jobs_source_idx", schema)

    def test_schema_contains_item_search_embeddings(self):
        schema_path = Path(__file__).resolve().parents[2] / "database" / "schema.sql"
        schema = schema_path.read_text(encoding="utf-8").casefold()

        self.assertIn("create extension if not exists vector", schema)
        self.assertIn("create table if not exists item_search_embeddings", schema)

        table = schema.split("create table if not exists item_search_embeddings", 1)[1].split(");", 1)[0]

        for column_name in [
            "item_id",
            "embedding",
            "source_text",
            "source_hash",
            "model",
            "embedding_dimensions",
            "created_at",
            "updated_at",
        ]:
            self.assertIn(column_name, table)

        self.assertIn("item_id bigint primary key references items(id) on delete cascade", table)
        self.assertIn("embedding vector(1536) not null", table)
        self.assertIn("source_text text not null", table)
        self.assertIn("source_hash text not null", table)
        self.assertIn("model text not null", table)
        self.assertIn("embedding_dimensions integer not null default 1536", table)
        self.assertIn("item_search_embeddings_source_hash_idx", schema)
        self.assertIn("on item_search_embeddings (source_hash)", schema)
        self.assertIn("item_search_embeddings_model_idx", schema)
        self.assertIn("on item_search_embeddings (model)", schema)

    def test_schema_contains_bgg_metadata_tables(self):
        schema_path = Path(__file__).resolve().parents[2] / "database" / "schema.sql"
        schema = schema_path.read_text(encoding="utf-8").casefold()

        for table_name in [
            "boardgame_categories",
            "boardgame_mechanics",
            "boardgame_families",
            "contributors",
            "item_categories",
            "item_mechanics",
            "item_families",
            "item_contributors",
            "bgg_search_cache",
            "bgg_thing_cache",
        ]:
            self.assertIn(f"create table if not exists {table_name}", schema)

        for lookup_table in ["boardgame_categories", "boardgame_mechanics", "boardgame_families"]:
            table = schema.split(f"create table if not exists {lookup_table}", 1)[1].split(");", 1)[0]
            self.assertIn("bgg_id bigint not null unique", table)
            self.assertIn("name text not null", table)
            self.assertIn("name_es text not null default ''", table)
            self.assertIn("created_at timestamptz not null default now()", table)
            self.assertIn("updated_at timestamptz not null default now()", table)

        contributors_table = schema.split("create table if not exists contributors", 1)[1].split(");", 1)[0]
        self.assertIn("bgg_id bigint not null unique", contributors_table)
        self.assertIn("name text not null", contributors_table)

        self.assertIn("alter table if exists publishers add column if not exists bgg_id bigint", schema)
        self.assertIn("create unique index if not exists publishers_bgg_id_unique", schema)
        self.assertIn("where bgg_id is not null", schema)

        category_relationship = schema.split("create table if not exists item_categories", 1)[1].split(");", 1)[0]
        self.assertIn("category_id bigint not null references boardgame_categories(id)", category_relationship)
        self.assertIn("primary key (item_id, category_id)", category_relationship)

        mechanic_relationship = schema.split("create table if not exists item_mechanics", 1)[1].split(");", 1)[0]
        self.assertIn("mechanic_id bigint not null references boardgame_mechanics(id)", mechanic_relationship)
        self.assertIn("primary key (item_id, mechanic_id)", mechanic_relationship)

        family_relationship = schema.split("create table if not exists item_families", 1)[1].split(");", 1)[0]
        self.assertIn("family_id bigint not null references boardgame_families(id)", family_relationship)
        self.assertIn("primary key (item_id, family_id)", family_relationship)

        contributor_relationship = schema.split("create table if not exists item_contributors", 1)[1].split(");", 1)[0]
        self.assertIn("contributor_id bigint not null references contributors(id)", contributor_relationship)
        self.assertIn("contribution_role text not null", contributor_relationship)
        self.assertIn("contribution_role in ('designer', 'artist')", contributor_relationship)
        self.assertIn("primary key (item_id, contributor_id, contribution_role)", contributor_relationship)

        self.assertIn("drop table if exists bgg_item_snapshots", schema)

        self.assertIn("column_name = 'bgg_id'", schema)

        search_cache_table = schema.split("create table if not exists bgg_search_cache", 1)[1].split(");", 1)[0]
        self.assertIn("bgg_id bigint not null unique", search_cache_table)
        self.assertIn("name text not null", search_cache_table)
        self.assertIn("item_type text not null default ''", search_cache_table)
        self.assertIn("year_published integer", search_cache_table)
        self.assertIn("result_json jsonb not null default '{}'::jsonb", search_cache_table)
        self.assertIn("first_seen_at timestamptz not null default now()", search_cache_table)
        self.assertIn("updated_at timestamptz not null default now()", search_cache_table)

        thing_cache_table = schema.split("create table if not exists bgg_thing_cache", 1)[1].split(");", 1)[0]
        self.assertIn("bgg_id bigint not null", thing_cache_table)
        self.assertIn("request_type text not null default 'boardgame,boardgameexpansion'", thing_cache_table)
        self.assertIn("raw_xml text not null", thing_cache_table)
        self.assertIn("parsed_json jsonb not null default '{}'::jsonb", thing_cache_table)
        self.assertIn("name text not null default ''", thing_cache_table)
        self.assertIn("item_type text not null default ''", thing_cache_table)
        self.assertIn("year_published integer", thing_cache_table)
        self.assertIn("fetched_at timestamptz not null default now()", thing_cache_table)
        self.assertIn("updated_at timestamptz not null default now()", thing_cache_table)
        self.assertIn("unique (bgg_id, request_type)", thing_cache_table)
        self.assertIn("bgg_thing_cache_bgg_id_idx", schema)

        search_queries_table = schema.split("create table if not exists bgg_search_queries", 1)[1].split(");", 1)[0]
        self.assertIn("query text not null", search_queries_table)
        self.assertIn("normalized_query text not null", search_queries_table)
        self.assertIn("search_type text not null default 'boardgame,boardgameexpansion'", search_queries_table)
        self.assertIn("result_count integer not null default 0", search_queries_table)
        self.assertIn("fetched_at timestamptz not null default now()", search_queries_table)
        self.assertIn("updated_at timestamptz not null default now()", search_queries_table)
        self.assertIn("unique (normalized_query, search_type)", search_queries_table)

        query_results_table = schema.split("create table if not exists bgg_search_query_results", 1)[1].split(");", 1)[0]
        self.assertIn("query_id bigint not null references bgg_search_queries(id) on delete cascade", query_results_table)
        self.assertIn("cache_id bigint not null references bgg_search_cache(id) on delete cascade", query_results_table)
        self.assertIn("result_rank integer not null default 0", query_results_table)
        self.assertIn("primary key (query_id, cache_id)", query_results_table)
        self.assertIn("bgg_search_queries_normalized_query_idx", schema)
        self.assertIn("bgg_search_query_results_query_rank_idx", schema)

    def test_schema_contains_front_page_categories(self):
        schema_path = Path(__file__).resolve().parents[2] / "database" / "schema.sql"
        schema = schema_path.read_text(encoding="utf-8").casefold()

        self.assertIn("create table if not exists front_page_categories", schema)
        table = schema.split("create table if not exists front_page_categories", 1)[1].split(");", 1)[0]

        self.assertIn("id bigserial primary key", table)
        self.assertIn("category_type text not null", table)
        self.assertIn("category_type in ('category', 'family', 'mechanic')", table)
        self.assertIn("category_id bigint not null", table)
        self.assertIn("title text not null", table)
        self.assertIn('"order" numeric not null default 0', table)
        self.assertIn("created_at timestamptz not null default now()", table)
        self.assertIn("updated_at timestamptz not null default now()", table)
        self.assertIn('alter table if exists front_page_categories add column if not exists "order" numeric not null default 0', schema)
        self.assertIn("front_page_categories_category_ref_idx", schema)
        self.assertIn("on front_page_categories (category_type, category_id)", schema)

    def test_schema_contains_front_page_category_items(self):
        schema_path = Path(__file__).resolve().parents[2] / "database" / "schema.sql"
        schema = schema_path.read_text(encoding="utf-8").casefold()

        self.assertIn("create table if not exists front_page_category_items", schema)
        table = schema.split("create table if not exists front_page_category_items", 1)[1].split(");", 1)[0]

        self.assertIn("id bigserial primary key", table)
        self.assertIn("front_page_category_id bigint not null references front_page_categories(id) on delete cascade", table)
        self.assertIn("item_id bigint not null unique references items(id) on delete cascade", table)
        self.assertIn("item_order integer not null default 0", table)
        self.assertIn("created_at timestamptz not null default now()", table)
        self.assertIn("updated_at timestamptz not null default now()", table)
        self.assertIn("front_page_category_items_item_id_idx", schema)
        self.assertIn("on front_page_category_items (item_id)", schema)
        self.assertIn("front_page_category_items_category_order_idx", schema)
        self.assertIn("on front_page_category_items (front_page_category_id, item_order)", schema)


if __name__ == "__main__":
    unittest.main()
