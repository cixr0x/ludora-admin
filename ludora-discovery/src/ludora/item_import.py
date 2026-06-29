from __future__ import annotations

import unicodedata
from typing import Any

from ludora.bgg import BggLink, BggThing


def normalize_title(value: str) -> str:
    without_accents = unicodedata.normalize("NFD", value).encode("ascii", "ignore").decode("ascii")
    normalized = (
        without_accents.replace("&", " and ")
        .replace("'", " ")
        .replace('"', " ")
        .casefold()
        .translate(str.maketrans({char: " " for char in ":;,.!?/\\|()[]{}+-_"}))
    )
    return " ".join(normalized.split())


class BggItemImporter:
    def __init__(self, connection: Any, bgg_client: Any | None = None) -> None:
        self.connection = connection
        self.bgg_client = bgg_client

    def import_bgg_id(self, bgg_id: int) -> int | None:
        if not self.bgg_client:
            return None
        fetched = self.bgg_client.fetch_thing(bgg_id)
        if not fetched:
            return None
        thing, raw_xml = fetched
        return self.import_thing(thing, raw_xml)

    def import_thing(self, thing: BggThing, raw_xml: str = "", visited: set[int] | None = None) -> int:
        current_visited = visited if visited is not None else set()
        if thing.bgg_id in current_visited:
            existing_id = self._existing_item_id(thing.bgg_id)
            return existing_id or 0
        current_visited.add(thing.bgg_id)

        with self.connection.cursor() as cursor:
            item_id = self._upsert_item(cursor, thing)
            self._upsert_aliases(cursor, item_id, thing.alternate_names)
            self._upsert_taxonomy_links(cursor, item_id, "boardgame_categories", "item_categories", "category_id", thing.categories)
            self._upsert_taxonomy_links(cursor, item_id, "boardgame_mechanics", "item_mechanics", "mechanic_id", thing.mechanics)
            self._upsert_taxonomy_links(cursor, item_id, "boardgame_families", "item_families", "family_id", thing.families)
            self._upsert_contributors(cursor, item_id, thing.designers, "designer")
            self._upsert_contributors(cursor, item_id, thing.artists, "artist")
            self._upsert_publishers(cursor, item_id, thing.publishers)
        self.connection.commit()

        for parent_link in thing.parent_links:
            parent_id = self._import_linked_thing(parent_link, current_visited)
            if parent_id:
                with self.connection.cursor() as cursor:
                    self._upsert_item_relationship(cursor, item_id, "extension", parent_id, str(parent_link.bgg_id))
                    cursor.execute(
                        """
                        update items
                        set parent_item_id = %s,
                            updated_at = now()
                        where id = %s
                        """,
                        (parent_id, item_id),
                    )
                self.connection.commit()

        for implementation_link in thing.implementation_links:
            linked_id = self._import_linked_thing(implementation_link, current_visited)
            if linked_id:
                item_a_id, item_b_id = _bgg_relationship_item_ids(item_id, linked_id, implementation_link)
                with self.connection.cursor() as cursor:
                    self._upsert_item_relationship(cursor, item_a_id, "implementation", item_b_id, str(implementation_link.bgg_id))
                self.connection.commit()

        return item_id

    def _existing_item_id(self, bgg_id: int) -> int | None:
        with self.connection.cursor() as cursor:
            cursor.execute("select id from items where bgg_id = %s", (bgg_id,))
            row = cursor.fetchone()
        return int(row[0]) if row else None

    def _import_linked_thing(self, link: BggLink, visited: set[int]) -> int | None:
        if not self.bgg_client:
            return None
        fetched = self.bgg_client.fetch_thing(link.bgg_id)
        if not fetched:
            return None
        linked_thing, linked_xml = fetched
        return self.import_thing(linked_thing, linked_xml, visited)

    def _upsert_item(self, cursor: Any, thing: BggThing) -> int:
        cursor.execute("select id from items where bgg_id = %s", (thing.bgg_id,))
        existing = cursor.fetchone()
        item_type = _bgg_type_to_item_type(thing.item_type)
        params = (
            thing.name,
            normalize_title(thing.name),
            item_type,
            None,
            thing.bgg_id,
            _bgg_url(thing),
            thing.year_published,
            thing.description,
            thing.min_players,
            thing.max_players,
            thing.min_playtime or thing.playing_time,
            thing.max_playtime or thing.playing_time,
            thing.min_age,
            thing.image or thing.thumbnail,
        )
        if existing:
            cursor.execute(
                """
                update items
                set canonical_name = %s,
                    normalized_name = %s,
                    item_type = %s,
                    parent_item_id = coalesce(parent_item_id, %s),
                    bgg_id = %s,
                    bgg_url = %s,
                    bgg_last_sync_at = now(),
                    year_published = %s,
                    description = %s,
                    min_players = %s,
                    max_players = %s,
                    min_minutes = %s,
                    max_minutes = %s,
                    min_age = %s,
                    image_url = %s,
                    status = 'active',
                    updated_at = now()
                where id = %s
                """,
                (*params, existing[0]),
            )
            return int(existing[0])

        cursor.execute(
            """
            insert into items (
                canonical_name,
                normalized_name,
                item_type,
                parent_item_id,
                bgg_id,
                bgg_url,
                bgg_last_sync_at,
                year_published,
                description,
                min_players,
                max_players,
                min_minutes,
                max_minutes,
                min_age,
                image_url,
                status,
                updated_at
            )
            values (%s, %s, %s, %s, %s, %s, now(), %s, %s, %s, %s, %s, %s, %s, %s, 'active', now())
            returning id
            """,
            params,
        )
        row = cursor.fetchone()
        return int(row[0])

    def _upsert_aliases(self, cursor: Any, item_id: int, aliases: list[str]) -> None:
        for alias in _dedupe(aliases):
            cursor.execute(
                """
                insert into item_aliases (item_id, alias, normalized_alias, source)
                values (%s, %s, %s, 'BGG')
                on conflict (item_id, normalized_alias) do update set
                    alias = excluded.alias,
                    source = excluded.source
                """,
                (item_id, alias, normalize_title(alias)),
            )

    def _upsert_taxonomy_links(
        self,
        cursor: Any,
        item_id: int,
        lookup_table: str,
        relation_table: str,
        relation_id_column: str,
        links: list[BggLink],
    ) -> None:
        for link in links:
            lookup_id = self._upsert_lookup(cursor, lookup_table, link.bgg_id, link.name)
            cursor.execute(
                f"""
                insert into {relation_table} (item_id, {relation_id_column})
                values (%s, %s)
                on conflict do nothing
                """,
                (item_id, lookup_id),
            )

    def _upsert_lookup(self, cursor: Any, table: str, bgg_id: int, name: str) -> int:
        cursor.execute(f"select id from {table} where bgg_id = %s", (bgg_id,))
        existing = cursor.fetchone()
        if existing:
            cursor.execute(
                f"""
                update {table}
                set name = %s,
                    updated_at = now()
                where id = %s
                """,
                (name, existing[0]),
            )
            return int(existing[0])

        cursor.execute(
            f"""
            insert into {table} (bgg_id, name, updated_at)
            values (%s, %s, now())
            returning id
            """,
            (bgg_id, name),
        )
        row = cursor.fetchone()
        return int(row[0])

    def _upsert_contributors(self, cursor: Any, item_id: int, links: list[BggLink], role: str) -> None:
        for link in links:
            contributor_id = self._upsert_lookup(cursor, "contributors", link.bgg_id, link.name)
            cursor.execute(
                """
                insert into item_contributors (item_id, contributor_id, contribution_role)
                values (%s, %s, %s)
                on conflict do nothing
                """,
                (item_id, contributor_id, role),
            )

    def _upsert_publishers(self, cursor: Any, item_id: int, links: list[BggLink]) -> None:
        for link in links:
            publisher_id = self._upsert_publisher(cursor, link)
            cursor.execute(
                """
                insert into item_publishers (item_id, publisher_id)
                values (%s, %s)
                on conflict do nothing
                """,
                (item_id, publisher_id),
            )

    def _upsert_publisher(self, cursor: Any, link: BggLink) -> int:
        cursor.execute("select id from publishers where bgg_id = %s", (link.bgg_id,))
        existing = cursor.fetchone()
        normalized_name = normalize_title(link.name)
        if not existing:
            cursor.execute("select id from publishers where name = %s", (link.name,))
            existing = cursor.fetchone()
        if existing:
            cursor.execute(
                """
                update publishers
                set name = %s,
                    normalized_name = %s,
                    bgg_id = coalesce(bgg_id, %s),
                    updated_at = now()
                where id = %s
                """,
                (link.name, normalized_name, link.bgg_id, existing[0]),
            )
            return int(existing[0])

        cursor.execute(
            """
            insert into publishers (name, normalized_name, bgg_id, updated_at)
            values (%s, %s, %s, now())
            returning id
            """,
            (link.name, normalized_name, link.bgg_id),
        )
        row = cursor.fetchone()
        return int(row[0])

    def _upsert_item_relationship(self, cursor: Any, item_a_id: int, link_type: str, item_b_id: int, source_ref: str) -> None:
        cursor.execute(
            """
            with relationship_input as (
                select
                    %s::bigint as item_a_id,
                    %s::text as link_type,
                    %s::bigint as item_b_id,
                    %s::text as source_ref
            ),
            removed_inverse_relationship as (
                delete from item_relationships inverse_relationship
                using relationship_input
                where relationship_input.link_type in ('extension', 'implementation')
                  and inverse_relationship.link_type = relationship_input.link_type
                  and inverse_relationship.item_a_id = relationship_input.item_b_id
                  and inverse_relationship.item_b_id = relationship_input.item_a_id
                returning inverse_relationship.id
            )
            insert into item_relationships (item_a_id, link_type, item_b_id, source, source_ref)
            select relationship_input.item_a_id, relationship_input.link_type, relationship_input.item_b_id, 'BGG', relationship_input.source_ref
            from relationship_input
            cross join (select count(*) as deleted_count from removed_inverse_relationship) inverse_cleanup
            on conflict (item_a_id, link_type, item_b_id) do update set
                source = excluded.source,
                source_ref = excluded.source_ref
            """,
            (item_a_id, link_type, item_b_id, source_ref),
        )


def _bgg_type_to_item_type(value: str) -> str:
    if value == "boardgameexpansion":
        return "expansion"
    if value == "boardgame":
        return "base_game"
    return "base_game"


def _bgg_relationship_item_ids(current_item_id: int, linked_item_id: int, link: BggLink) -> tuple[int, int]:
    return (current_item_id, linked_item_id) if link.inbound else (linked_item_id, current_item_id)


def _bgg_url(thing: BggThing) -> str:
    path = "boardgameexpansion" if thing.item_type == "boardgameexpansion" else "boardgame"
    return f"https://boardgamegeek.com/{path}/{thing.bgg_id}"


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = normalize_title(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(value)
    return result
