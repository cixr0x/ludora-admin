from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import unicodedata
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen

from ludora.browser_fetch import _browser_user_agent, _chrome_executable_path
from ludora.config import resolve_database_url
from ludora.database import DiscoveryRepository, connect_database


DEFAULT_API_BASE_URL = "https://ludora.bobbycrimson.com/api"
DEFAULT_OUTPUT_DIR = "artifacts/tiktok-discovery"
DEFAULT_PROFILE_DIR = ".playwright/tiktok-profile"

SAMPLE_CLASSICS = [
    ("871", "Catan", ""),
    ("1350", "Azul", ""),
    ("1496", "Carcassonne", ""),
    ("712", "Wingspan", ""),
    ("1471", "Brass: Birmingham", ""),
    ("1462", "Ticket to Ride", "Aventureros al Tren"),
    ("851", "Dixit", ""),
    ("1300", "Pandemic", ""),
    ("743", "Exploding Kittens", ""),
    ("1069", "Splendor", ""),
]


@dataclass(frozen=True)
class TikTokItem:
    id: str
    name: str
    name_es: str = ""
    item_type: str = ""


@dataclass(frozen=True)
class TikTokCandidate:
    url: str
    user: str
    video_id: str
    caption: str = ""
    likes_text: str = ""
    date_text: str = ""
    raw_text: str = ""
    score: float = 0.0
    oembed_ok: bool | None = None
    oembed_status: int | None = None
    oembed_title: str = ""
    oembed_author_name: str = ""
    oembed_provider_name: str = ""
    oembed_error: str = ""


@dataclass(frozen=True)
class TikTokDiscoveryResult:
    item: TikTokItem
    query: str
    search_url: str
    page_title: str
    link_count: int
    blockers: list[str]
    candidates: list[TikTokCandidate]


@dataclass(frozen=True)
class TikTokCandidateWriteResult:
    item_id: int
    tutorial_link_id: int
    url: str
    action: str


def build_search_query(item: TikTokItem) -> str:
    names: list[str] = []
    if item.name_es.strip():
        names.append(item.name_es.strip())
    if item.name.strip() and _normalize_text(item.name) not in {_normalize_text(name) for name in names}:
        names.append(item.name.strip())
    if not names:
        names.append(item.id)
    return f"{' '.join(names)} juego de mesa como jugar tutorial"


def tiktok_video_identity_from_url(url: str) -> tuple[str, str] | None:
    try:
        parsed = urlparse(url)
    except ValueError:
        return None

    if not parsed.netloc.casefold().endswith("tiktok.com"):
        return None

    path_parts = [part for part in parsed.path.split("/") if part]
    for index, part in enumerate(path_parts):
        if not part.startswith("@"):
            continue
        if index + 2 >= len(path_parts) or path_parts[index + 1] != "video":
            continue
        video_id = path_parts[index + 2]
        if re.fullmatch(r"\d+", video_id):
            return (part.removeprefix("@"), video_id)
    return None


def parse_search_result_candidate(url: str, raw_text: str) -> TikTokCandidate | None:
    identity = tiktok_video_identity_from_url(url)
    if identity is None:
        return None

    user, video_id = identity
    lines = _candidate_lines(raw_text)
    user_index = next((index for index, line in enumerate(lines) if line.casefold() == user.casefold()), -1)

    caption = ""
    likes_text = ""
    date_text = ""
    if user_index >= 0:
        for line in reversed(lines[:user_index]):
            if not _is_noise_line(line) and not _looks_like_like_count(line):
                caption = line
                break
        for line in reversed(lines[:user_index]):
            if _looks_like_like_count(line):
                likes_text = line
                break
        if user_index + 1 < len(lines):
            date_text = lines[user_index + 1]
    else:
        caption = next((line for line in lines if not _is_noise_line(line) and not _looks_like_like_count(line)), "")
        likes_text = next((line for line in lines if _looks_like_like_count(line)), "")

    return TikTokCandidate(
        url=url,
        user=user,
        video_id=video_id,
        caption=caption,
        likes_text=likes_text,
        date_text=date_text,
        raw_text=raw_text.strip(),
    )


def rank_candidates(item: TikTokItem, candidates: list[TikTokCandidate]) -> list[TikTokCandidate]:
    deduped: dict[str, TikTokCandidate] = {}
    for candidate in candidates:
        if candidate.video_id and candidate.video_id not in deduped:
            deduped[candidate.video_id] = candidate

    scored = [replace(candidate, score=score_candidate(item, candidate)) for candidate in deduped.values()]
    return sorted(scored, key=lambda candidate: (-candidate.score, -_parse_likes(candidate.likes_text), candidate.url))


