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

    def complete_discovery_pair(self, candidate_id, *, activate_if_ready=False, non_boardgame_success=False):
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
    def _changes(self, rows, current_id, *, allow_activation=True):
        return {row.id: row for row in reconcile_discovery_pairs(rows, current_id, allow_activation=allow_activation)}

    def test_new_direct_displaces_equal_redirect_after_success(self):
        redirect = DiscoveryPairState(1, B, A, True, "LISTED", processed_at="2026-09-01")
        direct = DiscoveryPairState(2, B, None, False, "LISTED", processed_at="2026-09-02")
        changes = self._changes([redirect, direct], 2)
        self.assertFalse(changes[1].store_active)
        self.assertTrue(changes[2].store_active)

    def test_incomplete_or_failed_candidate_does_not_change_visibility(self):
        redirect = DiscoveryPairState(1, B, A, True, "LISTED", processed_at="2026-09-01")
        for processed_at, error in [(None, ""), ("2026-09-02", "Matcher failed")]:
            with self.subTest(processed_at=processed_at, error=error):
                candidate = DiscoveryPairState(2, B, None, False, "LISTED", processed_at=processed_at, processing_error=error)
                self.assertEqual(self._changes([redirect, candidate], 2), {})

    def test_published_match_outranks_direct_without_match(self):
        redirect = DiscoveryPairState(1, B, A, True, "LISTED", item_id=9, is_boardgame_confirmed=True, is_boardgame=True, processed_at="2026-09-01")
        direct = DiscoveryPairState(2, B, None, False, "PENDING", processed_at="2026-09-02")
        self.assertEqual(self._changes([redirect, direct], 2), {})

    def test_available_redirect_outranks_unavailable_direct(self):
        redirect = DiscoveryPairState(1, B, A, True, "LISTED", item_id=9, is_boardgame_confirmed=True, is_boardgame=True, availability="available", processed_at="2026-09-01")
        direct = DiscoveryPairState(2, B, None, False, "LISTED", item_id=9, is_boardgame_confirmed=True, is_boardgame=True, availability="unavailable", processed_at="2026-09-02")
        self.assertEqual(self._changes([redirect, direct], 2), {})

    def test_unavailable_only_candidate_can_be_visible(self):
        candidate = DiscoveryPairState(2, B, None, False, "LISTED", availability="unavailable", processed_at="2026-09-02")
        self.assertTrue(self._changes([candidate], 2)[2].store_active)

    def test_rejected_candidate_stays_hidden(self):
        candidate = DiscoveryPairState(2, B, None, False, "REJECTED", processed_at="2026-09-02")
        self.assertEqual(self._changes([candidate], 2), {})

    def test_previously_hidden_completed_pair_is_not_reactivated(self):
        hidden = DiscoveryPairState(1, B, None, False, "LISTED", processed_at="2026-09-01")
        self.assertEqual(self._changes([hidden], 1, allow_activation=False), {})

    def test_reappearing_historical_pair_retires_visible_old_target_without_reactivation(self):
        historical = DiscoveryPairState(1, B, A, False, "LISTED", processed_at="2026-09-01")
        latest = DiscoveryPairState(2, C, A, True, "LISTED", processed_at="2026-09-02")
        changes = self._changes([historical, latest], 1, allow_activation=False)
        self.assertFalse(changes[2].store_active)
        self.assertNotIn(1, changes)

    def test_same_source_history_is_hidden_before_new_target_activation(self):
        old = DiscoveryPairState(1, B, A, True, "LISTED", processed_at="2026-09-01")
        new = DiscoveryPairState(2, C, A, False, "LISTED", processed_at="2026-09-02")
        changes = self._changes([old, new], 2)
        self.assertFalse(changes[1].store_active)
        self.assertTrue(changes[2].store_active)


if __name__ == "__main__":
    unittest.main()
