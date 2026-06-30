import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.amazon_discovery import build_amazon_store_search_url, crawl_amazon_store_inventory
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


if __name__ == "__main__":
    unittest.main()
