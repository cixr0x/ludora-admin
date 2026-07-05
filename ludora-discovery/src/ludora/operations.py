from __future__ import annotations

import os
import inspect
import threading
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from ludora.admin_matching import AdminItemMatcher
from ludora.admin_title_extraction import AdminAmazonTitleExtractor
from ludora.ai_item_classification import OpenAIItemClassifier
from ludora.cancellation import CancellationToken, OperationCancelled, raise_if_cancelled
from ludora.collector import collect_stores
from ludora.config import (
    resolve_ai_classifier_enabled,
    resolve_admin_api_url,
    resolve_brave_api_key,
    resolve_browser_fetch_enabled,
    resolve_classifier_model,
    resolve_database_url,
    resolve_embedding_model,
    resolve_openai_base_url,
    resolve_openai_api_key,
)
from ludora.database import DiscoveryRepository, connect_database
from ludora.embeddings import OpenAIEmbeddingClient, build_item_embedding_text, source_text_hash
from ludora.inventory import collect_store_inventory, update_confirmed_store_items
from ludora.item_classification import apply_item_classification
from ludora.models import DiscoveryItemCandidateRecord


RunStatus = Literal["running", "cancelling", "cancelled", "completed", "failed"]
EmbeddingRefreshMode = Literal["missing", "full"]
ItemClassifierCallable = Callable[[DiscoveryItemCandidateRecord], DiscoveryItemCandidateRecord]


class OperationAlreadyRunning(RuntimeError):
    pass


class OperationNotRunning(RuntimeError):
    pass


@dataclass(frozen=True)
class StoreDiscoveryRunResult:
    searched_queries: int
    candidate_domains: int
    accepted_stores: int

    def to_dict(self) -> dict[str, int]:
        return {
            "searched_queries": self.searched_queries,
            "candidate_domains": self.candidate_domains,
            "accepted_stores": self.accepted_stores,
        }


@dataclass(frozen=True)
class ItemDiscoveryRunResult:
    store_id: int
    website_url: str
    item_candidates: int
    new_items: int = 0

    def to_dict(self) -> dict[str, object]:
        return {
            "store_id": self.store_id,
            "website_url": self.website_url,
            "item_candidates": self.item_candidates,
            "new_items": self.new_items,
        }


@dataclass(frozen=True)
class ItemUpdateRunResult:
    updated_items: int

    def to_dict(self) -> dict[str, int]:
        return {
            "updated_items": self.updated_items,
        }


@dataclass(frozen=True)
class ItemEmbeddingRunResult:
    refresh_mode: str
    selected_items: int
    embedded_items: int
    model: str

    def to_dict(self) -> dict[str, object]:
        return {
            "refresh_mode": self.refresh_mode,
            "selected_items": self.selected_items,
            "embedded_items": self.embedded_items,
            "model": self.model,
        }


@dataclass
class StoreDiscoveryRun:
    id: str
    status: RunStatus
    started_at: datetime
    run_type: str = "store_discovery"
    completed_at: datetime | None = None
    result: StoreDiscoveryRunResult | ItemDiscoveryRunResult | ItemUpdateRunResult | ItemEmbeddingRunResult | None = None
    error: str | None = None
    cancellation_token: CancellationToken | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "type": self.run_type,
            "status": self.status,
            "started_at": _format_datetime(self.started_at),
            "completed_at": _format_datetime(self.completed_at) if self.completed_at else None,
            "result": self.result.to_dict() if self.result else None,
            "error": self.error,
        }


def run_store_discovery(
    *,
    env: Mapping[str, str] | None = None,
    env_file: str = ".env",
    cancellation_token: CancellationToken | None = None,
) -> StoreDiscoveryRunResult:
    current_env = env if env is not None else os.environ
    api_key = resolve_brave_api_key(None, env=current_env, dotenv_path=env_file)
    if not api_key:
        raise RuntimeError("Missing Brave API key")

    database_url = resolve_database_url(None, env=current_env, dotenv_path=env_file)
    if not database_url:
        raise RuntimeError("Missing database URL")

    connection = connect_database(database_url)
    try:
        repository = DiscoveryRepository(connection)
        collect_kwargs = {}
        if cancellation_token is not None:
            collect_kwargs["cancellation_token"] = cancellation_token
        summary = collect_stores(
            api_key=api_key,
            query_scope="expanded",
            max_queries=None,
            count=20,
            pages=1,
            request_delay=1.1,
            website_delay=0.3,
            max_enrichment_pages=3,
            include_low_confidence=False,
            verbose=False,
            discovery_repository=repository,
            export_files=False,
            **collect_kwargs,
        )
        return StoreDiscoveryRunResult(
            searched_queries=summary.searched_queries,
            candidate_domains=summary.candidate_domains,
            accepted_stores=len(summary.records),
        )
    finally:
        connection.close()


