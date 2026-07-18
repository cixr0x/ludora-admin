from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from ludora.models import DiscoveryItemCandidateRecord, StoreRecord


def connect_database(database_url: str):
    import psycopg

    normalized_url, connect_kwargs = _psycopg_connection_args(database_url)
    return psycopg.connect(normalized_url, **connect_kwargs)


def _psycopg_connection_args(database_url: str) -> tuple[str, dict[str, str]]:
    normalized_url = _normalize_url_sslmode(database_url)
    if _url_has_sslmode(normalized_url):
        return normalized_url, {}
    if os.environ.get("PGSSLMODE", "").strip().casefold() == "no-verify":
        return normalized_url, {"sslmode": "require"}
    return normalized_url, {}


def _normalize_url_sslmode(database_url: str) -> str:
    parsed = urlparse(database_url)
    query_pairs = parse_qsl(parsed.query, keep_blank_values=True)
    if not query_pairs:
        return database_url

    changed = False
    normalized_pairs: list[tuple[str, str]] = []
    for key, value in query_pairs:
        if key.casefold() == "sslmode" and value.strip().casefold() == "no-verify":
            normalized_pairs.append((key, "require"))
            changed = True
        else:
            normalized_pairs.append((key, value))
    if not changed:
        return database_url
    return urlunparse(parsed._replace(query=urlencode(normalized_pairs)))


def _url_has_sslmode(database_url: str) -> bool:
    parsed = urlparse(database_url)
    return any(key.casefold() == "sslmode" for key, _value in parse_qsl(parsed.query, keep_blank_values=True))


@dataclass(frozen=True)
class ItemCandidateUpsertResult:
    candidate_id: int
    listing_status: str
    item_id: int | None
    should_process: bool
    created: bool = False
    changed: bool = False


@dataclass(frozen=True)
class ItemSearchEmbeddingSource:
    item_id: int
    canonical_name: str
    canonical_name_es: str
    description: str
    description_es: str
    min_players: int | None = None
    max_players: int | None = None
    min_minutes: int | None = None
    max_minutes: int | None = None
    complexity: float | None = None
    min_age: int | None = None
    categories: list[str] = field(default_factory=list)
    categories_es: list[str] = field(default_factory=list)
    mechanics: list[str] = field(default_factory=list)
    mechanics_es: list[str] = field(default_factory=list)
    families: list[str] = field(default_factory=list)
    families_es: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class TutorialLinkUpsertResult:
    tutorial_link_id: int
    action: str


@dataclass(frozen=True)
class StoreItemDiscoverySource:
    store_id: int
    store_name: str
    website_url: str
    platform: str


STORE_ITEM_PRICE_AVAILABILITY_REFRESH_FIELDS = (
    "title",
    "raw_price",
    "price",
    "price_source",
    "currency",
    "availability",
    "availability_source",
)