def search_extraction_needs_retry(*, page_title: str, link_count: int, blockers: list[str]) -> bool:
    if blockers:
        return True

    normalized_title = page_title.casefold().strip()
    if link_count > 0:
        return False

    generic_titles = {
        "tiktok - make your day",
        "tiktok - alegra tu dia",
        "tiktok - alegra tu día",
    }
    if normalized_title in generic_titles:
        return True

    return "search" not in normalized_title and "busca" not in normalized_title


def score_candidate(item: TikTokItem, candidate: TikTokCandidate) -> float:
    text = _normalize_text(
        f"{candidate.caption} {candidate.oembed_title} {candidate.oembed_author_name} {candidate.user}"
    )
    score = 0.0

    for name in _item_names(item):
        normalized_name = _normalize_text(name)
        if normalized_name and normalized_name in text:
            score += 6.0
        for token in _significant_tokens(name):
            if token in text:
                score += 2.0

    tutorial_signals = [
        "como jugar",
        "como se juega",
        "tutorial",
        "aprende",
        "aprendiendo",
        "enseno",
        "ensenamos",
        "explicar",
        "explicado",
        "reglas",
        "guia",
    ]
    overview_signals = [
        "conoce",
        "conocer",
        "conoceremos",
        "vista rapida",
        "resena",
        "review",
        "que es",
        "juegazo",
    ]
    for signal in tutorial_signals:
        if signal in text:
            score += 5.0 if signal in {"aprende", "aprendiendo", "enseno", "ensenamos"} else 7.0
    for signal in overview_signals:
        if signal in text:
            score += 4.0

    if "juegosdemesa" in text or "juego de mesa" in text or "boardgame" in text:
        score += 2.0

    weak_signals = ["unboxing", "destroquel", "comprar", "top ", "mejores que"]
    for signal in weak_signals:
        if signal in text:
            score -= 2.5

    score += min(4.0, math.log10(_parse_likes(candidate.likes_text) + 1))
    return round(max(score, 0.0), 1)


class TikTokDiscoveryBrowser:
    def __init__(
        self,
        *,
        profile_dir: str | Path = DEFAULT_PROFILE_DIR,
        headless: bool = False,
        timeout_ms: int = 30_000,
        search_wait_ms: int = 5_500,
        challenge_retries: int = 2,
        challenge_wait_seconds: float = 60.0,
    ) -> None:
        self.profile_dir = Path(profile_dir)
        self.headless = headless
        self.timeout_ms = timeout_ms
        self.search_wait_ms = search_wait_ms
        self.challenge_retries = challenge_retries
        self.challenge_wait_seconds = challenge_wait_seconds
        self._playwright = None
        self._context = None
        self._page = None

    def __enter__(self) -> TikTokDiscoveryBrowser:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:  # pragma: no cover - depends on local environment.
            raise RuntimeError("Playwright is not installed. Install ludora-discovery dependencies first.") from exc

        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self._playwright = sync_playwright().start()
        chrome_path = _chrome_executable_path()
        self._context = self._playwright.chromium.launch_persistent_context(
            str(self.profile_dir),
            executable_path=chrome_path,
            headless=self.headless,
            locale="es-MX",
            user_agent=_browser_user_agent(chrome_path),
            viewport={"width": 1365, "height": 900},
            extra_http_headers={"Accept-Language": "es-MX,es;q=0.9,en;q=0.8"},
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        self._context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined});")
        self._page = self._context.pages[0] if self._context.pages else self._context.new_page()
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        if self._context is not None:
            self._context.close()
        if self._playwright is not None:
            self._playwright.stop()

    def discover_item(self, item: TikTokItem, *, max_candidates: int = 5) -> TikTokDiscoveryResult:
        if self._page is None:
            raise RuntimeError("TikTok discovery browser has not been started.")

        query = build_search_query(item)
        search_url = _tiktok_search_url(query)
        extracted: dict[str, object] = {"title": "", "bodyText": "", "linkCount": 0, "candidates": []}
        blockers: list[str] = []
        for attempt in range(self.challenge_retries + 1):
            self._page.goto(search_url, wait_until="domcontentloaded", timeout=self.timeout_ms)
            self._page.wait_for_timeout(self.search_wait_ms)
            extracted = _extract_search_page(self._page)
            blockers = _detect_blockers(str(extracted.get("bodyText", "")))
            link_count = int(extracted.get("linkCount", 0) or 0)
            page_title = str(extracted.get("title", ""))
            if not search_extraction_needs_retry(
                page_title=page_title,
                link_count=link_count,
                blockers=blockers,
            ):
                break
            if "challenge_or_warmup" not in blockers:
                blockers.append("challenge_or_warmup")
            if attempt >= self.challenge_retries:
                break
            print(
                (
                    f"TikTok search for item {item.id} loaded a challenge or warm-up page. "
                    f"Clear it in the visible browser if needed; retrying in {self.challenge_wait_seconds:g}s."
                ),
                file=sys.stderr,
            )
            self._page.wait_for_timeout(int(self.challenge_wait_seconds * 1000))

        candidates = [
            candidate
            for raw in extracted.get("candidates", [])
            if (candidate := parse_search_result_candidate(str(raw.get("href", "")), str(raw.get("text", "")))) is not None
        ]
        ranked = rank_candidates(item, candidates)[:max_candidates]
        return TikTokDiscoveryResult(
            item=item,
            query=query,
            search_url=search_url,
            page_title=str(extracted.get("title", "")),
            link_count=int(extracted.get("linkCount", 0) or 0),
            blockers=blockers,
            candidates=ranked,
        )