def run_item_discovery(
    *,
    store_id: int,
    website_url: str,
    platform: str = "",
    store_name: str = "",
    env: Mapping[str, str] | None = None,
    env_file: str = ".env",
    cancellation_token: CancellationToken | None = None,
    run_id: str | None = None,
    started_at: datetime | None = None,
) -> ItemDiscoveryRunResult:
    current_env = env if env is not None else os.environ
    database_url = resolve_database_url(None, env=current_env, dotenv_path=env_file)
    if not database_url:
        raise RuntimeError("Missing database URL")

    connection = connect_database(database_url)
    resolved_run_id = run_id or str(uuid.uuid4())
    resolved_started_at = started_at or _utc_now()
    tracking_repository: _StoreItemDiscoveryTrackingRepository | None = None
    try:
        repository = DiscoveryRepository(connection)
        repository.start_store_item_discovery_log(
            run_id=resolved_run_id,
            store_id=store_id,
            website_url=website_url,
            started_at=resolved_started_at,
        )
        try:
            browser_sitemap_fetch_enabled = resolve_browser_fetch_enabled(env=current_env, dotenv_path=env_file)
            admin_api_url = resolve_admin_api_url(env=current_env, dotenv_path=env_file)
            item_classifier = _resolve_item_classifier(current_env, env_file)
            tracking_repository = _StoreItemDiscoveryTrackingRepository(repository)
            item_processor = AdminItemMatcher(admin_api_url, repository)
            normalized_platform = platform.strip().casefold()
            item_title_extractor = (
                AdminAmazonTitleExtractor(admin_api_url).extract_title
                if normalized_platform in {"amazon", "amazon_brand"}
                else None
            )
            collect_kwargs = {}
            if cancellation_token is not None:
                collect_kwargs["cancellation_token"] = cancellation_token
            raise_if_cancelled(cancellation_token)
            records = collect_store_inventory(
                website_url,
                store_id,
                tracking_repository,
                platform=platform,
                store_name=store_name,
                browser_sitemap_fetch_enabled=browser_sitemap_fetch_enabled,
                item_classifier=item_classifier,
                item_processor=item_processor,
                item_title_extractor=item_title_extractor,
                **collect_kwargs,
            )
            raise_if_cancelled(cancellation_token)
        except OperationCancelled as exc:
            repository.complete_store_item_discovery_log(
                run_id=resolved_run_id,
                status="cancelled",
                completed_at=_utc_now(),
                new_items=_new_items_count(tracking_repository),
                error=str(exc),
            )
            raise
        except Exception as exc:
            repository.complete_store_item_discovery_log(
                run_id=resolved_run_id,
                status="failed",
                completed_at=_utc_now(),
                new_items=_new_items_count(tracking_repository),
                error=str(exc),
            )
            raise

        new_items = tracking_repository.new_items if tracking_repository is not None else 0
        repository.complete_store_item_discovery_log(
            run_id=resolved_run_id,
            status="completed",
            completed_at=_utc_now(),
            new_items=new_items,
            error="",
        )
        return ItemDiscoveryRunResult(
            store_id=store_id,
            website_url=website_url,
            item_candidates=len(records),
            new_items=new_items,
        )
    finally:
        connection.close()


class _StoreItemDiscoveryTrackingRepository:
    def __init__(self, repository: DiscoveryRepository) -> None:
        self.repository = repository
        self.new_items = 0

    def upsert_item_candidate(self, record: DiscoveryItemCandidateRecord) -> object | None:
        result = self.repository.upsert_item_candidate(record)
        if getattr(result, "created", False):
            self.new_items += 1
        return result

    def __getattr__(self, name: str) -> object:
        return getattr(self.repository, name)


