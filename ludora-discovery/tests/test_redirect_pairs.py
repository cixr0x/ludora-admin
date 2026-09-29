import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import crawl_listing_candidates
from ludora.webfetch import FetchResult
from ludora.discovery_pairs import DiscoveryPairState, reconcile_discovery_pairs


PRODUCT_HTML = '<script type="application/ld+json">{"@type":"Product","name":"Catan"}</script>'
A = "https://example.mx/product/old"
B = "https://example.mx/product/catan"
C = "https://example.mx/product/new"


class PairRepository:
    def __init__(self, recorded=()):
        self.recorded = set(recorded)
        self.observations = []
        self.records = []
        self.completions = []

    def item_candidate_exists(self, *_args):
        return False

    def observe_discovery_pair(self, store_id, discovered_url, target_url):
        self.observations.append((store_id, discovered_url, target_url))
        return (store_id, discovered_url, target_url) in self.recorded

    def prepare_discovery_pair(self, record):
        self.records.append(record)
        return SimpleNamespace(candidate_id=len(self.records), should_process=True, created=True)

    def upsert_item_candidate(self, record):
        self.records.append(record)
        return SimpleNamespace(candidate_id=len(self.records), should_process=True, created=True)

    def complete_discovery_pair(self, candidate_id):
        self.completions.append(candidate_id)


class DiscoveryPairFlowTests(unittest.TestCase):
    def test_invalid_redirect_targets_are_not_recorded_or_used_for_pair_skips(self):
        for url, html, status in [("javascript:alert(1)", PRODUCT_HTML, 200), ("https://example.mx/", "<h1>Our store</h1>", 200), (B, "<h1>Producto no encontrado</h1>", 200), (B, PRODUCT_HTML, 404), (B, '<script type="application/ld+json">{"@type":"Product"}</script>', 200)]:
            with self.subTest(url=url, html=html, status=status):
                repository = PairRepository(recorded={(12, A, B)})
                with patch("ludora.product_crawler.fetch_html", return_value=FetchResult(url=url, text=html, status_code=status)):
                    records = crawl_listing_candidates([DiscoveryItemCandidateRecord(store_id=12, source_url=A, title="Catan")], repository, source_listing_url="https://example.mx/sitemap.xml", item_classifier=lambda _record: None)
                self.assertEqual(records, [])
                self.assertEqual(repository.observations, [])
                self.assertEqual(repository.records, [])

    def test_insufficient_static_redirect_uses_browser_before_pair_skip(self):
        repository = PairRepository(recorded={(12, A, B)})
        browser = Mock(return_value=FetchResult(url=B, text=PRODUCT_HTML))
        extractor = Mock(side_effect=AssertionError("Recorded browser pair must skip extraction"))
        with patch("ludora.product_crawler.fetch_html", return_value=FetchResult(url="https://example.mx/", text="<h1>Loading</h1>")):
            records = crawl_listing_candidates([DiscoveryItemCandidateRecord(store_id=12, source_url=A, title="Catan")], repository, source_listing_url="https://example.mx/sitemap.xml", browser_fetcher=browser, item_detail_extractor=extractor)
        self.assertEqual(records, [])
        self.assertEqual(browser.call_count, 1)
        self.assertEqual(repository.observations, [(12, A, B)])

    def test_pairs_are_scoped_to_the_current_store(self):
        repository = PairRepository(recorded={(13, A, B)})
        with patch("ludora.product_crawler.fetch_html", return_value=FetchResult(url=B, text=PRODUCT_HTML)):
            records = crawl_listing_candidates([DiscoveryItemCandidateRecord(store_id=12, source_url=A, title="Catan")], repository, source_listing_url="https://example.mx/sitemap.xml", item_classifier=lambda _record: None)
        self.assertEqual(len(records), 1)
        self.assertEqual(repository.observations, [(12, A, B)])

    def test_redirect_and_direct_target_are_separate_records_in_both_orders(self):
        for urls in ([A, B], [B, A]):
            with self.subTest(urls=urls):
                repository = PairRepository()
                listings = [DiscoveryItemCandidateRecord(store_id=12, source_url=url, title="Catan") for url in urls]
                with patch("ludora.product_crawler.fetch_html", side_effect=lambda url, **_kwargs: FetchResult(url=B, text=PRODUCT_HTML)):
                    records = crawl_listing_candidates(listings, repository, source_listing_url="https://example.mx/sitemap.xml", item_classifier=lambda _record: None)
                self.assertEqual([(getattr(record, "source_url_origin", None), record.source_url) for record in records], [(A if url == A else None, B) for url in urls])
                self.assertEqual(repository.observations, [(12, url, B) for url in urls])
                self.assertEqual(repository.completions, [1, 2])

    def test_registered_pair_resolves_but_skips_extraction_and_classification(self):
        repository = PairRepository(recorded={(12, A, B)})
        extractor = Mock(side_effect=AssertionError("Recorded pair must not be extracted"))
        classifier = Mock(side_effect=AssertionError("Recorded pair must not be classified"))
        with patch("ludora.product_crawler.fetch_html", return_value=FetchResult(url=B, text=PRODUCT_HTML)) as fetch:
            records = crawl_listing_candidates([DiscoveryItemCandidateRecord(store_id=12, source_url=A, title="Catan")], repository, source_listing_url="https://example.mx/sitemap.xml", item_detail_extractor=extractor, item_classifier=classifier)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(records, [])
        self.assertEqual(repository.observations, [(12, A, B)])
        self.assertEqual(repository.records, [])

    def test_failed_processing_does_not_complete_pair_activation(self):
        repository = PairRepository()
        processor = SimpleNamespace(process_candidate=Mock(side_effect=RuntimeError("Matcher failed")))
        with patch("ludora.product_crawler.fetch_html", return_value=FetchResult(url=B, text=PRODUCT_HTML)):
            with self.assertRaisesRegex(RuntimeError, "Matcher failed"):
                crawl_listing_candidates([DiscoveryItemCandidateRecord(store_id=12, source_url=B, title="Catan")], repository, source_listing_url="https://example.mx/sitemap.xml", item_classifier=lambda _record: None, item_processor=processor)
        self.assertEqual(repository.completions, [])


