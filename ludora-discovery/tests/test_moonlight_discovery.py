import errno
import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.cancellation import CancellationToken, OperationCancelled
from ludora.inventory import collect_store_inventory
from ludora.operations import run_item_discovery
from ludora.product_crawler import crawl_store_product_details
from ludora.product_discovery_throttle import ProductDiscoveryRequestThrottle
from ludora.sitemap_discovery import discover_product_urls_from_sitemaps
from ludora.supervised_browser import BrowserFetchFailed
from ludora.webfetch import FetchResult


STORE = "https://moonlightgamestore.com/"
ACCEPTED_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/149.0.7827.55 Safari/537.36"
)
COLLECTOR_USER_AGENT = "LudoraStoreCollector/1.0 (+https://admin.ludora.bobbycrimson.com/crawler)"


def urlset(*urls):
    return "<urlset>" + "".join(f"<url><loc>{url}</loc></url>" for url in urls) + "</urlset>"


def sitemapindex(*urls):
    return "<sitemapindex>" + "".join(f"<sitemap><loc>{url}</loc></sitemap>" for url in urls) + "</sitemapindex>"


PRODUCT_HTML = '<script type="application/ld+json">{"@type":"Product","name":"Catan"}</script>'


class Response:
    def __init__(self, url, text):
        self.url = url
        self.text = text
        self.status = 200
        self.headers = Message()
        self.headers["content-type"] = "application/xml" if url.endswith(".xml") else "text/html"

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        pass

    def read(self):
        return self.text.encode("utf-8")

    def geturl(self):
        return self.url


class Transport:
    """Record emitted HTTP requests; replace only the external network boundary."""
    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        result = self.routes.get(request.full_url, 404)
        if result == "refused":
            raise URLError(ConnectionRefusedError(errno.ECONNREFUSED, "Connection refused"))
        if isinstance(result, int):
            raise HTTPError(request.full_url, result, "HTTP failure", Message(), None)
        if isinstance(result, tuple):
            return Response(*result)
        return Response(request.full_url, result)

    @property
    def urls(self):
        return [request.full_url for request in self.requests]

    def patches(self):
        stack = ExitStack()
        stack.enter_context(patch("ludora.sitemap_discovery.urlopen", side_effect=self.open))
        stack.enter_context(patch("ludora.webfetch.urlopen", side_effect=self.open))
        return stack


class Repository:
    def __init__(self):
        self.records = []

    def discovery_url_exists(self, *_args):
        return False

    def observe_discovery_pair(self, *_args):
        return False

    def prepare_discovery_pair(self, record):
        self.records.append(record)
        return SimpleNamespace(candidate_id=len(self.records), created=True, should_process=False)

    def complete_discovery_pair(self, *_args, **_kwargs):
        return True


class Trace:
    def __init__(self):
        self.events = []

    def log(self, event, **fields):
        self.events.append((event, fields))


class Browser:
    def __init__(self, results):
        self.results = results
        self.urls = []
        self.last_failure = None

    def fetch(self, url):
        self.urls.append(url)
        value = self.results.get(url)
        self.last_failure = None
        if isinstance(value, Exception):
            raise value
        if value == "refused":
            self.last_failure = {"error_type": "Error", "error": "net::ERR_CONNECTION_REFUSED"}
            return None
        return value