def _new_items_count(repository: _StoreItemDiscoveryTrackingRepository | None) -> int:
    return repository.new_items if repository is not None else 0


def _resolve_item_classifier(current_env: Mapping[str, str], env_file: str) -> ItemClassifierCallable:
    if not resolve_ai_classifier_enabled(env=current_env, dotenv_path=env_file):
        return apply_item_classification

    openai_api_key = resolve_openai_api_key(env=current_env, dotenv_path=env_file)
    if not openai_api_key:
        raise RuntimeError("Missing OpenAI API key for AI item classifier")

    return OpenAIItemClassifier(
        api_key=openai_api_key,
        model=resolve_classifier_model(env=current_env, dotenv_path=env_file),
        base_url=resolve_openai_base_url(env=current_env, dotenv_path=env_file),
    ).apply_item_classification


def run_item_update(
    *,
    env: Mapping[str, str] | None = None,
    env_file: str = ".env",
    cancellation_token: CancellationToken | None = None,
    run_id: str | None = None,
) -> ItemUpdateRunResult:
    current_env = env if env is not None else os.environ
    database_url = resolve_database_url(None, env=current_env, dotenv_path=env_file)
    if not database_url:
        raise RuntimeError("Missing database URL")
    browser_fetch_enabled = resolve_browser_fetch_enabled(env=current_env, dotenv_path=env_file)

    connection = connect_database(database_url)
    resolved_run_id = run_id or str(uuid.uuid4())
    try:
        repository = DiscoveryRepository(connection)
        job_id = repository.start_store_item_update_log(run_id=resolved_run_id)
        update_kwargs = {}
        if cancellation_token is not None:
            update_kwargs["cancellation_token"] = cancellation_token
        try:
            records = update_confirmed_store_items(
                repository,
                browser_fetch_enabled=browser_fetch_enabled,
                job_id=job_id,
                run_id=resolved_run_id,
                **update_kwargs,
            )
        except OperationCancelled:
            repository.complete_store_item_update_log(
                job_id=job_id,
                status="cancelled",
                completed_at=_utc_now(),
                scanned_items=0,
                updated_items=0,
                error="",
            )
            raise
        except Exception as exc:
            repository.complete_store_item_update_log(
                job_id=job_id,
                status="failed",
                completed_at=_utc_now(),
                scanned_items=0,
                updated_items=0,
                error=str(exc),
            )
            raise
        repository.complete_store_item_update_log(
            job_id=job_id,
            status="completed",
            completed_at=_utc_now(),
            scanned_items=len(records),
            updated_items=len(records),
            error="",
        )
        return ItemUpdateRunResult(updated_items=len(records))
    finally:
        connection.close()


def run_item_embeddings(
    *,
    refresh_mode: EmbeddingRefreshMode = "missing",
    env: Mapping[str, str] | None = None,
    env_file: str = ".env",
    cancellation_token: CancellationToken | None = None,
) -> ItemEmbeddingRunResult:
    current_env = env if env is not None else os.environ
    database_url = resolve_database_url(None, env=current_env, dotenv_path=env_file)
    if not database_url:
        raise RuntimeError("Missing database URL")
    openai_api_key = resolve_openai_api_key(env=current_env, dotenv_path=env_file)
    if not openai_api_key:
        raise RuntimeError("Missing OpenAI API key")
    embedding_model = resolve_embedding_model(env=current_env, dotenv_path=env_file)

    connection = connect_database(database_url)
    try:
        repository = DiscoveryRepository(connection)
        client = OpenAIEmbeddingClient(api_key=openai_api_key, model=embedding_model)
        sources = repository.list_item_search_embedding_sources(refresh_mode=refresh_mode)
        embedded_items = 0
        for source in sources:
            raise_if_cancelled(cancellation_token)
            source_text = build_item_embedding_text(source)
            embedding = client.create_embedding(source_text)
            repository.upsert_item_search_embedding(
                item_id=source.item_id,
                embedding=embedding,
                source_text=source_text,
                source_hash=source_text_hash(source_text),
                model=embedding_model,
            )
            embedded_items += 1

        return ItemEmbeddingRunResult(
            refresh_mode=refresh_mode,
            selected_items=len(sources),
            embedded_items=embedded_items,
            model=embedding_model,
        )
    finally:
        connection.close()