def validate_oembed(candidate: TikTokCandidate, *, timeout_seconds: int = 15) -> TikTokCandidate:
    request_url = "https://www.tiktok.com/oembed?" + urlencode({"url": candidate.url})
    request = Request(request_url, headers={"Accept": "application/json", "User-Agent": "LudoraDiscovery/0.1"})
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return replace(
                candidate,
                oembed_ok=True,
                oembed_status=response.status,
                oembed_title=str(payload.get("title", "")),
                oembed_author_name=str(payload.get("author_name", "")),
                oembed_provider_name=str(payload.get("provider_name", "")),
                oembed_error="",
            )
    except Exception as exc:
        status = getattr(getattr(exc, "response", None), "status", None)
        return replace(candidate, oembed_ok=False, oembed_status=status, oembed_error=str(exc))


def discover_tiktok_candidates(
    items: list[TikTokItem],
    *,
    profile_dir: str | Path = DEFAULT_PROFILE_DIR,
    headless: bool = False,
    timeout_ms: int = 30_000,
    search_wait_ms: int = 5_500,
    challenge_retries: int = 2,
    challenge_wait_seconds: float = 60.0,
    delay_seconds: float = 2.0,
    max_candidates: int = 5,
    validate: bool = True,
) -> list[TikTokDiscoveryResult]:
    results: list[TikTokDiscoveryResult] = []
    with TikTokDiscoveryBrowser(
        profile_dir=profile_dir,
        headless=headless,
        timeout_ms=timeout_ms,
        search_wait_ms=search_wait_ms,
        challenge_retries=challenge_retries,
        challenge_wait_seconds=challenge_wait_seconds,
    ) as browser:
        for index, item in enumerate(items):
            if index > 0 and delay_seconds > 0:
                time.sleep(delay_seconds)
            result = browser.discover_item(item, max_candidates=max_candidates)
            if validate:
                validated_candidates = [validate_oembed(candidate) for candidate in result.candidates]
                result = replace(result, candidates=rank_candidates(item, validated_candidates))
            results.append(result)
    return results


def write_artifact(results: list[TikTokDiscoveryResult], output_dir: str | Path = DEFAULT_OUTPUT_DIR) -> Path:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    artifact_path = output_path / f"tiktok-discovery-{timestamp}.json"
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "result_count": len(results),
        "results": [asdict(result) for result in results],
    }
    artifact_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return artifact_path


def write_top_tiktok_candidates_to_database(
    results: list[TikTokDiscoveryResult],
    repository: DiscoveryRepository,
    *,
    status: str = "candidate",
) -> list[TikTokCandidateWriteResult]:
    writes: list[TikTokCandidateWriteResult] = []
    for result in results:
        if not result.candidates:
            continue

        top_candidate = result.candidates[0]
        upsert_result = repository.upsert_tutorial_link(
            item_id=int(result.item.id),
            url=top_candidate.url,
            title=_tutorial_link_title(top_candidate),
            language="es",
            source="tiktok",
            status=status,
        )
        writes.append(
            TikTokCandidateWriteResult(
                item_id=int(result.item.id),
                tutorial_link_id=upsert_result.tutorial_link_id,
                url=top_candidate.url,
                action=upsert_result.action,
            )
        )
    return writes


