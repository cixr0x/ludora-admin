import html
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.cancellation import CancellationToken, OperationCancelled
from ludora.listing_extraction import extract_listing_candidates
from ludora.product_crawler import crawl_store_product_details
from ludora.sitemap_discovery import discover_product_urls_from_sitemaps
from ludora.webfetch import FetchResult


STORE = "https://sigad.mx/"
CATAN = STORE + "catan-3d-edition-juego-de-mesa"
CUBIRDS = STORE + "cubirds-juego-de-mesa"
COFFEE = STORE + "coffee-rush-piece-of-cake-expansion"
SITEMAP_NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9"
COFFEE_TITLE = "Coffee Rush: Piece of Cake – Expansión (ESP)"
PRODUCT_CARD = f"""
<div class="product-block text-center col-md-3">
  <a href="/coffee-rush-piece-of-cake-expansion?variant=1" class="product-image d-block">
    <img src="/coffee.webp" alt="{COFFEE_TITLE}" />
  </a>
  <div class="caption"><div class="brand-name"><h4>
    <a href="/coffee-rush-piece-of-cake-expansion">Coffee Rush: Piece of Cake – Expa..</a>
  </h4></div><div class="list-price"><span class="product-block-list">$750.00</span></div>
  <form id="product-form-27987561" action="/cart/add/27987561"><button>Comprar</button></form></div>
</div>
"""
DETAIL = """<script type="application/ld+json">{
  "@type":"Product", "name":"Catan 3D Edition", "description":"Juego de mesa",
  "image":"https://sigad.mx/catan.webp",
  "offers":{"price":"899.00", "priceCurrency":"MXN", "availability":"https://schema.org/InStock"}
}</script>"""


def urlset(*entries, namespace=SITEMAP_NAMESPACE):
    attribute = f' xmlns="{namespace}"' if namespace else ""
    return f"<urlset{attribute}>" + "".join(
        f"<url><loc>{html.escape(url)}</loc><priority>{priority}</priority></url>"
        for url, priority in entries
    ) + "</urlset>"


class Trace:
    def __init__(self):
        self.events = []

    def log(self, event, **fields):
        self.events.append((event, fields))


class Repository:
    def __init__(self, existing=False):
        self.existing = existing
        self.checked = []
        self.saved = []
        self.completed = []

    def discovery_url_exists(self, store_id, source_url):
        self.checked.append((store_id, source_url))
        return self.existing

    def observe_discovery_pair(self, store_id, discovered_url, target_url):
        return False

    def prepare_discovery_pair(self, record):
        self.saved.append(record)
        return SimpleNamespace(candidate_id=102, should_process=True, activate_if_ready=True)

    def complete_discovery_pair(self, candidate_id, **fields):
        self.completed.append((candidate_id, fields))


class Processor:
    def __init__(self):
        self.processed = []

    def process_candidate(self, candidate_id, record):
        self.processed.append((candidate_id, record.source_url, record.is_boardgame))


