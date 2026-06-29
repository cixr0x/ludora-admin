import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.bgg import parse_bgg_search_response, parse_bgg_thing_response


class BggParserTests(unittest.TestCase):
    def test_parse_search_response(self):
        xml = """
        <items>
          <item type="boardgame" id="13">
            <name type="primary" value="Catan" />
            <yearpublished value="1995" />
          </item>
        </items>
        """

        results = parse_bgg_search_response(xml)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].bgg_id, 13)
        self.assertEqual(results[0].name, "Catan")
        self.assertEqual(results[0].item_type, "boardgame")
        self.assertEqual(results[0].year_published, 1995)

    def test_parse_thing_response_with_metadata_and_parent_link(self):
        xml = """
        <items>
          <item type="boardgameexpansion" id="34691">
            <thumbnail>https://example.test/thumb.jpg</thumbnail>
            <image>https://example.test/image.jpg</image>
            <name type="primary" value="Catan: Traders &amp; Barbarians – 5-6 Player Expansion" />
            <name type="alternate" value="Los Colonos de Catán: Mercaderes y Bárbaros – Expansión 5-6 Jugadores" />
            <description>Expansion description</description>
            <yearpublished value="2008" />
            <minplayers value="5" />
            <maxplayers value="6" />
            <playingtime value="90" />
            <minplaytime value="90" />
            <maxplaytime value="90" />
            <minage value="12" />
            <link type="boardgamecategory" id="1042" value="Expansion for Base-game" />
            <link type="boardgamemechanic" id="2008" value="Trading" />
            <link type="boardgamefamily" id="3" value="Game: Catan" />
            <link type="boardgamedesigner" id="11" value="Klaus Teuber" />
            <link type="boardgameartist" id="12036" value="Volkan Baga" />
            <link type="boardgamepublisher" id="2366" value="Devir" />
            <link type="boardgameexpansion" id="13" value="Catan" inbound="true" />
          </item>
        </items>
        """

        thing = parse_bgg_thing_response(xml)

        self.assertIsNotNone(thing)
        assert thing is not None
        self.assertEqual(thing.bgg_id, 34691)
        self.assertEqual(thing.item_type, "boardgameexpansion")
        self.assertEqual(thing.name, "Catan: Traders & Barbarians – 5-6 Player Expansion")
        self.assertEqual(thing.alternate_names, ["Los Colonos de Catán: Mercaderes y Bárbaros – Expansión 5-6 Jugadores"])
        self.assertEqual(thing.categories[0].name, "Expansion for Base-game")
        self.assertEqual(thing.mechanics[0].bgg_id, 2008)
        self.assertEqual(thing.designers[0].name, "Klaus Teuber")
        self.assertEqual(thing.publishers[0].name, "Devir")
        self.assertEqual(thing.parent_links[0].bgg_id, 13)


if __name__ == "__main__":
    unittest.main()