class PairActivationTests(unittest.TestCase):
    def test_non_boardgame_direct_cannot_displace_published_boardgame(self):
        redirect = DiscoveryPairState(1, B, A, True, "LISTED", item_id=9, is_boardgame_confirmed=True, is_boardgame=True)
        direct = DiscoveryPairState(2, B, None, False, "LISTED", "pending", visibility_before_suppression=True, item_id=9, is_boardgame_confirmed=True, is_boardgame=False)
        changes = {row.id: row for row in reconcile_discovery_pairs([redirect, direct], 2)}
        self.assertNotIn(1, changes)
        self.assertFalse(changes[2].store_active)
        self.assertEqual(changes[2].duplicate_of_id, 1)

    def test_published_redirect_is_retained_until_matched_direct_is_listed(self):
        redirect = DiscoveryPairState(1, B, A, True, "LISTED", item_id=9, is_boardgame_confirmed=True, is_boardgame=True)
        for status in ("PENDING", "UNLISTED"):
            with self.subTest(status=status):
                direct = DiscoveryPairState(2, B, None, False, status, "pending", visibility_before_suppression=True, item_id=9, is_boardgame_confirmed=True, is_boardgame=True)
                changes = {row.id: row for row in reconcile_discovery_pairs([redirect, direct], 2)}
                self.assertNotIn(1, changes)
                self.assertEqual(changes[2].hidden_reason, "duplicate")
                self.assertEqual(changes[2].duplicate_of_id, 1)
        direct = DiscoveryPairState(2, B, None, False, "LISTED", "duplicate", 1, visibility_before_suppression=True, item_id=9, is_boardgame_confirmed=True, is_boardgame=True)
        changes = {row.id: row for row in reconcile_discovery_pairs([redirect, direct], 2)}
        self.assertEqual(changes[1].duplicate_of_id, 2)
        self.assertTrue(changes[2].store_active)
        self.assertIsNone(changes[2].hidden_reason)

    def test_unfinished_pair_stays_retryable_after_superseded_and_reappearing(self):
        unfinished = DiscoveryPairState(1, C, A, False, "PENDING", "pending", visibility_before_suppression=True, processing_complete=False)
        known = DiscoveryPairState(2, B, A, True, "LISTED")
        changes = {row.id: row for row in reconcile_discovery_pairs([unfinished, known], 2)}
        self.assertEqual(changes[1].hidden_reason, "superseded")
        self.assertFalse(changes[1].processing_complete)
        self.assertFalse(changes[1].eligible)

    def test_completed_no_match_direct_does_not_hide_usable_redirect(self):
        redirect = DiscoveryPairState(1, B, A, True, "LISTED", item_id=9, is_boardgame_confirmed=True, is_boardgame=True)
        direct = DiscoveryPairState(2, B, None, False, "PENDING", "pending", visibility_before_suppression=True)
        changes = {row.id: row for row in reconcile_discovery_pairs([redirect, direct], 2)}
        self.assertNotIn(1, changes)
        self.assertEqual(changes[2].hidden_reason, "duplicate")
        self.assertEqual(changes[2].duplicate_of_id, 1)
        self.assertTrue(changes[2].visibility_before_suppression)

    def test_rejected_direct_does_not_displace_eligible_redirect(self):
        redirect = DiscoveryPairState(1, B, A, True, "LISTED")
        direct = DiscoveryPairState(2, B, None, False, "REJECTED", "pending", visibility_before_suppression=True)
        changes = {row.id: row for row in reconcile_discovery_pairs([redirect, direct], 2)}
        self.assertNotIn(1, changes)
        self.assertFalse(changes[2].store_active)

    def test_direct_pair_wins_after_successful_processing(self):
        redirect = DiscoveryPairState(1, B, A, True, "LISTED")
        direct = DiscoveryPairState(2, B, None, False, "LISTED", "pending", visibility_before_suppression=True)
        changes = {row.id: row for row in reconcile_discovery_pairs([redirect, direct], 2)}
        self.assertFalse(changes[1].store_active)
        self.assertEqual(changes[1].duplicate_of_id, 2)
        self.assertTrue(changes[2].store_active)
        self.assertIsNone(changes[2].hidden_reason)

    def test_changed_target_and_reappearance_keep_historical_rows(self):
        old = DiscoveryPairState(1, B, A, True, "LISTED")
        new = DiscoveryPairState(2, C, A, False, "LISTED", "pending", visibility_before_suppression=True)
        states = {row.id: row for row in [old, new]}
        states.update({row.id: row for row in reconcile_discovery_pairs(list(states.values()), 2)})
        self.assertEqual(states[1].hidden_reason, "superseded")
        self.assertEqual(states[1].superseded_by_id, 2)
        self.assertTrue(states[2].store_active)
        states.update({row.id: row for row in reconcile_discovery_pairs(list(states.values()), 1)})
        self.assertTrue(states[1].store_active)
        self.assertEqual(states[2].hidden_reason, "superseded")
        self.assertEqual(states[2].superseded_by_id, 1)

    def test_repeat_duplicate_leaves_saved_eligibility_untouched(self):
        redirect = DiscoveryPairState(1, B, A, False, "LISTED", "duplicate", 2, visibility_before_suppression=True)
        direct = DiscoveryPairState(2, B, None, True, "LISTED")
        self.assertEqual(reconcile_discovery_pairs([redirect, direct], 1), [])

    def test_external_inactive_direct_does_not_displace_redirect(self):
        redirect = DiscoveryPairState(1, B, A, True, "LISTED")
        direct = DiscoveryPairState(2, B, None, False, "LISTED")
        changes = {row.id: row for row in reconcile_discovery_pairs([redirect, direct], 2)}
        self.assertNotIn(1, changes)
        self.assertFalse(changes[2].visibility_before_suppression)

    def test_unavailable_direct_cannot_hide_equally_published_usable_redirect(self):
        redirect = DiscoveryPairState(1, B, A, True, "LISTED", item_id=9, is_boardgame_confirmed=True, is_boardgame=True, availability="out_of_stock")
        direct = DiscoveryPairState(2, B, None, False, "LISTED", "pending", visibility_before_suppression=True, item_id=9, is_boardgame_confirmed=True, is_boardgame=True, availability="unavailable")
        changes = {row.id: row for row in reconcile_discovery_pairs([redirect, direct], 2)}
        self.assertNotIn(1, changes)
        self.assertEqual(changes[2].duplicate_of_id, 1)
        self.assertEqual(changes[2].availability, "unavailable")

    def test_unavailable_only_representative_remains_visible(self):
        direct = DiscoveryPairState(2, B, None, False, "LISTED", "pending", visibility_before_suppression=True, availability="unavailable")
        changes = reconcile_discovery_pairs([direct], 2)
        self.assertTrue(changes[0].store_active)
        self.assertEqual(changes[0].availability, "unavailable")

    def test_published_unavailable_kept_over_unmatched_available_direct(self):
        redirect = DiscoveryPairState(1, B, A, True, "LISTED", item_id=9, is_boardgame_confirmed=True, is_boardgame=True, availability="unavailable")
        direct = DiscoveryPairState(2, B, None, False, "PENDING", "pending", visibility_before_suppression=True, availability="available")
        changes = {row.id: row for row in reconcile_discovery_pairs([redirect, direct], 2)}
        self.assertNotIn(1, changes)
        self.assertEqual(changes[2].duplicate_of_id, 1)

    def test_stable_redirect_winner_is_preserved(self):
        earlier = DiscoveryPairState(1, B, C, False, "LISTED", "duplicate", 2, visibility_before_suppression=True)
        winner = DiscoveryPairState(2, B, A, True, "LISTED")
        self.assertEqual(reconcile_discovery_pairs([earlier, winner], 1), [])


if __name__ == "__main__":
    unittest.main()
