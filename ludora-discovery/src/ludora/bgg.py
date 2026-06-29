from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from xml.etree import ElementTree


@dataclass(frozen=True)
class BggSearchResult:
    bgg_id: int
    name: str
    item_type: str
    year_published: int | None = None


@dataclass(frozen=True)
class BggLink:
    bgg_id: int
    name: str
    link_type: str = ""
    inbound: bool = False


@dataclass(frozen=True)
class BggThing:
    bgg_id: int
    item_type: str
    name: str
    alternate_names: list[str] = field(default_factory=list)
    description: str = ""
    year_published: int | None = None
    min_players: int | None = None
    max_players: int | None = None
    playing_time: int | None = None
    min_playtime: int | None = None
    max_playtime: int | None = None
    min_age: int | None = None
    thumbnail: str = ""
    image: str = ""
    categories: list[BggLink] = field(default_factory=list)
    mechanics: list[BggLink] = field(default_factory=list)
    families: list[BggLink] = field(default_factory=list)
    designers: list[BggLink] = field(default_factory=list)
    artists: list[BggLink] = field(default_factory=list)
    publishers: list[BggLink] = field(default_factory=list)
    parent_links: list[BggLink] = field(default_factory=list)
    implementation_links: list[BggLink] = field(default_factory=list)


class BggClient:
    def __init__(self, api_token: str, base_url: str = "https://boardgamegeek.com/xmlapi2") -> None:
        self.api_token = api_token
        self.base_url = base_url.rstrip("/")

    def search(self, query: str) -> list[BggSearchResult]:
        xml = self._get_xml("search", {"query": query, "type": "boardgame,boardgameexpansion"})
        return parse_bgg_search_response(xml)

    def fetch_thing(self, bgg_id: int) -> tuple[BggThing | None, str]:
        xml = self._get_xml("thing", {"id": str(bgg_id), "type": "boardgame,boardgameexpansion"})
        return parse_bgg_thing_response(xml), xml

    def _get_xml(self, path: str, params: dict[str, str]) -> str:
        url = f"{self.base_url}/{path}?{urlencode(params)}"
        request = Request(
            url,
            headers={
                "Accept": "application/xml,text/xml",
                "Authorization": f"Bearer {self.api_token}",
                "User-Agent": "LudoraDiscovery/0.1",
            },
        )
        with urlopen(request, timeout=30) as response:
            return response.read().decode(response.headers.get_content_charset() or "utf-8", errors="replace")


def parse_bgg_search_response(xml: str) -> list[BggSearchResult]:
    root = ElementTree.fromstring(xml)
    results: list[BggSearchResult] = []
    for item in root.findall("item"):
        results.append(
            BggSearchResult(
                bgg_id=_int_attr(item, "id") or 0,
                item_type=item.attrib.get("type", "").strip(),
                name=_primary_name(item),
                year_published=_value_int(item, "yearpublished"),
            )
        )
    return [result for result in results if result.bgg_id and result.name]


def parse_bgg_thing_response(xml: str) -> BggThing | None:
    root = ElementTree.fromstring(xml)
    item = root.find("item")
    if item is None:
        return None

    links = [_link_from_element(link) for link in item.findall("link")]
    return BggThing(
        bgg_id=_int_attr(item, "id") or 0,
        item_type=item.attrib.get("type", "").strip(),
        name=_primary_name(item),
        alternate_names=[
            name.attrib.get("value", "").strip()
            for name in item.findall("name")
            if name.attrib.get("type") == "alternate" and name.attrib.get("value", "").strip()
        ],
        description=_element_text(item, "description"),
        year_published=_value_int(item, "yearpublished"),
        min_players=_value_int(item, "minplayers"),
        max_players=_value_int(item, "maxplayers"),
        playing_time=_value_int(item, "playingtime"),
        min_playtime=_value_int(item, "minplaytime"),
        max_playtime=_value_int(item, "maxplaytime"),
        min_age=_value_int(item, "minage"),
        thumbnail=_element_text(item, "thumbnail"),
        image=_element_text(item, "image"),
        categories=_links_by_type(links, "boardgamecategory"),
        mechanics=_links_by_type(links, "boardgamemechanic"),
        families=_links_by_type(links, "boardgamefamily"),
        designers=_links_by_type(links, "boardgamedesigner"),
        artists=_links_by_type(links, "boardgameartist"),
        publishers=_links_by_type(links, "boardgamepublisher"),
        parent_links=[link for link in _links_by_type(links, "boardgameexpansion") if link.inbound],
        implementation_links=_links_by_type(links, "boardgameimplementation"),
    )


def _link_from_element(element: ElementTree.Element) -> BggLink:
    return BggLink(
        bgg_id=_int_attr(element, "id") or 0,
        link_type=element.attrib.get("type", "").strip(),
        name=element.attrib.get("value", "").strip(),
        inbound=element.attrib.get("inbound", "").casefold() == "true",
    )


def _links_by_type(links: list[BggLink], link_type: str) -> list[BggLink]:
    return [link for link in links if link.link_type == link_type and link.bgg_id and link.name]


def _primary_name(item: ElementTree.Element) -> str:
    names = item.findall("name")
    primary = next((name for name in names if name.attrib.get("type") == "primary"), None)
    selected = primary if primary is not None else (names[0] if names else None)
    return selected.attrib.get("value", "").strip() if selected is not None else ""


def _element_text(item: ElementTree.Element, tag: str) -> str:
    element = item.find(tag)
    return (element.text or "").strip() if element is not None else ""


def _value_int(item: ElementTree.Element, tag: str) -> int | None:
    element = item.find(tag)
    if element is None:
        return None
    return _int_value(element.attrib.get("value"))


def _int_attr(item: ElementTree.Element, key: str) -> int | None:
    return _int_value(item.attrib.get(key))


def _int_value(value: str | None) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except ValueError:
        return None
