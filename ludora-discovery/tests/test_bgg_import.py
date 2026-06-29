import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.bgg import BggLink, BggThing
from ludora.item_import import BggItemImporter, normalize_title


class FakeBggClient:
    def __init__(self, things):
        self.things = things
        self.fetched_ids = []

    def fetch_thing(self, bgg_id):
        self.fetched_ids.append(bgg_id)
        return self.things.get(bgg_id)


class FakeCursor:
    def __init__(self):
        self.executions = []
        self.fetchone_result = None
        self.next_id = 100
        self.items_by_bgg = {}
        self.lookups = {
            "boardgame_categories": {},
            "boardgame_mechanics": {},
            "boardgame_families": {},
            "contributors": {},
            "publishers": {},
        }
        self.relationships = []
        self.aliases = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=()):
        self.executions.append((sql, params))
        normalized_sql = " ".join(sql.casefold().split())
        self.fetchone_result = None

        if "select id from items where bgg_id = %s" in normalized_sql:
            self.fetchone_result = self.items_by_bgg.get(params[0])
            return

        if "insert into items" in normalized_sql and "returning id" in normalized_sql:
            item_id = self._allocate_id()
            self.items_by_bgg[params[4]] = (item_id,)
            self.fetchone_result = (item_id,)
            return

        if "select id from" in normalized_sql:
            table = self._lookup_table(normalized_sql)
            if table:
                self.fetchone_result = self.lookups[table].get(params[0])
            return

        if "insert into boardgame_categories" in normalized_sql:
            self._insert_lookup("boardgame_categories", params[0])
            return
        if "insert into boardgame_mechanics" in normalized_sql:
            self._insert_lookup("boardgame_mechanics", params[0])
            return
        if "insert into boardgame_families" in normalized_sql:
            self._insert_lookup("boardgame_families", params[0])
            return
        if "insert into contributors" in normalized_sql:
            self._insert_lookup("contributors", params[0])
            return
        if "insert into publishers" in normalized_sql:
            self._insert_lookup("publishers", params[2] or params[0])
            return
        if "insert into item_aliases" in normalized_sql:
            self.aliases.append(params)
            return
        if "insert into item_relationships" in normalized_sql:
            self.relationships.append(params)
            return

    def fetchone(self):
        return self.fetchone_result

    def _allocate_id(self):
        self.next_id += 1
        return self.next_id

    def _lookup_table(self, normalized_sql):
        for table in self.lookups:
            if f"from {table}" in normalized_sql:
                return table
        return None

    def _insert_lookup(self, table, bgg_id):
        lookup_id = self._allocate_id()
        self.lookups[table][bgg_id] = (lookup_id,)
        self.fetchone_result = (lookup_id,)


class FakeConnection:
    def __init__(self):
        self.cursor_instance = FakeCursor()
        self.commits = 0

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.commits += 1


class BggImportTests(unittest.TestCase):
    def test_normalize_title_removes_accents_and_symbols(self):
        self.assertEqual(normalize_title("Café Barista: Edición México"), "cafe barista edicion mexico")

    def test_imports_bgg_item_metadata_and_parent_relationship(self):
        parent = BggThing(
            bgg_id=13,
            item_type="boardgame",
            name="Catan",
            alternate_names=["Los Colonos de Catan"],
            publishers=[BggLink(bgg_id=2366, name="Devir", link_type="boardgamepublisher")],
        )
        expansion = BggThing(
            bgg_id=34691,
            item_type="boardgameexpansion",
            name="Catan: 5-6 Player Extension",
            alternate_names=["Catan: Extension 5-6 Jugadores"],
            description="Adds support for more players.",
            min_players=5,
            max_players=6,
            categories=[BggLink(bgg_id=1042, name="Expansion for Base-game", link_type="boardgamecategory")],
            mechanics=[BggLink(bgg_id=2008, name="Trading", link_type="boardgamemechanic")],
            families=[BggLink(bgg_id=3, name="Game: Catan", link_type="boardgamefamily")],
            designers=[BggLink(bgg_id=11, name="Klaus Teuber", link_type="boardgamedesigner")],
            artists=[BggLink(bgg_id=12036, name="Volkan Baga", link_type="boardgameartist")],
            publishers=[BggLink(bgg_id=2366, name="Devir", link_type="boardgamepublisher")],
            parent_links=[BggLink(bgg_id=13, name="Catan", link_type="boardgameexpansion", inbound=True)],
        )
        connection = FakeConnection()
        importer = BggItemImporter(connection, bgg_client=FakeBggClient({13: (parent, "<parent />")}))

        item_id = importer.import_thing(expansion, "<expansion />")

        self.assertIsInstance(item_id, int)
        self.assertIn(34691, connection.cursor_instance.items_by_bgg)
        self.assertIn(13, connection.cursor_instance.items_by_bgg)
        self.assertTrue(any(alias[1] == "Catan: Extension 5-6 Jugadores" for alias in connection.cursor_instance.aliases))
        self.assertTrue(
            any(
                relationship[0] == item_id and relationship[1] == "extension"
                for relationship in connection.cursor_instance.relationships
            )
        )
        self.assertFalse(
            any("bgg_item_snapshots" in sql.casefold() for sql, _params in connection.cursor_instance.executions)
        )
        self.assertGreaterEqual(connection.commits, 1)

    def test_imports_implementation_relationships_using_bgg_inbound_direction(self):
        lancashire = BggThing(
            bgg_id=28720,
            item_type="boardgame",
            name="Brass: Lancashire",
        )
        pittsburgh = BggThing(
            bgg_id=452264,
            item_type="boardgame",
            name="Brass: Pittsburgh",
        )
        birmingham = BggThing(
            bgg_id=224517,
            item_type="boardgame",
            name="Brass: Birmingham",
            implementation_links=[
                BggLink(bgg_id=452264, name="Brass: Pittsburgh", link_type="boardgameimplementation"),
                BggLink(bgg_id=28720, name="Brass: Lancashire", link_type="boardgameimplementation", inbound=True),
            ],
        )
        connection = FakeConnection()
        importer = BggItemImporter(
            connection,
            bgg_client=FakeBggClient(
                {
                    28720: (lancashire, "<lancashire />"),
                    452264: (pittsburgh, "<pittsburgh />"),
                }
            ),
        )

        birmingham_id = importer.import_thing(birmingham, "<birmingham />")
        lancashire_id = connection.cursor_instance.items_by_bgg[28720][0]
        pittsburgh_id = connection.cursor_instance.items_by_bgg[452264][0]

        self.assertIn((birmingham_id, "implementation", lancashire_id, "28720"), connection.cursor_instance.relationships)
        self.assertIn((pittsburgh_id, "implementation", birmingham_id, "452264"), connection.cursor_instance.relationships)


if __name__ == "__main__":
    unittest.main()
