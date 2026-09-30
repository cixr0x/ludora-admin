import sys
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.continuous_update_worker import _process_claim
from ludora.cancellation import CancellationToken, OperationCancelled
from ludora.database import ClaimedStoreItemUpdate, ItemCandidateUpsertResult
from ludora.discovery_pairs import DiscoveryPairState, reconcile_discovery_pairs
from ludora.models import DiscoveryItemCandidateRecord
from ludora.operations import create_item_update_redirect_handler
from ludora.product_crawler import update_confirmed_store_item_details
from ludora.webfetch import FetchResult

A = "https://example.test/product/old"
B = "https://example.test/product/catan"
C = "https://example.test/product/azul"


def product_html(name="Azul", sku="AZUL", price="499"):
    return ('<script type="application/ld+json">'
            '{"@type":"Product","name":"' + name + '","sku":"' + sku + '",'
            '"offers":{"price":"' + price + '","priceCurrency":"MXN",'
            '"availability":"https://schema.org/InStock"}}</script>')


class PairRepository:
    """Offline store state; visibility uses the real discovery preference policy."""

    def __init__(self, origin=None):
        self.original = DiscoveryItemCandidateRecord(
            store_id=12, store_item_id=501, source_url=B, source_url_origin=origin,
            title="Catan", original_title="Catan", store_sku="CATAN", price="799",
            item_id=77, listing_status="LISTED", store_active=True,
            is_boardgame=True, is_boardgame_confirmed=True, processed_at="2026-09-01",
            availability="available")
        self.rows = {501: self.original}
        self.failures = []
        self.removals = []
        self.changed_updates = []
        self.finalizations = []
        self.progress = []
        self.lease_valid = True
        self.persistence_error = False
        self.completed_reuse = False

    def list_confirmed_boardgame_item_candidates(self, **kwargs):
        return [self.original]

    def list_store_item_discovery_sources(self, **kwargs):
        return [SimpleNamespace(store_id=12, platform="custom", store_name="Example")]

    def get_completed_discovery_pair_id(self, store_id, discovered_url, target_url):
        for row in self.rows.values():
            origin = discovered_url if discovered_url != target_url else None
            if (row.store_id, row.source_url_origin, row.source_url) == (store_id, origin, target_url):
                if row.processed_at and not row.processing_error:
                    self.completed_reuse = True
                    return row.store_item_id
        return None

    def prepare_discovery_pair(self, record):
        if self.persistence_error:
            raise RuntimeError("candidate persistence failed")
        previous = next((row for row in self.rows.values()
                         if (row.source_url_origin, row.source_url) ==
                         (record.source_url_origin, record.source_url)), None)
        candidate_id = previous.store_item_id if previous else max(self.rows) + 1
        record.store_item_id = candidate_id
        record.store_active = previous.store_active if previous else False
        self.rows[candidate_id] = record
        return ItemCandidateUpsertResult(candidate_id, "PENDING", None, True,
                                        created=previous is None, activate_if_ready=True)

    def complete_item_update_redirect(self, original, candidate_id, **kwargs):
        if not self.lease_valid:
            raise RuntimeError("update lease was lost")
        current = self.rows[candidate_id]
        if current.processing_error or (current.is_boardgame and not current.processed_at):
            raise RuntimeError("redirect target processing did not complete")
        if not current.processed_at:
            current.processed_at = "2026-09-30"
        changed = original.store_active
        original.store_active = False
        states = [DiscoveryPairState(
            row.store_item_id, row.source_url, row.source_url_origin, row.store_active,
            row.listing_status, row.item_id, row.is_boardgame_confirmed, row.is_boardgame,
            row.availability, row.processed_at, row.processing_error) for row in self.rows.values()]
        for state in reconcile_discovery_pairs(states, candidate_id,
                                              allow_activation=kwargs["activate_if_ready"]):
            self.rows[state.id].store_active = state.store_active
        self.finalizations.append((original.store_item_id, candidate_id, kwargs))
        return ItemCandidateUpsertResult(candidate_id, current.listing_status,
                                        current.item_id, False, changed=changed)

    def mark_item_update_redirect_retryable(self, store_id, candidate_id, error):
        if not self.rows[candidate_id].store_active:
            self.rows[candidate_id].processing_error = error

    def complete_claimed_store_item_update(self, original, refreshed, **kwargs):
        self.changed_updates.append(refreshed)
        return ItemCandidateUpsertResult(501, "LISTED", 77, False)

    def deactivate_claimed_store_item_update(self, original, **kwargs):
        original.availability = "unavailable"
        self.removals.append(original)

    def mark_item_candidate_inactive(self, original, **kwargs):
        original.availability = "unavailable"
        self.removals.append(original)
        return SimpleNamespace(changed=True)

    def fail_claimed_store_item_update(self, original, **kwargs):
        self.failures.append(kwargs)

    def update_item_candidate_price_availability(self, original, refreshed, **kwargs):
        self.changed_updates.append(refreshed)
        return SimpleNamespace(changed=False)

    def update_item_candidate_with_change_log(self, original, refreshed, **kwargs):
        return self.update_item_candidate_price_availability(original, refreshed)

    def update_store_item_update_progress(self, **kwargs):
        self.progress.append(kwargs)