class StoreDiscoveryRunManager:
    def __init__(
        self,
        runner: Callable[[], StoreDiscoveryRunResult] | None = None,
        item_runner: Callable[..., ItemDiscoveryRunResult] | None = None,
        item_update_runner: Callable[[], ItemUpdateRunResult] | None = None,
        item_embedding_runner: Callable[[EmbeddingRefreshMode], ItemEmbeddingRunResult] | None = None,
        *,
        background: bool = True,
        env_file: str = ".env",
    ) -> None:
        self.runner = (
            _store_runner_with_token(runner)
            if runner is not None
            else (lambda cancellation_token: run_store_discovery(env_file=env_file, cancellation_token=cancellation_token))
        )
        self.item_runner = (
            _item_runner_with_token(item_runner)
            if item_runner is not None
            else (
                lambda store_id, website_url, platform, store_name, cancellation_token, run_id, started_at: run_item_discovery(
                    store_id=store_id,
                    website_url=website_url,
                    platform=platform,
                    store_name=store_name,
                    env_file=env_file,
                    cancellation_token=cancellation_token,
                    run_id=run_id,
                    started_at=started_at,
                )
            )
        )
        self.item_update_runner = (
            _update_runner_with_token(item_update_runner)
            if item_update_runner is not None
            else (lambda cancellation_token, run_id: run_item_update(env_file=env_file, cancellation_token=cancellation_token, run_id=run_id))
        )
        self.item_embedding_runner = (
            _embedding_runner_with_token(item_embedding_runner)
            if item_embedding_runner is not None
            else (
                lambda refresh_mode, cancellation_token: run_item_embeddings(
                    refresh_mode=refresh_mode,
                    env_file=env_file,
                    cancellation_token=cancellation_token,
                )
            )
        )
        self.background = background
        self.lock = threading.Lock()
        self.runs: dict[str, StoreDiscoveryRun] = {}
        self.latest_run_id: str | None = None
        self.active_run_id: str | None = None

    def start_store_discovery(self) -> StoreDiscoveryRun:
        with self.lock:
            if self.active_run_id:
                raise OperationAlreadyRunning("Store discovery is already running")

            cancellation_token = CancellationToken()
            run = StoreDiscoveryRun(
                id=str(uuid.uuid4()),
                status="running",
                started_at=_utc_now(),
                cancellation_token=cancellation_token,
            )
            self.runs[run.id] = run
            self.latest_run_id = run.id
            self.active_run_id = run.id

        if self.background:
            thread = threading.Thread(target=self._execute_run, args=(run.id,), daemon=True)
            thread.start()
        else:
            self._execute_run(run.id)

        return self.get_run(run.id) or run

    def start_item_discovery(
        self,
        store_id: int,
        website_url: str,
        platform: str = "",
        store_name: str = "",
    ) -> StoreDiscoveryRun:
        with self.lock:
            if self.active_run_id:
                raise OperationAlreadyRunning("Discovery operation is already running")

            cancellation_token = CancellationToken()
            run = StoreDiscoveryRun(
                id=str(uuid.uuid4()),
                status="running",
                started_at=_utc_now(),
                run_type="item_discovery",
                cancellation_token=cancellation_token,
            )
            self.runs[run.id] = run
            self.latest_run_id = run.id
            self.active_run_id = run.id

        if self.background:
            thread = threading.Thread(
                target=self._execute_item_run,
                args=(run.id, store_id, website_url, platform, store_name),
                daemon=True,
            )
            thread.start()
        else:
            self._execute_item_run(run.id, store_id, website_url, platform, store_name)

        return self.get_run(run.id) or run

    def start_item_update(self) -> StoreDiscoveryRun:
        with self.lock:
            if self.active_run_id:
                raise OperationAlreadyRunning("Discovery operation is already running")

            cancellation_token = CancellationToken()
            run = StoreDiscoveryRun(
                id=str(uuid.uuid4()),
                status="running",
                started_at=_utc_now(),
                run_type="item_update",
                cancellation_token=cancellation_token,
            )
            self.runs[run.id] = run
            self.latest_run_id = run.id
            self.active_run_id = run.id

        if self.background:
            thread = threading.Thread(target=self._execute_item_update_run, args=(run.id,), daemon=True)
            thread.start()
        else:
            self._execute_item_update_run(run.id)

        return self.get_run(run.id) or run

    def start_item_embeddings(self, refresh_mode: EmbeddingRefreshMode) -> StoreDiscoveryRun:
        with self.lock:
            if self.active_run_id:
                raise OperationAlreadyRunning("Discovery operation is already running")

            cancellation_token = CancellationToken()
            run = StoreDiscoveryRun(
                id=str(uuid.uuid4()),
                status="running",
                started_at=_utc_now(),
                run_type="item_embeddings",
                cancellation_token=cancellation_token,
            )
            self.runs[run.id] = run
            self.latest_run_id = run.id
            self.active_run_id = run.id

        if self.background:
            thread = threading.Thread(target=self._execute_item_embedding_run, args=(run.id, refresh_mode), daemon=True)
            thread.start()
        else:
            self._execute_item_embedding_run(run.id, refresh_mode)

        return self.get_run(run.id) or run

    def get_run(self, run_id: str) -> StoreDiscoveryRun | None:
        with self.lock:
            return self.runs.get(run_id)

    def get_latest_run(self) -> StoreDiscoveryRun | None:
        with self.lock:
            if not self.latest_run_id:
                return None
            return self.runs.get(self.latest_run_id)

    def cancel_run(self, run_id: str) -> StoreDiscoveryRun | None:
        with self.lock:
            run = self.runs.get(run_id)
            if run is None:
                return None
            if self.active_run_id != run_id or run.status not in {"running", "cancelling"}:
                raise OperationNotRunning("Run is not running")
            if run.cancellation_token is not None:
                run.cancellation_token.cancel()
            run.status = "cancelling"
            return run

    def _execute_run(self, run_id: str) -> None:
        try:
            result = self.runner(self._cancellation_token_for(run_id))
        except OperationCancelled:
            self._mark_run_cancelled(run_id)
            return
        except Exception as exc:  # pragma: no cover - message behavior is tested through manager.
            with self.lock:
                run = self.runs[run_id]
                run.status = "failed"
                run.error = str(exc)
                run.completed_at = _utc_now()
                self.active_run_id = None
            return

        with self.lock:
            run = self.runs[run_id]
            if run.status == "cancelling":
                run.status = "cancelled"
                run.result = None
                run.completed_at = _utc_now()
                self.active_run_id = None
                return
            run.status = "completed"
            run.result = result
            run.completed_at = _utc_now()
            self.active_run_id = None

    def _execute_item_run(self, run_id: str, store_id: int, website_url: str, platform: str, store_name: str) -> None:
        try:
            run = self.runs[run_id]
            result = self.item_runner(
                store_id,
                website_url,
                platform,
                store_name,
                self._cancellation_token_for(run_id),
                run_id,
                run.started_at,
            )
        except OperationCancelled:
            self._mark_run_cancelled(run_id)
            return
        except Exception as exc:  # pragma: no cover - message behavior is tested through manager.
            with self.lock:
                run = self.runs[run_id]
                run.status = "failed"
                run.error = str(exc)
                run.completed_at = _utc_now()
                self.active_run_id = None
            return

        with self.lock:
            run = self.runs[run_id]
            if run.status == "cancelling":
                run.status = "cancelled"
                run.result = None
                run.completed_at = _utc_now()
                self.active_run_id = None
                return
            run.status = "completed"
            run.result = result
            run.completed_at = _utc_now()
            self.active_run_id = None

    def _execute_item_update_run(self, run_id: str) -> None:
        try:
            result = self.item_update_runner(self._cancellation_token_for(run_id), run_id)
        except OperationCancelled:
            self._mark_run_cancelled(run_id)
            return
        except Exception as exc:  # pragma: no cover - message behavior is tested through manager.
            with self.lock:
                run = self.runs[run_id]
                run.status = "failed"
                run.error = str(exc)
                run.completed_at = _utc_now()
                self.active_run_id = None
            return

        with self.lock:
            run = self.runs[run_id]
            if run.status == "cancelling":
                run.status = "cancelled"
                run.result = None
                run.completed_at = _utc_now()
                self.active_run_id = None
                return
            run.status = "completed"
            run.result = result
            run.completed_at = _utc_now()
            self.active_run_id = None

    def _execute_item_embedding_run(self, run_id: str, refresh_mode: EmbeddingRefreshMode) -> None:
        try:
            result = self.item_embedding_runner(refresh_mode, self._cancellation_token_for(run_id))
        except OperationCancelled:
            self._mark_run_cancelled(run_id)
            return
        except Exception as exc:  # pragma: no cover - message behavior is tested through manager.
            with self.lock:
                run = self.runs[run_id]
                run.status = "failed"
                run.error = str(exc)
                run.completed_at = _utc_now()
                self.active_run_id = None
            return

        with self.lock:
            run = self.runs[run_id]
            if run.status == "cancelling":
                run.status = "cancelled"
                run.result = None
                run.completed_at = _utc_now()
                self.active_run_id = None
                return
            run.status = "completed"
            run.result = result
            run.completed_at = _utc_now()
            self.active_run_id = None

    def _cancellation_token_for(self, run_id: str) -> CancellationToken:
        with self.lock:
            token = self.runs[run_id].cancellation_token
        if token is None:
            raise RuntimeError("Run is missing cancellation token")
        return token

    def _mark_run_cancelled(self, run_id: str) -> None:
        with self.lock:
            run = self.runs[run_id]
            run.status = "cancelled"
            run.result = None
            run.completed_at = _utc_now()
            self.active_run_id = None


