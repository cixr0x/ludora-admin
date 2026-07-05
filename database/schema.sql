create table if not exists discovery_store_candidates (
    id bigserial primary key,
    store_name text not null default '',
    canonical_domain text not null unique,
    website_url text not null,
    instagram_url text not null default '',
    facebook_url text not null default '',
    city text not null default '',
    state text not null default '',
    country text not null default 'Mexico',
    store_logo text not null default '',
    status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'REJECTED')),
    confidence numeric(5, 4) not null default 0,
    source_queries jsonb not null default '[]'::jsonb,
    evidence jsonb not null default '[]'::jsonb,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);

alter table discovery_store_candidates add column if not exists instagram_url text not null default '';
alter table discovery_store_candidates add column if not exists facebook_url text not null default '';
alter table discovery_store_candidates add column if not exists city text not null default '';
alter table discovery_store_candidates add column if not exists state text not null default '';
alter table discovery_store_candidates add column if not exists country text not null default 'Mexico';
alter table discovery_store_candidates add column if not exists store_logo text not null default '';
alter table discovery_store_candidates add column if not exists status text;

do $$
begin
    if exists (
        select 1
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'discovery_store_candidates'
          and column_name = 'accepted'
    ) then
        update discovery_store_candidates
        set status = case
            when accepted is true then 'ACCEPTED'
            when accepted is false then 'REJECTED'
            else 'PENDING'
        end
        where status is null or status = '';
    end if;
end $$;

update discovery_store_candidates
set status = 'PENDING'
where status is null or status = '';

alter table discovery_store_candidates alter column status set default 'PENDING';
alter table discovery_store_candidates alter column status set not null;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conrelid = 'discovery_store_candidates'::regclass
          and conname = 'discovery_store_candidates_status_check'
    ) then
        alter table discovery_store_candidates
        add constraint discovery_store_candidates_status_check
        check (status in ('PENDING', 'ACCEPTED', 'REJECTED'));
    end if;
end $$;

alter table discovery_store_candidates drop column if exists accepted;
alter table discovery_store_candidates add column if not exists evidence jsonb not null default '[]'::jsonb;

alter table if exists admin_review_tasks drop column if exists discovery_listing_candidate_id;
alter table if exists admin_item_match_decisions drop column if exists discovery_listing_candidate_id;
drop table if exists discovery_listing_candidates cascade;

do $$
begin
    if to_regclass('store_items') is null and to_regclass('discovery_item_candidates') is not null then
        alter table discovery_item_candidates rename to store_items;
    end if;
end $$;

create table if not exists store_items (
    id bigserial primary key,
    store_id bigint,
    source_url text not null default '',
    source_listing_url text not null default '',
    title text not null,
    publisher text not null default '',
    description text not null default '',
    item_id bigint,
    item_type text not null default 'unknown' check (item_type in ('unknown', 'base_game', 'expansion')),
    min_players integer,
    max_players integer,
    min_minutes integer,
    max_minutes integer,
    min_age integer,
    language text not null default '',
    language_source text not null default '',
    language_evidence text not null default '',
    image_url text not null default '',
    listing_status text not null default 'PENDING' check (listing_status in ('PENDING', 'LISTED', 'UNLISTED', 'REJECTED')),
    raw_price text not null default '',
    price numeric(12, 2),
    price_source text not null default 'none',
    currency text not null default 'MXN',
    availability text not null default 'unknown',
    availability_source text not null default 'none',
    store_sku text not null default '',
    raw_payload jsonb not null default '{}'::jsonb,
    is_boardgame boolean not null default false,
    is_boardgame_confirmed boolean not null default false,
    category_confidence numeric(4, 2),
    classification_reasons jsonb not null default '[]'::jsonb,
    match_source text not null default '',
    matched_bgg_id bigint,
    matched_name text not null default '',
    match_score numeric(5, 4),
    match_reasons jsonb not null default '[]'::jsonb,
    match_payload jsonb not null default '{}'::jsonb,
    matched_at timestamptz,
    processed_at timestamptz,
    processing_error text not null default '',
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    last_updated timestamptz not null default now(),
    refreshed_date timestamptz not null default now(),
    unique (store_id, source_url)
);