def fetch_items_from_public_api(
    *,
    api_base_url: str = DEFAULT_API_BASE_URL,
    item_ids: list[str] | None = None,
    limit: int = 10,
    offset: int = 0,
    base_games_only: bool = True,
) -> list[TikTokItem]:
    if item_ids:
        return [_item_from_api_payload(_read_json(f"{api_base_url.rstrip('/')}/items/{quote(item_id)}")["data"]) for item_id in item_ids]

    query = urlencode({"limit": limit, "offset": offset})
    payload = _read_json(f"{api_base_url.rstrip('/')}/items?{query}")
    items = [_item_from_api_payload(item) for item in payload.get("data", [])]
    if base_games_only:
        items = [item for item in items if item.item_type != "expansion"]
    return items[:limit]


def sample_classics() -> list[TikTokItem]:
    return [TikTokItem(id=item_id, name=name, name_es=name_es) for item_id, name, name_es in SAMPLE_CLASSICS]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Discover TikTok video candidates for Ludora item products.")
    parser.add_argument("--item-id", action="append", default=[], help="Ludora item id. May be repeated.")
    parser.add_argument("--sample-classics", action="store_true", help="Use the 10-product sample set from the initial spike.")
    parser.add_argument("--limit", type=int, default=10, help="Number of catalog items to fetch when --item-id is not provided.")
    parser.add_argument("--offset", type=int, default=0, help="Catalog offset when --item-id is not provided.")
    parser.add_argument("--include-expansions", action="store_true", help="Do not filter catalog expansions from --limit runs.")
    parser.add_argument("--api-base-url", default=os.environ.get("LUDORA_PUBLIC_API_URL", DEFAULT_API_BASE_URL))
    parser.add_argument("--env-file", default=".env", help="Path to the .env file used to resolve database settings.")
    parser.add_argument("--database-url", default=None, help="Postgres URL. Falls back to LUDORA_DATABASE_URL.")
    parser.add_argument("--profile-dir", default=os.environ.get("LUDORA_TIKTOK_PROFILE_DIR", DEFAULT_PROFILE_DIR))
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--max-candidates", type=int, default=5)
    parser.add_argument("--delay-seconds", type=float, default=2.0)
    parser.add_argument("--timeout-ms", type=int, default=30_000)
    parser.add_argument("--search-wait-ms", type=int, default=5_500)
    parser.add_argument("--challenge-retries", type=int, default=2)
    parser.add_argument("--challenge-wait-seconds", type=float, default=60.0)
    parser.add_argument("--headless", action="store_true", help="Run Chromium headless. Headed mode is the default.")
    parser.add_argument("--skip-oembed", action="store_true", help="Skip TikTok oEmbed validation.")
    parser.add_argument("--write-db", action="store_true", help="Persist the top scored candidate per item to tutorial_links.")
    parser.add_argument("--candidate-status", default="candidate", help="tutorial_links.status value used with --write-db.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    database_writes: list[TikTokCandidateWriteResult] = []

    try:
        if args.sample_classics:
            items = sample_classics()
        else:
            items = fetch_items_from_public_api(
                api_base_url=args.api_base_url,
                item_ids=args.item_id,
                limit=args.limit,
                offset=args.offset,
                base_games_only=not args.include_expansions,
            )
        if not items:
            print("No items selected for TikTok discovery.", file=sys.stderr)
            return 2

        results = discover_tiktok_candidates(
            items,
            profile_dir=args.profile_dir,
            headless=args.headless,
            timeout_ms=args.timeout_ms,
            search_wait_ms=args.search_wait_ms,
            challenge_retries=args.challenge_retries,
            challenge_wait_seconds=args.challenge_wait_seconds,
            delay_seconds=args.delay_seconds,
            max_candidates=args.max_candidates,
            validate=not args.skip_oembed,
        )
        artifact_path = write_artifact(results, args.output_dir)
        if args.write_db:
            database_url = resolve_database_url(args.database_url, env=os.environ, dotenv_path=args.env_file)
            if not database_url:
                print(
                    "Missing database URL. Add LUDORA_DATABASE_URL to .env, set the environment variable, or pass --database-url.",
                    file=sys.stderr,
                )
                return 2
            connection = connect_database(database_url)
            try:
                database_writes = write_top_tiktok_candidates_to_database(
                    results,
                    DiscoveryRepository(connection),
                    status=args.candidate_status,
                )
            finally:
                connection.close()
    except Exception as exc:
        print(f"TikTok discovery failed: {exc}", file=sys.stderr)
        return 1

    print(f"Items searched: {len(results)}")
    print(f"Artifact: {artifact_path}")
    if args.write_db:
        inserted_count = sum(1 for write in database_writes if write.action == "inserted")
        updated_count = sum(1 for write in database_writes if write.action == "updated")
        print(f"Database writes: {len(database_writes)} ({inserted_count} inserted, {updated_count} updated)")
    for result in results:
        top = result.candidates[0] if result.candidates else None
        if top is None:
            print(f"- {result.item.id} {result.item.name}: no candidates ({', '.join(result.blockers) or 'no blocker'})")
        else:
            print(f"- {result.item.id} {result.item.name}: {top.url} score={top.score} oembed={top.oembed_status}")
    return 0


def _item_from_api_payload(payload: dict[str, object]) -> TikTokItem:
    return TikTokItem(
        id=str(payload.get("id", "")),
        name=str(payload.get("canonical_name", "")),
        name_es=str(payload.get("canonical_name_es", "")),
        item_type=str(payload.get("item_type", "")),
    )


def _read_json(url: str) -> dict[str, object]:
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "LudoraDiscovery/0.1"})
    with urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def _tiktok_search_url(query: str) -> str:
    return "https://www.tiktok.com/search/video?q=" + quote(query)


