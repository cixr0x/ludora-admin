import sys
import unittest
from pathlib import Path
from unittest.mock import Mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.browser_fetch import BrowserTextFetcher, _significant_url_tokens


class FakeResponse:
    def __init__(self, url, text, content_type):
        self.url = url
        self._text = text
        self.headers = {"content-type": content_type}

    def text(self):
        return self._text


class FakePage:
    def __init__(self, response, rendered_html):
        self.url = response.url
        self.response = response
        self.rendered_html = rendered_html
        self.waited_for_load = False
        self.waited_for_function = False
        self.wait_for_function_arg = None
        self.wait_for_function_args = []
        self.closed = False

    def goto(self, url, wait_until, timeout):
        return self.response

    def wait_for_load_state(self, state, timeout):
        self.waited_for_load = True

    def wait_for_function(self, expression, arg, timeout):
        self.waited_for_function = True
        self.wait_for_function_arg = arg
        self.wait_for_function_args.append(arg)

    def content(self):
        return self.rendered_html

    def close(self):
        self.closed = True


class FakeInfiniteScrollPage(FakePage):
    def __init__(self, response, rendered_html, scroll_snapshots):
        super().__init__(response, rendered_html)
        self.scroll_snapshots = list(scroll_snapshots)
        self.evaluate_calls = 0
        self.wait_timeouts = []

    def evaluate(self, expression):
        snapshot_index = min(self.evaluate_calls, len(self.scroll_snapshots) - 1)
        self.evaluate_calls += 1
        return self.scroll_snapshots[snapshot_index]

    def wait_for_timeout(self, timeout):
        self.wait_timeouts.append(timeout)


class FakeContext:
    def __init__(self, pages):
        self.pages = list(pages)
        self.created_pages = []

    def new_page(self):
        page = self.pages.pop(0)
        self.created_pages.append(page)
        return page