class DiscoveryRepository:
    def __init__(self, connection: Any):
        self.connection = connection

    def upsert_store_candidate(self, record: StoreRecord) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                insert into discovery_store_candidates (
                    store_name,
                    canonical_domain,
                    website_url,
                    instagram_url,
                    facebook_url,
                    city,
                    state,
                    country,
                    store_logo,
                    status,
                    confidence,
                    source_queries,
                    evidence,
                    last_seen_at
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, now())
                on conflict (canonical_domain) do update set
                    store_name = excluded.store_name,
                    website_url = excluded.website_url,
                    instagram_url = excluded.instagram_url,
                    facebook_url = excluded.facebook_url,
                    city = excluded.city,
                    state = excluded.state,
                    country = excluded.country,
                    store_logo = excluded.store_logo,
                    status = excluded.status,
                    confidence = excluded.confidence,
                    source_queries = excluded.source_queries,
                    evidence = excluded.evidence,
                    last_seen_at = now()
                """,
                (
                    record.store_name,
                    record.canonical_domain,
                    record.website_url,
                    record.instagram_url,
                    record.facebook_url,
                    record.city,
                    record.state,
                    record.country,
                    record.store_logo,
                    record.status,
                    record.confidence,
                    json.dumps(record.source_queries, ensure_ascii=False),
                    json.dumps(record.evidence, ensure_ascii=False),
                ),
            )
        self.connection.commit()

    def start_store_item_discovery_log(
        self,
        *,
        run_id: str,
        store_id: int,
        website_url: str,
        started_at: datetime,
    ) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                insert into job_store_item_discovery_log (
                    run_id,
                    store_id,
                    website_url,
                    status,
                    error,
                    started_at,
                    completed_at,
                    new_items
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (run_id, store_id, website_url, "running", "", started_at, None, 0),
            )
        self.connection.commit()

    def complete_store_item_discovery_log(
        self,
        *,
        run_id: str,
        status: str,
        completed_at: datetime,
        new_items: int,
        error: str = "",
    ) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                update job_store_item_discovery_log
                set status = %s,
                    error = %s,
                    completed_at = %s,
                    new_items = %s,
                    updated_at = now()
                where run_id = %s
                """,
                (status, error, completed_at, new_items, run_id),
            )
        self.connection.commit()

    def list_store_item_discovery_sources(self, *, store_ids: list[int] | None = None) -> list[StoreItemDiscoverySource]:
        sql = """
            select id, name, website_url, platform
            from stores
        """
        params: list[int] = []
        if store_ids:
            placeholders = ", ".join(["%s"] * len(store_ids))
            sql += f"\n            where id in ({placeholders})"
            params.extend(store_ids)
        sql += "\n            order by canonical_domain asc"

        with self.connection.cursor() as cursor:
            cursor.execute(sql, params)
            rows = cursor.fetchall()

        return [
            StoreItemDiscoverySource(
                store_id=int(row[0]),
                store_name=_text(row[1]),
                website_url=_text(row[2]),
                platform=_text(row[3]),
            )
            for row in rows
        ]

    def start_store_item_update_log(self, *, run_id: str, store_id: int | None = None) -> int:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                insert into job_store_item_update_log (
                    run_id,
                    store_id,
                    status,
                    error,
                    completed_at,
                    scanned_items,
                    updated_items
                )
                values (%s, %s, %s, %s, %s, %s, %s)
                returning id
                """,
                (run_id, store_id, "running", "", None, 0, 0),
            )
            row = cursor.fetchone()
        self.connection.commit()
        return int(row[0]) if row else 0

    def complete_store_item_update_log(
        self,
        *,
        job_id: int,
        status: str,
        completed_at: datetime,
        scanned_items: int,
        updated_items: int,
        error: str = "",
    ) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                update job_store_item_update_log
                set status = %s,
                    error = %s,
                    completed_at = %s,
                    scanned_items = %s,
                    updated_items = %s,
                    updated_at = now()
                where id = %s
                """,
                (status, error, completed_at, scanned_items, updated_items, job_id),
            )
        self.connection.commit()

    def upsert_item_candidate(self, record: DiscoveryItemCandidateRecord) -> ItemCandidateUpsertResult:
        data = record.to_db_dict()
        with self.connection.cursor() as cursor:
            existing = self._find_item_candidate(cursor, record)
            if existing:
                item_id = _optional_int(existing[2])
                data["listing_status"] = str(existing[1])
                data["item_id"] = item_id
                cursor.execute(
                    _update_item_candidate_sql(),
                    (
                        *self._item_candidate_write_params(data),
                        existing[0],
                    ),
                )
                result = ItemCandidateUpsertResult(
                    candidate_id=int(existing[0]),
                    listing_status=str(existing[1]),
                    item_id=item_id,
                    should_process=item_id is None and not existing[3] and existing[4] is None,
                    created=False,
                )
            else:
                cursor.execute(_insert_item_candidate_sql(), self._item_candidate_write_params(data))
                row = cursor.fetchone()
                result = ItemCandidateUpsertResult(
                    candidate_id=int(row[0]) if row else 0,
                    listing_status=str(row[1]) if row else str(data["listing_status"]),
                    item_id=_optional_int(row[2]) if row else _optional_int(data["item_id"]),
                    should_process=True,
                    created=True,
                )
        self.connection.commit()
        return result

    def update_item_candidate_with_change_log(
        self,
        existing_record: DiscoveryItemCandidateRecord,
        refreshed_record: DiscoveryItemCandidateRecord,
        *,
        job_id: int,
        run_id: str,
        include_title: bool = True,
    ) -> ItemCandidateUpsertResult:
        store_item_id = existing_record.store_item_id or refreshed_record.store_item_id
        if store_item_id is None:
            raise ValueError("store item id is required to log update changes")

        refreshed_record.store_item_id = store_item_id
        data = refreshed_record.to_db_dict()
        changes = _item_update_changes(existing_record, refreshed_record, include_title=include_title)

        with self.connection.cursor() as cursor:
            cursor.execute(
                _update_item_candidate_price_availability_sql(include_title=include_title),
                (
                    *self._item_candidate_price_availability_params(data, include_title=include_title),
                    store_item_id,
                ),
            )
            for field_name, old_value, new_value in changes:
                cursor.execute(
                    """
                    insert into store_item_update_change_log (
                        job_id,
                        run_id,
                        store_item_id,
                        field_name,
                        old_value,
                        new_value
                    )
                    values (%s, %s, %s, %s, %s::jsonb, %s::jsonb)
                    """,
                    (
                        job_id,
                        run_id,
                        store_item_id,
                        field_name,
                        _jsonb_log_value(old_value),
                        _jsonb_log_value(new_value),
                    ),
                )
        self.connection.commit()
        return ItemCandidateUpsertResult(
            candidate_id=store_item_id,
            listing_status=refreshed_record.listing_status,
            item_id=refreshed_record.item_id,
            should_process=False,
            created=False,
            changed=bool(changes),
        )

    def update_item_candidate_price_availability(
        self,
        existing_record: DiscoveryItemCandidateRecord,
        refreshed_record: DiscoveryItemCandidateRecord,
        *,
        include_title: bool = True,
    ) -> ItemCandidateUpsertResult:
        store_item_id = existing_record.store_item_id or refreshed_record.store_item_id
        if store_item_id is None:
            raise ValueError("store item id is required to update price and availability")

        refreshed_record.store_item_id = store_item_id
        data = refreshed_record.to_db_dict()
        changes = _item_update_changes(existing_record, refreshed_record, include_title=include_title)

        with self.connection.cursor() as cursor:
            cursor.execute(
                _update_item_candidate_price_availability_sql(include_title=include_title),
                (
                    *self._item_candidate_price_availability_params(data, include_title=include_title),
                    store_item_id,
                ),
            )
        self.connection.commit()
        return ItemCandidateUpsertResult(
            candidate_id=store_item_id,
            listing_status=refreshed_record.listing_status,
            item_id=refreshed_record.item_id,
            should_process=False,
            created=False,
            changed=bool(changes),
        )

    def mark_item_candidate_inactive(
        self,
        existing_record: DiscoveryItemCandidateRecord,
        *,
        job_id: int | None = None,
        run_id: str | None = None,
    ) -> ItemCandidateUpsertResult:
        store_item_id = existing_record.store_item_id
        if store_item_id is None:
            raise ValueError("store item id is required to mark it inactive")
        if run_id is not None and job_id is None:
            raise ValueError("job id is required to log update changes")

        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                update store_items
                set store_active = false,
                    refreshed_date = now()
                where id = %s
                  and store_active = true
                returning id
                """,
                (store_item_id,),
            )
            changed = cursor.fetchone() is not None
            if changed and run_id is not None:
                cursor.execute(
                    """
                    insert into store_item_update_change_log (
                        job_id,
                        run_id,
                        store_item_id,
                        field_name,
                        old_value,
                        new_value
                    )
                    values (%s, %s, %s, %s, %s::jsonb, %s::jsonb)
                    """,
                    (
                        job_id,
                        run_id,
                        store_item_id,
                        "store_active",
                        _jsonb_log_value(True),
                        _jsonb_log_value(False),
                    ),
                )
        self.connection.commit()
        existing_record.store_active = False
        return ItemCandidateUpsertResult(
            candidate_id=store_item_id,
            listing_status=existing_record.listing_status,
            item_id=existing_record.item_id,
            should_process=False,
            created=False,
            changed=changed,
        )

    def _find_item_candidate(self, cursor: Any, record: DiscoveryItemCandidateRecord):
        cursor.execute(
            """
            select id, listing_status, item_id, match_source, processed_at
            from store_items
            where store_id is not distinct from %s
              and source_url = %s
            """,
            (record.store_id, record.source_url),
        )
        return cursor.fetchone()

    def item_candidate_exists(self, store_id: int | None, source_url: str) -> bool:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                select 1
                from store_items
                where store_id is not distinct from %s
                  and source_url = %s
                limit 1
                """,
                (store_id, source_url),
            )
            return cursor.fetchone() is not None

    def upsert_tutorial_link(
        self,
        *,
        item_id: int,
        url: str,
        title: str,
        language: str = "es",
        source: str = "tiktok",
        status: str = "candidate",
    ) -> TutorialLinkUpsertResult:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                select id
                from tutorial_links
                where item_id = %s
                  and url = %s
                limit 1
                """,
                (item_id, url),
            )
            existing = cursor.fetchone()
            if existing:
                cursor.execute(
                    """
                    update tutorial_links
                    set title = %s,
                        language = %s,
                        source = %s,
                        status = %s
                    where id = %s
                    returning id
                    """,
                    (title, language, source, status, existing[0]),
                )
                row = cursor.fetchone()
                result = TutorialLinkUpsertResult(
                    tutorial_link_id=int(row[0]) if row else int(existing[0]),
                    action="updated",
                )
            else:
                cursor.execute(
                    """
                    insert into tutorial_links (
                        item_id,
                        url,
                        title,
                        language,
                        source,
                        status
                    )
                    values (%s, %s, %s, %s, %s, %s)
                    returning id
                    """,
                    (item_id, url, title, language, source, status),
                )
                row = cursor.fetchone()
                result = TutorialLinkUpsertResult(
                    tutorial_link_id=int(row[0]) if row else 0,
                    action="inserted",
                )
        self.connection.commit()
        return result

    def list_confirmed_boardgame_item_candidates(
        self,
        limit: int | None = None,
        store_ids: list[int] | None = None,
    ) -> list[DiscoveryItemCandidateRecord]:
        sql = f"""
            select {_item_candidate_select_columns()}
            from store_items
            where is_boardgame = true
              and is_boardgame_confirmed = true
              and item_id is not null
              and source_url <> ''
              and listing_status = 'LISTED'
              and store_active = true
        """
        params: list[object] = []
        if store_ids:
            placeholders = ", ".join(["%s"] * len(store_ids))
            sql += f"\n              and store_id in ({placeholders})"
            params.extend(store_ids)
        sql += "\n            order by refreshed_date asc nulls first, id asc"
        if limit is not None:
            sql += "\nlimit %s"
            params.append(limit)

        with self.connection.cursor() as cursor:
            cursor.execute(sql, tuple(params))
            return [_item_candidate_from_row(row) for row in cursor.fetchall()]

    def list_item_search_embedding_sources(self, *, refresh_mode: str = "missing") -> list[ItemSearchEmbeddingSource]:
        where_sql = "where ise.item_id is null" if refresh_mode == "missing" else ""
        sql = f"""
            select
              i.id,
              i.canonical_name,
              i.canonical_name_es,
              i.description,
              i.description_es,
              i.min_players,
              i.max_players,
              i.min_minutes,
              i.max_minutes,
              i.complexity,
              i.min_age,
              coalesce(categories.names, '{{}}'::text[]) as categories,
              coalesce(categories.names_es, '{{}}'::text[]) as categories_es,
              coalesce(mechanics.names, '{{}}'::text[]) as mechanics,
              coalesce(mechanics.names_es, '{{}}'::text[]) as mechanics_es,
              coalesce(families.names, '{{}}'::text[]) as families,
              coalesce(families.names_es, '{{}}'::text[]) as families_es
            from active_item i
            left join item_search_embeddings ise on ise.item_id = i.id
            left join lateral (
              select
                array_agg(bc.name order by bc.name) as names,
                array_agg(bc.name_es order by bc.name) filter (where bc.name_es <> '') as names_es
              from item_categories ic
              join boardgame_categories bc on bc.id = ic.category_id
              where ic.item_id = i.id
            ) categories on true
            left join lateral (
              select
                array_agg(bm.name order by bm.name) as names,
                array_agg(bm.name_es order by bm.name) filter (where bm.name_es <> '') as names_es
              from item_mechanics im
              join boardgame_mechanics bm on bm.id = im.mechanic_id
              where im.item_id = i.id
            ) mechanics on true
            left join lateral (
              select
                array_agg(bf.name order by bf.name) as names,
                array_agg(bf.name_es order by bf.name) filter (where bf.name_es <> '') as names_es
              from item_families ifa
              join boardgame_families bf on bf.id = ifa.family_id
              where ifa.item_id = i.id
            ) families on true
            {where_sql}
            order by i.id asc
        """

        with self.connection.cursor() as cursor:
            cursor.execute(sql, ())
            return [
                ItemSearchEmbeddingSource(
                    item_id=int(row[0]),
                    canonical_name=_text(row[1]),
                    canonical_name_es=_text(row[2]),
                    description=_text(row[3]),
                    description_es=_text(row[4]),
                    min_players=_optional_int(row[5]),
                    max_players=_optional_int(row[6]),
                    min_minutes=_optional_int(row[7]),
                    max_minutes=_optional_int(row[8]),
                    complexity=_optional_float(row[9]),
                    min_age=_optional_int(row[10]),
                    categories=_string_list(row[11]),
                    categories_es=_string_list(row[12]),
                    mechanics=_string_list(row[13]),
                    mechanics_es=_string_list(row[14]),
                    families=_string_list(row[15]),
                    families_es=_string_list(row[16]),
                )
                for row in cursor.fetchall()
            ]

    def upsert_item_search_embedding(
        self,
        *,
        item_id: int,
        embedding: list[float],
        source_text: str,
        source_hash: str,
        model: str,
    ) -> None:
        embedding_dimensions = len(embedding)
        embedding_literal = _vector_literal(embedding)
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                insert into item_search_embeddings (
                    item_id,
                    embedding,
                    source_text,
                    source_hash,
                    model,
                    embedding_dimensions,
                    created_at,
                    updated_at
                )
                values (%s, %s::vector, %s, %s, %s, %s, now(), now())
                on conflict (item_id) do update set
                    embedding = excluded.embedding,
                    source_text = excluded.source_text,
                    source_hash = excluded.source_hash,
                    model = excluded.model,
                    embedding_dimensions = excluded.embedding_dimensions,
                    updated_at = now()
                """,
                (item_id, embedding_literal, source_text, source_hash, model, embedding_dimensions),
            )
        self.connection.commit()

    def _item_candidate_write_params(self, data: dict[str, object]) -> tuple[object, ...]:
        return (
            data["store_id"],
            data["source_url"],
            data["source_listing_url"],
            data["title"],
            data["publisher"],
            data["description"],
            data["item_id"],
            data["item_type"],
            data["min_players"],
            data["max_players"],
            data["min_minutes"],
            data["max_minutes"],
            data["min_age"],
            data["language"],
            data["language_source"],
            data["language_evidence"],
            data["image_url"],
            data["listing_status"],
            data["raw_price"],
            data["price"],
            data["price_source"],
            data["currency"],
            data["availability"],
            data["availability_source"],
            data["store_sku"],
            json.dumps(data["raw_payload"], ensure_ascii=False),
            data["is_boardgame"],
            data["is_boardgame_confirmed"],
            data["category_confidence"],
            json.dumps(data["classification_reasons"], ensure_ascii=False),
        )

    def _item_candidate_price_availability_params(
        self,
        data: dict[str, object],
        *,
        include_title: bool = True,
    ) -> tuple[object, ...]:
        return tuple(data[field_name] for field_name in _store_item_refresh_fields(include_title=include_title))

    def mark_item_candidate_not_boardgame(self, candidate_id: int, reasons: list[str]) -> None:
        self._mark_item_candidate_no_match(candidate_id, reasons)

    def mark_item_candidate_match_not_found(self, candidate_id: int, reasons: list[str]) -> None:
        self._mark_item_candidate_no_match(candidate_id, reasons)

    def mark_item_candidate_processing_error(self, candidate_id: int, error: str) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                update store_items
                set processing_error = %s,
                    processed_at = now(),
                    last_updated = now()
                where id = %s
                """,
                (error, candidate_id),
            )
        self.connection.commit()

    def _mark_item_candidate_no_match(self, candidate_id: int, reasons: list[str]) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                update store_items
                set match_source = 'NONE',
                    match_reasons = %s::jsonb,
                    match_payload = '{}'::jsonb,
                    processed_at = now(),
                    processing_error = '',
                    last_updated = now()
                where id = %s
                """,
                (json.dumps(reasons, ensure_ascii=False), candidate_id),
            )
        self.connection.commit()


