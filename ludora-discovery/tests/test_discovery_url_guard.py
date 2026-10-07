import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.models import DiscoveryItemCandidateRecord
from ludora.amazon_discovery import crawl_amazon_store_inventory
from ludora.operations import _StoreItemDiscoveryTrackingRepository
from ludora.product_crawler import crawl_listing_candidates
from ludora.webfetch import FetchResult


KNOWN_URL = "https://example.mx/products/catan"
ORIGIN_URL = "http://example.mx/products/catan"
NEW_URL = "https://example.mx/products/new-game"
PRODUCT_HTML = '<script type="application/ld+json">{"@type":"Product","name":"New Game"}</script>'


class GuardRepository:
    def __init__(self, rows=()):
        self.rows = list(rows)
        self.checks = []
        self.observations = []
        self.records = []
        self.completions = []

    def discovery_url_exists(self, store_id, source_url):
        self.checks.append((store_id, source_url))
        return any(row.store_id == store_id and source_url in (row.source_url, row.source_url_origin)
                   for row in self.rows)

    def observe_discovery_pair(self, store_id, discovered_url, target_url):
        self.observations.append((store_id, discovered_url, target_url))
        return False

    def prepare_discovery_pair(self, record):
        self.records.append(record)
        return SimpleNamespace(candidate_id=len(self.records), should_process=True, created=True)

    def complete_discovery_pair(self, candidate_id, **_kwargs):
        self.completions.append(candidate_id)

    def update_store_item_discovery_progress(self, **_kwargs):
        pass


class Trace:
    def __init__(self):
        self.entries = []

    def log(self, event, **fields):
        self.entries.append((event, fields))