class BrowserFetchTests(unittest.TestCase):
    def test_reset_context_replaces_the_amazon_cookie_session(self):
        previous_context = Mock()
        next_context = Mock()
        next_page = Mock()
        next_context.new_page.return_value = next_page
        browser = Mock()
        browser.new_context.return_value = next_context
        fetcher = BrowserTextFetcher()
        fetcher._browser = browser
        fetcher._context = previous_context
        fetcher._page = Mock()

        fetcher.reset_context()

        previous_context.close.assert_called_once_with()
        next_context.add_init_script.assert_called_once()
        next_context.new_page.assert_called_once_with()
        self.assertIs(fetcher._context, next_context)
        self.assertIs(fetcher._page, next_page)

    def test_fetch_returns_rendered_dom_for_html_pages(self):
        response = FakeResponse(
            "https://example.mx/products/catan",
            "<html><head><title>Placeholder</title></head></html>",
            "text/html;charset=utf-8",
        )
        page = FakePage(response, "<html><body><h1>Catan</h1></body></html>")
        fetcher = BrowserTextFetcher()
        fetcher._page = page

        result = fetcher.fetch("https://example.mx/products/catan")

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.text, "<html><body><h1>Catan</h1></body></html>")
        self.assertTrue(page.waited_for_load)
        self.assertTrue(page.waited_for_function)

    def test_fetch_expands_embedded_amazon_store_asin_list_without_clicking_load_more(self):
        response = FakeResponse(
            "https://www.amazon.com.mx/stores/page/STORE-PAGE-ID/search?terms=jue",
            "<html></html>",
            "text/html;charset=utf-8",
        )
        page = FakePage(
            response,
            """
            <html><body>
              <a href="/First-Game/dp/B0FIRST001">First Game</a>
              <script>
                window.storeState = {
                  "ASINList": ["B0FIRST001", "B0SECOND02", "B0THIRD003"]
                };
              </script>
            </body></html>
            """,
        )
        fetcher = BrowserTextFetcher()
        fetcher._page = page

        result = fetcher.fetch(response.url)

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.text.count('data-ludora-amazon-store-asin="'), 3)
        self.assertIn('href="/dp/B0SECOND02"', result.text)
        self.assertIn('href="/dp/B0THIRD003"', result.text)

    def test_fetch_scrolls_amazon_store_search_until_products_stop_growing(self):
        response = FakeResponse(
            "https://www.amazon.com.mx/stores/page/STORE-PAGE-ID/search?terms=jue",
            "<html></html>",
            "text/html;charset=utf-8",
        )
        page = FakeInfiniteScrollPage(
            response,
            "<html><body><a href='/dp/B0LAST0001'>Last product</a></body></html>",
            [
                {"productCount": 20, "scrollHeight": 2_000},
                {"productCount": 40, "scrollHeight": 4_000},
                {"productCount": 40, "scrollHeight": 4_000},
                {"productCount": 40, "scrollHeight": 4_000},
                {"productCount": 40, "scrollHeight": 4_000},
            ],
        )
        fetcher = BrowserTextFetcher()
        fetcher._page = page

        result = fetcher.fetch(response.url)

        self.assertIsNotNone(result)
        assert result is not None
        self.assertIn("B0LAST0001", result.text)
        self.assertEqual(page.evaluate_calls, 5)
        self.assertEqual(page.wait_timeouts, [750, 750, 750, 750])

    def test_fetch_clicks_amazon_store_load_more_until_button_disappears(self):
        response = FakeResponse(
            "https://www.amazon.com.mx/stores/page/STORE-PAGE-ID/search?terms=jue",
            "<html></html>",
            "text/html;charset=utf-8",
        )
        page = FakeInfiniteScrollPage(
            response,
            "<html><body><a href='/dp/B0LAST0001'>Last product</a></body></html>",
            [
                {
                    "loadMoreButtonClicked": True,
                    "loadMoreButtonPresent": True,
                    "productCount": 25,
                    "scrollHeight": 2_000,
                },
                {
                    "loadMoreButtonClicked": True,
                    "loadMoreButtonPresent": True,
                    "productCount": 50,
                    "scrollHeight": 4_000,
                },
                {
                    "loadMoreButtonClicked": False,
                    "loadMoreButtonPresent": False,
                    "productCount": 75,
                    "scrollHeight": 6_000,
                },
                {
                    "loadMoreButtonClicked": False,
                    "loadMoreButtonPresent": False,
                    "productCount": 75,
                    "scrollHeight": 6_000,
                },
                {
                    "loadMoreButtonClicked": False,
                    "loadMoreButtonPresent": False,
                    "productCount": 75,
                    "scrollHeight": 6_000,
                },
                {
                    "loadMoreButtonClicked": False,
                    "loadMoreButtonPresent": False,
                    "productCount": 75,
                    "scrollHeight": 6_000,
                },
            ],
        )
        fetcher = BrowserTextFetcher()
        fetcher._page = page

        result = fetcher.fetch(response.url)

        self.assertIsNotNone(result)
        self.assertEqual(page.evaluate_calls, 6)
        self.assertEqual(page.wait_for_function_args[-2:], [25, 50])
        self.assertEqual(page.wait_timeouts, [5_000, 5_000, 750, 750, 750])

    def test_fetch_fails_when_amazon_store_load_more_stops_advancing(self):
        class StalledLoadMorePage(FakeInfiniteScrollPage):
            def wait_for_function(self, expression, arg, timeout):
                if isinstance(arg, int):
                    raise TimeoutError("Amazon batch did not load")
                return super().wait_for_function(expression, arg, timeout)

        response = FakeResponse(
            "https://www.amazon.com.mx/stores/page/STORE-PAGE-ID/search?terms=jue",
            "<html></html>",
            "text/html;charset=utf-8",
        )
        stalled_snapshot = {
            "loadMoreButtonClicked": True,
            "loadMoreButtonPresent": True,
            "productCount": 25,
            "scrollHeight": 2_000,
        }
        page = StalledLoadMorePage(
            response,
            "<html><body><a href='/dp/B0FIRST001'>First product</a></body></html>",
            [stalled_snapshot],
        )
        trace_logger = Mock()
        fetcher = BrowserTextFetcher(trace_logger=trace_logger)
        fetcher._page = page
        fetcher._playwright_timeout_error = TimeoutError

        result = fetcher.fetch(response.url)

        self.assertIsNone(result)
        self.assertEqual(page.evaluate_calls, 4)
        self.assertEqual(page.wait_timeouts, [10_000, 20_000, 30_000])
        self.assertIn("load-more button remained visible", trace_logger.log.call_args.kwargs["error"])

    def test_wait_tokens_ignore_short_common_slug_words(self):
        self.assertEqual(
            _significant_url_tokens("https://example.mx/products/the-resistance-avalon"),
            ["resistance", "avalon"],
        )
        self.assertEqual(_significant_url_tokens("https://example.mx/products/res-arcana"), ["arcana"])

    def test_fetch_preserves_response_text_for_xml_sitemaps(self):
        response = FakeResponse(
            "https://example.mx/sitemap.xml",
            "<urlset><url><loc>https://example.mx/products/catan</loc></url></urlset>",
            "application/xml",
        )
        page = FakePage(response, "<html><body>Chrome XML viewer</body></html>")
        fetcher = BrowserTextFetcher()
        fetcher._page = page

        result = fetcher.fetch("https://example.mx/sitemap.xml")

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.text, response.text())
        self.assertFalse(page.waited_for_load)
        self.assertFalse(page.waited_for_function)

    def test_fetch_uses_a_fresh_context_page_for_each_request(self):
        first_response = FakeResponse("https://example.mx/products/catan", "<html></html>", "text/html")
        second_response = FakeResponse("https://example.mx/products/dixit", "<html></html>", "text/html")
        first_page = FakePage(first_response, "<html><body><h1>Catan</h1></body></html>")
        second_page = FakePage(second_response, "<html><body><h1>Dixit</h1></body></html>")
        context = FakeContext([first_page, second_page])
        fetcher = BrowserTextFetcher()
        fetcher._context = context

        first_result = fetcher.fetch("https://example.mx/products/catan")
        second_result = fetcher.fetch("https://example.mx/products/dixit")

        self.assertEqual(first_result.text, "<html><body><h1>Catan</h1></body></html>")
        self.assertEqual(second_result.text, "<html><body><h1>Dixit</h1></body></html>")
        self.assertEqual(context.created_pages, [first_page, second_page])
        self.assertTrue(first_page.closed)
        self.assertTrue(second_page.closed)

    def test_fetch_logs_exact_exception_to_trace_logger(self):
        class FailingPage:
            url = "chrome-error://chromewebdata/"

            def goto(self, url, wait_until, timeout):
                raise RuntimeError("net::ERR_FAILED at https://example.mx/products/catan")

            def close(self):
                return None

        trace_logger = Mock()
        fetcher = BrowserTextFetcher(timeout_ms=12_345, trace_logger=trace_logger)
        fetcher._page = FailingPage()
        fetcher._playwright_error = RuntimeError

        result = fetcher.fetch("https://example.mx/products/catan")

        self.assertIsNone(result)
        trace_logger.log.assert_called_once_with(
            "browser_fetch.failed",
            error="net::ERR_FAILED at https://example.mx/products/catan",
            error_type="RuntimeError",
            final_url="chrome-error://chromewebdata/",
            timeout_ms=12_345,
            url="https://example.mx/products/catan",
        )

    def test_fetch_inspects_rendered_html_without_reading_navigation_response_body(self):
        class ResponseWithUnavailableBody(FakeResponse):
            def text(self):
                raise RuntimeError("Network.getResponseBody: No resource with given identifier found")

        response = ResponseWithUnavailableBody(
            "https://www.amazon.com.mx/s?page=3",
            "<html><body>unused response body</body></html>",
            "text/html;charset=utf-8",
        )
        page = FakePage(response, "<html><body><h1>Amazon search results</h1></body></html>")
        fetcher = BrowserTextFetcher()
        fetcher._page = page

        result = fetcher.fetch(response.url)

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.text, page.rendered_html)


if __name__ == "__main__":
    unittest.main()