class IndependentMatcher:
    def __init__(self, repository, *, fail=False, incomplete=False, item_id=99):
        self.repository = repository
        self.fail = fail
        self.incomplete = incomplete
        self.item_id = item_id
        self.inputs = []

    def process_candidate(self, candidate_id, record):
        self.inputs.append(replace(record))
        if not record.is_boardgame:
            return
        if self.fail:
            record.processing_error = "matcher failed"
            raise RuntimeError("matcher failed")
        if not self.incomplete:
            record.item_id = self.item_id
            record.is_boardgame_confirmed = True
            record.listing_status = "LISTED"
            record.processed_at = "2026-09-30"


class ItemUpdateRedirectTests(unittest.TestCase):
    def run_update(self, repository, fetched, *, manual=False, matcher=None,
                   browser_fetcher=None, platform="custom", classification_error=None, boardgame=True,
                   cancellation_token=None):
        matcher = matcher or IndependentMatcher(repository)
        classified = []

        def classify(record):
            classified.append(replace(record))
            if classification_error:
                raise classification_error
            record.is_boardgame = boardgame
            return record

        requested_urls = []

        def fetch(url, **kwargs):
            requested_urls.append(url)
            return fetched

        with (patch("ludora.product_crawler.fetch_html", side_effect=fetch),
              patch("ludora.operations._resolve_item_classifier", return_value=classify),
              patch("ludora.operations.AdminItemMatcher", return_value=matcher)):
            if manual:
                result = update_confirmed_store_item_details(
                    repository, browser_fetch_enabled=browser_fetcher is not None,
                    browser_fetcher=browser_fetcher, job_id=17, run_id="manual:test",
                    cancellation_token=cancellation_token,
                    request_throttle=Mock(cooldown_remaining=Mock(return_value=0.0),
                                          wait_before_request=Mock(return_value=0.0)))
            else:
                claim = ClaimedStoreItemUpdate(91, 0, "lease", platform,
                                              repository.original, 0, "Example")
                _process_claim(browser_fetcher=browser_fetcher, claim=claim,
                               item_title_extractor=lambda record: record.title, job_id=17, repository=repository,
                               request_headers_provider=None, run_id="continuous:test",
                               throttle=Mock(), trace_logger=Mock(), worker_id="worker")
                result = None
        repository.requested_urls = requested_urls
        return result, matcher, classified

    def test_redirect_is_independently_matched_in_both_update_paths(self):
        for manual in (False, True):
            with self.subTest(manual=manual):
                repository = PairRepository()
                result, matcher, classified = self.run_update(
                    repository, FetchResult(C, product_html()), manual=manual)
                self.assertEqual(len(matcher.inputs), 1)
                candidate = matcher.inputs[0]
                self.assertEqual((candidate.source_url_origin, candidate.source_url), (B, C))
                self.assertEqual((candidate.item_id, candidate.is_boardgame_confirmed), (None, False))
                self.assertEqual((candidate.title, candidate.store_sku, candidate.price), ("Azul", "AZUL", "499"))
                self.assertFalse(candidate.store_active)
                self.assertEqual(repository.rows[502].item_id, 99)
                self.assertFalse(repository.original.store_active)
                self.assertEqual(repository.original.availability, "available")
                self.assertEqual(repository.original.price, "799")
                self.assertEqual(repository.original.item_id, 77)
                self.assertTrue(repository.rows[502].store_active)
                self.assertEqual(repository.changed_updates, [])
                self.assertEqual(repository.removals, [])
                if manual:
                    self.assertEqual((len(result), result.updated_items), (1, 1))

    def test_chained_update_keeps_a_to_b_and_creates_b_to_c(self):
        repository = PairRepository(origin=A)
        self.run_update(repository, FetchResult(C + "#buy", product_html()))
        self.assertEqual((repository.original.source_url_origin, repository.original.source_url), (A, B))
        self.assertIn(502, repository.rows)
        self.assertEqual((repository.rows[502].source_url_origin, repository.rows[502].source_url), (B, C))
        self.assertEqual(repository.requested_urls, [B])

    def test_completed_hidden_pair_reuses_identity_and_preserves_manual_hide(self):
        repository = PairRepository()
        repository.rows[502] = replace(repository.original, store_item_id=502,
                                       source_url_origin=B, source_url=C,
                                       item_id=99, store_active=False)
        _, matcher, classified = self.run_update(repository, FetchResult(C, product_html()))
        self.assertTrue(repository.completed_reuse)
        self.assertEqual(classified, [])
        self.assertEqual(matcher.inputs, [])
        self.assertFalse(repository.rows[502].store_active)
        self.assertFalse(repository.original.store_active)

    def test_existing_direct_target_wins_without_coalescing_pair_identity(self):
        repository = PairRepository()
        repository.rows[503] = replace(repository.original, store_item_id=503,
                                       source_url=C, source_url_origin=None, item_id=99)
        self.run_update(repository, FetchResult(C, product_html()))
        self.assertEqual(len(repository.rows), 3)
        self.assertTrue(repository.rows[503].store_active)
        self.assertFalse(repository.rows[504].store_active)

    def test_target_failure_or_lost_lease_leaves_original_retryable(self):
        for mode in ("classification", "matcher", "incomplete", "lease", "persistence"):
            with self.subTest(mode=mode):
                repository = PairRepository()
                repository.lease_valid = mode != "lease"
                repository.persistence_error = mode == "persistence"
                self.run_update(repository, FetchResult(C, product_html()),
                                matcher=IndependentMatcher(repository, fail=mode == "matcher",
                                                           incomplete=mode == "incomplete"),
                                classification_error=RuntimeError("classifier failed") if mode == "classification" else None)
                self.assertTrue(repository.original.store_active)
                self.assertEqual(repository.original.availability, "available")
                self.assertEqual(len(repository.failures), 1)
                self.assertEqual(repository.finalizations, [])

    def test_invalid_redirect_never_hides_or_removes_original(self):
        repository = PairRepository()
        self.run_update(repository, FetchResult("https://example.test/", "<h1>Welcome</h1>"))
        self.assertTrue(repository.original.store_active)
        self.assertEqual(repository.original.availability, "available")
        self.assertEqual(repository.removals, [])
        self.assertEqual(len(repository.failures), 1)

    def test_removed_redirect_retains_existing_removal_path(self):
        for status, html in ((200, "<title>Error - 404</title>"), (404, ""), (410, "")):
            with self.subTest(status=status):
                repository = PairRepository()
                self.run_update(repository, FetchResult(C, html, status_code=status))
                self.assertEqual(repository.original.availability, "unavailable")
                self.assertTrue(repository.original.store_active)
                self.assertEqual(len(repository.removals), 1)
                self.assertEqual(len(repository.rows), 1)

    def test_browser_redirect_is_independently_processed(self):
        repository = PairRepository()
        browser = Mock(return_value=FetchResult(C, product_html()))
        self.run_update(repository, FetchResult(B, "<html></html>"), browser_fetcher=browser)
        self.assertIn(502, repository.rows)
        self.assertEqual(repository.rows[502].item_id, 99)
        self.assertFalse(repository.original.store_active)

    def test_fragment_only_update_keeps_original_identity(self):
        repository = PairRepository()
        _, matcher, classified = self.run_update(repository, FetchResult(B + "#buy", product_html("Catan", "CATAN")))
        self.assertEqual(len(repository.changed_updates), 1)
        self.assertEqual(repository.changed_updates[0].item_id, 77)
        self.assertTrue(repository.original.store_active)
        self.assertEqual(matcher.inputs, [])
        self.assertEqual(classified, [])

    def test_finalization_failure_then_retry_can_activate_prepared_hidden_pair(self):
        repository = PairRepository()
        repository.lease_valid = False
        self.run_update(repository, FetchResult(C, product_html()))
        self.assertTrue(repository.rows[502].processing_error)
        self.assertTrue(repository.original.store_active)
        repository.lease_valid = True
        _, matcher, classified = self.run_update(repository, FetchResult(C, product_html()))
        self.assertEqual(len(matcher.inputs), 1)
        self.assertEqual(len(repository.rows), 2)
        self.assertFalse(repository.original.store_active)
        self.assertTrue(repository.rows[502].store_active)

    def test_manual_cancellation_after_matcher_keeps_target_retryable_until_successful_retry(self):
        repository = PairRepository()
        token = CancellationToken()

        class CancellingMatcher(IndependentMatcher):
            def process_candidate(self, candidate_id, record):
                super().process_candidate(candidate_id, record)
                token.cancel()

        with self.assertRaises(OperationCancelled):
            self.run_update(repository, FetchResult(C, product_html()), manual=True,
                            matcher=CancellingMatcher(repository), cancellation_token=token)

        self.assertTrue(repository.original.store_active)
        self.assertEqual(repository.original.availability, "available")
        self.assertEqual(repository.finalizations, [])
        self.assertFalse(repository.rows[502].store_active)
        self.assertTrue(repository.rows[502].processed_at)
        self.assertTrue(repository.rows[502].processing_error)

        result, matcher, classified = self.run_update(repository, FetchResult(C, product_html()), manual=True)
        self.assertEqual(len(repository.rows), 2)
        self.assertEqual(len(matcher.inputs), 1)
        self.assertEqual(len(classified), 1)
        self.assertFalse(repository.completed_reuse)
        self.assertFalse(repository.original.store_active)
        self.assertTrue(repository.rows[502].store_active)
        self.assertEqual(repository.rows[502].processing_error, "")
        self.assertEqual((len(result), result.updated_items), (1, 1))

    def test_manual_cancellation_preserves_completed_reused_target_hide(self):
        token = CancellationToken()

        class CancellingCompletedRepository(PairRepository):
            def get_completed_discovery_pair_id(self, store_id, discovered_url, target_url):
                candidate_id = super().get_completed_discovery_pair_id(store_id, discovered_url, target_url)
                if candidate_id is not None:
                    token.cancel()
                return candidate_id

        repository = CancellingCompletedRepository()
        repository.rows[502] = replace(repository.original, store_item_id=502,
                                       source_url_origin=B, source_url=C,
                                       item_id=99, store_active=False)
        with self.assertRaises(OperationCancelled):
            self.run_update(repository, FetchResult(C, product_html()), manual=True, cancellation_token=token)

        self.assertTrue(repository.completed_reuse)
        self.assertTrue(repository.original.store_active)
        self.assertFalse(repository.rows[502].store_active)
        self.assertEqual(repository.rows[502].processing_error, "")
        self.assertEqual(repository.finalizations, [])

    def test_same_product_redirect_still_uses_independent_matcher(self):
        repository = PairRepository()
        _, matcher, _ = self.run_update(repository, FetchResult(C, product_html("Catan", "CATAN")),
                                       matcher=IndependentMatcher(repository, item_id=77))
        self.assertEqual(len(matcher.inputs), 1)
        self.assertIsNone(matcher.inputs[0].item_id)
        self.assertEqual(repository.rows[502].item_id, 77)
        self.assertEqual(repository.original.item_id, 77)

    def test_failed_hidden_pair_is_reprocessed(self):
        repository = PairRepository()
        repository.rows[502] = replace(repository.original, store_item_id=502,
                                       source_url_origin=B, source_url=C, item_id=None,
                                       store_active=False, processing_error="matcher failed")
        _, matcher, _ = self.run_update(repository, FetchResult(C, product_html()))
        self.assertEqual(len(matcher.inputs), 1)
        self.assertEqual(len(repository.rows), 2)
        self.assertTrue(repository.rows[502].store_active)

    def test_multiple_origins_prefer_one_visible_target(self):
        repository = PairRepository(origin=A)
        repository.rows[503] = replace(repository.original, store_item_id=503,
                                       source_url_origin="https://example.test/product/another",
                                       source_url=C, item_id=99)
        self.run_update(repository, FetchResult(C, product_html()))
        self.assertEqual([row.store_item_id for row in repository.rows.values() if row.store_active], [503])

    def test_amazon_same_asin_stays_routine_but_other_product_is_independent(self):
        asin = "B008EK6XEK"
        other_asin = "B0D36CJG6N"
        for platform in ("amazon", "amazon_brand"):
            for source_asin, final_asin in ((asin, asin), (asin, other_asin), (None, other_asin)):
                with self.subTest(platform=platform, source_asin=source_asin, final_asin=final_asin):
                    repository = PairRepository()
                    repository.original.source_url = ("https://www.amazon.com.mx/dp/" + source_asin
                                                      if source_asin else "https://www.amazon.com.mx/product/old")
                    repository.original.store_sku = source_asin or ""
                    html = ('<span id="productTitle">Azul</span><span class="a-offscreen">$499.00</span>'
                            '<input id="add-to-cart-button" type="submit"><div>ASIN: ' + final_asin + '</div>')
                    self.run_update(repository, FetchResult(
                        "https://www.amazon.com.mx/Azul/dp/" + final_asin, html), platform=platform)
                    if source_asin == final_asin:
                        self.assertEqual(len(repository.changed_updates), 1)
                        self.assertEqual(len(repository.rows), 1)
                    else:
                        self.assertIn(502, repository.rows)
                        self.assertEqual(repository.rows[502].item_id, 99)
                        self.assertFalse(repository.original.store_active)

    def test_amazon_redirect_with_missing_target_asin_keeps_original_retryable(self):
        repository = PairRepository()
        repository.original.source_url = "https://www.amazon.com.mx/dp/B008EK6XEK"
        self.run_update(repository, FetchResult("https://www.amazon.com.mx/s?k=dobble", "<h1>Amazon</h1>"),
                        platform="amazon")
        self.assertTrue(repository.original.store_active)
        self.assertEqual(repository.original.availability, "available")
        self.assertEqual(len(repository.failures), 1)

    def test_preparation_persistence_failure_rolls_back_before_retry_logging(self):
        repository = PairRepository()
        repository.persistence_error = True
        repository.connection = Mock()
        self.run_update(repository, FetchResult(C, product_html()))
        self.assertEqual(repository.connection.rollback.call_count, 1)
        self.assertEqual(len(repository.failures), 1)
        self.assertTrue(repository.original.store_active)

    def test_redirect_handler_setup_defers_discovery_ai_configuration(self):
        with patch("ludora.operations._resolve_item_classifier") as classifier:
            handler = create_item_update_redirect_handler(PairRepository(), current_env={}, env_file="test.env")
            self.assertTrue(callable(handler))
            classifier.assert_not_called()

    def test_redirect_target_browser_429_preserves_store_cooldown(self):
        repository = PairRepository()
        browser = Mock(return_value=FetchResult(C, "", status_code=429, retry_after_seconds=60))
        self.run_update(repository, FetchResult(C, product_html("website uses cookies")),
                        browser_fetcher=browser, platform="woocommerce")
        self.assertTrue(repository.original.store_active)
        self.assertEqual(repository.original.availability, "available")
        self.assertEqual(repository.failures[0]["http_status"], 429)
        self.assertIsNotNone(repository.failures[0]["store_blocked_until"])

    def test_non_boardgame_redirect_is_not_attached_to_original_game(self):
        repository = PairRepository()
        self.run_update(repository, FetchResult(C, product_html("Chess T-shirt", "SHIRT")), boardgame=False)
        self.assertFalse(repository.original.store_active)
        self.assertIsNone(repository.rows[502].item_id)
        self.assertFalse(repository.rows[502].is_boardgame)
        self.assertEqual(repository.original.item_id, 77)

    def test_redirect_target_timeout_keeps_original_retryable(self):
        repository = PairRepository()
        browser = Mock(side_effect=TimeoutError("browser timed out"))
        self.run_update(repository, FetchResult(C, product_html("website uses cookies")), browser_fetcher=browser)
        self.assertTrue(repository.original.store_active)
        self.assertEqual(repository.original.availability, "available")
        self.assertEqual(len(repository.failures), 1)


if __name__ == "__main__":
    unittest.main()
