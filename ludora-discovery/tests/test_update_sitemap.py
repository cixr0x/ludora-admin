import io
import sys
import tempfile
import threading
import time
import unittest
from email.message import Message
from http.client import HTTPResponse
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.cancellation import CancellationToken, OperationCancelled
from ludora.update_sitemap import UpdateSitemapChecker
from ludora.webfetch import FetchResult


ROOT = "https://shop.example/sitemap.xml"
CHILD = "https://shop.example/products.xml"
OTHER_CHILD = "https://shop.example/more-products.xml"
ORIGIN = "https://shop.example"
PRESENT = "https://shop.example/products/alpha"
MISSING = "https://shop.example/products/missing"
CONFIG = '{"7":{"url":"https://shop.example/sitemap.xml","min_urls":1}}'
ENV_KEY = "LUDORA_VERIFIED_UPDATE_SITEMAPS"


def urlset(*urls):
    entries = "".join(f"<url><loc>{url}</loc></url>" for url in urls)
    return f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{entries}</urlset>'


def index(*children):
    entries = "".join(f"<sitemap><loc>{child}</loc></sitemap>" for child in children)
    return f"<sitemapindex>{entries}</sitemapindex>"


class UpdateSitemapTests(unittest.TestCase):
    def setUp(self):
        self.now = 10.0
        self.requests = []
        self.responses = {ROOT: FetchResult(ROOT, urlset(PRESENT))}
        self.checker = self.make_checker()

    def make_checker(self, config=CONFIG, **kwargs):
        return UpdateSitemapChecker.from_environment(
            {ENV_KEY: config},
            "missing-update-sitemap-test.env",
            fetcher=self.fetch,
            clock=lambda: self.now,
            **kwargs,
        )

    def fetch(self, url, timeout):
        self.requests.append(url)
        response = self.responses[url]
        if isinstance(response, Exception):
            raise response
        return response

    def is_missing(self, source=MISSING, **kwargs):
        return self.checker.is_missing(7, source, store_url=ORIGIN, **kwargs)

    def test_direct_snapshot_checks_membership_and_reuses_fresh_evidence(self):
        self.assertFalse(self.is_missing(PRESENT))
        self.assertTrue(self.is_missing())
        self.assertEqual(self.requests, [ROOT])

    def test_index_collects_nested_urlsets_and_allows_nonproduct_page_locs(self):
        self.responses = {
            ROOT: FetchResult(ROOT, index(CHILD, OTHER_CHILD)),
            CHILD: FetchResult(CHILD, index("https://shop.example/nested.xml")),
            OTHER_CHILD: FetchResult(OTHER_CHILD, urlset(PRESENT)),
            "https://shop.example/nested.xml": FetchResult(
                "https://shop.example/nested.xml", urlset("https://shop.example/shop")
            ),
        }
        self.assertFalse(self.is_missing("https://shop.example/shop"))
        self.assertTrue(self.is_missing())
        self.assertEqual(set(self.requests), set(self.responses))

    def test_harmless_url_variants_are_treated_as_possible_presence(self):
        variants = (
            "http://WWW.shop.example:80/products/%61lpha/?utm_medium=abc#gallery",
            "https://shop.example/products//alpha",
            "https://shop.example/products/old/../alpha",
        )
        for variant in variants:
            with self.subTest(variant=variant):
                self.assertFalse(self.is_missing(variant))

    def test_invalid_candidates_wrong_store_and_unconfigured_store_do_not_fetch(self):
        for source in ("https://other.example/absent", "https://shop.example:garbage/foo",
                       "https://name@shop.example/foo", "https://shop.example/a%GG",
                       "https://shop.example:8443/a", "https://shop.example/a\\b"):
            with self.subTest(source=source):
                self.assertFalse(self.is_missing(source))
        self.assertFalse(self.checker.is_missing(8, MISSING, store_url=ORIGIN))
        self.assertFalse(self.checker.is_missing(7, MISSING, store_url="https://other.example"))
        self.assertEqual(self.requests, [])

    def test_config_uses_dotenv_and_allows_explicit_environment_disable(self):
        with tempfile.TemporaryDirectory() as directory:
            dotenv = Path(directory) / ".env"
            dotenv.write_text(f"{ENV_KEY}='{CONFIG}'\n", encoding="utf-8")
            checker = UpdateSitemapChecker.from_environment({}, dotenv, fetcher=self.fetch)
            self.assertTrue(checker.is_missing(7, MISSING, store_url=ORIGIN))
            checker = UpdateSitemapChecker.from_environment({ENV_KEY: ""}, dotenv, fetcher=self.fetch)
            self.assertFalse(checker.is_missing(7, MISSING, store_url=ORIGIN))
        self.assertEqual(self.requests, [ROOT])

    def test_invalid_config_does_not_authorize_a_negative_result(self):
        for config in ("{", "[]", '{"7":{"url":"https://shop.example/sitemap.xml","min_urls":true}}',
                       '{"7":{"url":"https://shop.example/sitemap.xml","min_urls":0}}',
                       '{"7":{"url":"https://other.example/sitemap.xml","min_urls":1}}'):
            with self.subTest(config=config):
                self.checker = self.make_checker(config)
                self.assertFalse(self.is_missing())
        self.assertEqual(self.requests, [])

    def test_duplicate_urls_do_not_satisfy_the_verified_floor(self):
        self.checker = self.make_checker(CONFIG.replace('"min_urls":1', '"min_urls":2'))
        self.responses[ROOT] = FetchResult(ROOT, urlset(PRESENT, PRESENT))
        self.assertFalse(self.is_missing())

    def test_shopify_product_handle_aliases_count_once_toward_the_floor(self):
        config = CONFIG.replace('"min_urls":1', '"min_urls":2')
        for alias in (
            "/collections/board-games/products/ALPHA",
            "/collections/board-games/%70roducts/alpha",
        ):
            with self.subTest(alias=alias):
                self.checker = self.make_checker(config)
                self.responses[ROOT] = FetchResult(ROOT, urlset(PRESENT, ORIGIN + alias))
                self.assertFalse(self.is_missing(platform="shopify"))
                self.assertTrue(self.is_missing())

    def test_shopify_floor_also_counts_distinct_nonproduct_paths(self):
        config = CONFIG.replace('"min_urls":1', '"min_urls":3')
        locations = (PRESENT, ORIGIN + "/collections/games/products/alpha", ORIGIN + "/pages/contact")
        self.checker = self.make_checker(config)
        self.responses[ROOT] = FetchResult(ROOT, urlset(*locations, ORIGIN + "/pages/contact/"))
        self.assertFalse(self.is_missing(platform="shopify"))
        self.checker = self.make_checker(config)
        self.responses[ROOT] = FetchResult(ROOT, urlset(*locations, ORIGIN + "/pages/about"))
        self.assertTrue(self.is_missing(platform="shopify"))

    def test_shopify_nonproduct_paths_alone_are_not_evidence_of_product_coverage(self):
        self.checker = self.make_checker(CONFIG.replace('"min_urls":1', '"min_urls":2'))
        self.responses[ROOT] = FetchResult(ROOT, urlset(ORIGIN + "/pages/contact", ORIGIN + "/pages/about"))
        self.assertFalse(self.is_missing(platform="shopify"))

    def test_partial_indexes_remain_unknown_despite_a_valid_nonempty_child(self):
        for bad_child in (
            FetchResult(OTHER_CHILD, "<urlset>"),
            FetchResult(OTHER_CHILD, urlset()),
            FetchResult(OTHER_CHILD, urlset("https://evil.example/bad")),
            FetchResult(OTHER_CHILD, urlset("not-a-url")),
            FetchResult(OTHER_CHILD, "<html>Just a moment...</html>"),
            FetchResult(OTHER_CHILD, urlset(PRESENT), status_code=206),
            FetchResult("https://evil.example/more-products.xml", urlset(PRESENT)),
            FetchResult(OTHER_CHILD, index(ROOT)),
            OSError("connection lost"),
        ):
            with self.subTest(bad_child=bad_child):
                self.checker = self.make_checker()
                self.responses = {
                    ROOT: FetchResult(ROOT, index(CHILD, OTHER_CHILD)),
                    CHILD: FetchResult(CHILD, urlset(PRESENT)),
                    OTHER_CHILD: bad_child,
                }
                self.assertFalse(self.is_missing())

    def test_untrusted_child_reference_is_rejected_before_fetch(self):
        self.responses[ROOT] = FetchResult(ROOT, index(CHILD, "https://evil.example/items.xml"))
        self.responses[CHILD] = FetchResult(CHILD, urlset(PRESENT))
        self.assertFalse(self.is_missing())
        self.assertEqual(self.requests, [ROOT])

    def test_distinct_children_resolving_to_one_document_do_not_establish_coverage(self):
        self.responses = {
            ROOT: FetchResult(ROOT, index(CHILD, OTHER_CHILD)),
            CHILD: FetchResult(CHILD, urlset(PRESENT)),
            OTHER_CHILD: FetchResult(CHILD, urlset(PRESENT)),
        }
        self.assertFalse(self.is_missing())

    def test_child_redirect_aliases_cannot_hide_a_duplicate_document(self):
        origin = "https://xn--bcher-kva.example"
        root, first, second = (origin + "/" + path for path in ("index.xml", "first.xml", "second.xml"))
        present = origin + "/products/alpha"
        for final in ("https://XN--BCHER-KVA.example:443/first.xml", "https://bücher.example/first.xml"):
            with self.subTest(final=final):
                config = CONFIG.replace(ROOT, root)
                checker = self.make_checker(config)
                self.responses = {
                    root: FetchResult(root, index(first, second)),
                    first: FetchResult(first, urlset(present)),
                    second: FetchResult(final, urlset(present)),
                }
                self.assertFalse(checker.is_missing(7, origin + "/products/missing", store_url=origin))

    def test_document_identity_keeps_distinct_query_strings_and_path_case(self):
        first = CHILD + "?page=1"
        second = CHILD + "?page=2"
        third = CHILD.replace("products.xml", "Products.xml") + "?page=2"
        self.responses = {
            ROOT: FetchResult(ROOT, index(first, second, third)),
            first: FetchResult(first, urlset(PRESENT)),
            second: FetchResult(second, urlset(ORIGIN + "/products/beta")),
            third: FetchResult(third, urlset(ORIGIN + "/products/gamma")),
        }
        self.assertTrue(self.is_missing())
        self.assertEqual(self.requests, [ROOT, first, second, third])

    def test_escaped_child_redirect_aliases_cannot_hide_a_duplicate_document(self):
        for first, redirected in (
            (CHILD, ORIGIN + "/%70roducts.xml"),
            (CHILD + "?page=alpha~", CHILD + "?page=%61lpha%7e"),
            (CHILD + "?page=a%2Fb", CHILD + "?page=a%2fb"),
        ):
            with self.subTest(redirected=redirected):
                self.checker = self.make_checker()
                self.responses = {
                    ROOT: FetchResult(ROOT, index(first, OTHER_CHILD)),
                    first: FetchResult(first, urlset(PRESENT)),
                    OTHER_CHILD: FetchResult(redirected, urlset(PRESENT)),
                }
                self.assertFalse(self.is_missing())

    def test_document_identity_distinguishes_reserved_escapes_from_literal_separators(self):
        first = ORIGIN + "/sitemaps%2Fproducts.xml?page=alpha%2Fbeta"
        second = ORIGIN + "/sitemaps/products.xml?page=alpha%2Fbeta"
        third = ORIGIN + "/sitemaps%2Fproducts.xml?page=alpha/beta"
        self.responses = {
            ROOT: FetchResult(ROOT, index(first, second, third)),
            first: FetchResult(first, urlset(PRESENT)),
            second: FetchResult(second, urlset(ORIGIN + "/products/beta")),
            third: FetchResult(third, urlset(ORIGIN + "/products/gamma")),
        }
        self.assertTrue(self.is_missing())
        self.assertEqual(self.requests, [ROOT, first, second, third])

    def test_expired_success_is_discarded_and_failure_is_cached_briefly(self):
        self.assertTrue(self.is_missing())
        self.now += 3600
        self.responses[ROOT] = FetchResult(ROOT, urlset(PRESENT), status_code=503)
        self.assertFalse(self.is_missing())
        self.responses[ROOT] = FetchResult(ROOT, urlset(PRESENT))
        self.assertFalse(self.is_missing())
        self.assertEqual(self.requests, [ROOT, ROOT])
        self.now += 60
        self.assertTrue(self.is_missing())
        self.assertEqual(self.requests, [ROOT, ROOT, ROOT])

    def test_document_cap_cannot_turn_partial_urls_into_negative_evidence(self):
        self.responses[ROOT] = FetchResult(ROOT, index(CHILD, OTHER_CHILD))
        self.responses[CHILD] = FetchResult(CHILD, urlset(PRESENT))
        self.responses[OTHER_CHILD] = FetchResult(OTHER_CHILD, urlset("https://shop.example/shop"))
        with patch("ludora.update_sitemap.MAX_DOCUMENTS", 2):
            self.assertFalse(self.is_missing())
        self.assertLess(len(self.requests), len(self.responses))

    def test_document_count_and_wall_time_budget_apply_before_next_child(self):
        self.checker = self.make_checker(load_budget_seconds=2)
        self.responses[ROOT] = FetchResult(ROOT, index(CHILD, OTHER_CHILD))

        def slow_child(url, timeout):
            self.assertLessEqual(timeout, 2)
            result = self.fetch(url, timeout)
            if url == CHILD:
                self.now += 2
            return result

        self.responses[CHILD] = FetchResult(CHILD, urlset(PRESENT))
        with patch.object(self.checker, "_fetcher", slow_child):
            self.assertFalse(self.is_missing())
        self.assertEqual(self.requests, [ROOT, CHILD])

    def test_cancellation_during_fetch_propagates_without_caching_a_snapshot(self):
        token = CancellationToken()
        request_threads = []

        def cancelled_fetch(url, timeout):
            request_threads.append(threading.current_thread())
            token.cancel()
            return FetchResult(url, urlset(PRESENT))

        with patch.object(self.checker, "_fetcher", cancelled_fetch):
            with self.assertRaises(OperationCancelled):
                self.is_missing(cancellation_token=token)
        for thread in request_threads:
            if thread is not threading.current_thread():
                thread.join(1)
        self.assertTrue(self.is_missing())

    def test_default_http_transport_never_follows_off_store_redirect(self):
        for location in ("https://evil.example/forbidden.xml", "http://shop.example/products.xml"):
            with self.subTest(location=location):
                headers = Message()
                headers["Location"] = location
                redirect = HTTPError(ROOT, 302, "Found", headers, io.BytesIO())
                checker = UpdateSitemapChecker.from_environment({ENV_KEY: CONFIG}, ".env")
                with patch("ludora.update_sitemap.build_opener") as opener:
                    opener.return_value.open.side_effect = redirect
                    self.assertFalse(checker.is_missing(7, MISSING, store_url=ORIGIN))
                opener.return_value.open.assert_called_once()
                self.assertEqual(opener.return_value.open.call_args.args[0].full_url, ROOT)

    def http_response(self, url, *, missing_bytes=0, before_headers=None):
        body = urlset(PRESENT).encode()
        status_line = b"HTTP/1.1 200 OK\r\n"

        class ResponseBytes(io.BytesIO):
            def readline(self, size=-1):
                if self.tell() == len(status_line) and before_headers is not None:
                    before_headers()
                return super().readline(size)

        class Socket:
            def makefile(self, mode):
                length = len(body) + missing_bytes
                return ResponseBytes(status_line + f"Content-Length: {length}\r\n\r\n".encode() + body)

        response = HTTPResponse(Socket())
        response.begin()
        response.url = url
        return response

    def test_default_http_transport_accepts_complete_same_store_redirect(self):
        headers = Message()
        headers["Location"] = "/products.xml"
        redirect = HTTPError(ROOT, 302, "Found", headers, io.BytesIO())
        checker = UpdateSitemapChecker.from_environment({ENV_KEY: CONFIG}, ".env")
        with patch("ludora.update_sitemap.build_opener") as opener:
            opener.return_value.open.side_effect = [redirect, self.http_response(CHILD)]
            self.assertTrue(checker.is_missing(7, MISSING, store_url=ORIGIN))
        requests = [call.args[0].full_url for call in opener.return_value.open.call_args_list]
        self.assertEqual(requests, [ROOT, CHILD])

    def test_default_http_transport_rejects_truncated_body_even_if_prefix_is_valid_xml(self):
        checker = UpdateSitemapChecker.from_environment({ENV_KEY: CONFIG}, ".env")
        with patch("ludora.update_sitemap.build_opener") as opener:
            opener.return_value.open.return_value = self.http_response(ROOT, missing_bytes=100)
            self.assertFalse(checker.is_missing(7, MISSING, store_url=ORIGIN))

    def test_slow_response_headers_fall_back_by_deadline_and_do_not_accumulate(self):
        release = threading.Event()
        blocked = threading.Event()
        request_threads = []

        def wait_for_headers():
            request_threads.append(threading.current_thread())
            blocked.set()
            release.wait(0.8)

        checker = UpdateSitemapChecker.from_environment({ENV_KEY: CONFIG}, ".env", load_budget_seconds=0.15)
        other_checker = UpdateSitemapChecker.from_environment({ENV_KEY: CONFIG}, ".env", load_budget_seconds=0.15)
        try:
            with patch("ludora.update_sitemap.build_opener") as opener:
                opener.return_value.open.side_effect = lambda *args, **kwargs: self.http_response(
                    ROOT, before_headers=wait_for_headers)
                start = time.monotonic()
                self.assertFalse(checker.is_missing(7, MISSING, store_url=ORIGIN))
                self.assertTrue(blocked.is_set())
                self.assertLess(time.monotonic() - start, 0.5)
                self.assertFalse(other_checker.is_missing(7, MISSING, store_url=ORIGIN))
                opener.return_value.open.assert_called_once()
        finally:
            release.set()
            for thread in request_threads:
                if thread is not threading.current_thread():
                    thread.join(1)
        self.assertFalse(checker.is_missing(7, MISSING, store_url=ORIGIN))

    def test_cancellation_during_blocked_http_headers_is_prompt(self):
        token = CancellationToken()
        release = threading.Event()
        request_threads = []

        def wait_for_headers():
            request_threads.append(threading.current_thread())
            timer = threading.Timer(0.05, token.cancel)
            timer.start()
            release.wait(0.8)
            timer.join()

        checker = UpdateSitemapChecker.from_environment({ENV_KEY: CONFIG}, ".env", load_budget_seconds=2)
        try:
            with patch("ludora.update_sitemap.build_opener") as opener:
                opener.return_value.open.side_effect = lambda *args, **kwargs: self.http_response(
                    ROOT, before_headers=wait_for_headers)
                start = time.monotonic()
                with self.assertRaises(OperationCancelled):
                    checker.is_missing(7, MISSING, store_url=ORIGIN, cancellation_token=token)
                self.assertLess(time.monotonic() - start, 0.5)
        finally:
            release.set()
            for thread in request_threads:
                if thread is not threading.current_thread():
                    thread.join(1)