def _tutorial_link_title(candidate: TikTokCandidate) -> str:
    for value in (candidate.oembed_title, candidate.caption):
        title = value.strip()
        if title:
            return title
    if candidate.user:
        return f"Video de TikTok por @{candidate.user}"
    return "Video de TikTok"


def _extract_search_page(page) -> dict[str, object]:
    return page.evaluate(
        """
        () => {
          const cards = Array.from(document.querySelectorAll('[data-e2e="search_video-item"]'));
          const sources = cards.length > 0
            ? cards
            : Array.from(document.querySelectorAll('a[href*="/video/"]')).map(anchor => anchor.parentElement || anchor);
          const seen = new Set();
          const candidates = [];
          for (const source of sources) {
            const anchor = source.querySelector ? source.querySelector('a[href*="/video/"]') : source;
            if (!anchor || !anchor.href || seen.has(anchor.href)) continue;
            seen.add(anchor.href);
            candidates.push({
              href: anchor.href,
              text: source.innerText || anchor.innerText || anchor.getAttribute('aria-label') || ''
            });
            if (candidates.length >= 12) break;
          }
          const bodyText = document.body && document.body.innerText || '';
          return {
            title: document.title || '',
            bodyText: bodyText.slice(0, 1200),
            linkCount: document.querySelectorAll('a[href*="/video/"]').length,
            candidates
          };
        }
        """
    )


def _candidate_lines(raw_text: str) -> list[str]:
    return [line.strip() for line in raw_text.splitlines() if line.strip()]


def _is_noise_line(line: str) -> bool:
    return line.casefold() in {"top liked", "paid partnership", "sponsored"}


def _looks_like_like_count(line: str) -> bool:
    return re.fullmatch(r"\d+(?:\.\d+)?[KkMm]?", line.strip()) is not None


def _parse_likes(value: str) -> int:
    match = re.fullmatch(r"(\d+(?:\.\d+)?)([KkMm]?)", value.strip())
    if not match:
        return 0
    amount = float(match.group(1))
    suffix = match.group(2).casefold()
    if suffix == "m":
        amount *= 1_000_000
    elif suffix == "k":
        amount *= 1_000
    return int(amount)


def _item_names(item: TikTokItem) -> list[str]:
    names = [item.name_es.strip(), item.name.strip()]
    return [name for index, name in enumerate(names) if name and _normalize_text(name) not in {_normalize_text(prev) for prev in names[:index]}]


def _significant_tokens(text: str) -> list[str]:
    ignored = {
        "and",
        "como",
        "del",
        "juego",
        "mesa",
        "para",
        "the",
        "with",
    }
    return [token for token in re.findall(r"[a-z0-9]+", _normalize_text(text)) if len(token) >= 4 and token not in ignored]


def _normalize_text(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    without_accents = "".join(char for char in decomposed if not unicodedata.combining(char))
    return " ".join(re.findall(r"[a-z0-9]+", without_accents))


def _detect_blockers(body_text: str) -> list[str]:
    normalized = body_text.casefold()
    blockers: list[str] = []
    if "captcha" in normalized:
        blockers.append("captcha")
    if "log in to continue" in normalized or "inicia sesion para continuar" in normalized:
        blockers.append("login_required")
    if "verify" in normalized or "security" in normalized:
        blockers.append("security_or_verification")
    if "no results found" in normalized or "no se encontraron resultados" in normalized:
        blockers.append("no_results")
    return blockers


if __name__ == "__main__":
    raise SystemExit(main())
