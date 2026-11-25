BEGIN;

DO $$
BEGIN
    IF current_database() <> 'ludora_dev' THEN
        RAISE EXCEPTION 'Apply this patch while connected to ludora_dev';
    END IF;
END;
$$;

-- Provision roles and grants before a separately approved login cutover.
CREATE ROLE ludora_public_api WITH
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8;
CREATE ROLE ludora_admin_api WITH
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6;
CREATE ROLE ludora_background WITH
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8;

ALTER ROLE ludora_public_api IN DATABASE ludora_dev SET statement_timeout = '8s';
ALTER ROLE ludora_admin_api IN DATABASE ludora_dev SET statement_timeout = '8s';
ALTER ROLE ludora_background IN DATABASE ludora_dev SET statement_timeout = '30s';

GRANT CONNECT ON DATABASE ludora_dev TO ludora_public_api, ludora_admin_api, ludora_background;
GRANT USAGE ON SCHEMA public TO ludora_public_api, ludora_admin_api, ludora_background;

-- Public catalog, SEO export, search, offers and the active event.
GRANT SELECT ON TABLE
    public.boardgame_categories,
    public.boardgame_families,
    public.boardgame_mechanics,
    public.contributors,
    public.events,
    public.front_page_categories,
    public.front_page_category_items,
    public.item_categories,
    public.item_contributors,
    public.item_families,
    public.item_mechanics,
    public.item_publishers,
    public.publishers,
    public.store_item_additional_items,
    public.tutorial_links
TO ludora_public_api;

GRANT SELECT (
    id, canonical_name, normalized_name, canonical_name_es, normalized_name_es,
    item_type, parent_item_id, bgg_id, bgg_url, bgg_last_sync_at, year_published,
    rating, description, description_es, min_players, max_players, min_minutes,
    max_minutes, complexity, weight, min_age, image_url, image_url_es, status,
    has_approved_listing, is_expansion, created_at, updated_at
) ON TABLE public.active_item TO ludora_public_api;
GRANT SELECT (item_a_id, item_b_id, link_type)
    ON TABLE public.item_relationships TO ludora_public_api;
GRANT SELECT (item_id, embedding, model)
    ON TABLE public.item_search_embeddings TO ludora_public_api;
GRANT SELECT (
    id, store_id, item_id, source_url, source_listing_url, title, image_url,
    price, raw_price, currency, availability, store_active, listing_status,
    last_seen_at, last_updated, refreshed_date, language, is_boardgame, is_boardgame_confirmed
) ON TABLE public.store_items TO ludora_public_api;
GRANT SELECT (id, name, platform, canonical_domain, website_url, logo_url, country, updated_at, active)
    ON TABLE public.stores TO ludora_public_api;

-- Contact submission uses a serial default and returns only the new id.
GRANT INSERT (name, email, message), SELECT (id)
    ON TABLE public.contact_form_submissions TO ludora_public_api;
GRANT USAGE ON SEQUENCE public.contact_form_submissions_id_seq TO ludora_public_api;

-- Counter upserts read the conflict keys and the counters they increment.
GRANT INSERT (store_item_id, clicked_hour, click_count),
      SELECT (store_item_id, clicked_hour, click_count),
      UPDATE (click_count)
    ON TABLE public.store_item_click_stats TO ludora_public_api;
GRANT INSERT (event_id, date, click, positive, negative, dismiss),
      SELECT (event_id, date, click, positive, negative, dismiss),
      UPDATE (click, positive, negative, dismiss)
    ON TABLE public.event_stats TO ludora_public_api;

-- Admin routes, BGG import/cache/maintenance, and the local discovery watchdog.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.bgg_search_query_results,
    public.front_page_categories,
    public.front_page_category_items,
    public.item_relationships,
    public.items
TO ludora_admin_api;

GRANT SELECT, INSERT, UPDATE ON TABLE
    public.bgg_search_cache,
    public.bgg_search_queries,
    public.bgg_thing_cache,
    public.boardgame_categories,
    public.boardgame_families,
    public.boardgame_mechanics,
    public.contributors,
    public.discovery_store_candidates,
    public.item_aliases,
    public.publishers,
    public.store_item_update_schedule_runs,
    public.stores,
    public.tutorial_links
TO ludora_admin_api;