def _insert_item_candidate_sql() -> str:
    return """
    insert into store_items (
        store_id,
        source_url,
        source_listing_url,
        title,
        publisher,
        description,
        item_id,
        item_type,
        min_players,
        max_players,
        min_minutes,
        max_minutes,
        min_age,
        language,
        language_source,
        language_evidence,
        image_url,
        listing_status,
        raw_price,
        price,
        price_source,
        currency,
        availability,
        availability_source,
        store_sku,
        raw_payload,
        is_boardgame,
        is_boardgame_confirmed,
        category_confidence,
        classification_reasons,
        last_seen_at,
        last_updated,
        refreshed_date
    )
    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s::jsonb, now(), now(), now())
    returning id, listing_status, item_id
    """


def _update_item_candidate_sql(*, refresh_from_source: bool = False) -> str:
    timestamp_sql = (
        """
        last_seen_at = now(),
        refreshed_date = now()
        """
        if refresh_from_source
        else """
        last_seen_at = now(),
        last_updated = now()
        """
    )
    return f"""
    update store_items
    set store_id = %s,
        source_url = %s,
        source_listing_url = %s,
        title = %s,
        publisher = %s,
        description = %s,
        item_id = %s,
        item_type = %s,
        min_players = %s,
        max_players = %s,
        min_minutes = %s,
        max_minutes = %s,
        min_age = %s,
        language = %s,
        language_source = %s,
        language_evidence = %s,
        image_url = %s,
        listing_status = %s,
        raw_price = %s,
        price = %s,
        price_source = %s,
        currency = %s,
        availability = %s,
        availability_source = %s,
        store_sku = %s,
        raw_payload = %s::jsonb,
        is_boardgame = %s,
        is_boardgame_confirmed = %s,
        category_confidence = %s,
        classification_reasons = %s::jsonb,
        {timestamp_sql.strip()}
    where id = %s
    """


