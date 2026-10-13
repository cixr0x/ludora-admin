import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.cancellation import CancellationToken, OperationCancelled
from ludora.inventory import collect_store_inventory
from ludora.listing_extraction import extract_listing_candidates
from ludora.moonlight_discovery import StoreDiscoveryAccessStopped
from ludora.nalua_discovery import discover_nalua_product_urls
from ludora.sitemap_discovery import discover_product_urls_from_sitemaps
from ludora.webfetch import FetchResult


STORE = "https://naluajuegos.com/"
CATALOG = STORE + "2-inicio"


def urlset(*urls):
    return "<urlset>" + "".join(f"<url><loc>{url}</loc></url>" for url in urls) + "</urlset>"


def index(*urls):
    return "<sitemapindex>" + "".join(f"<sitemap><loc>{url}</loc></sitemap>" for url in urls) + "</sitemapindex>"


def catalog_page(ids, start, total, next_url=None):
    links = "".join(f'<a href="/expansiones-juegos-de-mesa/{pid}-juego-{pid}.html">Juego {pid}</a>' for pid in ids)
    next_link = f'<a class="next js-search-link" rel="next" href="{next_url}">Siguiente</a>' if next_url else ""
    return f'<div>Mostrando {start}–{start + len(ids) - 1} de {total} productos</div>{links}{next_link}'


class Trace:
    def __init__(self):
        self.events = []

    def log(self, event, **fields):
        self.events.append((event, fields))


class ExistingRepository:
    """Exercise the real early-existence boundary without product requests or writes."""
    def __init__(self):
        self.checked_urls = []

    def discovery_url_exists(self, store_id, source_url):
        self.checked_urls.append(source_url)
        return True


