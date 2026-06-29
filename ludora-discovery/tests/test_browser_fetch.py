import sys
import unittest
from pathlib import Path


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
        self.closed = False

    def goto(self, url, wait_until, timeout):
        return self.response

    def wait_for_load_state(self, state, timeout):
        self.waited_for_load = True

    def wait_for_function(self, expression, arg, timeout):
        self.waited_for_function = True
        self.wait_for_function_arg = arg

    def content(self):
        return self.rendered_html

    def close(self):
        self.closed = True


class FakeContext:
    def __init__(self, pages):
        self.pages = list(pages)
        self.created_pages = []

    def new_page(self):
        page = self.pages.pop(0)
        self.created_pages.append(page)
        return page


class BrowserFetchTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