GRANT SELECT, INSERT, DELETE ON TABLE
    public.item_match_candidates,
    public.store_item_additional_items
TO ludora_admin_api;

GRANT SELECT, INSERT ON TABLE
    public.item_categories,
    public.item_contributors,
    public.item_families,
    public.item_mechanics,
    public.item_publishers,
    public.store_item_discovery_trace_log,
    public.translation_jobs
TO ludora_admin_api;

GRANT SELECT, UPDATE ON TABLE public.job_store_item_discovery_log TO ludora_admin_api;
GRANT SELECT, UPDATE, DELETE ON TABLE public.store_items TO ludora_admin_api;
GRANT SELECT, DELETE ON TABLE public.store_item_click_stats TO ludora_admin_api;

GRANT SELECT ON TABLE
    public.active_item,
    public.admin_review_tasks,
    public.contact_form_submissions,
    public.job_store_item_update_log,
    public.publisher_aliases,
    public.store_item_update_attempt_log,
    public.store_item_update_change_log,
    public.store_item_update_store_cooldown,
    public.store_item_update_trace_log,
    public.store_item_update_worker_state
TO ludora_admin_api;

GRANT USAGE ON SEQUENCE
    public.bgg_search_cache_id_seq,
    public.bgg_search_queries_id_seq,
    public.bgg_thing_cache_id_seq,
    public.boardgame_categories_id_seq,
    public.boardgame_families_id_seq,
    public.boardgame_mechanics_id_seq,
    public.contributors_id_seq,
    public.discovery_store_candidates_id_seq,
    public.front_page_categories_id_seq,
    public.front_page_category_items_id_seq,
    public.item_aliases_id_seq,
    public.item_match_candidates_id_seq,
    public.item_relationships_id_seq,
    public.items_id_seq,
    public.publishers_id_seq,
    public.store_item_discovery_trace_log_id_seq,
    public.store_item_update_schedule_runs_id_seq,
    public.stores_id_seq,
    public.translation_jobs_id_seq,
    public.tutorial_links_id_seq
TO ludora_admin_api;

-- Discovery (including BGG imports and embeddings), updater claims and outcomes,
-- and the dedicated Admin schedule pool. The refresh trigger function runs as its owner.
GRANT SELECT, INSERT, UPDATE ON TABLE
    public.boardgame_categories,
    public.boardgame_families,
    public.boardgame_mechanics,
    public.contributors,
    public.discovery_store_candidates,
    public.item_aliases,
    public.item_search_embeddings,
    public.items,
    public.job_store_item_discovery_log,
    public.job_store_item_update_log,
    public.publishers,
    public.store_item_update_attempt_log,
    public.store_item_update_schedule_runs,
    public.store_item_update_store_cooldown,
    public.store_item_update_worker_state,
    public.store_items,
    public.tutorial_links
TO ludora_background;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.item_relationships TO ludora_background;
GRANT SELECT ON TABLE public.active_item, public.stores TO ludora_background;

GRANT SELECT, INSERT ON TABLE
    public.item_categories,
    public.item_families,
    public.item_mechanics
TO ludora_background;

GRANT INSERT ON TABLE
    public.item_contributors,
    public.item_publishers,
    public.store_item_discovery_trace_log,
    public.store_item_price_history,
    public.store_item_update_change_log,
    public.store_item_update_trace_log
TO ludora_background;

-- store_items kept its serial sequence name when the table was renamed.
GRANT USAGE ON SEQUENCE
    public.boardgame_categories_id_seq,
    public.boardgame_families_id_seq,
    public.boardgame_mechanics_id_seq,
    public.contributors_id_seq,
    public.discovery_item_candidates_id_seq,
    public.discovery_store_candidates_id_seq,
    public.item_aliases_id_seq,
    public.item_relationships_id_seq,
    public.items_id_seq,
    public.job_store_item_discovery_log_id_seq,
    public.job_store_item_update_log_id_seq,
    public.publishers_id_seq,
    public.store_item_discovery_trace_log_id_seq,
    public.store_item_price_history_id_seq,
    public.store_item_update_attempt_log_id_seq,
    public.store_item_update_change_log_id_seq,
    public.store_item_update_schedule_runs_id_seq,
    public.store_item_update_trace_log_id_seq,
    public.tutorial_links_id_seq
TO ludora_background;

COMMIT;