class NaluaDiscoveryTests(unittest.TestCase):
    def crawl(self, pages, *, sitemap_urls=(), limit=None, token=None, trace=None, on_fetch=None):
        repository = ExistingRepository()
        requests = []

        def sitemap_fetch(url, **_kwargs):
            if url == STORE + "sitemap.xml":
                return FetchResult(url=url, text=urlset(*sitemap_urls))
            return None

        def fetch(url, **_kwargs):
            requests.append(url)
            if on_fetch:
                on_fetch(url)
            response = pages.get(url, '<a href="/juegos/15-homepage-only.html">Homepage sample</a>' if url == STORE else None)
            if isinstance(response, Exception):
                raise response
            return response if isinstance(response, FetchResult) else FetchResult(url=url, text=response) if response else None

        with patch("ludora.sitemap_discovery.fetch_sitemap_text", side_effect=sitemap_fetch), patch(
            "ludora.product_crawler.fetch_html", side_effect=fetch
        ):
            collect_store_inventory(STORE, 67, repository, platform="prestashop", limit=limit,
                                    cancellation_token=token, trace_logger=trace,
                                    item_classifier=lambda _: self.fail("Enumeration called classifier"))
        return repository.checked_urls, requests

    def test_robots_index_recognizes_nalua_routes_and_guards_nested_cycles(self):
        root = STORE + "1_index_sitemap.xml"
        child = STORE + "1_mx_0_sitemap.xml"
        second = STORE + "second-sitemap.xml"
        product = STORE + "juegos-de-mesa/2261-las-aventuras-de-robin-hood.html"
        responses = {
            STORE + "robots.txt": "User-agent: *\nSitemap: " + root + "\nSITEMAP: " + second +
                "\nSitemap: " + root + "\nSitemap: https://evil.example/sitemap.xml\nSitemap: javascript:alert(1)\nSitemap: https://naluajuegos.com:bad/sitemap.xml",
            root: index(child, root), child: urlset(product, STORE + "2-inicio", "https://evil.example/123-game.html"),
            second: urlset(STORE + "123-juego-raiz.html"),
        }
        requests = []
        trace = Trace()

        def fetch(url):
            requests.append(url)
            return FetchResult(url=url, text=responses[url]) if url in responses else None

        self.assertCountEqual(discover_product_urls_from_sitemaps(STORE, fetcher=fetch, trace_logger=trace),
                         [product, STORE + "123-juego-raiz.html"])
        self.assertEqual(requests.count(root), 1)
        self.assertFalse(any("evil.example" in url for url in requests))
        self.assertEqual({fields["source_url"] for event, fields in trace.events
                          if event == "inventory.sitemap_source.discovered"}, {root, child, second})

    def test_numeric_html_routes_are_scoped_and_nonproduct_routes_are_excluded(self):
        paths = ["/123-catan.html", "/escape-room/234-exit.html", "/accesorios-juegos-de-mesa/345-fundas.html",
                 "/2-inicio", "/content/3-condiciones.html", "/blog/456-review.html", "/my-account", "/juegos/condiciones.html"]
        markup = "".join(f'<a href="{path}">Link</a>' for path in paths) + '<a href="https://evil.example/567-catan.html">Fuera</a>'
        self.assertEqual([record.source_url for record in extract_listing_candidates(markup, STORE, 67)],
                         [STORE + "123-catan.html", STORE + "escape-room/234-exit.html", STORE + "accesorios-juegos-de-mesa/345-fundas.html"])
        self.assertEqual(extract_listing_candidates('<a href="/123-catan.html">Catan</a>', "https://other.example/", 1), [])
        self.assertEqual([record.source_url for record in extract_listing_candidates('<a href="/123-catan.html">Catan</a>', "https://www.naluajuegos.com/", 67)],
                         ["https://www.naluajuegos.com/123-catan.html"])

    def test_catalog_complements_sitemap_and_prefers_current_aliases(self):
        old = STORE + "juegos-de-mesa/101-old-name.html"
        sitemap_only = STORE + "escape-room/999-old-stock.html"
        trace = Trace()
        urls, requests = self.crawl({CATALOG: catalog_page([101, 102], 1, 3, "?page=2"),
                                     CATALOG + "?page=2": catalog_page([103], 3, 3)},
                                    sitemap_urls=[old, sitemap_only], trace=trace)
        self.assertEqual(urls, [STORE + "expansiones-juegos-de-mesa/101-juego-101.html",
                               STORE + "expansiones-juegos-de-mesa/102-juego-102.html",
                               STORE + "expansiones-juegos-de-mesa/103-juego-103.html", sitemap_only])
        self.assertEqual(requests, [CATALOG, CATALOG + "?page=2"])
        completion = [fields for event, fields in trace.events if event == "inventory.nalua_catalog.completed"]
        self.assertEqual(completion[0]["expected_total"], 3)
        self.assertEqual(completion[0]["enumerated_total"], 3)
        self.assertEqual(completion[0]["sitemap_only_count"], 1)

    def test_all_31_pages_and_26_product_last_page_are_enumerated(self):
        pages = {}
        for number in range(1, 32):
            start = (number - 1) * 36 + 1
            ids = list(range(start, min(start + 36, 1107)))
            pages[CATALOG if number == 1 else CATALOG + f"?page={number}"] = catalog_page(
                ids, start, 1106, f"?page={number + 1}" if number < 31 else None)
        urls, requests = self.crawl(pages)
        self.assertEqual(len(urls), 1106)
        self.assertEqual(len(set(urls)), 1106)
        self.assertEqual(len(requests), 31)
        self.assertTrue(urls[-1].endswith("/1106-juego-1106.html"))

    def test_invalid_next_pages_fail_before_detail_handling(self):
        for next_url in ["https://evil.example/2-inicio?page=2", "/29-juegos?page=2", "?page=1", "?page=3", "?page=nope", "?page=2&page=3"]:
            with self.subTest(next_url=next_url), self.assertRaisesRegex(RuntimeError, "Nalua"):
                self.crawl({CATALOG: catalog_page([101], 1, 2, next_url)})

    def test_missing_or_failing_next_page_fails_coverage(self):
        for failed_page in [None, FetchResult(url=CATALOG + "?page=2", text="", status_code=404)]:
            with self.subTest(failed_page=failed_page), self.assertRaisesRegex(RuntimeError, "Nalua"):
                self.crawl({CATALOG: catalog_page([101], 1, 2, "?page=2"), CATALOG + "?page=2": failed_page})

    def test_repeated_page_and_advertised_count_mismatches_fail_coverage(self):
        for second in [catalog_page([101], 2, 2), catalog_page([102], 2, 3), catalog_page([102], 1, 2)]:
            with self.subTest(second=second), self.assertRaisesRegex(RuntimeError, "Nalua"):
                self.crawl({CATALOG: catalog_page([101], 1, 2, "?page=2"), CATALOG + "?page=2": second})
        with self.assertRaisesRegex(RuntimeError, "Nalua"):
            self.crawl({CATALOG: catalog_page([101], 1, 2)})

    def test_limit_stops_with_partial_trace_and_catalog_alias_preference(self):
        trace = Trace()
        urls, requests = self.crawl({CATALOG: catalog_page([101, 102], 1, 3, "?page=2")},
                                    sitemap_urls=[STORE + "101-old-alias.html"], limit=1, trace=trace)
        self.assertEqual(urls, [STORE + "expansiones-juegos-de-mesa/101-juego-101.html"])
        self.assertEqual(requests, [CATALOG])
        self.assertTrue(any(event == "inventory.nalua_catalog.limited" for event, _ in trace.events))

    def test_limit_truncating_a_complete_page_still_reports_limited_result(self):
        trace = Trace()
        urls, _ = self.crawl({CATALOG: catalog_page([101, 102], 1, 2)}, limit=1, trace=trace)
        self.assertEqual(len(urls), 1)
        summaries = [fields for event, fields in trace.events if event == "inventory.nalua_catalog.limited"]
        self.assertEqual(len(summaries), 1)
        self.assertFalse(summaries[0]["coverage_complete"])

    def test_cancellation_during_catalog_fetch_prevents_next_page(self):
        token = CancellationToken()
        with self.assertRaises(OperationCancelled):
            self.crawl({CATALOG: catalog_page([101], 1, 2, "?page=2")}, token=token,
                       on_fetch=lambda _: token.cancel())

    def test_optional_robots_stop_and_cancellation_are_not_swallowed(self):
        for error in [OperationCancelled("cancelled"), StoreDiscoveryAccessStopped("access stopped")]:
            def fetch(url):
                if url.endswith("robots.txt"):
                    raise error
                return None
            with self.subTest(error=error), self.assertRaises(type(error)):
                discover_product_urls_from_sitemaps(STORE, fetcher=fetch)

    def test_malformed_product_authorities_are_not_candidates(self):
        markup = '<a href="https://naluajuegos.com:bad/123-catan.html">Catan</a>'
        self.assertEqual(extract_listing_candidates(markup, STORE, 67), [])

    def test_catalog_malformed_thousands_count_fails_explicitly(self):
        with self.assertRaisesRegex(RuntimeError, "Nalua"):
            self.crawl({CATALOG: '<p>Mostrando 1–1 de 1.. productos</p><a href="/101-game.html">Game</a>'})

    def test_browser_fallback_and_retry_after_keep_page_query(self):
        static_requests, browser_requests = [], []
        trace = Trace()

        def static_fetch(url):
            static_requests.append(url)
            if url == CATALOG:
                return FetchResult(url=url, text=catalog_page([101], 1, 2, "?page=2"))
            return FetchResult(url=url, text="", status_code=503, retry_after_seconds=7)

        def browser_fetch(url):
            browser_requests.append(url)
            return FetchResult(url=url, text=catalog_page([102], 2, 2))

        with patch("ludora.webfetch._wait_for_fetch_retry") as wait:
            urls = discover_nalua_product_urls(STORE, sitemap_urls=[], fetcher=static_fetch,
                                               browser_fetcher=browser_fetch, browser_fallback_enabled=True,
                                               trace_logger=trace)
        self.assertEqual(len(urls), 2)
        self.assertEqual(static_requests, [CATALOG, CATALOG + "?page=2", CATALOG + "?page=2", CATALOG + "?page=2"])
        self.assertEqual(browser_requests, [CATALOG + "?page=2"])
        self.assertEqual([call.args[0] for call in wait.call_args_list], [7, 7])

    def test_redirected_wrong_page_and_page_bound_fail(self):
        with self.assertRaisesRegex(RuntimeError, "Nalua"):
            self.crawl({CATALOG: catalog_page([101], 1, 2, "?page=2"),
                        CATALOG + "?page=2": FetchResult(url=CATALOG, text=catalog_page([102], 2, 2))})
        with patch("ludora.nalua_discovery.NALUA_MAX_CATALOG_PAGES", 2), self.assertRaisesRegex(RuntimeError, "Nalua.*exceeds"):
            self.crawl({CATALOG: catalog_page([101], 1, 3, "?page=2"),
                        CATALOG + "?page=2": catalog_page([102], 2, 3, "?page=3")})

    def test_zero_limit_and_precancelled_calls_never_fetch_catalog(self):
        def fetch(_):
            self.fail("Unexpected catalog fetch")

        self.assertEqual(discover_nalua_product_urls(STORE, sitemap_urls=[], fetcher=fetch, limit=0), [])
        token = CancellationToken()
        token.cancel()
        with self.assertRaises(OperationCancelled):
            discover_nalua_product_urls(STORE, sitemap_urls=[], fetcher=fetch, cancellation_token=token)

    def test_inventory_zero_limit_does_not_fall_back_to_homepage(self):
        urls, requests = self.crawl({}, limit=0)
        self.assertEqual(urls, [])
        self.assertEqual(requests, [])

    def test_missing_robots_is_optional_without_browser_read(self):
        browser_requests = []

        def static_fetch(url):
            return FetchResult(url=url, text="", status_code=404)

        def browser_fetch(url):
            browser_requests.append(url)
            return None

        self.assertEqual(discover_product_urls_from_sitemaps(STORE, fetcher=static_fetch,
                         browser_fetcher=browser_fetch, browser_fallback_enabled=True), [])
        self.assertEqual(browser_requests, [STORE + "sitemap.xml", STORE + "product-sitemap.xml"])

    def test_extensionless_standard_sitemap_endpoint_keeps_existing_behavior(self):
        child = "https://other.example/sitemap?type=products"
        responses = {"https://other.example/sitemap.xml": index(child), child: urlset("https://other.example/products/catan")}
        self.assertEqual(discover_product_urls_from_sitemaps("https://other.example/",
            fetcher=lambda url: FetchResult(url=url, text=responses[url]) if url in responses else None),
            ["https://other.example/products/catan"])

    def test_robots_sitemap_uses_browser_fallback_and_keeps_nested_headers(self):
        root, child = STORE + "1_index_sitemap.xml", STORE + "1_mx_0_sitemap.xml"
        header_urls, browser_urls = [], []

        def headers(url):
            header_urls.append(url)
            return {"User-Agent": "test-profile"}

        def fetch(url, **kwargs):
            self.assertEqual(kwargs["headers"], {"User-Agent": "test-profile"})
            if url.endswith("robots.txt"):
                return FetchResult(url=url, text="Sitemap: " + root)
            if url == child:
                return FetchResult(url=url, text=urlset(STORE + "123-game.html"))
            return FetchResult(url=url, text="", status_code=404)

        def browser(url):
            browser_urls.append(url)
            return FetchResult(url=url, text=index(child)) if url == root else None

        with patch("ludora.sitemap_discovery.fetch_sitemap_text", side_effect=fetch):
            self.assertEqual(discover_product_urls_from_sitemaps(STORE, browser_fetcher=browser,
                browser_fallback_enabled=True, request_headers_provider=headers), [STORE + "123-game.html"])
        self.assertIn(child, header_urls)
        self.assertIn(root, browser_urls)

    def test_non_nalua_and_shopify_do_not_request_nalua_catalog(self):
        for store, platform in [("https://other.example/", "prestashop"), (STORE, "shopify")]:
            repository = ExistingRepository()
            product = store + "products/catan"
            with self.subTest(store=store, platform=platform), patch(
                "ludora.product_crawler.discover_product_urls_from_sitemaps", return_value=[product]
            ), patch("ludora.product_crawler.fetch_html", side_effect=lambda _: self.fail("Unexpected catalog fetch")):
                collect_store_inventory(store, 1, repository, platform=platform,
                    request_headers_provider=(lambda _: {"Signature": "signed"}) if platform == "shopify" else None)
            self.assertEqual(repository.checked_urls, [product])


if __name__ == "__main__":
    unittest.main()