class JumpsellerDiscoveryTests(unittest.TestCase):
    def discover(self, text, **kwargs):
        return discover_product_urls_from_sitemaps(
            STORE, platform="jumpseller",
            fetcher=lambda url: FetchResult(url=url, text=text) if url == STORE + "sitemap.xml" else None,
            **kwargs,
        )

    def crawl(self, sitemap, homepage="<p>No products</p>", *, limit=None, existing=False, token=None, trace=None):
        repository, processor, trace = Repository(existing), Processor(), trace or Trace()
        classified, requests = [], []

        def classify(record):
            classified.append((record.source_url, record.title, record.price))
            record.is_boardgame = True
            record.category_confidence = 0.99

        def fetch(url, **_kwargs):
            requests.append(url)
            return FetchResult(url=url, text=homepage if url == STORE else DETAIL)

        with patch("ludora.sitemap_discovery.fetch_sitemap_text", side_effect=lambda url, **_kwargs:
                   FetchResult(url=url, text=sitemap) if url == STORE + "sitemap.xml" else None), patch(
            "ludora.product_crawler.fetch_html", side_effect=fetch
        ):
            records = crawl_store_product_details(
                STORE, 74, repository, platform="Jumpseller", limit=limit,
                item_classifier=classify, item_processor=processor,
                trace_logger=trace, cancellation_token=token,
            )
        return records, repository, classified, processor, requests, trace

    def test_crawler_passes_sitemap_products_through_existing_detail_pipeline(self):
        records, repository, classified, processor, requests, trace = self.crawl(
            urlset((STORE, "1.0"), (STORE + "contact", "0.7"),
                   (STORE + "juegos-de-mesa-1", "0.6"), (CATAN, "0.8"))
        )
        self.assertEqual([record.source_url for record in records], [CATAN])
        self.assertEqual(classified, [(CATAN, "Catan 3D Edition", "899.00")])
        self.assertEqual([record.source_url for record in repository.saved], [CATAN])
        self.assertEqual(repository.saved[0].source_listing_url, STORE + "sitemap.xml")
        self.assertEqual(processor.processed, [(102, CATAN, True)])
        self.assertEqual(repository.completed, [(102, {"activate_if_ready": True, "non_boardgame_success": False})])
        self.assertEqual(requests, [CATAN])
        self.assertIn(("inventory.sitemap_discovery.completed", {
            "product_url_count": 1, "store_id": 74, "store_url": STORE,
        }), trace.events)

    def test_crawler_homepage_cards_reach_existing_detail_pipeline(self):
        records, repository, classified, processor, requests, trace = self.crawl(
            urlset((STORE + "juegos-de-mesa-1", "0.6")), PRODUCT_CARD
        )
        self.assertEqual([record.source_url for record in records], [COFFEE])
        self.assertEqual(requests, [STORE, COFFEE])
        self.assertEqual(classified, [(COFFEE, "Catan 3D Edition", "899.00")])
        self.assertEqual(repository.saved[0].source_listing_url, STORE)
        self.assertEqual(processor.processed, [(102, COFFEE, True)])
        self.assertTrue(any(event == "inventory.listing_extract.completed" and fields["listing_count"] == 1
                            for event, fields in trace.events))

    def test_crawler_empty_candidates_fail_before_success_trace(self):
        for limit in (None, 3):
            with self.subTest(limit=limit):
                trace = Trace()
                with self.assertRaisesRegex(RuntimeError, "Jumpseller discovery returned no product candidates: https://sigad.mx/"):
                    self.crawl(urlset((STORE + "juegos-de-mesa-1", "0.6")), limit=limit, trace=trace)
                self.assertFalse(any(event == "inventory.crawl.completed" for event, _fields in trace.events))

    def test_crawler_all_existing_candidates_succeed_without_writes(self):
        records, repository, classified, processor, requests, trace = self.crawl(urlset((CATAN, "0.8")), existing=True)
        self.assertEqual(records, [])
        self.assertEqual(repository.checked, [(74, CATAN)])
        self.assertEqual(repository.saved, [])
        self.assertEqual(classified, [])
        self.assertEqual(processor.processed, [])
        self.assertEqual(requests, [])
        self.assertTrue(any(event == "inventory.crawl.completed" and fields["record_count"] == 0
                            for event, fields in trace.events))

    def test_crawler_zero_limit_is_successful_without_homepage_or_detail_fetch(self):
        for sitemap in (urlset(), urlset((CATAN, "0.8"))):
            with self.subTest(sitemap=sitemap):
                records, repository, classified, processor, requests, _trace = self.crawl(sitemap, limit=0)
                self.assertEqual(records, [])
                self.assertEqual(repository.checked, [])
                self.assertEqual(repository.saved, [])
                self.assertEqual(classified, [])
                self.assertEqual(requests, [])

    def test_crawler_cancellation_stops_before_enumeration(self):
        token = CancellationToken()
        token.cancel()
        with self.assertRaises(OperationCancelled):
            self.crawl(urlset((CATAN, "0.8")), token=token)

    def test_sitemap_product_priority_excludes_home_category_and_content(self):
        for namespace in (SITEMAP_NAMESPACE, ""):
            with self.subTest(namespace=namespace):
                self.assertEqual(self.discover(urlset(
                    (STORE, "1.0"), (STORE + "contact", "0.7"),
                    (STORE + "pokemon-tcg", "0.6"), (STORE + "juegos-de-mesa-1", "0.6"),
                    (CATAN, "0.8"), (CUBIRDS, "0.80"), namespace=namespace,
                )), [CATAN, CUBIRDS])

    def test_sitemap_reads_only_direct_product_entry_loc_and_priority(self):
        text = f"""<urlset xmlns="{SITEMAP_NAMESPACE}" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
          <url><loc>{CATAN}</loc><priority>0.8</priority>
            <image:image><image:loc>{STORE}not-a-product</image:loc></image:image></url>
          <url><loc>{STORE}category</loc><priority>0.6</priority><other><priority>0.8</priority></other></url>
          <url><other><loc>{STORE}nested</loc></other><priority>0.8</priority></url>
          <other><url><loc>{STORE}nested-url</loc><priority>0.8</priority></url></other>
          <url><loc>{STORE}no-priority</loc></url>
          <url><loc>{STORE}bad-priority</loc><priority>not-a-number</priority></url>
        </urlset>"""
        self.assertEqual(self.discover(text), [CATAN])

    def test_sitemap_rejects_malformed_xml_and_sitemap_index_locs(self):
        for text in ("<urlset><url><loc>broken", f"<sitemapindex><sitemap><loc>{CATAN}</loc><priority>0.8</priority></sitemap></sitemapindex>"):
            with self.subTest(text=text):
                self.assertEqual(self.discover(text), [])

    def test_sitemap_cleans_escaped_query_fragment_aliases_and_deduplicates_before_limit(self):
        text = urlset((CATAN + "?a=1&b=2#image", "0.8"), (CATAN + "?variant=2", "0.8"), (CUBIRDS, "0.8"))
        self.assertEqual(self.discover(text), [CATAN, CUBIRDS])
        self.assertEqual(self.discover(text, limit=1), [CATAN])
        self.assertEqual(self.discover(text, limit=2), [CATAN, CUBIRDS])
        self.assertEqual(self.discover(text, limit=0), [])

    def test_sitemap_accepts_cdata_escaped_query_urls(self):
        text = f"<urlset><url><loc><![CDATA[{CATAN}?a=1&amp;b=2]]></loc><priority>0.8</priority></url></urlset>"
        self.assertEqual(self.discover(text), [CATAN])

    def test_sitemap_rejects_invalid_off_store_and_reserved_urls(self):
        rejected = [
            "https://other.example/catan", "https://sigad.mx.evil.test/catan", "https://user:secret@sigad.mx/catan",
            "https://@sigad.mx/catan", STORE + "ca%00tan", STORE + "catan?add-to-cart=",
            "https://sigad.mx:444/catan", "https://sigad.mx:bad/catan", "ftp://sigad.mx/catan",
            "javascript:alert(1)", "https://sigad.mx/catan bad", "https://sigad.mx/ca\x00tan",
            STORE, STORE + "cart", STORE + "cart/add/123", STORE + "checkout", STORE + "contact",
            STORE + "search?q=catan", STORE + "customer/login", STORE + "blog/catan", STORE + "category/catan",
            STORE + "content/about", STORE + "my-account", STORE + "authentication", STORE + "order",
            STORE + "sitemap_1.xml", STORE + "robots.txt", STORE + "images/catan.jpg",
        ]
        # NUL is not legal XML, so exercise it via CDATA separately in listing validation below.
        text = urlset(*[(url, "0.8") for url in rejected if "\x00" not in url], (CATAN, "0.8"))
        self.assertEqual(self.discover(text), [CATAN])

    def test_jumpseller_does_not_fall_back_to_global_product_path_markers(self):
        self.assertEqual(self.discover(urlset((STORE + "products/category", "0.6"))), [])

    def test_other_platform_sitemap_keeps_path_marker_behavior(self):
        text = urlset((CATAN, "0.8"), (STORE + "products/catan", "0.6"))
        fetcher = lambda url: FetchResult(url=url, text=text) if url == STORE + "sitemap.xml" else None
        for kwargs in ({}, {"platform": "woocommerce"}):
            with self.subTest(kwargs=kwargs):
                self.assertEqual(discover_product_urls_from_sitemaps(STORE, fetcher=fetcher, **kwargs),
                                 [STORE + "products/catan"])

    def test_robots_split_sitemaps_keep_traversal_traces_and_deduplication(self):
        responses = {
            STORE + "sitemap.xml": "<urlset />",
            STORE + "robots.txt": f"User-agent: *\nSitemap: {STORE}sitemap_1.xml\nSitemap: {STORE}sitemap_2.xml\nSitemap: https://evil.test/map.xml",
            STORE + "sitemap_1.xml": urlset((CATAN, "0.8"), (STORE + "pokemon-tcg", "0.6")),
            STORE + "sitemap_2.xml": urlset((CATAN + "?variant=1", "0.8"), (CUBIRDS, "0.8")),
        }
        requests, trace = [], Trace()

        def fetch(url):
            requests.append(url)
            return FetchResult(url=url, text=responses[url]) if url in responses else None

        actual = discover_product_urls_from_sitemaps(STORE, platform="jumpseller", fetcher=fetch, trace_logger=trace)
        self.assertEqual(actual, [CATAN, CUBIRDS])
        self.assertIn(STORE + "sitemap_1.xml", requests)
        self.assertIn(STORE + "sitemap_2.xml", requests)
        self.assertNotIn("https://evil.test/map.xml", requests)
        self.assertEqual([fields["source_url"] for event, fields in trace.events
                          if event == "inventory.sitemap_source.discovered"],
                         [STORE + "sitemap_1.xml", STORE + "sitemap_2.xml"])

    def test_sitemap_browser_fallback_retains_platform_recognition(self):
        challenge = "<html><title>Un momento...</title><script>window.location.reload()</script></html>"
        actual = discover_product_urls_from_sitemaps(
            STORE, platform="jumpseller", fetcher=lambda url: FetchResult(url=url, text=challenge),
            browser_fetcher=lambda url: FetchResult(url=url, text=urlset((CATAN, "0.8"))),
            browser_fallback_enabled=True,
        )
        self.assertEqual(actual, [CATAN])

    def test_sitemap_retry_keeps_platform_recognition(self):
        attempts, trace = [], Trace()

        def fetch(url):
            attempts.append(url)
            if len(attempts) == 1:
                return FetchResult(url=url, text="", status_code=503, retry_after_seconds=0)
            return FetchResult(url=url, text=urlset((CATAN, "0.8")))

        actual = discover_product_urls_from_sitemaps(STORE, platform="jumpseller", fetcher=fetch, limit=1, trace_logger=trace)
        self.assertEqual(actual, [CATAN])
        self.assertEqual(attempts, [STORE + "sitemap.xml", STORE + "sitemap.xml"])
        self.assertTrue(any(event == "inventory.sitemap_fetch.http_error" and fields["will_retry"]
                            for event, fields in trace.events))

    def test_sitemap_cancellation_stops_split_sitemap_traversal(self):
        token = CancellationToken()

        def fetch(url):
            token.cancel()
            return FetchResult(url=url, text=urlset((CATAN, "0.8")))

        with self.assertRaises(OperationCancelled):
            discover_product_urls_from_sitemaps(STORE, platform="jumpseller", fetcher=fetch, cancellation_token=token)

    def test_product_cards_use_full_image_alt_for_truncated_heading(self):
        records = extract_listing_candidates(PRODUCT_CARD, STORE, 74, platform="jumpseller")
        self.assertEqual([(record.source_url, record.title, record.store_id) for record in records],
                         [(COFFEE, COFFEE_TITLE, 74)])

    def test_product_cards_ignore_discount_badge_text_inside_image_link(self):
        for badge in ("Oferta -25%", "Oferta -34%"):
            with self.subTest(badge=badge):
                card = PRODUCT_CARD.replace("<img ", f'<span class="status-tag sale">{badge}</span><img ')
                records = extract_listing_candidates(card, STORE, 74, platform="jumpseller")
                self.assertEqual([(record.source_url, record.title) for record in records], [(COFFEE, COFFEE_TITLE)])

    def test_product_cards_accept_text_or_image_titles_and_deduplicate_clean_urls(self):
        cards = f"""<div class="product-block"><h3><a href="{CATAN}?variant=1"> Catan <span>3D</span> </a></h3></div>
          <div class="product-block"><a class="product-image" href="{CUBIRDS}"><img alt="CuBirds" /></a></div>
          <div class="product-block"><h3><a href="{CATAN}#more">Duplicate Catan</a></h3></div>"""
        records = extract_listing_candidates(cards, STORE, 74, platform="jumpseller")
        self.assertEqual([(record.source_url, record.title) for record in records], [(CATAN, "Catan 3D"), (CUBIRDS, "CuBirds")])
        self.assertEqual(len(extract_listing_candidates(cards, STORE, 74, limit=1, platform="jumpseller")), 1)
        self.assertEqual(extract_listing_candidates(cards, STORE, 74, limit=0, platform="jumpseller"), [])

    def test_product_cards_exclude_navigation_categories_actions_offhost_and_invalid_links(self):
        invalid = [STORE, STORE + "cart/add/1", STORE + "customer/login", STORE + "category/1", STORE + "search",
                   "https://other.test/catan", "https://user:pass@sigad.mx/catan", "https://sigad.mx:444/catan",
                   "javascript:alert(1)", STORE + "ca\x00tan"]
        cards = "".join(f'<div class="product-block"><h4><a href="{html.escape(url)}">Wrong</a></h4></div>' for url in invalid)
        cards += f"""<nav><a href="{CATAN}">Navigation</a></nav>
          <div class="product-block-not"><h4><a href="{CATAN}">Not a product card</a></h4></div>
          <div class="product-block"><a href="/juegos-de-mesa-1" class="category">Juegos de mesa</a>
            <a href="/catan-3d-edition-juego-de-mesa?add-to-cart=1">Comprar</a></div>""" + PRODUCT_CARD
        self.assertEqual([record.source_url for record in extract_listing_candidates(cards, STORE, 74, platform="jumpseller")], [COFFEE])

    def test_other_platform_listing_keeps_generic_extraction(self):
        cards = PRODUCT_CARD + '<a href="/products/catan">Catan</a>'
        for kwargs in ({}, {"platform": "woocommerce"}):
            with self.subTest(kwargs=kwargs):
                self.assertEqual([record.source_url for record in extract_listing_candidates(cards, STORE, 74, **kwargs)],
                                 [STORE + "products/catan"])

    def test_product_cards_do_not_use_action_labels_as_image_titles(self):
        cards = f'<div class="product-block"><a class="product-image" href="{CATAN}"><img alt="Comprar" /></a></div>'
        self.assertEqual(extract_listing_candidates(cards, STORE, 74, platform="jumpseller"), [])

    def test_product_cards_respect_original_store_after_homepage_redirect(self):
        records = extract_listing_candidates(PRODUCT_CARD, "https://other.test/", 74,
                                             platform="jumpseller", store_url=STORE)
        self.assertEqual(records, [])


if __name__ == "__main__":
    unittest.main()