def _store_runner_with_token(runner: Callable[..., StoreDiscoveryRunResult]) -> Callable[[CancellationToken], StoreDiscoveryRunResult]:
    if _accepts_cancellation_token(runner, positional_before_token=0):
        return lambda cancellation_token: runner(cancellation_token)
    return lambda cancellation_token: runner()


def _item_runner_with_token(
    runner: Callable[..., ItemDiscoveryRunResult],
) -> Callable[[int, str, str, str, CancellationToken, str, datetime], ItemDiscoveryRunResult]:
    def run(
        store_id: int,
        website_url: str,
        platform: str,
        store_name: str,
        cancellation_token: CancellationToken,
        run_id: str,
        started_at: datetime,
    ) -> ItemDiscoveryRunResult:
        args, kwargs = _item_runner_arguments(
            runner,
            store_id,
            website_url,
            platform,
            store_name,
            cancellation_token,
            run_id,
            started_at,
        )
        return runner(*args, **kwargs)

    return run


def _item_runner_arguments(
    runner: Callable[..., object],
    store_id: int,
    website_url: str,
    platform: str,
    store_name: str,
    cancellation_token: CancellationToken,
    run_id: str,
    started_at: datetime,
) -> tuple[list[object], dict[str, object]]:
    try:
        signature = inspect.signature(runner)
    except (TypeError, ValueError):
        return [store_id, website_url, platform, store_name, cancellation_token, run_id, started_at], {}

    parameters = list(signature.parameters.values())
    if any(parameter.kind == inspect.Parameter.VAR_POSITIONAL for parameter in parameters):
        return [store_id, website_url, platform, store_name, cancellation_token, run_id, started_at], {}

    args: list[object] = []
    kwargs: dict[str, object] = {}
    positional_index = 0
    unknown_after_url = 0
    positional_values = [store_id, website_url]
    fallback_values = [platform, store_name, cancellation_token, run_id, started_at]

    for parameter in parameters:
        if parameter.kind in {inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD}:
            if positional_index < len(positional_values):
                args.append(positional_values[positional_index])
                positional_index += 1
            elif parameter.name == "platform":
                args.append(platform)
            elif parameter.name == "store_name":
                args.append(store_name)
            elif parameter.name == "cancellation_token":
                args.append(cancellation_token)
            elif parameter.name == "run_id":
                args.append(run_id)
            elif parameter.name == "started_at":
                args.append(started_at)
            else:
                args.append(fallback_values[min(unknown_after_url, len(fallback_values) - 1)])
                unknown_after_url += 1
        elif parameter.kind == inspect.Parameter.KEYWORD_ONLY:
            if parameter.name == "platform":
                kwargs["platform"] = platform
            elif parameter.name == "store_name":
                kwargs["store_name"] = store_name
            elif parameter.name == "cancellation_token":
                kwargs["cancellation_token"] = cancellation_token
            elif parameter.name == "run_id":
                kwargs["run_id"] = run_id
            elif parameter.name == "started_at":
                kwargs["started_at"] = started_at
        elif parameter.kind == inspect.Parameter.VAR_KEYWORD:
            kwargs.setdefault("platform", platform)
            kwargs.setdefault("store_name", store_name)
            kwargs.setdefault("cancellation_token", cancellation_token)
            kwargs.setdefault("run_id", run_id)
            kwargs.setdefault("started_at", started_at)

    return args, kwargs


