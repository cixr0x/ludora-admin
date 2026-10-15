import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.cancellation import CancellationToken, OperationCancelled
from ludora.inventory import collect_store_inventory
from ludora.listing_extraction import extract_listing_candidates
from ludora.nalua_discovery import discover_nalua_product_urls
from ludora.product_crawler import crawl_store_product_details
from ludora.revilo_discovery import discover_revilo_product_urls
from ludora.sitemap_discovery import discover_product_urls_from_sitemaps
from ludora.webfetch import FetchResult


STORE = "https://revilogames.com.mx/"
CATALOG = STORE + "6-todos"


def urlset(*urls):
    return '<urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">' + "".join(
        f"<url><loc><![CDATA[{url}]]></loc><image:image><image:loc>https://cdn.example/123-image.html</image:loc></image:image></url>"
        for url in urls
    ) + "</urlset>"


def catalog_page(ids, start, total, next_url=None):
    links = "".join(f'<a href="/todos/{pid}-juego-{pid}.html">Juego {pid}</a>' for pid in ids)
    next_link = f'<a rel="next" href="{next_url}">Siguiente</a>' if next_url is not None else ""
    return (f'<p>Hay {total} productos.</p><p>Mostrando {start}-{start + len(ids) - 1} de {total} artículo(s)</p>'
            + links + next_link)


class Trace:
    def __init__(self):
        self.events = []

    def log(self, event, **fields):
        self.events.append((event, fields))


class ExistingRepository:
    """Existing URLs stop at the real pre-fetch existence boundary."""
    def __init__(self):
        self.checked_urls = []

    def discovery_url_exists(self, store_id, source_url):
        self.checked_urls.append(source_url)
        return True