class DiscoveryUrlGuardTests(unittest.TestCase):
    def test_known_direct_and_redirect_origin_skip_before_all_product_work_for_any_row_state(self):
        for store_id in (12, None):
            for state in ({"listing_status": "PENDING"}, {"processing_error": "Matcher failed"},
                          {"store_active": False}, {"is_boardgame": False},
                          {"listing_status": "LISTED", "is_boardgame_confirmed": True}):
                for discovered_url in (KNOWN_URL, ORIGIN_URL):
                    with self.subTest(store_id=store_id, state=state, url=discovered_url):
                        stored = DiscoveryItemCandidateRecord(store_id=store_id, source_url=KNOWN_URL,
                                                              source_url_origin=ORIGIN_URL, title="Catan", **state)
                        repository = GuardRepository([stored])
                        trace = Trace()
                        browser = Mock(return_value=FetchResult(url=discovered_url, text=PRODUCT_HTML))
                        extractor = Mock(return_value=DiscoveryItemCandidateRecord(store_id=store_id, source_url=discovered_url, title="Catan"))
                        signer = Mock(return_value={})
                        throttle = Mock()
                        classifier = Mock()
                        processor = SimpleNamespace(process_candidate=Mock())
                        enricher = Mock(side_effect=lambda detail, _listing: detail)
                        with patch("ludora.product_crawler.fetch_html", return_value=FetchResult(url=discovered_url, text=PRODUCT_HTML)) as fetch:
                            records = crawl_listing_candidates(
                                [DiscoveryItemCandidateRecord(store_id=store_id, source_url=discovered_url, title="Catan")],
                                repository, source_listing_url="https://example.mx/sitemap.xml",
                                browser_fetcher=browser, item_detail_extractor=extractor,
                                request_headers_provider=signer, before_product_request=throttle,
                                item_classifier=classifier, item_processor=processor,
                                item_candidate_enricher=enricher, trace_logger=trace)
                        self.assertEqual(records, [])
                        fetch.assert_not_called()
                        for dependency in (browser, extractor, signer, throttle, classifier, processor.process_candidate, enricher):
                            dependency.assert_not_called()
                        self.assertEqual(repository.checks, [(store_id, discovered_url)])
                        self.assertEqual(repository.observations, [])
                        self.assertEqual(repository.records, [])
                        self.assertEqual(repository.completions, [])
                        self.assertEqual([event for event, _ in trace.entries], ["inventory.candidate.skipped_existing"])
                        self.assertEqual(trace.entries[0][1]["stage"], "before_fetch")

    def test_mixed_known_and_new_urls_fetch_and_process_only_new_product(self):
        repository = GuardRepository([DiscoveryItemCandidateRecord(store_id=12, source_url=KNOWN_URL, title="Catan")])
        throttle = Mock()
        classifier = Mock()
        processor = SimpleNamespace(process_candidate=Mock())
        with patch("ludora.product_crawler.fetch_html", side_effect=lambda url, **_kwargs: FetchResult(url=url, text=PRODUCT_HTML)) as fetch:
            records = crawl_listing_candidates(
                [DiscoveryItemCandidateRecord(store_id=12, source_url=url, title="Game") for url in (KNOWN_URL, NEW_URL)],
                repository, source_listing_url="https://example.mx/sitemap.xml",
                item_classifier=classifier, item_processor=processor, before_product_request=throttle)
        self.assertEqual([record.source_url for record in records], [NEW_URL])
        self.assertEqual([call.args[0] for call in fetch.call_args_list], [NEW_URL])
        self.assertEqual([call.args[0] for call in throttle.call_args_list], [NEW_URL])
        self.assertEqual([record.source_url for record in repository.records], [NEW_URL])
        self.assertEqual(repository.completions, [1])
        classifier.assert_called_once()
        processor.process_candidate.assert_called_once()

    def test_url_from_other_store_or_different_scheme_is_new(self):
        for stored_store_id, discovered_url in ((13, KNOWN_URL), (12, ORIGIN_URL)):
            with self.subTest(stored_store_id=stored_store_id, discovered_url=discovered_url):
                repository = GuardRepository([DiscoveryItemCandidateRecord(store_id=stored_store_id, source_url=KNOWN_URL, title="Catan")])
                with patch("ludora.product_crawler.fetch_html", return_value=FetchResult(url=discovered_url, text=PRODUCT_HTML)) as fetch:
                    records = crawl_listing_candidates(
                        [DiscoveryItemCandidateRecord(store_id=12, source_url=discovered_url, title="Catan")],
                        repository, source_listing_url="https://example.mx/sitemap.xml", item_classifier=lambda _record: None)
                self.assertEqual(len(records), 1)
                self.assertEqual(repository.checks, [(12, discovered_url)])
                fetch.assert_called_once()

    def test_tracking_repository_forwards_known_url_guard_without_progress_writes(self):
        repository = GuardRepository([DiscoveryItemCandidateRecord(store_id=12, source_url=KNOWN_URL, title="Catan")])
        tracking = _StoreItemDiscoveryTrackingRepository(repository, "test-run")
        with patch("ludora.product_crawler.fetch_html", return_value=FetchResult(url=KNOWN_URL, text=PRODUCT_HTML)) as fetch:
            records = crawl_listing_candidates(
                [DiscoveryItemCandidateRecord(store_id=12, source_url=KNOWN_URL, title="Catan")],
                tracking, source_listing_url="https://example.mx/sitemap.xml", item_classifier=lambda _record: None)
        self.assertEqual(records, [])
        fetch.assert_not_called()
        self.assertEqual(repository.checks, [(12, KNOWN_URL)])
        self.assertEqual(tracking.items_discovered, 0)

    def test_amazon_remembered_origin_skips_without_broadening_same_asin_or_store_identity(self):
        product_url = "https://www.amazon.com.mx/dp/B0HASBRO01"
        canonical_url = "https://www.amazon.com.mx/Hasbro-Clue/dp/B0HASBRO01"
        for stored_store_id, origin, expected_urls in (
            (12, product_url, []),
            (12, None, [product_url]),
            (13, product_url, [product_url]),
        ):
            with self.subTest(stored_store_id=stored_store_id, origin=origin):
                repository = GuardRepository([DiscoveryItemCandidateRecord(
                    store_id=stored_store_id, source_url=canonical_url, source_url_origin=origin, title="Clue")])
                detail_urls = []
                throttle = Mock()

                def fetcher(url):
                    if "/search?" in url:
                        return FetchResult(url=url, text=f'<a href="{product_url}">Hasbro Clue</a>')
                    detail_urls.append(url)
                    return FetchResult(url=canonical_url, text='<span id="productTitle">Hasbro Clue</span>'
                                       '<input id="add-to-cart-button">'
                                       '<table><tr><th>ASIN</th><td>B0HASBRO01</td></tr></table>')

                records = crawl_amazon_store_inventory(
                    "https://www.amazon.com.mx/stores/page/00565807-102E-497A-894A-3434B4619BD2",
                    12, repository, browser_fetcher=fetcher, before_product_request=throttle,
                    item_classifier=lambda _record: None, delay_seconds=0)
                self.assertEqual(detail_urls, expected_urls)
                self.assertEqual([call.args[0] for call in throttle.call_args_list], expected_urls)
                self.assertEqual(len(records), len(expected_urls))
                self.assertEqual(repository.checks, [(12, product_url)])
                if not expected_urls:
                    self.assertEqual(repository.observations, [])
                    self.assertEqual(repository.records, [])


if __name__ == "__main__":
    unittest.main()