def _update_runner_with_token(runner: Callable[..., ItemUpdateRunResult]) -> Callable[[CancellationToken, str], ItemUpdateRunResult]:
    def run(cancellation_token: CancellationToken, run_id: str) -> ItemUpdateRunResult:
        args, kwargs = _update_runner_arguments(runner, cancellation_token, run_id)
        return runner(*args, **kwargs)

    return run


def _update_runner_arguments(
    runner: Callable[..., object],
    cancellation_token: CancellationToken,
    run_id: str,
) -> tuple[list[object], dict[str, object]]:
    try:
        signature = inspect.signature(runner)
    except (TypeError, ValueError):
        return [cancellation_token, run_id], {}

    parameters = list(signature.parameters.values())
    if any(parameter.kind == inspect.Parameter.VAR_POSITIONAL for parameter in parameters):
        return [cancellation_token, run_id], {}

    args: list[object] = []
    kwargs: dict[str, object] = {}
    fallback_values = [cancellation_token, run_id]
    unknown_positional = 0

    for parameter in parameters:
        if parameter.kind in {inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD}:
            if parameter.name == "cancellation_token":
                args.append(cancellation_token)
            elif parameter.name == "run_id":
                args.append(run_id)
            else:
                args.append(fallback_values[min(unknown_positional, len(fallback_values) - 1)])
                unknown_positional += 1
        elif parameter.kind == inspect.Parameter.KEYWORD_ONLY:
            if parameter.name == "cancellation_token":
                kwargs["cancellation_token"] = cancellation_token
            elif parameter.name == "run_id":
                kwargs["run_id"] = run_id
        elif parameter.kind == inspect.Parameter.VAR_KEYWORD:
            kwargs.setdefault("cancellation_token", cancellation_token)
            kwargs.setdefault("run_id", run_id)

    return args, kwargs