class ReviloDiscoveryTests(unittest.TestCase):
    def crawl(self, pages, *, sitemap_urls=(), limit=None, token=None, trace=None, on_fetch=None,
              browser_fetcher=None, repository=None, classifier=None, processor=None):
        repository = repository or ExistingRepository()
        requests = []

        def sitemap_fetch(url, **_kwargs):
            if url == STORE + "sitemap.xml":
                return FetchResult(url=url, text=urlset(*sitemap_urls))
            return FetchResult(url=url, text=urlset()) if url == STORE + "product-sitemap.xml" else None

        def fetch(url, **_kwargs):
            requests.append(url)
            if on_fetch:
                on_fetch(url)
            response = pages.get(url, "<p>Homepage has no product links</p>" if url == STORE else None)
            if isinstance(response, Exception):
                raise response
            return response if isinstance(response, FetchResult) else FetchResult(url=url, text=response) if response else None

        with patch("ludora.sitemap_discovery.fetch_sitemap_text", side_effect=sitemap_fetch), patch(
            "ludora.product_crawler.fetch_html", side_effect=fetch
        ):
            records = crawl_store_product_details(
                STORE, 71, repository, platform="prestashop", limit=limit,
                cancellation_token=token, trace_logger=trace,
                browser_fetch_enabled=browser_fetcher is not None, browser_fetcher=browser_fetcher,
                item_classifier=classifier or (lambda _: self.fail("Enumeration called classifier")),
                item_processor=processor,
            )
        return repository, requests, records

    def test_cdata_sitemap_from_robots_and_nested_index_recognizes_actual_routes(self):
        root, child = STORE + "1_index_sitemap.xml", STORE + "1_mx_0_sitemap.xml"
        expected = [STORE + "todos/3-carcassonne-8436017222593.html",
                    STORE + "inicio/504-brass-birmingham-deluxe-8436578817627.html", STORE + "inicio/686-gaudi.html"]
        responses = {
            STORE + "robots.txt": "User-agent: *\nSitemap: " + root,
            root: "<sitemapindex><sitemap><loc>" + child + "</loc></sitemap></sitemapindex>",
            child: urlset(*expected, STORE + "6-todos", STORE + "content/3-condiciones.html"),
        }
        actual = discover_product_urls_from_sitemaps(
            STORE, fetcher=lambda url: FetchResult(url=url, text=responses[url]) if url in responses else None)
        self.assertEqual(actual, expected)

    def test_listing_recognizes_root_and_category_routes_for_both_exact_hosts(self):
        for store in [STORE, "https://www.revilogames.com.mx/"]:
            with self.subTest(store=store):
                markup = ('<a href="/todos/3-carcassonne-8436017222593.html">Carcassonne</a>'
                          '<a href="/inicio/504-brass-birmingham-deluxe-8436578817627.html">Brass</a>'
                          '<a href="/inicio/686-gaudi.html">Gaudi</a>'
                          '<a href="/687-root-game.html?tracking=1#cover">Root</a>'
                          '<a href="/accesorios/688-fundas.html">Fundas</a>')
                self.assertEqual([record.source_url for record in extract_listing_candidates(markup, store, 71)],
                                 [store + "todos/3-carcassonne-8436017222593.html",
                                  store + "inicio/504-brass-birmingham-deluxe-8436578817627.html",
                                  store + "inicio/686-gaudi.html", store + "687-root-game.html",
                                  store + "accesorios/688-fundas.html"])

    def test_numeric_routes_remain_scoped_and_reject_nonproducts_and_bad_authorities(self):
        paths = ["/6-todos", "/2-inicio", "/content/3-conditions.html", "/blog/3-review.html",
                 "/account/3-profile.html", "/category/3-catan.html", "/categories/3-catan.html",
                 "/authentication/3-login.html", "/module/3-news.html", "/cart/3-order.html",
                 "/todos/0-game.html", "/todos/3-.html", "/todos/three-game.html",
                 "https://evil.example/3-game.html", "https://revilogames.com.mx.evil.example/3-game.html",
                 "https://user:pass@revilogames.com.mx/3-game.html", "https://revilogames.com.mx:bad/3-game.html",
                 "https://revilogames.com.mx:444/3-game.html", "ftp://revilogames.com.mx/3-game.html"]
        markup = "".join(f'<a href="{path}">Link</a>' for path in paths)
        self.assertEqual(extract_listing_candidates(markup, STORE, 71), [])
        for store in ["https://other.example/", "https://shop.revilogames.com.mx/"]:
            with self.subTest(store=store):
                self.assertEqual(extract_listing_candidates('<a href="/3-game.html">Game</a>', store, 1), [])

    def test_all_45_pages_enumerate_535_products_with_seven_on_last_page(self):
        pages = {}
        for number in range(1, 46):
            start = (number - 1) * 12 + 1
            ids = list(range(start, min(start + 12, 536)))
            pages[CATALOG if number == 1 else CATALOG + f"?page={number}"] = catalog_page(
                ids, start, 535, f"?page={number + 1}" if number < 45 else None)
        trace = Trace()
        repository, requests, records = self.crawl(pages, trace=trace)
        self.assertEqual(len(repository.checked_urls), 535)
        self.assertEqual(len(set(repository.checked_urls)), 535)
        self.assertEqual(repository.checked_urls[-1], STORE + "todos/535-juego-535.html")
        self.assertEqual(len(requests), 45)
        self.assertEqual(requests[-1], CATALOG + "?page=45")
        self.assertEqual(records, [])
        events = dict(trace.events)
        self.assertEqual(events["inventory.revilo_catalog.start"]["source_url"], CATALOG)
        self.assertEqual(events["inventory.revilo_catalog.page.completed"]["page_product_count"], 7)
        self.assertEqual(events["inventory.revilo_catalog.completed"]["expected_total"], 535)
        self.assertEqual(events["inventory.revilo_catalog.completed"]["enumerated_total"], 535)
        self.assertTrue(events["inventory.revilo_catalog.completed"]["coverage_complete"])

    def test_nonempty_sitemap_still_enumerates_catalog_and_prefers_current_alias(self):
        sitemap_only = STORE + "inicio/999-old-stock.html"
        trace = Trace()
        repository, requests, _ = self.crawl(
            {CATALOG: catalog_page([3, 504], 1, 3, "?page=2"), CATALOG + "?page=2": catalog_page([686], 3, 3)},
            sitemap_urls=[STORE + "inicio/3-old-alias.html", sitemap_only], trace=trace)
        self.assertEqual(repository.checked_urls, [STORE + "todos/3-juego-3.html", STORE + "todos/504-juego-504.html",
                                                  STORE + "todos/686-juego-686.html", sitemap_only])
        self.assertEqual(requests, [CATALOG, CATALOG + "?page=2"])
        self.assertEqual(dict(trace.events)["inventory.revilo_catalog.completed"]["sitemap_only_count"], 1)

    def test_invalid_next_links_fail_before_downstream_processing(self):
        for next_url in ["https://evil.example/6-todos?page=2", "/2-inicio?page=2", "?page=1", "?page=3",
                         "?page=nope", "?page=2&page=3", "?page=2&other=1", "",
                         "https://user@revilogames.com.mx/6-todos?page=2"]:
            with self.subTest(next_url=next_url), self.assertRaisesRegex(RuntimeError, "Revilo"):
                self.crawl({CATALOG: catalog_page([3], 1, 2, next_url)})

    def test_missing_or_failing_page_and_wrong_redirect_fail_coverage(self):
        for response in [None, FetchResult(url=CATALOG + "?page=2", text="", status_code=404),
                         FetchResult(url=CATALOG, text=catalog_page([504], 2, 2)),
                         FetchResult(url="https://evil.example/6-todos?page=2", text=catalog_page([504], 2, 2))]:
            with self.subTest(response=response), self.assertRaisesRegex(RuntimeError, "Revilo"):
                self.crawl({CATALOG: catalog_page([3], 1, 2, "?page=2"), CATALOG + "?page=2": response})

    def test_repeated_products_and_inconsistent_counts_fail_coverage(self):
        for second in [catalog_page([3], 2, 2), catalog_page([504], 2, 3), catalog_page([504], 1, 2),
                       catalog_page([504], 2, 2) + "<p>Mostrando 1-1 de 2 artículo(s)</p>",
                       catalog_page([504], 2, 2).replace("Hay 2", "Hay 3")]:
            with self.subTest(second=second), self.assertRaisesRegex(RuntimeError, "Revilo"):
                self.crawl({CATALOG: catalog_page([3], 1, 2, "?page=2"), CATALOG + "?page=2": second})

    def test_missing_next_extra_next_malformed_or_absent_counts_fail_coverage(self):
        for first in [catalog_page([3], 1, 2), catalog_page([3], 1, 1, "?page=2"),
                      catalog_page([3], 1, 2, "?page=2") + '<a rel="next" href="?page=3">Next</a>',
                      catalog_page([3], 1, 2).replace("de 2 artículo", "de 2.. artículo"),
                      '<a href="/todos/3-game.html">Game</a>']:
            with self.subTest(first=first), self.assertRaisesRegex(RuntimeError, "Revilo"):
                self.crawl({CATALOG: first})

    def test_limit_reports_partial_coverage_without_fetching_next_page(self):
        trace = Trace()
        repository, requests, _ = self.crawl({CATALOG: catalog_page([3, 504], 1, 3, "?page=2")},
                                            sitemap_urls=[STORE + "inicio/3-old.html"], limit=1, trace=trace)
        self.assertEqual(repository.checked_urls, [STORE + "todos/3-juego-3.html"])
        self.assertEqual(requests, [CATALOG])
        self.assertFalse(dict(trace.events)["inventory.revilo_catalog.limited"]["coverage_complete"])

    def test_limit_truncating_complete_catalog_reports_partial_coverage(self):
        trace = Trace()
        repository, _, _ = self.crawl({CATALOG: catalog_page([3, 504], 1, 2)}, limit=1, trace=trace)
        self.assertEqual(repository.checked_urls, [STORE + "todos/3-juego-3.html"])
        self.assertFalse(dict(trace.events)["inventory.revilo_catalog.limited"]["coverage_complete"])

    def test_zero_limit_does_not_fetch_catalog_or_homepage_or_fail(self):
        repository, requests, records = self.crawl({}, limit=0)
        self.assertEqual((repository.checked_urls, requests, records), ([], [], []))

    def test_invalid_catalog_authority_or_scheme_is_rejected_before_fetch(self):
        for store in ["https://user:pass@revilogames.com.mx/", "https://revilogames.com.mx:bad/",
                      "https://revilogames.com.mx:444/", "ftp://revilogames.com.mx/", "https://evil.example/"]:
            requests = []

            def fetch(url):
                requests.append(url)
                return FetchResult(url=url, text=catalog_page([3], 1, 1))

            with self.subTest(store=store):
                with self.assertRaises((RuntimeError, ValueError)):
                    discover_revilo_product_urls(store, sitemap_urls=[], fetcher=fetch)
                self.assertEqual(requests, [])

    def test_revilo_page_bound_is_checked_before_requesting_an_extra_page(self):
        requests = []
        with patch("ludora.revilo_discovery.REVILO_MAX_CATALOG_PAGES", 2), self.assertRaisesRegex(RuntimeError, "Revilo.*exceeds"):
            self.crawl({CATALOG: catalog_page([3], 1, 3, "?page=2"),
                        CATALOG + "?page=2": catalog_page([504], 2, 3, "?page=3")},
                       on_fetch=requests.append)
        self.assertEqual(requests, [CATALOG, CATALOG + "?page=2"])

    def test_cancellation_during_catalog_page_stops_before_next_page(self):
        token = CancellationToken()
        requests = []

        def cancel(url):
            requests.append(url)
            token.cancel()

        with self.assertRaises(OperationCancelled):
            self.crawl({CATALOG: catalog_page([3], 1, 2, "?page=2")}, token=token, on_fetch=cancel)
        self.assertEqual(requests, [CATALOG])

    def test_browser_fallback_retries_page_with_query_and_retry_after(self):
        browser_requests = []

        def browser(url):
            browser_requests.append(url)
            return FetchResult(url=url, text=catalog_page([504], 2, 2))

        with patch("ludora.webfetch._wait_for_fetch_retry") as wait:
            repository, requests, _ = self.crawl(
                {CATALOG: catalog_page([3], 1, 2, "?page=2"), CATALOG + "?page=2":
                 FetchResult(url=CATALOG + "?page=2", text="", status_code=503, retry_after_seconds=7)},
                sitemap_urls=[STORE + "inicio/3-old.html"], browser_fetcher=browser)
        self.assertEqual(repository.checked_urls, [STORE + "todos/3-juego-3.html", STORE + "todos/504-juego-504.html"])
        self.assertEqual(requests, [CATALOG, CATALOG + "?page=2", CATALOG + "?page=2", CATALOG + "?page=2"])
        self.assertEqual(browser_requests, [CATALOG + "?page=2"])
        self.assertEqual([call.args[0] for call in wait.call_args_list], [7, 7])

    def test_normalized_prestashop_empty_homepage_fails_but_other_platforms_keep_behavior(self):
        for platform in [" PrestaShop ", "custom", ""]:
            with self.subTest(platform=platform), patch("ludora.product_crawler.discover_product_urls_from_sitemaps", return_value=[]), patch(
                "ludora.product_crawler.fetch_html", return_value=FetchResult(url="https://other.example/", text="<p>No products</p>")
            ):
                if platform.strip().casefold() == "prestashop":
                    with self.assertRaisesRegex(RuntimeError, "PrestaShop.*no product candidates"):
                        collect_store_inventory("https://other.example/", 1, ExistingRepository(), platform=platform)
                else:
                    self.assertEqual(collect_store_inventory("https://other.example/", 1, ExistingRepository(), platform=platform), [])

    def test_prestashop_zero_limit_is_not_an_empty_discovery_failure(self):
        with patch("ludora.product_crawler.discover_product_urls_from_sitemaps", return_value=[]), patch(
            "ludora.product_crawler.fetch_html", side_effect=lambda *args, **kwargs: self.fail("Zero limit fetched homepage")
        ):
            self.assertEqual(collect_store_inventory("https://other.example/", 1, ExistingRepository(), platform="prestashop", limit=0), [])

    def test_other_store_and_revilo_shopify_do_not_request_revilo_catalog(self):
        for store, platform in [("https://other.example/", "prestashop"), (STORE, "shopify")]:
            repository = ExistingRepository()
            product = store + "products/catan"
            with self.subTest(store=store, platform=platform), patch(
                "ludora.product_crawler.discover_product_urls_from_sitemaps", return_value=[product]
            ), patch("ludora.product_crawler.fetch_html", side_effect=lambda _: self.fail("Unexpected catalog fetch")):
                collect_store_inventory(store, 1, repository, platform=platform,
                                        request_headers_provider=(lambda _: {"Signature": "signed"}) if platform == "shopify" else None)
            self.assertEqual(repository.checked_urls, [product])

    def test_inventory_limit_merges_sitemap_aliases_before_truncating_unique_ids(self):
        cases = [(STORE, CATALOG, "artículo(s)", "revilo"),
                 ("https://naluajuegos.com/", "https://naluajuegos.com/2-inicio", "productos", "nalua")]
        for store, catalog, units, trace_name in cases:
            current = store + "inicio/3-current.html"
            sitemap_only = store + "inicio/999-sitemap-only.html"
            sitemap = urlset(store + "inicio/3-old-a.html", store + "inicio/3-old-b.html", sitemap_only)
            markup = f'<p>Mostrando 1-1 de 1 {units}</p><a href="{current}">Current game</a>'
            repository, trace, catalog_requests = ExistingRepository(), Trace(), []

            def sitemap_fetch(url, **_kwargs):
                return FetchResult(url=url, text=sitemap if url == store + "sitemap.xml" else urlset())

            def fetch_catalog(url, **_kwargs):
                self.assertEqual(url, catalog, "Unexpected homepage or detail fetch")
                catalog_requests.append(url)
                return FetchResult(url=url, text=markup)

            with self.subTest(store=store), patch("ludora.sitemap_discovery.fetch_sitemap_text", side_effect=sitemap_fetch), patch(
                "ludora.product_crawler.fetch_html", side_effect=fetch_catalog
            ):
                records = collect_store_inventory(store, 71, repository, platform="prestashop", limit=2,
                                                  trace_logger=trace,
                                                  item_classifier=lambda _: self.fail("Enumeration called classifier"))
                self.assertEqual(repository.checked_urls, [current, sitemap_only])
                self.assertEqual((records, catalog_requests), ([], [catalog]))
                summary = dict(trace.events)[f"inventory.{trace_name}_catalog.completed"]
                self.assertEqual((summary["product_url_count"], summary["sitemap_only_count"]), (2, 1))
                self.assertTrue(summary["coverage_complete"])

    def test_default_catalog_helpers_merge_all_sitemap_aliases_before_result_limit(self):
        cases = [(STORE, CATALOG, "artículo(s)", discover_revilo_product_urls),
                 ("https://naluajuegos.com/", "https://naluajuegos.com/2-inicio", "productos", discover_nalua_product_urls)]
        for store, catalog, units, discover in cases:
            current = store + "inicio/3-current.html"
            sitemap_only = store + "inicio/999-sitemap-only.html"
            sitemap = urlset(store + "inicio/3-old-a.html", store + "inicio/3-old-b.html", sitemap_only)
            markup = f'<p>Mostrando 1-1 de 1 {units}</p><a href="{current}">Current game</a>'

            def sitemap_fetch(url, **_kwargs):
                return FetchResult(url=url, text=sitemap if url == store + "sitemap.xml" else urlset())

            def fetch_catalog(url, **_kwargs):
                self.assertEqual(url, catalog, "Unexpected homepage or detail fetch")
                return FetchResult(url=url, text=markup)

            with self.subTest(store=store), patch("ludora.sitemap_discovery.fetch_sitemap_text", side_effect=sitemap_fetch), patch(
                "ludora.prestashop_catalog.fetch_html", side_effect=fetch_catalog
            ):
                self.assertEqual(discover(store, limit=2), [current, sitemap_only])

    def test_unrelated_store_and_shopify_keep_sitemap_url_limits(self):
        cases = [("https://other.example/", "prestashop", ["products/a", "products/b", "products/c"]),
                 (STORE, "shopify", ["todos/3-a.html", "todos/4-b.html", "todos/5-c.html"])]
        for store, platform, paths in cases:
            repository = ExistingRepository()

            def sitemap_fetch(url, **_kwargs):
                return FetchResult(url=url, text=urlset(*(store + path for path in paths)) if url == store + "sitemap.xml" else urlset())

            with self.subTest(store=store, platform=platform), patch("ludora.sitemap_discovery.fetch_sitemap_text", side_effect=sitemap_fetch), patch(
                "ludora.product_crawler.fetch_html", side_effect=lambda *args, **kwargs: self.fail("Unexpected catalog or detail fetch")
            ):
                collect_store_inventory(store, 71, repository, platform=platform, limit=2,
                                        request_headers_provider=(lambda _: {"Signature": "signed"}) if platform == "shopify" else None)
                self.assertEqual(repository.checked_urls, [store + paths[0], store + paths[1]])

    def test_new_catalog_product_uses_existing_redirect_classification_and_persistence_pipeline(self):
        class Repository(ExistingRepository):
            def __init__(self):
                super().__init__()
                self.observed = []
                self.prepared = []
                self.completed = []

            def discovery_url_exists(self, store_id, source_url):
                self.checked_urls.append(source_url)
                return False

            def observe_discovery_pair(self, store_id, discovered_url, target_url):
                self.observed.append((store_id, discovered_url, target_url))
                return False

            def prepare_discovery_pair(self, record):
                self.prepared.append(record)
                return SimpleNamespace(candidate_id=100, should_process=False, activate_if_ready=False)

            def complete_discovery_pair(self, candidate_id, **kwargs):
                self.completed.append(candidate_id)

        current, redirected = STORE + "todos/3-juego-3.html", STORE + "inicio/3-current.html"
        detail = '<script type="application/ld+json">{"@type":"Product","name":"Carcassonne","offers":{"price":"799","priceCurrency":"MXN","availability":"https://schema.org/InStock"}}</script>'
        classified = []
        repository, requests, records = self.crawl(
            {CATALOG: catalog_page([3], 1, 1), current: FetchResult(url=redirected, text=detail)},
            repository=Repository(), classifier=lambda candidate: classified.append(candidate.title))
        self.assertEqual(requests, [CATALOG, current])
        self.assertEqual(repository.checked_urls, [current])
        self.assertEqual(repository.observed, [(71, current, redirected)])
        self.assertEqual(classified, ["Carcassonne"])
        self.assertEqual(repository.completed, [100])
        self.assertEqual(repository.prepared, records)
        self.assertEqual((records[0].source_url_origin, records[0].source_url, records[0].source_listing_url),
                         (current, redirected, CATALOG))


if __name__ == "__main__":
    unittest.main()
