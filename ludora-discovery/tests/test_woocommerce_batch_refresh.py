import json
import sys
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlparse


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora import continuous_update_worker
from ludora.database import ClaimedStoreItemUpdate, DiscoveryRepository
from ludora.models import DiscoveryItemCandidateRecord
from ludora.product_crawler import TransientProductFetchError
from ludora.webfetch import FetchResult
from test_database import FakeConnection
from batch_target_query_fixture import BatchTargetSelectConnection, batch_target_row


ORIGIN = "https://chocitajuegos.com"
ENDPOINT = ORIGIN + "/wp-json/wc/store/v1/products"


def product(slug, product_id=100, **changes):
    value = {
        "id": product_id,
        "slug": slug,
        "permalink": ORIGIN + "/juego/" + slug + "/",
        "type": "simple",
        "prices": {
            "price": "770",
            "regular_price": "850",
            "sale_price": "770",
            "price_range": None,
            "currency_code": "MXN",
            "currency_minor_unit": 0,
        },
        "is_in_stock": True,
        "is_purchasable": True,
    }
    value.update(changes)
    return value


def claim(slug="long-shot", store_item_id=501, store_id=17):
    record = DiscoveryItemCandidateRecord(
        store_id=store_id,
        store_item_id=store_item_id,
        source_url=ORIGIN + "/juego/" + slug + "/",
        source_listing_url=ORIGIN + "/juegos/",
        title="Preserved title",
        original_title="Preserved original title",
        image_url="https://images.test/original.webp",
        store_sku="preserved-sku",
        item_id=77,
        listing_status="LISTED",
        store_active=True,
        is_boardgame=True,
        is_boardgame_confirmed=True,
        price="720",
        raw_price="$720",
        currency="MXN",
        availability="out_of_stock",
        raw_payload={"keep": "original"},
    )
    return ClaimedStoreItemUpdate(
        attempt_id=91,
        consecutive_failures=0,
        lease_token="ee2bf2df-2330-430b-8f65-ad41dad4dc62",
        platform="woocommerce",
        record=record,
        store_consecutive_429s=0,
        store_name="Chocita Juegos",
        canonical_domain="chocitajuegos.com",
    )


class Clock:
    def __init__(self):
        self.now = 0.0
        self.waits = []

    def __call__(self):
        return self.now

    def wait(self, seconds):
        self.waits.append(seconds)
        self.now += seconds


class Targets:
    def __init__(self, claims):
        self.claims = claims
        self.calls = []

    def list_store_item_update_batch_targets(self, **kwargs):
        self.calls.append(kwargs)
        return [(target.record.store_item_id, target.record.source_url) for target in self.claims]


class Transport:
    def __init__(self, products):
        self.products = products
        self.urls = []
        self.status = 200
        self.retry_after = None
        self.response_url = None

    def __call__(self, url):
        self.urls.append(url)
        return FetchResult(
            url=self.response_url or url,
            text=json.dumps(self.products),
            status_code=self.status,
            retry_after_seconds=self.retry_after,
        )


