import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.amazon_discovery import (
    _amazon_retry_delay_seconds,
    _extract_amazon_detail_candidate,
    build_amazon_store_search_url,
    crawl_amazon_brand_inventory,
    crawl_amazon_store_inventory,
)
from ludora.database import ItemCandidateUpsertResult
from ludora.webfetch import FetchResult


class FakeRepository:
    def __init__(self, existing_urls=None):
        self.existing_urls = set(existing_urls or [])
        self.exists_checks = []
        self.item_records = []

    def item_candidate_exists(self, store_id, source_url):
        self.exists_checks.append((store_id, source_url))
        return (store_id, source_url) in self.existing_urls

    def upsert_item_candidate(self, record):
        self.item_records.append(record)
        return ItemCandidateUpsertResult(candidate_id=101, listing_status="PENDING", item_id=None, should_process=True)


class FakeTraceLogger:
    def __init__(self):
        self.entries = []

    def log(self, event, **fields):
        self.entries.append((event, fields))


class AmazonDiscoveryTests(unittest.TestCase):
    def test_builds_storefront_search_url_from_named_store_page(self):
        url = build_amazon_store_search_url(
            "https://www.amazon.com.mx/stores/LaCompa%C3%B1%C3%ADadelosJuegos/page/00565807-102E-497A-894A-3434B4619BD2",
            "jue",
        )

        self.assertEqual(
            url,
            "https://www.amazon.com.mx/stores/page/00565807-102E-497A-894A-3434B4619BD2/search?terms=jue",
        )

    def test_crawls_storefront_search_products_and_extracts_detail_rows(self):
        search_html = """
        <html><body>
          <a href="/Compa%C3%B1%C3%ADa-Juegos-Catfe/dp/B0DZL3YFC5?ref_=ast_sto_dp">
            La Compañía de los Juegos | Catfé | Juego en Español
          </a>
          <a href="/Compa%C3%B1%C3%ADa-Juegos-Catfe/dp/B0DZL3YFC5?ref_=ast_sto_dp">Ver opciones</a>
        </body></html>
        """
        product_html = """
        <html><body>
          <span id="productTitle">La Compañía de los Juegos | Catfé | Juego en Español</span>
          <img id="landingImage" src="https://m.media-amazon.com/images/I/catfe.jpg">
          <span class="a-offscreen">$417.00</span>
          <div id="availability">Disponible</div>
          <input id="add-to-cart-button" type="submit" value="Agregar al carrito">
          <input id="buy-now-button" type="submit" value="Comprar ahora">
          <table>
            <tr><th>Marca</th><td>CJ LA COMPAÑÍA DE LOS JUEGOS</td></tr>
            <tr><th>Fabricante</th><td>Meeple Angel</td></tr>
            <tr><th>Cantidad de jugadores</th><td>2-5</td></tr>
            <tr><th>Tiempo de juego estimado</th><td>20 Minutos</td></tr>
            <tr><th>Edad mínima recomendada por el fabricante</th><td>96</td></tr>
            <tr><th>ASIN</th><td>B0DZL3YFC5</td></tr>
          </table>
          <div id="feature-bullets">
            <ul>
              <li>Para 2-5 Jugadores. Tiempo promedio de Partida: 20 minutos</li>
              <li>Juego perfecto para jugar en familia o con amigos.</li>
            </ul>
          </div>
        </body></html>
        """
        fetched_urls = []

        def fetcher(url):
            fetched_urls.append(url)
            if "/search?" in url:
                return FetchResult(url=url, text=search_html)
            return FetchResult(url=url, text=product_html)

        classified = []

        def classifier(record):
            classified.append(record.title)
            record.is_boardgame = True
            record.category_confidence = 0.95
            record.classification_reasons = ["amazon test"]
            return record

        repository = FakeRepository()

        records = crawl_amazon_store_inventory(
            "https://www.amazon.com.mx/stores/LaComp/page/00565807-102E-497A-894A-3434B4619BD2",
            12,
            repository,
            browser_fetcher=fetcher,
            item_classifier=classifier,
            delay_seconds=0,
        )

        self.assertEqual(
            fetched_urls[0],
            "https://www.amazon.com.mx/stores/page/00565807-102E-497A-894A-3434B4619BD2/search?terms=jue",
        )
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record.source_url, "https://www.amazon.com.mx/dp/B0DZL3YFC5")
        self.assertEqual(record.source_listing_url, fetched_urls[0])
        self.assertEqual(record.title, "La Compañía de los Juegos | Catfé | Juego en Español")
        self.assertEqual(record.publisher, "Meeple Angel")
        self.assertEqual(record.image_url, "https://m.media-amazon.com/images/I/catfe.jpg")
        self.assertEqual(record.raw_price, "$417.00")
        self.assertEqual(record.price, "417.00")
        self.assertEqual(record.availability, "available")
        self.assertEqual(record.min_players, 2)
        self.assertEqual(record.max_players, 5)
        self.assertEqual(record.min_minutes, 20)
        self.assertEqual(record.max_minutes, 20)
        self.assertEqual(record.min_age, 8)
        self.assertEqual(record.language, "es")
        self.assertEqual(record.store_sku, "B0DZL3YFC5")
        self.assertEqual(record.raw_payload["amazon"]["asin"], "B0DZL3YFC5")
        self.assertEqual(record.raw_payload["amazon"]["product_details"]["Cantidad de jugadores"], "2-5")
        self.assertEqual(classified, [record.title])
        self.assertEqual(repository.item_records[0].classification_reasons, ["amazon test"])

    def test_marks_amazon_product_without_direct_buy_option_out_of_stock(self):
        product_html = """
        <html><body>
          <span id="productTitle">Asmodee Survive The Island Monster Pack</span>
          <div id="availability">
            <div id="all-offers-display"></div>
          </div>
          <div id="recommendations">
            <span class="a-offscreen">$635.11</span>
          </div>
          <table><tr><th>ASIN</th><td>B0DQVHVBX6</td></tr></table>
        </body></html>
        """

        record = _extract_amazon_detail_candidate(
            html=product_html,
            product_url="https://www.amazon.com.mx/dp/B0DQVHVBX6",
            store_id=12,
            source_listing_url="https://www.amazon.com.mx/stores/page/store-id/search?terms=jue",
            search_title="Survive The Island Monster Pack",
        )

        self.assertEqual(record.availability, "out_of_stock")
        self.assertEqual(record.availability_source, "amazon_detail")
        self.assertEqual(record.raw_price, "")
        self.assertEqual(record.price, "")
        self.assertEqual(record.price_source, "none")
        self.assertFalse(record.raw_payload["amazon"]["has_add_to_cart"])
        self.assertFalse(record.raw_payload["amazon"]["has_buy_now"])

    def test_applies_title_extractor_before_classification_and_upsert(self):
        search_html = """
        <html><body>
          <a href="/Compania-Juegos-Yokai-Pagoda/dp/B0TEST1234?ref_=ast_sto_dp">
            La Compania de los Juegos | Yokai Pagoda | Juego en Espanol
          </a>
        </body></html>
        """
        product_html = """
        <html><body>
          <span id="productTitle">
            La Compania de los Juegos | Yokai Pagoda | Juega Cartas para Evitar Recibir Puntos Negativos | Juego en Espanol
          </span>
          <table><tr><th>ASIN</th><td>B0TEST1234</td></tr></table>
        </body></html>
        """

        def fetcher(url):
            if "/search?" in url:
                return FetchResult(url=url, text=search_html)
            return FetchResult(url=url, text=product_html)

        classified = []

        def classifier(record):
            classified.append(record.title)
            return record

        repository = FakeRepository()
        records = crawl_amazon_store_inventory(
            "https://www.amazon.com.mx/stores/page/00565807-102E-497A-894A-3434B4619BD2",
            12,
            repository,
            browser_fetcher=fetcher,
            item_classifier=classifier,
            item_title_extractor=lambda record: "Yokai Pagoda",
            delay_seconds=0,
        )

        self.assertEqual(records[0].title, "Yokai Pagoda")
        self.assertEqual(classified, ["Yokai Pagoda"])
        self.assertEqual(repository.item_records[0].title, "Yokai Pagoda")
        self.assertEqual(
            records[0].raw_payload["amazon"]["product_title"],
            "La Compania de los Juegos | Yokai Pagoda | Juega Cartas para Evitar Recibir Puntos Negativos | Juego en Espanol",
        )
        self.assertEqual(records[0].raw_payload["amazon"]["extracted_game_title"], "Yokai Pagoda")

    def test_raises_when_amazon_search_fetch_fails(self):
        repository = FakeRepository()

        with self.assertRaisesRegex(RuntimeError, "Failed to fetch Amazon search page"):
            crawl_amazon_store_inventory(
                "https://www.amazon.com.mx/stores/page/00565807-102E-497A-894A-3434B4619BD2",
                12,
                repository,
                browser_fetcher=lambda _url: None,
                delay_seconds=0,
            )

        self.assertEqual(repository.item_records, [])

    def test_retries_throttled_amazon_store_search_in_a_clean_context(self):
        product_url = "https://www.amazon.com.mx/dp/B0TEST1234"
        search_html = f'<html><body><a href="{product_url}">Juego recuperado</a></body></html>'
        product_html = """
        <html><head><title>Juego recuperado</title></head><body>
          <span id="productTitle">Juego recuperado</span>
          <div>ASIN: B0TEST1234</div>
        </body></html>
        """

        class RecoveringFetcher:
            def __init__(self):
                self.context_resets = 0
                self.search_fetches = 0

            def fetch(self, url):
                if "/search?" not in url:
                    return FetchResult(url=url, text=product_html)
                self.search_fetches += 1
                if self.context_resets == 0:
                    return FetchResult(
                        url=url,
                        text="<html><head><title>Documento no encontrado</title></head></html>",
                        status_code=429,
                    )
                return FetchResult(url=url, text=search_html)

            def reset_context(self):
                self.context_resets += 1

        fetcher = RecoveringFetcher()
        trace = FakeTraceLogger()

        records = crawl_amazon_store_inventory(
            "https://www.amazon.com.mx/stores/page/00565807-102E-497A-894A-3434B4619BD2",
            12,
            FakeRepository(),
            browser_fetcher=fetcher.fetch,
            trace_logger=trace,
            delay_seconds=0,
        )

        self.assertEqual(fetcher.search_fetches, 2)
        self.assertEqual(fetcher.context_resets, 1)
        self.assertEqual([record.title for record in records], ["Juego recuperado"])
        invalid_entries = [fields for event, fields in trace.entries if event == "amazon_inventory.search_fetch.invalid"]
        self.assertEqual(len(invalid_entries), 1)
        self.assertEqual(invalid_entries[0]["status_code"], 429)
        self.assertEqual(invalid_entries[0]["reason"], "http_status")

    def test_rejects_empty_amazon_storefront_shell_after_retries(self):
        search_url = "https://www.amazon.com.mx/stores/page/00565807-102E-497A-894A-3434B4619BD2/search?terms=jue"
        shell_html = "<html><head><title>Amazon.com.mx</title></head><body>Inicio</body></html>"
        fetched_urls = []

        def fetcher(url):
            fetched_urls.append(url)
            return FetchResult(url=url, text=shell_html)

        trace = FakeTraceLogger()
        with self.assertRaisesRegex(RuntimeError, "Failed to fetch valid Amazon search page"):
            crawl_amazon_store_inventory(
                "https://www.amazon.com.mx/stores/page/00565807-102E-497A-894A-3434B4619BD2",
                12,
                FakeRepository(),
                browser_fetcher=fetcher,
                trace_logger=trace,
                delay_seconds=0,
            )

        self.assertEqual(fetched_urls, [search_url, search_url, search_url])
        invalid_entries = [fields for event, fields in trace.entries if event == "amazon_inventory.search_fetch.invalid"]
        self.assertEqual(len(invalid_entries), 3)
        self.assertTrue(all(entry["reason"] == "missing_listing_candidates" for entry in invalid_entries))
        self.assertFalse(invalid_entries[-1]["will_retry"])

    def test_uses_long_backoff_for_amazon_throttling(self):
        self.assertEqual(
            _amazon_retry_delay_seconds(
                {"reason": "http_status", "status_code": 429, "page_title": "Documento no encontrado"},
                attempt=1,
                base_delay_seconds=1,
                jitter_fraction=0,
            ),
            60,
        )
        self.assertEqual(
            _amazon_retry_delay_seconds(
                {"reason": "http_status", "status_code": 503, "page_title": "Service unavailable"},
                attempt=2,
                base_delay_seconds=1,
                jitter_fraction=0,
            ),
            180,
        )

        jittered_delay = _amazon_retry_delay_seconds(
            {"reason": "missing_product_title", "status_code": 200, "page_title": "Amazon.com.mx"},
            attempt=1,
            base_delay_seconds=1,
        )
        self.assertGreaterEqual(jittered_delay, 48)
        self.assertLessEqual(jittered_delay, 72)

    def test_raises_when_amazon_detail_fetch_fails(self):
        search_html = """
        <html><body>
          <a href="/Compania-Juegos-Yokai-Pagoda/dp/B0TEST1234?ref_=ast_sto_dp">
            La Compania de los Juegos | Yokai Pagoda | Juego en Espanol
          </a>
        </body></html>
        """

        def fetcher(url):
            if "/search?" in url:
                return FetchResult(url=url, text=search_html)
            return None

        repository = FakeRepository()

        with self.assertRaisesRegex(RuntimeError, "Failed to fetch Amazon product detail page: https://www.amazon.com.mx/dp/B0TEST1234"):
            crawl_amazon_store_inventory(
                "https://www.amazon.com.mx/stores/page/00565807-102E-497A-894A-3434B4619BD2",
                12,
                repository,
                browser_fetcher=fetcher,
                delay_seconds=0,
            )

        self.assertEqual(repository.item_records, [])

    def test_retries_generic_amazon_detail_page_before_title_extraction(self):
        product_url = "https://www.amazon.com.mx/dp/B0B7QXY8ZS"
        search_html = f'<html><body><a href="{product_url}"></a></body></html>'
        generic_html = "<html><head><title>Amazon.com.mx</title></head><body>Inicio</body></html>"
        product_html = """
        <html><head><title>Disney Juego de Mesa : Amazon.com.mx</title></head><body>
          <span id="productTitle">Disney Juego de Mesa Infantil ¿Sabes Quién Es?</span>
          <input id="add-to-cart-button" type="submit" value="Agregar al carrito">
          <table><tr><th>ASIN</th><td>B0B7QXY8ZS</td></tr></table>
        </body></html>
        """
        detail_fetches = []

        def fetcher(url):
            if "/search?" in url:
                return FetchResult(url=url, text=search_html)
            detail_fetches.append(url)
            html = generic_html if len(detail_fetches) == 1 else product_html
            return FetchResult(url=url, text=html)

        extractor_inputs = []

        def title_extractor(record):
            extractor_inputs.append(record.title)
            return "¿Sabes Quién Es?"

        trace = FakeTraceLogger()
        repository = FakeRepository()
        records = crawl_amazon_store_inventory(
            "https://www.amazon.com.mx/stores/Novelty/page/63DBDD5C-19BE-4897-A1AE-57B94E8DA3FC",
            11,
            repository,
            browser_fetcher=fetcher,
            item_title_extractor=title_extractor,
            trace_logger=trace,
            delay_seconds=0,
        )

        self.assertEqual(detail_fetches, [product_url, product_url])
        self.assertEqual(extractor_inputs, ["Disney Juego de Mesa Infantil ¿Sabes Quién Es?"])
        self.assertEqual(records[0].title, "¿Sabes Quién Es?")
        invalid_entries = [fields for event, fields in trace.entries if event == "amazon_inventory.candidate.detail_fetch.invalid"]
        self.assertEqual(len(invalid_entries), 1)
        self.assertEqual(
            invalid_entries[0],
            {
                "attempt": 1,
                "expected_asin": "B0B7QXY8ZS",
                "expected_asin_present": False,
                "final_url": product_url,
                "max_attempts": 3,
                "page_title": "Amazon.com.mx",
                "product_title_present": False,
                "reason": "missing_product_title",
                "retry_in_seconds": 0.0,
                "source_url": product_url,
                "status_code": 200,
                "store_id": 11,
                "will_retry": True,
            },
        )

    def test_raises_after_invalid_amazon_detail_page_retries(self):
        product_url = "https://www.amazon.com.mx/dp/B0B7QXY8ZS"
        search_html = f'<html><body><a href="{product_url}"></a></body></html>'
        generic_html = "<html><head><title>Amazon.com.mx</title></head><body>Inicio</body></html>"
        detail_fetches = []

        def fetcher(url):
            if "/search?" in url:
                return FetchResult(url=url, text=search_html)
            detail_fetches.append(url)
            return FetchResult(url=url, text=generic_html)

        extractor_inputs = []
        trace = FakeTraceLogger()
        repository = FakeRepository()

        with self.assertRaisesRegex(RuntimeError, "Failed to fetch valid Amazon product detail page"):
            crawl_amazon_store_inventory(
                "https://www.amazon.com.mx/stores/Novelty/page/63DBDD5C-19BE-4897-A1AE-57B94E8DA3FC",
                11,
                repository,
                browser_fetcher=fetcher,
                item_title_extractor=lambda record: extractor_inputs.append(record.title) or record.title,
                trace_logger=trace,
                delay_seconds=0,
            )

        self.assertEqual(detail_fetches, [product_url, product_url, product_url])
        self.assertEqual(extractor_inputs, [])
        self.assertEqual(repository.item_records, [])
        invalid_entries = [fields for event, fields in trace.entries if event == "amazon_inventory.candidate.detail_fetch.invalid"]
        self.assertEqual(len(invalid_entries), 3)
        self.assertEqual([entry["attempt"] for entry in invalid_entries], [1, 2, 3])
        self.assertEqual(invalid_entries[-1]["page_title"], "Amazon.com.mx")
        self.assertFalse(invalid_entries[-1]["will_retry"])

    def test_preserves_valid_products_after_an_exhausted_detail_page_and_reports_partial_failure(self):
        failed_url = "https://www.amazon.com.mx/dp/B0BAD00001"
        valid_url = "https://www.amazon.com.mx/dp/B0GOOD0001"
        search_html = f"""
        <html><body>
          <a href="{failed_url}">Producto bloqueado</a>
          <a href="{valid_url}">Producto valido</a>
        </body></html>
        """
        shell_html = "<html><head><title>Amazon.com.mx</title></head><body>Inicio</body></html>"
        valid_html = """
        <html><head><title>Producto valido</title></head><body>
          <span id="productTitle">Novelty Producto Valido</span>
          <div>ASIN: B0GOOD0001</div>
        </body></html>
        """
        detail_fetches = []

        def fetcher(url):
            if "/search?" in url:
                return FetchResult(url=url, text=search_html)
            detail_fetches.append(url)
            return FetchResult(url=url, text=shell_html if url == failed_url else valid_html)

        trace = FakeTraceLogger()
        repository = FakeRepository()

        with self.assertRaisesRegex(RuntimeError, "Valid products were preserved"):
            crawl_amazon_store_inventory(
                "https://www.amazon.com.mx/stores/Novelty/page/63DBDD5C-19BE-4897-A1AE-57B94E8DA3FC",
                11,
                repository,
                browser_fetcher=fetcher,
                trace_logger=trace,
                delay_seconds=0,
            )

        self.assertEqual(detail_fetches, [failed_url, failed_url, failed_url, valid_url])
        self.assertEqual([record.source_url for record in repository.item_records], [valid_url])
        exhausted_entries = [
            fields
            for event, fields in trace.entries
            if event == "amazon_inventory.candidate.detail_fetch.exhausted"
        ]
        self.assertEqual(
            exhausted_entries,
            [
                {
                    "attempts": 3,
                    "error": f"Failed to fetch valid Amazon product detail page: {failed_url}",
                    "resume_in_seconds": 0.0,
                    "source_url": failed_url,
                    "store_id": 11,
                    "title": "Producto bloqueado",
                }
            ],
        )
        partial_entries = [
            fields for event, fields in trace.entries if event == "amazon_inventory.crawl.partial_failure"
        ]
        self.assertEqual(
            partial_entries,
            [
                {
                    "failed_detail_pages": 1,
                    "failed_source_urls": [failed_url],
                    "processed_items": 1,
                    "store_id": 11,
                }
            ],
        )

    def test_resets_browser_context_before_retrying_invalid_amazon_detail_page(self):
        product_url = "https://www.amazon.com.mx/dp/B0B7QXY8ZS"
        search_html = f'<html><body><a href="{product_url}"></a></body></html>'
        generic_html = "<html><head><title>Amazon.com.mx</title></head><body>B0B7QXY8ZS</body></html>"
        valid_html = """
        <html><head><title>Valid product</title></head><body>
          <span id="productTitle">Novelty Corp Juego Recuperado</span>
          <div>ASIN: B0B7QXY8ZS</div>
        </body></html>
        """

        class RecoveringFetcher:
            def __init__(self):
                self.context_resets = 0
                self.detail_fetches = 0

            def fetch(self, url):
                if "/search?" in url:
                    return FetchResult(url=url, text=search_html)
                self.detail_fetches += 1
                html = generic_html if self.context_resets == 0 else valid_html
                return FetchResult(url=url, text=html)

            def reset_context(self):
                self.context_resets += 1

        fetcher = RecoveringFetcher()
        trace = FakeTraceLogger()
        repository = FakeRepository()

        records = crawl_amazon_store_inventory(
            "https://www.amazon.com.mx/stores/Novelty/page/63DBDD5C-19BE-4897-A1AE-57B94E8DA3FC",
            11,
            repository,
            browser_fetcher=fetcher.fetch,
            trace_logger=trace,
            delay_seconds=0,
        )

        self.assertEqual(fetcher.detail_fetches, 2)
        self.assertEqual(fetcher.context_resets, 1)
        self.assertEqual([record.title for record in records], ["Novelty Corp Juego Recuperado"])
        reset_entries = [
            fields
            for event, fields in trace.entries
            if event == "amazon_inventory.candidate.detail_fetch.context_reset.completed"
        ]
        self.assertEqual(
            reset_entries,
            [{"attempt": 1, "source_url": product_url, "store_id": 11}],
        )

    def test_crawls_brand_search_and_stores_only_matching_brand_products(self):
        brand_search_url = "https://www.amazon.com.mx/s?srs=19815643011&rh=p_89%3AHasbro%2BGaming"
        search_html = """
        <html><body>
          <a href="/Hasbro-Gaming-Clue/dp/B0HASBRO01">Hasbro Gaming | Clue | Juego de mesa</a>
          <a href="/Mattel-Games-Uno/dp/B0MATTEL01">Mattel Games | UNO</a>
        </body></html>
        """
        hasbro_product_html = """
        <html><body>
          <span id="productTitle">Hasbro Gaming | Clue | Juego de misterio</span>
          <table>
            <tr><th>Marca</th><td>Hasbro Gaming</td></tr>
            <tr><th>ASIN</th><td>B0HASBRO01</td></tr>
          </table>
        </body></html>
        """
        mattel_product_html = """
        <html><body>
          <span id="productTitle">Mattel Games | UNO | Juego de cartas</span>
          <table>
            <tr><th>Marca</th><td>Mattel Games</td></tr>
            <tr><th>ASIN</th><td>B0MATTEL01</td></tr>
          </table>
        </body></html>
        """
        fetched_urls = []

        def fetcher(url):
            fetched_urls.append(url)
            if url == brand_search_url:
                return FetchResult(url=url, text=search_html)
            if "/s?" in url:
                return FetchResult(url=url, text="<html><body>No more results</body></html>")
            if url.endswith("/B0HASBRO01"):
                return FetchResult(url=url, text=hasbro_product_html)
            return FetchResult(url=url, text=mattel_product_html)

        classified = []

        def classifier(record):
            classified.append(record.title)
            return record

        repository = FakeRepository()
        records = crawl_amazon_brand_inventory(
            brand_search_url,
            12,
            repository,
            brand_name="Hasbro Gaming",
            browser_fetcher=fetcher,
            item_classifier=classifier,
            item_title_extractor=lambda record: "Clue",
            delay_seconds=0,
        )

        self.assertEqual(
            fetched_urls,
            [
                brand_search_url,
                "https://www.amazon.com.mx/dp/B0HASBRO01",
                "https://www.amazon.com.mx/dp/B0MATTEL01",
                "https://www.amazon.com.mx/s?srs=19815643011&rh=p_89%3AHasbro%2BGaming&page=2",
            ],
        )
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].title, "Clue")
        self.assertEqual(records[0].publisher, "Hasbro Gaming")
        self.assertEqual(records[0].raw_payload["amazon"]["brand"], "Hasbro Gaming")
        self.assertEqual(records[0].raw_payload["amazon"]["extracted_game_title"], "Clue")
        self.assertEqual(classified, ["Clue"])
        self.assertEqual([record.source_url for record in repository.item_records], ["https://www.amazon.com.mx/dp/B0HASBRO01"])

    def test_crawls_brand_search_up_to_five_pages(self):
        brand_search_url = "https://www.amazon.com.mx/s?srs=19815643011&rh=p_89%3AHasbro%2BGaming"
        fetched_urls = []

        def fetcher(url):
            fetched_urls.append(url)
            if "/s?" in url:
                page = _page_number(url)
                return FetchResult(
                    url=url,
                    text=f'<a href="/Hasbro-Gaming-Game-{page}/dp/B0PAGE{page:04d}">Hasbro Gaming | Game {page}</a>',
                )
            asin = url.rsplit("/", 1)[-1]
            return FetchResult(
                url=url,
                text=f"""
                <html><body>
                  <span id="productTitle">Hasbro Gaming | Game {asin[-4:]}</span>
                  <table>
                    <tr><th>Marca</th><td>Hasbro Gaming</td></tr>
                    <tr><th>ASIN</th><td>{asin}</td></tr>
                  </table>
                </body></html>
                """,
            )

        repository = FakeRepository()
        records = crawl_amazon_brand_inventory(
            brand_search_url,
            12,
            repository,
            brand_name="Hasbro Gaming",
            browser_fetcher=fetcher,
            delay_seconds=0,
        )

        search_urls = [url for url in fetched_urls if "/s?" in url]
        self.assertEqual(
            search_urls,
            [
                brand_search_url,
                "https://www.amazon.com.mx/s?srs=19815643011&rh=p_89%3AHasbro%2BGaming&page=2",
                "https://www.amazon.com.mx/s?srs=19815643011&rh=p_89%3AHasbro%2BGaming&page=3",
                "https://www.amazon.com.mx/s?srs=19815643011&rh=p_89%3AHasbro%2BGaming&page=4",
                "https://www.amazon.com.mx/s?srs=19815643011&rh=p_89%3AHasbro%2BGaming&page=5",
            ],
        )
        self.assertEqual(len(records), 5)
        self.assertEqual(len(repository.item_records), 5)
        self.assertNotIn("page=6", " ".join(fetched_urls))

    def test_skips_existing_asins_before_fetching_details(self):
        product_url = "https://www.amazon.com.mx/dp/B0DZL3YFC5"
        repository = FakeRepository(existing_urls={(12, product_url)})
        fetched_urls = []

        def fetcher(url):
            fetched_urls.append(url)
            return FetchResult(
                url=url,
                text='<a href="/Compa%C3%B1%C3%ADa-Juegos-Catfe/dp/B0DZL3YFC5?ref_=ast_sto_dp">Catfé</a>',
            )

        records = crawl_amazon_store_inventory(
            "https://www.amazon.com.mx/stores/page/00565807-102E-497A-894A-3434B4619BD2",
            12,
            repository,
            browser_fetcher=fetcher,
            delay_seconds=0,
        )

        self.assertEqual(records, [])
        self.assertEqual(repository.exists_checks, [(12, product_url)])
        self.assertEqual(len(fetched_urls), 1)


def _page_number(url):
    if "page=" not in url:
        return 1
    return int(url.rsplit("page=", 1)[1].split("&", 1)[0])


if __name__ == "__main__":
    unittest.main()