def _embedding_runner_with_token(
    runner: Callable[..., ItemEmbeddingRunResult],
) -> Callable[[EmbeddingRefreshMode, CancellationToken], ItemEmbeddingRunResult]:
    if _accepts_cancellation_token(runner, positional_before_token=1):
        return lambda refresh_mode, cancellation_token: runner(refresh_mode, cancellation_token)
    return lambda refresh_mode, cancellation_token: runner(refresh_mode)


def _accepts_cancellation_token(runner: Callable[..., object], positional_before_token: int) -> bool:
    try:
        signature = inspect.signature(runner)
    except (TypeError, ValueError):
        return False

    parameters = list(signature.parameters.values())
    if any(parameter.kind == inspect.Parameter.VAR_POSITIONAL for parameter in parameters):
        return True
    if any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters):
        return True
    if "cancellation_token" in signature.parameters:
        return True

    positional = [
        parameter
        for parameter in parameters
        if parameter.kind in {inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD}
    ]
    return len(positional) > positional_before_token


def _accepts_named_parameter(runner: Callable[..., object], name: str) -> bool:
    try:
        signature = inspect.signature(runner)
    except (TypeError, ValueError):
        return False
    return name in signature.parameters


def _accepts_var_keyword(runner: Callable[..., object]) -> bool:
    try:
        signature = inspect.signature(runner)
    except (TypeError, ValueError):
        return False
    return any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values())


def _accepts_platform_positional(runner: Callable[..., object]) -> bool:
    try:
        signature = inspect.signature(runner)
    except (TypeError, ValueError):
        return False
    parameters = list(signature.parameters.values())
    if any(parameter.kind == inspect.Parameter.VAR_POSITIONAL for parameter in parameters):
        return True
    positional = [
        parameter
        for parameter in parameters
        if parameter.kind in {inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD}
    ]
    return len(positional) >= 3 and positional[2].name not in {"cancellation_token", "token"}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _format_datetime(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")
