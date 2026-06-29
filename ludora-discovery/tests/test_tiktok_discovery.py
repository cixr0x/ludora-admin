from __future__ import annotations

import unittest
from types import SimpleNamespace

from ludora.tiktok_discovery import (
    TikTokCandidate,
    TikTokDiscoveryResult,
    TikTokItem,
    build_search_query,
    parse_search_result_candidate,
    rank_candidates,
    search_extraction_needs_retry,
    tiktok_video_identity_from_url,
    write_top_tiktok_candidates_to_database,
)


class TikTokDiscoveryTests(unittest.TestCase):
    def test_build_search_query_prefers_spanish_name_and_keeps_canonical_name(self) -> None:
        item = TikTokItem(id="1462", name="Ticket to Ride", name_es="Aventureros al Tren")

        query = build_search_query(item)

        self.assertEqual(query, "Aventureros al Tren Ticket to Ride juego de mesa como jugar tutorial")

    def test_tiktok_video_identity_from_canonical_url(self) -> None:
        identity = tiktok_video_identity_from_url("https://www.tiktok.com/@lacaravanacdmx/video/7552741217180716308")

        self.assertEqual(identity, ("lacaravanacdmx", "7552741217180716308"))

    def test_parse_search_result_candidate_extracts_caption_author_date_and_likes(self) -> None:
        raw_text = "\n".join(
            [
                "Top liked",
                "672",
                "Aprende como se juega Ticket to Ride #juegosdemesa",
                "lacaravanacdmx",
                "2025-9-21",
            ]
        )

        candidate = parse_search_result_candidate(
            "https://www.tiktok.com/@lacaravanacdmx/video/7552741217180716308",
            raw_text,
        )

        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.user, "lacaravanacdmx")
        self.assertEqual(candidate.video_id, "7552741217180716308")
        self.assertEqual(candidate.caption, "Aprende como se juega Ticket to Ride #juegosdemesa")
        self.assertEqual(candidate.likes_text, "672")
        self.assertEqual(candidate.date_text, "2025-9-21")

    def test_rank_candidates_accepts_game_overviews_as_relevant(self) -> None:
        item = TikTokItem(id="712", name="Wingspan")
        candidates = [
            TikTokCandidate(
                url="https://www.tiktok.com/@generic/video/111",
                user="generic",
                video_id="111",
                caption="Mira este juego bonito",
                likes_text="9000",
            ),
            TikTokCandidate(
                url="https://www.tiktok.com/@diluvioludico/video/7152177259296738566",
                user="diluvioludico",
                video_id="7152177259296738566",
                caption="Hoy conoceremos Wingspan, uno de los juegos mas hermosos #juegosdemesa",
                likes_text="486",
            ),
        ]

        ranked = rank_candidates(item, candidates)

        self.assertEqual(ranked[0].video_id, "7152177259296738566")
        self.assertGreater(ranked[0].score, ranked[1].score)

    def test_rank_candidates_uses_oembed_title_when_card_caption_is_blank(self) -> None:
        item = TikTokItem(id="1350", name="Azul")
        candidates = [
            TikTokCandidate(
                url="https://www.tiktok.com/@overview/video/111",
                user="creatora",
                video_id="111",
                likes_text="9000",
                oembed_title="AZUL! De 2 a 4 jugadores #juegosdemesa",
            ),
            TikTokCandidate(
                url="https://www.tiktok.com/@tutorial/video/222",
                user="creatorb",
                video_id="222",
                likes_text="10",
                oembed_title="tutorial completo del juego #azul #juegosdemesa",
            ),
        ]

        ranked = rank_candidates(item, candidates)

        self.assertEqual(ranked[0].video_id, "222")

    def test_search_extraction_retries_generic_tiktok_shell_without_video_links(self) -> None:
        self.assertTrue(
            search_extraction_needs_retry(
                page_title="TikTok - Make Your Day",
                link_count=0,
                blockers=[],
            )
        )

        self.assertFalse(
            search_extraction_needs_retry(
                page_title="Find 'Catan' on TikTok | TikTok Search",
                link_count=12,
                blockers=[],
            )
        )

    def test_writes_only_the_top_ranked_tiktok_candidate_to_database(self) -> None:
        repository = FakeTutorialLinkRepository()
        result = TikTokDiscoveryResult(
            item=TikTokItem(id="1462", name="Ticket to Ride", name_es="Aventureros al Tren"),
            query="Aventureros al Tren Ticket to Ride juego de mesa como jugar tutorial",
            search_url="https://www.tiktok.com/search/video?q=ticket",
            page_title="Find Ticket to Ride on TikTok",
            link_count=2,
            blockers=[],
            candidates=[
                TikTokCandidate(
                    url="https://www.tiktok.com/@topcreator/video/7552741217180716308",
                    user="topcreator",
                    video_id="7552741217180716308",
                    caption="Caption fallback",
                    score=20.0,
                    oembed_title="Como jugar Ticket to Ride #juegosdemesa",
                ),
                TikTokCandidate(
                    url="https://www.tiktok.com/@lower/video/7552741217180716309",
                    user="lower",
                    video_id="7552741217180716309",
                    caption="Lower ranked candidate",
                    score=5.0,
                ),
            ],
        )

        writes = write_top_tiktok_candidates_to_database([result], repository, status="candidate")

        self.assertEqual(len(repository.calls), 1)
        self.assertEqual(repository.calls[0]["item_id"], 1462)
        self.assertEqual(repository.calls[0]["url"], "https://www.tiktok.com/@topcreator/video/7552741217180716308")
        self.assertEqual(repository.calls[0]["title"], "Como jugar Ticket to Ride #juegosdemesa")
        self.assertEqual(repository.calls[0]["language"], "es")
        self.assertEqual(repository.calls[0]["source"], "tiktok")
        self.assertEqual(repository.calls[0]["status"], "candidate")
        self.assertEqual(writes[0].item_id, 1462)
        self.assertEqual(writes[0].url, "https://www.tiktok.com/@topcreator/video/7552741217180716308")
        self.assertEqual(writes[0].action, "inserted")

    def test_tiktok_database_write_skips_results_without_candidates(self) -> None:
        repository = FakeTutorialLinkRepository()
        result = TikTokDiscoveryResult(
            item=TikTokItem(id="1350", name="Azul"),
            query="Azul juego de mesa como jugar tutorial",
            search_url="https://www.tiktok.com/search/video?q=azul",
            page_title="TikTok - Make Your Day",
            link_count=0,
            blockers=["challenge_or_warmup"],
            candidates=[],
        )

        writes = write_top_tiktok_candidates_to_database([result], repository)

        self.assertEqual(repository.calls, [])
        self.assertEqual(writes, [])

    def test_tiktok_database_write_uses_caption_when_oembed_title_is_blank(self) -> None:
        repository = FakeTutorialLinkRepository()
        result = TikTokDiscoveryResult(
            item=TikTokItem(id="1350", name="Azul"),
            query="Azul juego de mesa como jugar tutorial",
            search_url="https://www.tiktok.com/search/video?q=azul",
            page_title="Find Azul on TikTok",
            link_count=1,
            blockers=[],
            candidates=[
                TikTokCandidate(
                    url="https://www.tiktok.com/@creator/video/7552741217180716310",
                    user="creator",
                    video_id="7552741217180716310",
                    caption="Resena rapida de Azul",
                    score=10.0,
                )
            ],
        )

        write_top_tiktok_candidates_to_database([result], repository)

        self.assertEqual(repository.calls[0]["title"], "Resena rapida de Azul")


class FakeTutorialLinkRepository:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def upsert_tutorial_link(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(tutorial_link_id=100 + len(self.calls), action="inserted")


if __name__ == "__main__":
    unittest.main()