class MoonlightDiscoveryTests(unittest.TestCase):
    def crawl(self, transport, *, browser=None, trace=None, before=None):
        repository = Repository()
        transport.routes.setdefault(STORE + "product-sitemap.xml", urlset())
        with transport.patches():
            records = crawl_store_product_details(
                STORE, 65, repository, platform="woocommerce", item_classifier=lambda record: record,
                browser_fetch_enabled=browser is not None,
                browser_fetcher=browser.fetch if browser else None, trace_logger=trace,
                before_product_request=before,
            )
        return records, repository

    def operation_patches(self, transport):
        repository, coordinator, trace = Mock(), Mock(), Trace()
        coordinator.try_acquire_item_discovery_coordinator_lock.return_value = True
        repository.discovery_url_exists.return_value = False
        repository.observe_discovery_pair.return_value = False
        repository.prepare_discovery_pair.return_value = SimpleNamespace(candidate_id=1, created=True, should_process=False)
        stack = transport.patches()
        stack.enter_context(patch("ludora.operations.resolve_database_url", return_value="postgresql://test"))
        stack.enter_context(patch("ludora.operations.connect_database", side_effect=[Mock(), Mock()]))
        stack.enter_context(patch("ludora.operations.DiscoveryRepository", side_effect=[coordinator, repository]))
        stack.enter_context(patch("ludora.operations.create_item_discovery_trace_logger", return_value=trace))
        stack.enter_context(patch("ludora.operations.resolve_browser_fetch_enabled", return_value=False))
        stack.enter_context(patch("ludora.operations.resolve_web_bot_auth_enabled", return_value=False))
        stack.enter_context(patch("ludora.operations.resolve_admin_api_url", return_value="http://admin.test"))
        stack.enter_context(patch("ludora.operations._resolve_item_classifier", return_value=lambda record: record))
        stack.enter_context(patch("ludora.operations.AdminItemMatcher", return_value=object()))
        return stack, repository, trace

    def test_profile_reaches_root_nested_direct_and_detail_http_requests(self):
        first = STORE + "product-sitemap-1.xml"
        nested = STORE + "product-sitemap-2.xml"
        product = STORE + "producto/catan/"
        transport = Transport({STORE + "sitemap.xml": sitemapindex(first), first: sitemapindex(nested),
                               nested: urlset(product), product: PRODUCT_HTML})
        repository = Repository()
        with transport.patches():
            records = collect_store_inventory(STORE, 65, repository, platform="woocommerce",
                                              item_classifier=lambda record: record)
        self.assertEqual([record.source_url for record in records], [product])
        self.assertEqual(set(transport.urls), {STORE + "sitemap.xml", first, nested,
                                              STORE + "product-sitemap.xml", product})
        self.assertEqual({r.get_header("User-agent") for r in transport.requests}, {ACCEPTED_USER_AGENT})

    def test_homepage_fallback_and_detail_use_configured_profile(self):
        product = STORE + "producto/catan/"
        transport = Transport({STORE + "sitemap.xml": urlset(), STORE: f'<a href="{product}">Catan</a>',
                               product: PRODUCT_HTML})
        with patch.dict(os.environ, {"LUDORA_MOONLIGHT_USER_AGENT": "Configured Chromium"}):
            records, _ = self.crawl(transport)
        self.assertEqual([record.source_url for record in records], [product])
        self.assertIn(STORE, transport.urls)
        self.assertEqual({r.get_header("User-agent") for r in transport.requests}, {"Configured Chromium"})

    def test_www_alias_uses_profile_but_substrings_and_other_subdomains_do_not(self):
        for store, expected in [
            ("https://www.moonlightgamestore.com/", ACCEPTED_USER_AGENT),
            ("https://moonlightgamestore.com.evil.example/", COLLECTOR_USER_AGENT),
            ("https://other.example/moonlightgamestore.com/", COLLECTOR_USER_AGENT),
            ("https://shop.moonlightgamestore.com/", COLLECTOR_USER_AGENT),
        ]:
            with self.subTest(store=store):
                root = urljoin(store, "/sitemap.xml")
                transport = Transport({root: urlset()})
                with transport.patches():
                    discover_product_urls_from_sitemaps(store)
                self.assertEqual(transport.requests[0].get_header("User-agent"), expected)

    def test_shopify_signed_sitemap_headers_remain_unchanged(self):
        product = STORE + "products/catan"
        transport = Transport({STORE + "sitemap.xml": urlset(product)})
        repository = Repository()
        repository.discovery_url_exists = lambda *_args: True
        with transport.patches():
            records = collect_store_inventory(STORE, 65, repository, platform="shopify",
                request_headers_provider=lambda url: {"Signature": "signed:" + url, "User-Agent": "Signed bot"})
        self.assertEqual(records, [])
        for request in transport.requests:
            self.assertEqual(request.get_header("Signature"), "signed:" + request.full_url)
            self.assertEqual(request.get_header("User-agent"), "Signed bot")

    def test_403_at_each_sitemap_stage_stops_without_browser_or_homepage(self):
        nested = STORE + "product-sitemap-nested.xml"
        for blocked in [STORE + "sitemap.xml", nested, STORE + "product-sitemap.xml"]:
            with self.subTest(blocked=blocked):
                transport = Transport({STORE + "sitemap.xml": sitemapindex(nested), nested: urlset(), blocked: 403})
                browser = Browser({})
                trace = Trace()
                with self.assertRaisesRegex(RuntimeError, "Moonlight.*HTTP 403"):
                    self.crawl(transport, browser=browser, trace=trace)
                self.assertEqual(transport.urls[-1], blocked)
                self.assertEqual(browser.urls, [])
                self.assertNotIn(STORE, transport.urls)
                self.assertNotIn("inventory.crawl.completed", [event for event, _ in trace.events])

    def test_product_403_stops_before_browser_or_next_product_and_preserves_saved_progress(self):
        saved, blocked, untouched = [STORE + "producto/" + name for name in ["saved", "blocked", "untouched"]]
        transport = Transport({STORE + "sitemap.xml": urlset(saved, blocked, untouched),
                               STORE + "product-sitemap.xml": urlset(),
                               saved: PRODUCT_HTML, blocked: 403, untouched: PRODUCT_HTML})
        repository, trace, browser = Repository(), Trace(), Browser({})
        with transport.patches(), self.assertRaisesRegex(RuntimeError, "Moonlight.*HTTP 403"):
            crawl_store_product_details(STORE, 65, repository, platform="woocommerce",
                item_classifier=lambda record: record, browser_fetch_enabled=True,
                browser_fetcher=browser.fetch, trace_logger=trace)
        self.assertEqual([record.source_url for record in repository.records], [saved])
        self.assertEqual(transport.urls[-1], blocked)
        self.assertEqual(browser.urls, [])
        self.assertNotIn("inventory.crawl.completed", [event for event, _ in trace.events])

    def test_three_static_connection_refusals_stop_before_fourth_product(self):
        products = [STORE + f"producto/{i}" for i in range(4)]
        transport = Transport({STORE + "sitemap.xml": urlset(*products), **dict.fromkeys(products, "refused")})
        with self.assertRaisesRegex(RuntimeError, "Moonlight.*3 consecutive connection refusals"):
            self.crawl(transport)
        self.assertEqual(transport.urls[-3:], products[:3])
        self.assertNotIn(products[3], transport.urls)

    def test_sitemap_refusals_are_bounded_across_root_direct_and_homepage(self):
        transport = Transport(dict.fromkeys([STORE + "sitemap.xml", STORE + "product-sitemap.xml", STORE], "refused"))
        with self.assertRaisesRegex(RuntimeError, "Moonlight.*3 consecutive connection refusals"):
            self.crawl(transport)
        self.assertEqual(transport.urls, [STORE + "sitemap.xml", STORE + "product-sitemap.xml", STORE])

    def test_supervised_browser_sitemap_refusal_does_not_abort_before_threshold(self):
        product = STORE + "producto/catan"
        transport = Transport({STORE + "sitemap.xml": "refused", STORE + "product-sitemap.xml": urlset(product),
                               product: PRODUCT_HTML})
        browser = Browser({STORE + "sitemap.xml": BrowserFetchFailed("net::ERR_CONNECTION_REFUSED")})
        try:
            records, _ = self.crawl(transport, browser=browser)
        except BrowserFetchFailed as exc:
            self.fail(f"One observed browser refusal must allow the next sitemap: {exc}")
        self.assertEqual([record.source_url for record in records], [product])

    def test_sitemap_static_and_browser_refusals_share_threshold(self):
        transport = Transport({STORE + "sitemap.xml": "refused", STORE + "product-sitemap.xml": "refused"})
        browser = Browser({STORE + "sitemap.xml": "refused"})
        with self.assertRaisesRegex(RuntimeError, "Moonlight.*3 consecutive connection refusals"):
            self.crawl(transport, browser=browser)
        self.assertEqual(browser.urls, [STORE + "sitemap.xml"])
        self.assertNotIn(STORE, transport.urls)

    def test_browser_refusals_count_once_and_third_refusal_prevents_further_fallback(self):
        products = [STORE + f"producto/{i}" for i in range(3)]
        transport = Transport({STORE + "sitemap.xml": urlset(*products), **dict.fromkeys(products, "refused")})
        browser = Browser(dict.fromkeys(products, "refused"))
        with self.assertRaisesRegex(RuntimeError, "Moonlight.*3 consecutive connection refusals"):
            self.crawl(transport, browser=browser)
        self.assertEqual(browser.urls, [products[0]])
        self.assertEqual(transport.urls[-2:], products[:2])

    def test_successful_detail_access_resets_refusals_and_rendering_fallback_remains_available(self):
        products = [STORE + f"producto/{i}" for i in range(5)]
        routes = dict.fromkeys(products, "refused")
        routes.update({STORE + "sitemap.xml": urlset(*products), products[2]: PRODUCT_HTML})
        transport = Transport(routes)
        try:
            records, _ = self.crawl(transport)
        except RuntimeError as exc:
            self.fail(f"Isolated refusals must allow later successful access: {exc}")
        self.assertEqual([record.source_url for record in records], [products[2]])
        self.assertEqual(transport.urls[-5:], products)

        transport = Transport({STORE + "sitemap.xml": urlset(products[0]), products[0]: "<html>render me</html>"})
        browser = Browser({products[0]: FetchResult(url=products[0], text=PRODUCT_HTML)})
        records, _ = self.crawl(transport, browser=browser)
        self.assertEqual([record.title for record in records], ["Catan"])
        self.assertEqual(browser.urls, [products[0]])

    def test_successful_nested_sitemap_access_resets_refusals(self):
        nested = [STORE + f"product-sitemap-{i}.xml" for i in range(5)]
        product = STORE + "producto/catan"
        routes = dict.fromkeys(nested, "refused")
        routes.update({STORE + "sitemap.xml": sitemapindex(*nested), nested[2]: urlset(),
                       STORE + "product-sitemap.xml": urlset(product), product: PRODUCT_HTML})
        records, _ = self.crawl(Transport(routes))
        self.assertEqual([record.source_url for record in records], [product])

    def test_successful_browser_access_resets_prior_static_and_browser_refusals(self):
        products = [STORE + f"producto/{i}" for i in range(4)]
        transport = Transport({STORE + "sitemap.xml": urlset(*products),
                               products[0]: "refused", products[1]: "<html>render me</html>",
                               products[2]: "refused", products[3]: PRODUCT_HTML})
        browser = Browser({products[0]: "refused", products[1]: FetchResult(url=products[1], text=PRODUCT_HTML),
                           products[2]: "refused"})
        records, _ = self.crawl(transport, browser=browser)
        self.assertEqual([record.source_url for record in records], [products[1], products[3]])

    def test_moonlight_redirect_pair_records_requested_and_final_url(self):
        requested, final = STORE + "producto/old-catan", STORE + "producto/new-catan"
        transport = Transport({STORE + "sitemap.xml": urlset(requested), requested: (final, PRODUCT_HTML)})
        records, _ = self.crawl(transport)
        self.assertEqual(records[0].source_url_origin, requested)
        self.assertEqual(records[0].source_url, final)

    def test_isolated_other_http_error_keeps_browser_fallback(self):
        product = STORE + "producto/catan"
        transport = Transport({STORE + "sitemap.xml": urlset(product), product: 401})
        browser = Browser({product: FetchResult(url=product, text=PRODUCT_HTML)})
        records, _ = self.crawl(transport, browser=browser)
        self.assertEqual([record.title for record in records], ["Catan"])

    def test_cancellation_still_stops_before_product_fetch(self):
        product = STORE + "producto/catan"
        transport = Transport({STORE + "sitemap.xml": urlset(product), product: PRODUCT_HTML})
        token = CancellationToken()

        def before(_url):
            token.cancel()
            token.raise_if_cancelled()

        with transport.patches(), self.assertRaises(OperationCancelled):
            crawl_store_product_details(STORE, 65, Repository(), cancellation_token=token,
                                        before_product_request=before)
        self.assertNotIn(product, transport.urls)

    def test_operations_records_access_stop_as_failed_with_partial_counts(self):
        saved, blocked = STORE + "producto/saved", STORE + "producto/blocked"
        transport = Transport({STORE + "sitemap.xml": urlset(saved, blocked), saved: PRODUCT_HTML, blocked: 403})
        stack, repository, trace = self.operation_patches(transport)
        with stack:
            with self.assertRaisesRegex(RuntimeError, "Moonlight.*HTTP 403"):
                run_item_discovery(store_id=65, website_url=STORE, platform="woocommerce", run_id="moonlight-test",
                                   product_request_throttle=Mock())
        result = repository.complete_store_item_discovery_log.call_args.kwargs
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["items_discovered"], 1)
        self.assertEqual(result["new_items"], 1)
        self.assertEqual(result["unconfirmed_non_boardgames"], 1)
        self.assertEqual(trace.events[-1][0], "item_discovery.run.failed")
        self.assertEqual(trace.events[-1][1]["error_type"], "StoreDiscoveryAccessStopped")
        self.assertNotIn("item_discovery.run.completed", [event for event, _ in trace.events])

    def test_operation_uses_user_agent_from_explicit_environment_and_env_file(self):
        product = STORE + "producto/catan"
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            env_file = Path(folder) / "profile.env"
            env_file.write_text('LUDORA_MOONLIGHT_USER_AGENT="Validated file identity"\n', encoding="utf-8")
            for env, expected in [({}, "Validated file identity"),
                                  ({"LUDORA_MOONLIGHT_USER_AGENT": " Validated env identity "}, "Validated env identity")]:
                with self.subTest(env=env):
                    transport = Transport({STORE + "sitemap.xml": urlset(product), product: PRODUCT_HTML})
                    stack, _, _ = self.operation_patches(transport)
                    with stack:
                        run_item_discovery(store_id=65, website_url=STORE, platform="woocommerce", run_id="profile-test",
                            env=env, env_file=str(env_file), product_request_throttle=Mock())
                    self.assertEqual({r.get_header("User-agent") for r in transport.requests}, {expected})

    def test_operation_retains_three_second_product_pacing(self):
        products = [STORE + f"producto/{i}" for i in range(3)]
        transport = Transport({STORE + "sitemap.xml": urlset(*products), **dict.fromkeys(products, PRODUCT_HTML)})
        current_time = [0.0]
        waited = []

        def wait(seconds, _token):
            waited.append(seconds)
            current_time[0] += seconds

        throttle = ProductDiscoveryRequestThrottle(clock=lambda: current_time[0], waiter=wait)
        stack, _, _ = self.operation_patches(transport)
        with stack:
            run_item_discovery(store_id=65, website_url=STORE, platform="woocommerce", run_id="pacing-test",
                               product_request_throttle=throttle)
        self.assertEqual(waited, [3.0, 3.0])


if __name__ == "__main__":
    unittest.main()