def _update_item_candidate_price_availability_sql(*, include_title: bool = True) -> str:
    title_assignment = "title = %s,\n        " if include_title else ""
    return f"""
    update store_items
    set {title_assignment}raw_price = %s,
        price = %s,
        price_source = %s,
        currency = %s,
        availability = %s,
        availability_source = %s,
        last_seen_at = now(),
        refreshed_date = now()
    where id = %s
    """


def _item_candidate_select_columns() -> str:
    return """
        store_id,
        source_url,
        source_listing_url,
        title,
        publisher,
        description,
        item_id,
        item_type,
        min_players,
        max_players,
        min_minutes,
        max_minutes,
        min_age,
        language,
        language_source,
        language_evidence,
        image_url,
        listing_status,
        raw_price,
        price,
        price_source,
        currency,
        availability,
        availability_source,
        store_active,
        store_sku,
        raw_payload,
        is_boardgame,
        is_boardgame_confirmed,
        category_confidence,
        classification_reasons,
        match_source,
        matched_bgg_id,
        matched_name,
        match_score,
        match_reasons,
        match_payload,
        matched_at,
        processed_at,
        processing_error,
        id
    """


def _item_candidate_from_row(row: Any) -> DiscoveryItemCandidateRecord:
    return DiscoveryItemCandidateRecord(
        store_id=_optional_int(row[0]),
        source_url=_text(row[1]),
        source_listing_url=_text(row[2]),
        title=_text(row[3]),
        publisher=_text(row[4]),
        description=_text(row[5]),
        item_id=_optional_int(row[6]),
        item_type=_text(row[7]) or "unknown",
        min_players=_optional_int(row[8]),
        max_players=_optional_int(row[9]),
        min_minutes=_optional_int(row[10]),
        max_minutes=_optional_int(row[11]),
        min_age=_optional_int(row[12]),
        language=_text(row[13]),
        language_source=_text(row[14]),
        language_evidence=_text(row[15]),
        image_url=_text(row[16]),
        listing_status=_text(row[17]) or "PENDING",
        raw_price=_text(row[18]),
        price=_text(row[19]),
        price_source=_text(row[20]) or "none",
        currency=_text(row[21]) or "MXN",
        availability=_text(row[22]) or "unknown",
        availability_source=_text(row[23]) or "none",
        store_active=bool(row[24]),
        store_sku=_text(row[25]),
        raw_payload=_json_object(row[26]),
        is_boardgame=bool(row[27]),
        is_boardgame_confirmed=bool(row[28]),
        category_confidence=_optional_float(row[29]),
        classification_reasons=_json_list(row[30]),
        match_source=_text(row[31]),
        matched_bgg_id=_optional_int(row[32]),
        matched_name=_text(row[33]),
        match_score=_optional_float(row[34]),
        match_reasons=_json_list(row[35]),
        match_payload=_json_object(row[36]),
        matched_at=_text(row[37]) or None,
        processed_at=_text(row[38]) or None,
        processing_error=_text(row[39]),
        store_item_id=_optional_int(row[40]),
    )