class WooCommerceBatchRefreshTests(unittest.TestCase):
    def setUp(self):
        self.adapter_type = continuous_update_worker.ChocitaBatchRefresher
        self.clock = Clock()
        self.first = claim()
        self.second = claim("catan", 502)
        self.targets = Targets([self.first, self.second])
        self.transport = Transport([product("long-shot"), product("catan", 101)])
        self.adapter = self.adapter_type(
            self.targets,
            fetcher=self.transport,
            clock=self.clock,
            waiter=self.clock.wait,
        )

    def test_two_individual_claims_share_one_targeted_response_and_preserve_identity(self):
        refreshed = self.adapter.refresh(self.first)
        second = self.adapter.refresh(self.second)

        self.assertEqual(len(self.transport.urls), 1)
        query = parse_qs(urlparse(self.transport.urls[0]).query)
        self.assertEqual(query["slug"], ["long-shot,catan"])
        self.assertEqual(query["per_page"], ["100"])
        self.assertEqual(refreshed.price, "770")
        self.assertEqual(refreshed.availability, "available")
        self.assertEqual(second.price, "770")
        for field in ("title", "original_title", "image_url", "store_sku", "item_id", "listing_status",
                      "source_url", "source_url_origin", "store_active", "is_boardgame_confirmed", "raw_payload"):
            self.assertEqual(getattr(refreshed, field), getattr(self.first.record, field), field)
        self.assertEqual(self.first.record.price, "720")
        self.assertEqual(self.clock.waits, [])

    def test_current_sale_price_uses_returned_currency_minor_unit(self):
        for minor_unit, raw_price, expected in ((0, "770", "770"), (1, "7705", "770.5"), (2, "77050", "770.5")):
            with self.subTest(minor_unit=minor_unit):
                value = product("long-shot")
                value["prices"].update(price=raw_price, currency_minor_unit=minor_unit, regular_price="99999")
                self.transport.products = [value]
                adapter = self.adapter_type(self.targets, fetcher=self.transport, clock=self.clock, waiter=self.clock.wait)
                self.assertEqual(adapter.refresh(self.first).price, expected)

    def test_price_is_bounded_to_existing_numeric_12_2_storage(self):
        cases = (
            ("9999999999", 0, "9999999999"),
            ("99999999999", 1, "9999999999.9"),
            ("999999999999", 2, "9999999999.99"),
            ("10000000000", 0, None),
            ("100000000000", 1, None),
            ("1000000000000", 2, None),
            ("100001", 3, None),
        )
        for raw_price, minor_unit, expected in cases:
            with self.subTest(raw_price=raw_price, minor_unit=minor_unit):
                value = product("long-shot")
                value["prices"].update(price=raw_price, currency_minor_unit=minor_unit)
                self.transport.products = [value]
                adapter = self.adapter_type(self.targets, fetcher=self.transport, clock=self.clock, waiter=self.clock.wait)
                if expected is None:
                    with self.assertRaises(RuntimeError):
                        adapter.refresh(self.first)
                else:
                    self.assertEqual(adapter.refresh(self.first).price, expected)

    def test_out_of_stock_is_successful_refresh_without_deactivation(self):
        self.transport.products = [product("long-shot", is_in_stock=False)]
        refreshed = self.adapter.refresh(self.first)
        self.assertEqual(refreshed.availability, "out_of_stock")
        self.assertTrue(refreshed.store_active)
        self.assertEqual(refreshed.listing_status, "LISTED")

    def test_routing_requires_database_domain_woocommerce_and_exact_https_origin(self):
        self.assertTrue(self.adapter.supports(self.first))
        self.assertTrue(self.adapter.supports(claim(store_id=999)))
        for changed in (
            replace(self.first, canonical_domain="other.test"),
            replace(self.first, platform="shopify"),
            replace(self.first, canonical_domain=""),
            replace(self.first, record=replace(self.first.record, source_url="http://chocitajuegos.com/juego/long-shot/")),
            replace(self.first, record=replace(self.first.record, source_url="https://other.test/juego/long-shot/")),
            replace(self.first, record=replace(self.first.record, source_url="https://chocitajuegos.com:444/juego/long-shot/")),
            replace(self.first, record=replace(self.first.record, source_url="https://user@chocitajuegos.com/juego/long-shot/")),
        ):
            with self.subTest(changed=changed):
                self.assertFalse(self.adapter.supports(changed))

    def test_expired_batch_is_refetched_and_consumed_entries_are_not_reused(self):
        self.adapter.refresh(self.first)
        self.clock.now = 600
        self.transport.products[1]["prices"]["price"] = "900"
        self.assertEqual(self.adapter.refresh(self.second).price, "900")
        self.assertEqual(len(self.transport.urls), 2)
        self.transport.products[1]["prices"]["price"] = "950"
        self.assertEqual(self.adapter.refresh(self.second).price, "950")
        self.assertEqual(len(self.transport.urls), 3)
        self.assertEqual(self.clock.waits, [15.0])

    def test_pacing_applies_to_actual_batches_and_does_not_delay_cache_hits(self):
        self.adapter.refresh(self.first)
        self.clock.now = 1
        self.adapter.refresh(self.second)
        self.assertEqual(self.clock.waits, [])
        self.adapter.refresh(self.first)
        self.assertEqual(self.clock.waits, [14.0])

    def test_missing_product_is_cached_as_failure_and_never_replaces_existing_values(self):
        self.transport.products = [product("long-shot")]
        self.adapter.refresh(self.first)
        with self.assertRaisesRegex(RuntimeError, "missing"):
            self.adapter.refresh(self.second)
        self.assertEqual(len(self.transport.urls), 1)
        self.assertEqual(self.second.record.price, "720")

    def test_identity_uses_exact_permalink_not_slug_sku_or_name(self):
        for url in (ORIGIN + "/juego/long-shot", ORIGIN + "/juego/long-shot/?x=1", "https://foreign.test/juego/long-shot/"):
            with self.subTest(url=url):
                self.transport.products = [product("long-shot", permalink=url, name=self.first.record.title, sku=self.first.record.store_sku)]
                adapter = self.adapter_type(self.targets, fetcher=self.transport, clock=self.clock, waiter=self.clock.wait)
                with self.assertRaises(RuntimeError):
                    adapter.refresh(self.first)

    def test_duplicate_permalink_or_product_id_rejects_ambiguous_targets(self):
        for payload in (
            [product("long-shot"), product("long-shot", 101)],
            [product("long-shot"), product("catan")],
        ):
            with self.subTest(payload=payload):
                self.transport.products = payload
                adapter = self.adapter_type(self.targets, fetcher=self.transport, clock=self.clock, waiter=self.clock.wait)
                with self.assertRaisesRegex(RuntimeError, "duplicate"):
                    adapter.refresh(self.first)

    def test_invalid_api_values_fail_without_partial_record_changes(self):
        invalid = [
            {"type": "variable"}, {"is_in_stock": "yes"}, {"is_purchasable": False},
            {"prices": {}}, {"prices": None}, {"id": True}, {"id": 0},
        ]
        for field, value in (
            ("price", ""), ("price", "-1"), ("price", "0"), ("price", "1.5"), ("price", "NaN"),
            ("price", "999999999999"), ("currency_minor_unit", True), ("currency_minor_unit", "0"),
            ("currency_minor_unit", 3), ("currency_minor_unit", -1), ("currency_code", "USD"),
            ("price_range", {"min_amount": "100", "max_amount": "200"}),
        ):
            prices = dict(product("long-shot")["prices"])
            prices[field] = value
            invalid.append({"prices": prices})
        prices = dict(product("long-shot")["prices"])
        del prices["price_range"]
        invalid.append({"prices": prices})
        for changes in invalid:
            with self.subTest(changes=changes):
                self.transport.products = [product("long-shot", **changes)]
                adapter = self.adapter_type(self.targets, fetcher=self.transport, clock=self.clock, waiter=self.clock.wait)
                with self.assertRaises(RuntimeError):
                    adapter.refresh(self.first)
                self.assertEqual(self.first.record.price, "720")
                self.assertEqual(self.first.record.availability, "out_of_stock")

    def test_foreign_response_origin_and_malformed_payload_are_rejected(self):
        for response_url, payload in (("https://foreign.test/products", []), (ENDPOINT, {"error": "blocked"})):
            with self.subTest(response_url=response_url):
                self.transport.response_url = response_url
                self.transport.products = payload
                adapter = self.adapter_type(self.targets, fetcher=self.transport, clock=self.clock, waiter=self.clock.wait)
                with self.assertRaises(RuntimeError):
                    adapter.refresh(self.first)

    def test_429_preserves_status_retry_after_and_invalidates_all_cached_results(self):
        self.adapter.refresh(self.first)
        self.transport.status = 429
        self.transport.retry_after = 7200
        with self.assertRaises(TransientProductFetchError) as raised:
            self.adapter.refresh(self.first)
        self.assertEqual(raised.exception.status_code, 429)
        self.assertEqual(raised.exception.retry_after_seconds, 7200)
        self.assertEqual(len(self.transport.urls), 2)
        self.transport.status = 200
        self.adapter.refresh(self.second)
        self.assertEqual(len(self.transport.urls), 3)

    def test_transport_429_exception_also_discards_previous_unconsumed_results(self):
        calls = []

        def transport(url):
            calls.append(url)
            if len(calls) == 2:
                raise TransientProductFetchError("HTTP 429", status_code=429, retry_after_seconds=7200)
            return self.transport(url)

        adapter = self.adapter_type(self.targets, fetcher=transport, clock=self.clock, waiter=self.clock.wait)
        adapter.refresh(self.first)
        with self.assertRaises(TransientProductFetchError):
            adapter.refresh(self.first)
        adapter.refresh(self.second)
        self.assertEqual(len(calls), 3, "A rejected batch must invalidate older cached targets")

    def test_batch_targets_and_encoded_request_url_are_bounded(self):
        targets = [claim("product-" + str(index), index + 1) for index in range(120)]
        self.targets.claims = targets
        self.transport.products = [product("product-" + str(index), index + 1) for index in range(100)]
        self.adapter.refresh(targets[0])
        for target in targets[1:100]:
            self.adapter.refresh(target)
        self.assertEqual(len(self.transport.urls), 1)
        query = parse_qs(urlparse(self.transport.urls[0]).query)
        self.assertEqual(len(query["slug"][0].split(",")), 100)
        self.assertLessEqual(len(self.transport.urls[0].encode("utf-8")), 8000)
        self.assertEqual(self.targets.calls[0]["limit"], 100)

        targets = [claim("a" * 500 + str(index), index + 1) for index in range(100)]
        self.targets.claims = targets
        self.transport.products = [product(target.record.source_url.split("/")[-2], index + 1) for index, target in enumerate(targets)]
        adapter = self.adapter_type(self.targets, fetcher=self.transport, clock=self.clock, waiter=self.clock.wait)
        adapter.refresh(targets[0])
        self.assertLessEqual(len(self.transport.urls[-1].encode("utf-8")), 8000)

    def test_cache_never_crosses_store_ids_or_reuses_data_after_source_url_changes(self):
        self.adapter.refresh(self.first)
        other_store = replace(self.second, record=replace(self.second.record, store_id=999))
        self.targets.claims = [other_store]
        self.adapter.refresh(other_store)
        self.assertEqual(len(self.transport.urls), 2)
        changed = replace(self.second, record=replace(self.second.record, source_url=ORIGIN + "/juego/new-catan/"))
        self.targets.claims = [changed]
        self.transport.products = [product("new-catan", 102)]
        self.adapter.refresh(changed)
        self.assertEqual(len(self.transport.urls), 3)

    def process_claim(self, current_claim, repository, trace=None):
        continuous_update_worker._process_claim(
            browser_fetcher=Mock(side_effect=AssertionError("No browser needed for batch refresh")),
            claim=current_claim,
            item_title_extractor=Mock(side_effect=AssertionError("No AI needed for batch refresh")),
            job_id=17,
            repository=repository,
            request_headers_provider=None,
            run_id="continuous:test",
            throttle=Mock(),
            trace_logger=trace,
            worker_id="worker-1",
            batch_refresher=self.adapter,
        )

    def test_worker_completes_each_claim_with_lease_timestamp_schedule_and_change_audit(self):
        connection = FakeConnection(fetchone_rows=[(501,), (502,)])
        repository = DiscoveryRepository(connection)
        delegate = Mock()
        with patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate", side_effect=AssertionError("No HTML fetch")):
            for current in (self.first, self.second):
                trace = continuous_update_worker._ContextTraceLogger(delegate, store_item_id=current.record.store_item_id, update_attempt_id=current.attempt_id)
                self.process_claim(current, repository, trace)
        self.assertEqual(len(self.transport.urls), 1)
        updates = [(sql, params) for sql, params in connection.cursor_instance.executions if "set original_title" in sql]
        self.assertEqual(len(updates), 2)
        for index, (sql, params) in enumerate(updates):
            self.assertIn("refreshed_date = now()", sql)
            self.assertIn("next_update_at = null", sql)
            self.assertIn("update_lease_token = null", sql)
            self.assertIn("consecutive_update_failures = 0", sql)
            self.assertEqual(params[-2:], (501 + index, self.first.lease_token))
            self.assertIn("770", params)
        changes = [params for sql, params in connection.cursor_instance.executions if "insert into store_item_update_change_log" in sql]
        self.assertEqual({params[2] for params in changes}, {501, 502})
        self.assertIn(("price", '"720"', '"770"'), [params[3:] for params in changes])
        self.assertNotIn("title", [params[3] for params in changes])
        self.assertEqual(connection.commits, 2)
        cache_events = [entry.kwargs for entry in delegate.log.call_args_list if entry.kwargs.get("cache_hit")]
        self.assertTrue(any(entry.get("store_item_id") == 502 and entry.get("update_attempt_id") == 91 for entry in cache_events))

    def test_worker_429_uses_existing_store_retry_after_and_failure_audit_without_fallback(self):
        self.transport.status = 429
        self.transport.retry_after = 7200
        now = datetime(2026, 10, 13, 18, tzinfo=timezone.utc)
        connection = FakeConnection(fetchone_rows=[(501,)])
        repository = DiscoveryRepository(connection)
        with (
            patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate", side_effect=AssertionError("No HTML fallback")),
            patch("ludora.continuous_update_worker._utc_now", return_value=now),
            patch("ludora.continuous_update_worker.random.uniform", return_value=1.0),
        ):
            self.process_claim(self.first, repository)
        self.assertEqual(len(self.transport.urls), 1)
        updates = [(sql, params) for sql, params in connection.cursor_instance.executions if "set next_update_at" in sql]
        self.assertEqual(updates[0][1][0], now + timedelta(hours=2))
        self.assertEqual(updates[0][1][-2:], (501, self.first.lease_token))
        failures = [params for sql, params in connection.cursor_instance.executions if "set status = 'failed'" in sql]
        self.assertEqual(failures[0][0], 429)
        cooldowns = [params for sql, params in connection.cursor_instance.executions if "insert into store_item_update_store_cooldown" in sql]
        self.assertEqual(cooldowns, [("continuous", 17, now + timedelta(hours=2))])

    def test_worker_missing_api_product_fails_without_success_or_deactivation(self):
        self.transport.products = []
        connection = FakeConnection(fetchone_rows=[(501,)])
        repository = DiscoveryRepository(connection)
        with patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate", side_effect=AssertionError("No HTML fallback")):
            self.process_claim(self.first, repository)
        sql = " ".join(statement for statement, _ in connection.cursor_instance.executions)
        self.assertIn("set status = 'failed'", sql)
        self.assertNotIn("refreshed_date = now()", sql)
        self.assertNotIn("unavailable", sql)

    def test_worker_other_woocommerce_store_retains_existing_refresh_path(self):
        other = replace(self.first, canonical_domain="other.test", record=replace(self.first.record, source_url="https://other.test/products/game"))
        repository = Mock()
        with patch("ludora.continuous_update_worker.refresh_confirmed_store_item_candidate", return_value=replace(other.record, price="800")):
            self.process_claim(other, repository)
        self.assertEqual(len(self.transport.urls), 0)
        self.assertEqual(repository.complete_claimed_store_item_update.call_args.args[1].price, "800")

    def adapter_with_actual_target_select(self, current, historical, **historical_changes):
        connection = BatchTargetSelectConnection([
            batch_target_row(current.record, update_lease_token=current.lease_token, update_lease_expires_at="2026-10-13T19:00:00+00:00"),
            batch_target_row(historical, **historical_changes),
        ])
        self.addCleanup(connection.close)
        return self.adapter_type(
            DiscoveryRepository(connection),
            fetcher=self.transport,
            clock=self.clock,
            waiter=self.clock.wait,
        )

    def refresh_unambiguous_target(self, adapter, current):
        try:
            return adapter.refresh(current)
        except RuntimeError as exc:
            self.fail(f"An unambiguous active product must remain refreshable: {exc}")

    def test_active_direct_product_refreshes_with_inactive_completed_redirect_history(self):
        historical = replace(
            self.first.record,
            store_item_id=502,
            source_url_origin=ORIGIN + "/juego/old-long-shot/",
            store_active=False,
            processed_at="2026-10-01T00:00:00+00:00",
        )
        adapter = self.adapter_with_actual_target_select(self.first, historical)

        refreshed = self.refresh_unambiguous_target(adapter, self.first)

        self.assertEqual(refreshed.price, "770")
        self.assertEqual(refreshed.availability, "available")
        self.assertEqual(refreshed.store_item_id, 501)
        self.assertIsNone(refreshed.source_url_origin)
        self.assertTrue(refreshed.store_active)
        self.assertEqual(len(self.transport.urls), 1)

    def test_active_redirect_product_refreshes_with_inactive_direct_history(self):
        current = replace(self.first, record=replace(self.first.record, source_url_origin=ORIGIN + "/juego/old-long-shot/"))
        historical = replace(self.first.record, store_item_id=502, store_active=False, processed_at="2026-10-01T00:00:00+00:00")
        adapter = self.adapter_with_actual_target_select(current, historical)

        refreshed = self.refresh_unambiguous_target(adapter, current)

        self.assertEqual(refreshed.price, "770")
        self.assertEqual(refreshed.availability, "available")
        self.assertEqual(refreshed.source_url_origin, ORIGIN + "/juego/old-long-shot/")
        self.assertEqual(refreshed.item_id, 77)
        self.assertTrue(refreshed.store_active)
        self.assertEqual(len(self.transport.urls), 1)

    def test_competing_active_representative_is_rejected_before_api_request(self):
        # An active UNLISTED representative still competes under the target
        # invariant, even though it cannot itself be selected for this refresh.
        competing = replace(self.first.record, store_item_id=502, source_url_origin=ORIGIN + "/juego/other-long-shot/", listing_status="UNLISTED")
        adapter = self.adapter_with_actual_target_select(self.first, competing)

        with self.assertRaisesRegex(RuntimeError, "no unique eligible batch source URL"):
            adapter.refresh(self.first)

        self.assertEqual(self.first.record.price, "720")
        self.assertEqual(len(self.transport.urls), 0)

    def test_rejected_history_is_not_a_competing_active_representative(self):
        rejected = replace(self.first.record, store_item_id=502, source_url_origin=ORIGIN + "/juego/rejected-long-shot/", listing_status="REJECTED")
        adapter = self.adapter_with_actual_target_select(self.first, rejected)

        self.assertEqual(self.refresh_unambiguous_target(adapter, self.first).price, "770")
        self.assertEqual(len(self.transport.urls), 1)


if __name__ == "__main__":
    unittest.main()