alter table if exists store_items add column if not exists refreshed_date timestamptz;
update store_items set refreshed_date = last_updated where refreshed_date is null;
alter table if exists store_items alter column refreshed_date set default now();
alter table if exists store_items alter column refreshed_date set not null;

create index if not exists store_items_store_id_idx
on store_items (store_id);

create index if not exists store_items_item_id_idx
on store_items (item_id);

create index if not exists store_items_refreshed_date_idx
on store_items (refreshed_date, id);

create table if not exists store_item_click_stats (
    store_item_id bigint not null,
    clicked_hour timestamptz not null,
    click_count bigint not null default 0,
    primary key (store_item_id, clicked_hour)
);

create table if not exists job_store_item_discovery_log (
    id bigserial primary key,
    run_id text not null unique,
    store_id bigint not null,
    website_url text not null default '',
    status text not null default 'running' check (status in ('running', 'cancelled', 'completed', 'failed')),
    error text not null default '',
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    new_items integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists job_store_item_discovery_log_store_id_started_at_idx
on job_store_item_discovery_log (store_id, started_at desc);

create index if not exists job_store_item_discovery_log_status_idx
on job_store_item_discovery_log (status);

create table if not exists job_store_item_update_log (
    id bigserial primary key,
    run_id text not null unique,
    store_id bigint,
    status text not null default 'running' check (status in ('running', 'cancelled', 'completed', 'failed')),
    error text not null default '',
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    scanned_items integer not null default 0,
    updated_items integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table if exists job_store_item_update_log add column if not exists store_id bigint;

create index if not exists job_store_item_update_log_started_at_idx
on job_store_item_update_log (started_at desc);

create index if not exists job_store_item_update_log_store_id_started_at_idx
on job_store_item_update_log (store_id, started_at desc);

create index if not exists job_store_item_update_log_status_idx
on job_store_item_update_log (status);

create table if not exists store_item_update_change_log (
    id bigserial primary key,
    job_id bigint not null references job_store_item_update_log(id) on delete cascade,
    run_id text not null,
    store_item_id bigint not null,
    field_name text not null,
    old_value jsonb not null,
    new_value jsonb not null,
    created_at timestamptz not null default now()
);

alter table if exists store_item_update_change_log
add column if not exists job_id bigint;

do $$
begin
    if to_regclass('store_item_update_change_log') is not null
       and not exists (
           select 1
           from pg_constraint
           where conrelid = 'store_item_update_change_log'::regclass
             and conname = 'store_item_update_change_log_job_id_fkey'
       ) then
        alter table store_item_update_change_log
        add constraint store_item_update_change_log_job_id_fkey
        foreign key (job_id) references job_store_item_update_log(id) on delete cascade;
    end if;
end $$;

create index if not exists store_item_update_change_log_job_id_idx
on store_item_update_change_log (job_id);

create index if not exists store_item_update_change_log_run_id_idx
on store_item_update_change_log (run_id);

create index if not exists store_item_update_change_log_store_item_created_idx
on store_item_update_change_log (store_item_id, created_at desc);

alter table if exists store_items add column if not exists source_listing_url text not null default '';
alter table if exists store_items add column if not exists image_url text not null default '';
alter table if exists store_items add column if not exists item_type text not null default 'unknown';
alter table if exists store_items add column if not exists min_minutes integer;
alter table if exists store_items add column if not exists max_minutes integer;
alter table if exists store_items add column if not exists min_age integer;
alter table if exists store_items add column if not exists language_source text not null default '';
alter table if exists store_items add column if not exists language_evidence text not null default '';
alter table if exists store_items add column if not exists currency text not null default 'MXN';
alter table if exists store_items add column if not exists price_source text not null default 'none';
alter table if exists store_items add column if not exists availability_source text not null default 'none';
alter table if exists store_items add column if not exists store_sku text not null default '';
alter table if exists store_items add column if not exists raw_payload jsonb not null default '{}'::jsonb;
alter table if exists store_items add column if not exists is_boardgame boolean not null default false;
alter table if exists store_items add column if not exists is_boardgame_confirmed boolean not null default false;
alter table if exists store_items add column if not exists category_confidence numeric(4, 2);
alter table if exists store_items add column if not exists classification_reasons jsonb not null default '[]'::jsonb;
alter table if exists store_items add column if not exists match_source text not null default '';
alter table if exists store_items add column if not exists matched_bgg_id bigint;
alter table if exists store_items add column if not exists matched_name text not null default '';
alter table if exists store_items add column if not exists match_score numeric(5, 4);
alter table if exists store_items add column if not exists match_reasons jsonb not null default '[]'::jsonb;
alter table if exists store_items add column if not exists match_payload jsonb not null default '{}'::jsonb;
alter table if exists store_items add column if not exists matched_at timestamptz;
alter table if exists store_items add column if not exists processed_at timestamptz;
alter table if exists store_items add column if not exists processing_error text not null default '';
alter table if exists store_items add column if not exists last_seen_at timestamptz not null default now();

alter table if exists store_items drop constraint if exists discovery_item_candidates_status_check;
alter table if exists store_items drop constraint if exists store_items_status_check;
alter table if exists store_items drop constraint if exists store_items_listing_status_check;

do $$
begin
    if exists (
        select 1
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'store_items'
          and column_name = 'status'
    ) and not exists (
        select 1
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'store_items'
          and column_name = 'listing_status'
    ) then
        alter table store_items rename column status to listing_status;
    end if;
end $$;

alter table if exists store_items add column if not exists listing_status text;
update store_items set listing_status = 'PENDING';
alter table if exists store_items alter column listing_status set default 'PENDING';
alter table if exists store_items alter column listing_status set not null;
alter table if exists store_items
add constraint store_items_listing_status_check
check (listing_status in ('PENDING', 'LISTED', 'UNLISTED', 'REJECTED'));
drop index if exists store_items_status_idx;
create index if not exists store_items_listing_status_idx
on store_items (listing_status);
alter table if exists store_items drop column if exists status;

delete from store_items stale
using store_items current
where stale.store_id is not distinct from current.store_id
  and stale.source_url = current.source_url
  and (
      stale.last_seen_at < current.last_seen_at
      or (stale.last_seen_at = current.last_seen_at and stale.last_updated < current.last_updated)
      or (stale.last_seen_at = current.last_seen_at and stale.last_updated = current.last_updated and stale.id < current.id)
  );

alter table if exists store_items drop constraint if exists discovery_item_candidates_store_id_source_url_title_key;
alter table if exists store_items drop constraint if exists discovery_item_candidates_store_id_source_url_key;
alter table if exists store_items drop constraint if exists store_items_store_id_source_url_key;
alter table if exists store_items drop column if exists offer_id;

do $$
begin
    if exists (
        select 1
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'store_items'
          and column_name = 'match_item_id'
    ) then
        update store_items set item_id = match_item_id where item_id is null and match_item_id is not null;
    end if;
end $$;

alter table if exists store_items drop constraint if exists store_items_match_item_id_fkey;
alter table if exists store_items drop column if exists match_item_id;

do $$
begin
    if to_regclass('store_items') is not null and not exists (
        select 1
        from pg_constraint
        where conrelid = 'store_items'::regclass
          and conname = 'store_items_store_id_source_url_key'
    ) then
        alter table store_items
        add constraint store_items_store_id_source_url_key
        unique (store_id, source_url);
    end if;
end $$;

do $$
begin
    alter table if exists store_items drop constraint if exists discovery_item_candidates_item_type_check;
    alter table if exists store_items drop constraint if exists store_items_item_type_check;
    if to_regclass('store_items') is not null and not exists (
        select 1
        from pg_constraint
        where conrelid = 'store_items'::regclass
          and conname = 'store_items_item_type_check'
    ) then
        alter table store_items
        add constraint store_items_item_type_check
        check (item_type in ('unknown', 'base_game', 'expansion'));
    end if;
end $$;

do $$
begin
    if exists (
        select 1
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'store_items'
          and column_name = 'candidate_category'
    ) then
        execute $migration$
            update store_items set is_boardgame = candidate_category in ('LIKELY_BOARDGAME', 'LIKELY_EXPANSION')
        $migration$;
    end if;
end $$;

update store_items set is_boardgame_confirmed = is_boardgame is true and item_id is not null;

alter table if exists store_items drop constraint if exists discovery_item_candidates_candidate_category_check;
alter table if exists store_items drop constraint if exists store_items_candidate_category_check;
alter table if exists store_items drop column if exists candidate_category;

create table if not exists discovery_evidence (
    id bigserial primary key,
    evidence_type text not null,
    source_url text not null,
    canonical_domain text not null default '',
    payload jsonb not null default '{}'::jsonb,
    captured_at timestamptz not null default now()
);

create table if not exists admin_review_tasks (
    id bigserial primary key,
    task_type text not null,
    status text not null default 'open',
    discovery_store_candidate_id bigint references discovery_store_candidates(id) on delete cascade,
    discovery_item_candidate_id bigint references store_items(id) on delete cascade,
    assigned_to text not null default '',
    decision text not null default '',
    decision_notes text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists admin_item_match_decisions (
    id bigserial primary key,
    discovery_item_candidate_id bigint references store_items(id) on delete cascade,
    item_id bigint,
    decision text not null,
    confidence numeric(5, 4) not null default 0,
    decided_by text not null default '',
    decided_at timestamptz not null default now()
);

create table if not exists admin_import_jobs (
    id bigserial primary key,
    import_type text not null,
    status text not null default 'queued',
    item_id bigint,
    source text not null default '',
    source_id text not null default '',
    error_message text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists stores (
    id bigserial primary key,
    name text not null,
    canonical_domain text not null unique,
    website_url text not null,
    platform text not null default '',
    instagram_url text not null default '',
    facebook_url text not null default '',
    city text not null default '',
    state text not null default '',
    country text not null default 'Mexico',
    logo_url text not null default '',
    status text not null default 'draft',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table if exists stores add column if not exists platform text not null default '';

create table if not exists items (
    id bigserial primary key,
    canonical_name text not null,
    normalized_name text not null,
    canonical_name_es text not null default '',
    normalized_name_es text not null default '',
    item_type text not null check (item_type in ('base_game', 'expansion')),
    parent_item_id bigint references items(id) on delete set null,
    bgg_id bigint,
    bgg_url text,
    bgg_last_sync_at timestamptz,
    year_published integer,
    description text not null default '',
    description_es text not null default '',
    min_players integer,
    max_players integer,
    min_minutes integer,
    max_minutes integer,
    complexity numeric(4, 2),
    min_age integer,
    image_url text not null default '',
    image_url_es text not null default '',
    status text not null default 'draft',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table if exists items add column if not exists canonical_name_es text not null default '';
alter table if exists items add column if not exists normalized_name_es text not null default '';
alter table if exists items add column if not exists description_es text not null default '';
alter table if exists items add column if not exists image_url_es text not null default '';

create extension if not exists vector;

create table if not exists item_search_embeddings (
    item_id bigint primary key references items(id) on delete cascade,
    embedding vector(1536) not null,
    source_text text not null,
    source_hash text not null,
    model text not null,
    embedding_dimensions integer not null default 1536,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists item_search_embeddings_source_hash_idx
on item_search_embeddings (source_hash);

create index if not exists item_search_embeddings_model_idx
on item_search_embeddings (model);

create table if not exists item_match_candidates (
    id bigserial primary key,
    discovery_item_candidate_id bigint not null references store_items(id) on delete cascade,
    source text not null check (source in ('LOCAL', 'BGG')),
    item_id bigint references items(id) on delete set null,
    bgg_id bigint,
    matched_name text not null default '',
    match_score numeric(5, 4) not null default 0,
    match_reasons jsonb not null default '[]'::jsonb,
    status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'REJECTED')),
    raw_payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists item_match_candidates_discovery_item_candidate_id_idx
on item_match_candidates (discovery_item_candidate_id);

create index if not exists item_match_candidates_status_idx
on item_match_candidates (status);

create table if not exists translation_jobs (
    id bigserial primary key,
    source_type text not null default '',
    source_id bigint,
    source_field text not null default '',
    source_language text not null,
    target_language text not null,
    purpose text not null,
    source_text_hash text not null,
    source_text text not null,
    translated_text text not null default '',
    alternates jsonb not null default '[]'::jsonb,
    metadata jsonb not null default '{}'::jsonb,
    model text not null default '',
    prompt_version text not null default '',
    status text not null default 'PENDING' check (status in ('PENDING', 'COMPLETED', 'FAILED')),
    error_message text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists translation_jobs_cache_key_idx
on translation_jobs (source_text_hash, source_language, target_language, purpose, status);

create index if not exists translation_jobs_cache_context_idx
on translation_jobs (source_text_hash, source_language, target_language, purpose, model, prompt_version, status);

create index if not exists translation_jobs_source_idx
on translation_jobs (source_type, source_id, source_field);

create unique index if not exists items_bgg_id_unique
on items (bgg_id)
where bgg_id is not null;

create table if not exists boardgame_categories (
    id bigserial primary key,
    bgg_id bigint not null unique,
    name text not null,
    name_es text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists boardgame_mechanics (
    id bigserial primary key,
    bgg_id bigint not null unique,
    name text not null,
    name_es text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists boardgame_families (
    id bigserial primary key,
    bgg_id bigint not null unique,
    name text not null,
    name_es text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists contributors (
    id bigserial primary key,
    bgg_id bigint not null unique,
    name text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conrelid = 'store_items'::regclass
          and conname = 'store_items_store_id_fkey'
    ) then
        alter table store_items
        add constraint store_items_store_id_fkey
        foreign key (store_id) references stores(id) on delete set null;
    end if;

    if not exists (
        select 1
        from pg_constraint
        where conrelid = 'store_items'::regclass
          and conname = 'store_items_item_id_fkey'
    ) then
        alter table store_items
        add constraint store_items_item_id_fkey
        foreign key (item_id) references items(id) on delete set null;
    end if;
end $$;

alter table if exists admin_review_tasks
add column if not exists discovery_item_candidate_id bigint references store_items(id) on delete cascade;

alter table if exists admin_item_match_decisions
add column if not exists discovery_item_candidate_id bigint references store_items(id) on delete cascade;

create table if not exists publishers (
    id bigserial primary key,
    name text not null unique,
    normalized_name text not null,
    website_url text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table if exists publishers add column if not exists bgg_id bigint;

create unique index if not exists publishers_bgg_id_unique
on publishers (bgg_id)
where bgg_id is not null;

create table if not exists item_publishers (
    item_id bigint not null references items(id) on delete cascade,
    publisher_id bigint not null references publishers(id) on delete cascade,
    primary key (item_id, publisher_id)
);

drop table if exists offers;

create table if not exists tutorial_links (
    id bigserial primary key,
    item_id bigint not null references items(id) on delete cascade,
    url text not null,
    title text not null default '',
    language text not null default 'es',
    source text not null default '',
    status text not null default 'published',
    created_at timestamptz not null default now()
);

create table if not exists item_aliases (
    id bigserial primary key,
    item_id bigint not null references items(id) on delete cascade,
    alias text not null,
    normalized_alias text not null,
    source text not null default 'admin',
    unique (item_id, normalized_alias)
);

create table if not exists publisher_aliases (
    id bigserial primary key,
    publisher_id bigint not null references publishers(id) on delete cascade,
    alias text not null,
    normalized_alias text not null,
    source text not null default 'admin',
    unique (publisher_id, normalized_alias)
);

do $$
begin
    if to_regclass('item_categories') is not null and exists (
        select 1
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'item_categories'
          and column_name = 'category'
    ) then
        if to_regclass('item_categories_legacy_text') is null then
            alter table item_categories rename to item_categories_legacy_text;
        else
            drop table item_categories;
        end if;
    end if;

    if to_regclass('item_mechanics') is not null and exists (
        select 1
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'item_mechanics'
          and column_name = 'mechanic'
    ) then
        if to_regclass('item_mechanics_legacy_text') is null then
            alter table item_mechanics rename to item_mechanics_legacy_text;
        else
            drop table item_mechanics;
        end if;
    end if;
end $$;

create table if not exists item_categories (
    item_id bigint not null references items(id) on delete cascade,
    category_id bigint not null references boardgame_categories(id) on delete cascade,
    primary key (item_id, category_id)
);

create table if not exists item_mechanics (
    item_id bigint not null references items(id) on delete cascade,
    mechanic_id bigint not null references boardgame_mechanics(id) on delete cascade,
    primary key (item_id, mechanic_id)
);

create table if not exists item_families (
    item_id bigint not null references items(id) on delete cascade,
    family_id bigint not null references boardgame_families(id) on delete cascade,
    primary key (item_id, family_id)
);

create table if not exists front_page_categories (
    id bigserial primary key,
    category_type text not null check (category_type in ('category', 'family', 'mechanic')),
    category_id bigint not null,
    title text not null,
    "order" numeric not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table if exists front_page_categories add column if not exists "order" numeric not null default 0;

create index if not exists front_page_categories_category_ref_idx
on front_page_categories (category_type, category_id);

create table if not exists front_page_category_items (
    id bigserial primary key,
    front_page_category_id bigint not null references front_page_categories(id) on delete cascade,
    item_id bigint not null unique references items(id) on delete cascade,
    item_order integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists front_page_category_items_item_id_idx
on front_page_category_items (item_id);

create index if not exists front_page_category_items_category_order_idx
on front_page_category_items (front_page_category_id, item_order);

create table if not exists item_contributors (
    item_id bigint not null references items(id) on delete cascade,
    contributor_id bigint not null references contributors(id) on delete cascade,
    contribution_role text not null check (contribution_role in ('designer', 'artist')),
    primary key (item_id, contributor_id, contribution_role)
);

create table if not exists item_relationships (
    id bigserial primary key,
    item_a_id bigint not null references items(id) on delete cascade,
    link_type text not null,
    item_b_id bigint not null references items(id) on delete cascade,
    source text not null default '',
    source_ref text not null default '',
    created_at timestamptz not null default now(),
    unique (item_a_id, link_type, item_b_id)
);

create or replace view active_item as
select
    i.*,
    exists (
        select 1
        from store_items si
        where si.item_id = i.id
          and si.is_boardgame = true
          and si.is_boardgame_confirmed = true
          and si.listing_status = 'LISTED'
    ) as has_approved_listing,
    exists (
        select 1
        from item_relationships ir
        where (ir.link_type = 'extension' and ir.item_a_id = i.id)
           or (ir.link_type = 'expansion' and ir.item_b_id = i.id)
    ) as is_expansion
from items i
where exists (
    select 1
    from store_items si
    where si.item_id = i.id
      and si.is_boardgame = true
      and si.is_boardgame_confirmed = true
);

create table if not exists item_themes (
    item_id bigint not null references items(id) on delete cascade,
    theme text not null,
    primary key (item_id, theme)
);

drop table if exists bgg_item_snapshots;

do $$
begin
    if to_regclass('bgg_search_cache') is not null and not exists (
        select 1
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'bgg_search_cache'
          and column_name = 'bgg_id'
    ) then
        drop table if exists bgg_search_query_results;
        drop table if exists bgg_search_queries;
        drop table if exists bgg_search_cache;
    end if;
end $$;

create table if not exists bgg_search_cache (
    id bigserial primary key,
    bgg_id bigint not null unique,
    name text not null,
    item_type text not null default '',
    year_published integer,
    result_json jsonb not null default '{}'::jsonb,
    first_seen_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists bgg_thing_cache (
    id bigserial primary key,
    bgg_id bigint not null,
    request_type text not null default 'boardgame,boardgameexpansion',
    raw_xml text not null,
    parsed_json jsonb not null default '{}'::jsonb,
    name text not null default '',
    item_type text not null default '',
    year_published integer,
    fetched_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (bgg_id, request_type)
);

create index if not exists bgg_thing_cache_bgg_id_idx
on bgg_thing_cache (bgg_id);

create table if not exists bgg_search_queries (
    id bigserial primary key,
    query text not null,
    normalized_query text not null,
    search_type text not null default 'boardgame,boardgameexpansion',
    result_count integer not null default 0,
    fetched_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (normalized_query, search_type)
);

create table if not exists bgg_search_query_results (
    query_id bigint not null references bgg_search_queries(id) on delete cascade,
    cache_id bigint not null references bgg_search_cache(id) on delete cascade,
    result_rank integer not null default 0,
    primary key (query_id, cache_id)
);

create index if not exists bgg_search_queries_normalized_query_idx
on bgg_search_queries (normalized_query);

create index if not exists bgg_search_query_results_query_rank_idx
on bgg_search_query_results (query_id, result_rank);