def _item_update_changes(
    existing_record: DiscoveryItemCandidateRecord,
    refreshed_record: DiscoveryItemCandidateRecord,
    *,
    include_title: bool = True,
) -> list[tuple[str, object, object]]:
    existing_data = existing_record.to_db_dict()
    refreshed_data = refreshed_record.to_db_dict()
    changes: list[tuple[str, object, object]] = []
    for field_name in _store_item_refresh_fields(include_title=include_title):
        old_value = existing_data[field_name]
        new_value = refreshed_data[field_name]
        if not _item_update_values_equal(field_name, old_value, new_value):
            changes.append((field_name, old_value, new_value))
    return changes


def _store_item_refresh_fields(*, include_title: bool) -> tuple[str, ...]:
    if include_title:
        return STORE_ITEM_PRICE_AVAILABILITY_REFRESH_FIELDS
    return tuple(field_name for field_name in STORE_ITEM_PRICE_AVAILABILITY_REFRESH_FIELDS if field_name != "title")


def _item_update_values_equal(field_name: str, old_value: object, new_value: object) -> bool:
    if field_name == "price":
        return _price_values_equal(old_value, new_value)
    return old_value == new_value


def _price_values_equal(old_value: object, new_value: object) -> bool:
    old_price = _decimal_price(old_value)
    new_price = _decimal_price(new_value)
    if old_price is not None and new_price is not None:
        return old_price == new_price
    return old_value == new_value


def _decimal_price(value: object) -> Decimal | None:
    if value is None:
        return None
    text_value = str(value).strip()
    if not text_value:
        return None
    try:
        return Decimal(text_value)
    except (InvalidOperation, ValueError):
        return None


def _jsonb_log_value(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _optional_float(value: object) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


def _text(value: object) -> str:
    if value is None:
        return ""
    return str(value)


def _string_list(value: object) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [item for item in (_text(entry).strip() for entry in value) if item]


def _vector_literal(values: list[float]) -> str:
    return "[" + ",".join(str(value) for value in values) + "]"


def _json_object(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _json_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str) and value:
        parsed = json.loads(value)
        return [str(item) for item in parsed] if isinstance(parsed, list) else []
    return []
