import sys
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.sitemap_discovery import SiteProtectionBlocked, discover_product_urls_from_sitemaps
from ludora.webfetch import FetchResult


class FakeTraceLogger:
    def __init__(self):
        self.events = []

    def log(self, event, **fields):
        self.events.append((event, fields))


class SitemapDiscoveryTests(unittest.TestCase):
    def test_follows_product_sitemaps_and_extracts_product_urls(self):
        responses = {
            "https://example.mx/sitemap.xml": """
            <sitemapindex>
              <sitemap><loc>https://example.mx/sitemap_pages_1.xml</loc></sitemap>
              <sitemap><loc>https://example.mx/sitemap_products_1.xml?from=1&amp;to=2</loc></sitemap>
            </sitemapindex>
            """,
            "https://example.mx/sitemap_products_1.xml?from=1&to=2": """
            <urlset>
              <url><loc>https://example.mx/products/catan</loc></url>
              <url><loc>https://example.mx/products/dixit?variant=123</loc></url>
              <url><loc>https://other.mx/products/wrong-domain</loc></url>
            </urlset>
            """,
        }
        fetched_urls = []

        def fake_fetcher(url):
            fetched_urls.append(url)
            text = responses.get(url)
            return FetchResult(url=url, text=text) if text is not None else None

        urls = discover_product_urls_from_sitemaps("https://example.mx/", fetcher=fake_fetcher, limit=20)

        self.assertEqual(
            urls,
            [
                "https://example.mx/products/catan",
                "https://example.mx/products/dixit",
            ],
        )
        self.assertIn("https://example.mx/sitemap_products_1.xml?from=1&to=2", fetched_urls)
        self.assertNotIn("https://example.mx/sitemap_pages_1.xml", fetched_urls)

    def test_extracts_product_urls_from_root_sitemap(self):
        def fake_fetcher(url):
            return FetchResult(
                url=url,
                text="""
                <urlset>
                  <url><loc>https://example.mx/products/catan</loc></url>
                  <url><loc>https://example.mx/blog/catan-review</loc></url>
                </urlset>
                """,
            )

        urls = discover_product_urls_from_sitemaps("https://example.mx/", fetcher=fake_fetcher, limit=20)

        self.assertEqual(urls, ["https://example.mx/products/catan"])

    def test_ignores_product_collection_roots_without_a_product_path_segment(self):
        def fake_fetcher(url):
            return FetchResult(
                url=url,
                text="""
                <urlset>
                  <url><loc>https://example.mx/product/</loc></url>
                  <url><loc>https://example.mx/products/</loc></url>
                  <url><loc>https://example.mx/producto/</loc></url>
                  <url><loc>https://example.mx/productos/</loc></url>
                  <url><loc>https://example.mx/juego/</loc></url>
                  <url><loc>https://example.mx/juegos/</loc></url>
                  <url><loc>https://example.mx/product/catan</loc></url>
                  <url><loc>https://example.mx/productos/69/</loc></url>
                  <url><loc>https://example.mx/productos/thats-not-a-hat/</loc></url>
                </urlset>
                """,
            )

        urls = discover_product_urls_from_sitemaps("https://example.mx/", fetcher=fake_fetcher)

        self.assertEqual(
            urls,
            [
                "https://example.mx/product/catan",
                "https://example.mx/productos/69/",
                "https://example.mx/productos/thats-not-a-hat/",
            ],
        )

    def test_follows_non_product_named_sitemaps_when_root_has_no_product_sitemap(self):
        responses = {
            "https://example.mx/sitemap.xml": """
            <sitemapindex>
              <sitemap><loc>https://example.mx/sitemap.website.xml</loc></sitemap>
              <sitemap><loc>https://example.mx/sitemap.ols.xml</loc></sitemap>
            </sitemapindex>
            """,
            "https://example.mx/sitemap.website.xml": """
            <urlset>
              <url><loc>https://example.mx/aviso-de-privacidad</loc></url>
            </urlset>
            """,
            "https://example.mx/sitemap.ols.xml": """
            <urlset>
              <url><loc>https://example.mx/tienda/ols/products/catan</loc></url>
            </urlset>
            """,
        }
        fetched_urls = []

        def fake_fetcher(url):
            fetched_urls.append(url)
            text = responses.get(url)
            return FetchResult(url=url, text=text) if text is not None else None

        urls = discover_product_urls_from_sitemaps("https://example.mx/", fetcher=fake_fetcher, limit=1)

        self.assertEqual(urls, ["https://example.mx/tienda/ols/products/catan"])
        self.assertIn("https://example.mx/sitemap.ols.xml", fetched_urls)

    def test_extracts_product_urls_from_cdata_loc_values(self):
        def fake_fetcher(url):
            return FetchResult(
                url=url,
                text="""
                <urlset>
                  <url><loc><![CDATA[https://example.mx/producto/catan/]]></loc></url>
                </urlset>
                """,
            )

        urls = discover_product_urls_from_sitemaps("https://example.mx/", fetcher=fake_fetcher)

        self.assertEqual(urls, ["https://example.mx/producto/catan/"])

    def test_fetches_direct_product_sitemap_when_root_sitemap_is_unavailable(self):
        fetched_urls = []

        def fake_fetcher(url):
            fetched_urls.append(url)
            if url == "https://example.mx/sitemap.xml":
                return None
            if url == "https://example.mx/product-sitemap.xml":
                return FetchResult(
                    url=url,
                    text="""
                    <urlset>
                      <url><loc>https://example.mx/product/catan</loc></url>
                      <url><loc>https://example.mx/product/dixit</loc></url>
                    </urlset>
                    """,
                )
            return None

        urls = discover_product_urls_from_sitemaps("https://example.mx/", fetcher=fake_fetcher)

        self.assertEqual(
            urls,
            [
                "https://example.mx/product/catan",
                "https://example.mx/product/dixit",
            ],
        )
        self.assertEqual(
            fetched_urls,
            [
                "https://example.mx/sitemap.xml",
                "https://example.mx/product-sitemap.xml",
            ],
        )

    def test_retries_transient_root_sitemap_status_and_honors_retry_after(self):
        root_url = "https://example.mx/sitemap.xml"
        fetched_urls = []
        trace = FakeTraceLogger()

        def fake_fetcher(url):
            fetched_urls.append(url)
            if url == root_url and fetched_urls.count(root_url) == 1:
                return FetchResult(url=url, text="", status_code=503, retry_after_seconds=41.0)
            if url == root_url:
                return FetchResult(
                    url=url,
                    text="""
                    <urlset>
                      <url><loc>https://example.mx/products/catan</loc></url>
                    </urlset>
                    """,
                )
            return None

        with patch("ludora.webfetch._wait_for_fetch_retry") as wait_for_retry:
            urls = discover_product_urls_from_sitemaps(
                "https://example.mx/",
                fetcher=fake_fetcher,
                trace_logger=trace,
            )

        self.assertEqual(urls, ["https://example.mx/products/catan"])
        self.assertEqual(fetched_urls.count(root_url), 2)
        wait_for_retry.assert_called_once_with(41.0, None)
        http_error_events = [fields for event, fields in trace.events if event == "inventory.sitemap_fetch.http_error"]
        self.assertEqual(len(http_error_events), 1)
        self.assertEqual(http_error_events[0]["status_code"], 503)
        self.assertEqual(http_error_events[0]["retry_in_seconds"], 41.0)
        self.assertTrue(http_error_events[0]["will_retry"])

    def test_raises_blocked_when_sitemap_response_is_a_challenge_page(self):
        def fake_fetcher(url):
            return FetchResult(
                url=url,
                text="""
                <!DOCTYPE html>
                <html>
                  <head><title>Un momento...</title></head>
                  <body>
                    <script>
                      setTimeout(function(){ window.location.reload(); }, 5000);
                    </script>
                  </body>
                </html>
                """,
            )

        with self.assertRaisesRegex(SiteProtectionBlocked, "Site protection challenge"):
            discover_product_urls_from_sitemaps("https://example.mx/", fetcher=fake_fetcher)

    def test_uses_browser_fetcher_when_static_sitemap_is_blocked(self):
        browser_fetched_urls = []

        def static_fetcher(url):
            return FetchResult(
                url=url,
                text="""
                <!DOCTYPE html>
                <html>
                  <head><title>Un momento...</title></head>
                  <body>
                    <script>
                      setTimeout(function(){ window.location.reload(); }, 5000);
                    </script>
                  </body>
                </html>
                """,
            )

        def browser_fetcher(url):
            browser_fetched_urls.append(url)
            if url == "https://example.mx/product-sitemap.xml":
                return FetchResult(
                    url=url,
                    text="""
                    <urlset>
                      <url><loc>https://example.mx/product/catan</loc></url>
                    </urlset>
                    """,
                )
            return None

        urls = discover_product_urls_from_sitemaps(
            "https://example.mx/",
            fetcher=static_fetcher,
            browser_fetcher=browser_fetcher,
            browser_fallback_enabled=True,
        )

        self.assertEqual(urls, ["https://example.mx/product/catan"])
        self.assertEqual(
            browser_fetched_urls,
            [
                "https://example.mx/sitemap.xml",
                "https://example.mx/product-sitemap.xml",
            ],
        )

    def test_does_not_use_browser_fetcher_when_static_sitemap_succeeds(self):
        def static_fetcher(url):
            return FetchResult(
                url=url,
                text="""
                <urlset>
                  <url><loc>https://example.mx/product/catan</loc></url>
                </urlset>
                """,
            )

        def browser_fetcher(url):
            raise AssertionError("browser fetcher should not be called")

        urls = discover_product_urls_from_sitemaps(
            "https://example.mx/",
            fetcher=static_fetcher,
            browser_fetcher=browser_fetcher,
            browser_fallback_enabled=True,
        )

        self.assertEqual(urls, ["https://example.mx/product/catan"])

    def test_does_not_use_browser_fetcher_when_fallback_is_disabled(self):
        def static_fetcher(url):
            return FetchResult(
                url=url,
                text="""
                <!DOCTYPE html>
                <html>
                  <head><title>Un momento...</title></head>
                  <body>
                    <script>
                      setTimeout(function(){ window.location.reload(); }, 5000);
                    </script>
                  </body>
                </html>
                """,
            )

        def browser_fetcher(url):
            return FetchResult(
                url=url,
                text="""
                <urlset>
                  <url><loc>https://example.mx/product/catan</loc></url>
                </urlset>
                """,
            )

        with self.assertRaisesRegex(SiteProtectionBlocked, "Site protection challenge"):
            discover_product_urls_from_sitemaps(
                "https://example.mx/",
                fetcher=static_fetcher,
                browser_fetcher=browser_fetcher,
                browser_fallback_enabled=False,
            )

    def test_does_not_limit_product_urls_by_default(self):
        def fake_fetcher(url):
            return FetchResult(
                url=url,
                text="<urlset>"
                + "".join(
                    f"<url><loc>https://example.mx/products/item-{index}</loc></url>"
                    for index in range(101)
                )
                + "</urlset>",
            )

        urls = discover_product_urls_from_sitemaps("https://example.mx/", fetcher=fake_fetcher)

        self.assertEqual(len(urls), 101)

    def test_deduplicates_and_limits_product_urls(self):
        def fake_fetcher(url):
            return FetchResult(
                url=url,
                text="""
                <urlset>
                  <url><loc>https://example.mx/products/catan?variant=1</loc></url>
                  <url><loc>https://example.mx/products/catan?variant=2</loc></url>
                  <url><loc>https://example.mx/products/dixit</loc></url>
                </urlset>
                """,
            )

        urls = discover_product_urls_from_sitemaps("https://example.mx/", fetcher=fake_fetcher, limit=1)

        self.assertEqual(urls, ["https://example.mx/products/catan"])


if __name__ == "__main__":
    unittest.main()
