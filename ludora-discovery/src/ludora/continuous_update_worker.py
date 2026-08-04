from __future__ import annotations

import argparse
import json
import os
import random
import signal
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Mapping

from ludora.admin_title_extraction import AdminAmazonTitleExtractor
from ludora.admin_web_bot_auth import AdminWebBotAuthHeadersProvider
from ludora.browser_fetch import BrowserTextFetcher
from ludora.config import (
    resolve_admin_api_url,
    resolve_browser_fetch_enabled,
    resolve_database_url,
    resolve_internal_api_token,
    resolve_web_bot_auth_enabled,
)
from ludora.database import ClaimedStoreItemUpdate, DiscoveryRepository, connect_database
from ludora.product_crawler import (
    ProductPageRemovedError,
    TransientProductFetchError,
    refresh_confirmed_store_item_candidate,
)
from ludora.trace import TraceLogger, create_item_update_trace_logger
from ludora.webfetch import PerHostRequestThrottle


WORKER_NAME = "continuous"
SUCCESS_MIN_HOURS = 21.0
SUCCESS_MAX_HOURS = 23.0
ITEM_FAILURE_BACKOFF_MINUTES = (15, 60, 360, 1_440)
SHOPIFY_429_BACKOFF_MINUTES = (15, 60, 360, 1_440)


class _ContextTraceLogger:
    def __init__(self, delegate: TraceLogger, **context: object) -> None:
        self.delegate = delegate
        self.context = context

    def log(self, event: str, **fields: object) -> None:
        self.delegate.log(event, **{**self.context, **fields})


def run_continuous_update_worker(
    *,
    env: Mapping[str, str] | None = None,
    env_file: str = ".env",
    poll_seconds: float = 5.0,
    lease_seconds: int = 300,
    stop_event: threading.Event | None = None,
) -> None:
    current_env = env if env is not None else os.environ
    database_url = resolve_database_url(None, env=current_env, dotenv_path=env_file)
    if not database_url:
        raise RuntimeError("Missing database URL")
    if poll_seconds <= 0:
        raise ValueError("poll_seconds must be positive")
    if lease_seconds <= 0:
        raise ValueError("lease_seconds must be positive")

    resolved_stop_event = stop_event or threading.Event()
    retry_seconds = 5.0
    while not resolved_stop_event.is_set():
        try:
            _run_worker_session(
                database_url=database_url,
                current_env=current_env,
                env_file=env_file,
                lease_seconds=lease_seconds,
                poll_seconds=poll_seconds,
                stop_event=resolved_stop_event,
            )
            return
        except Exception as exc:
            _log("worker.session.failed", error=str(exc), retry_seconds=retry_seconds)
            if resolved_stop_event.wait(retry_seconds):
                return
            retry_seconds = min(60.0, retry_seconds * 2)


def _run_worker_session(
    *,
    database_url: str,
    current_env: Mapping[str, str],
    env_file: str,
    lease_seconds: int,
    poll_seconds: float,
    stop_event: threading.Event,
) -> None:
    worker_id = str(uuid.uuid4())
    run_id = f"continuous:{worker_id}"
    browser_fetch_enabled = resolve_browser_fetch_enabled(env=current_env, dotenv_path=env_file)
    admin_api_url = resolve_admin_api_url(env=current_env, dotenv_path=env_file)
    internal_api_token = resolve_internal_api_token(env=current_env, dotenv_path=env_file)
    web_bot_auth_enabled = resolve_web_bot_auth_enabled(env=current_env, dotenv_path=env_file)
    request_headers_provider = (
        AdminWebBotAuthHeadersProvider(admin_api_url, internal_api_token=internal_api_token).headers_for
        if web_bot_auth_enabled
        else None
    )
    item_title_extractor = AdminAmazonTitleExtractor(
        admin_api_url,
        internal_api_token=internal_api_token,
    ).extract_title
    throttle = PerHostRequestThrottle(
        minimum_interval_seconds=2.0,
        jitter_seconds=1.0,
        fallback_cooldown_seconds=30.0,
    )

    connection = connect_database(database_url)
    repository = DiscoveryRepository(connection)
    job_id: int | None = None
    browser_session: BrowserTextFetcher | None = None
    try:
        if not repository.try_acquire_store_item_update_coordinator_lock():
            raise RuntimeError("Another store item update process owns the coordinator lock")
        repository.recover_interrupted_continuous_updates()
        repository.mark_continuous_update_worker_started(
            worker_name=WORKER_NAME,
            worker_id=worker_id,
            poll_seconds=poll_seconds,
        )
        job_id = repository.start_store_item_update_log(run_id=run_id)
        trace_logger = create_item_update_trace_logger(connection, run_id=run_id, job_id=job_id)
        browser_fetcher = None
        if browser_fetch_enabled:
            browser_session = BrowserTextFetcher(trace_logger=trace_logger)
            browser_fetcher = browser_session.__enter__().fetch
        _log(
            "worker.session.started",
            browser_fetch_enabled=browser_fetch_enabled,
            job_id=job_id,
            poll_seconds=poll_seconds,
            web_bot_auth_enabled=web_bot_auth_enabled,
            worker_id=worker_id,
        )

        next_slot = time.monotonic()
        while not stop_event.is_set():
            wait_seconds = max(0.0, next_slot - time.monotonic())
            if stop_event.wait(wait_seconds):
                break
            next_slot = time.monotonic() + poll_seconds

            lease_token = str(uuid.uuid4())
            claim = repository.claim_due_store_item_update(
                worker_name=WORKER_NAME,
                worker_id=worker_id,
                lease_token=lease_token,
                lease_seconds=lease_seconds,
            )
            if claim is None:
                repository.heartbeat_continuous_update_worker(
                    worker_name=WORKER_NAME,
                    worker_id=worker_id,
                )
                continue
            attempt_trace_logger = _ContextTraceLogger(
                trace_logger,
                platform=claim.platform,
                store_id=claim.record.store_id,
                store_item_id=claim.record.store_item_id,
                update_attempt_id=claim.attempt_id,
            )
            if browser_session is not None:
                browser_session.trace_logger = attempt_trace_logger
            try:
                _process_claim(
                    browser_fetcher=browser_fetcher,
                    claim=claim,
                    item_title_extractor=item_title_extractor,
                    job_id=job_id,
                    repository=repository,
                    request_headers_provider=request_headers_provider,
                    run_id=run_id,
                    throttle=throttle,
                    trace_logger=attempt_trace_logger,
                    worker_id=worker_id,
                )
            finally:
                if browser_session is not None:
                    browser_session.trace_logger = trace_logger

        repository.mark_continuous_update_worker_stopped(worker_name=WORKER_NAME, worker_id=worker_id)
        repository.complete_store_item_update_log(
            job_id=job_id,
            status="completed",
            completed_at=_utc_now(),
        )
    except Exception as exc:
        if job_id is not None:
            try:
                repository.complete_store_item_update_log(
                    job_id=job_id,
                    status="failed",
                    completed_at=_utc_now(),
                    error=str(exc),
                )
            except Exception:
                pass
        raise
    finally:
        if browser_session is not None:
            browser_session.__exit__(None, None, None)
        connection.close()


def _process_claim(
    *,
    browser_fetcher,
    claim: ClaimedStoreItemUpdate,
    item_title_extractor,
    job_id: int,
    repository: DiscoveryRepository,
    request_headers_provider,
    run_id: str,
    throttle: PerHostRequestThrottle,
    trace_logger: TraceLogger | None = None,
    worker_id: str,
) -> None:
    store_item_id = claim.record.store_item_id
    _log(
        "worker.item.started",
        attempt_id=claim.attempt_id,
        platform=claim.platform,
        store_item_id=store_item_id,
        store_name=claim.store_name,
    )
    try:
        refreshed_record = refresh_confirmed_store_item_candidate(
            claim.record,
            platform=claim.platform,
            browser_fetcher=browser_fetcher,
            item_title_extractor=item_title_extractor,
            before_request=lambda url: throttle.wait_before_request(url),
            request_headers_provider=request_headers_provider if claim.platform == "shopify" else None,
            trace_logger=trace_logger,
        )
        result = repository.complete_claimed_store_item_update(
            claim.record,
            refreshed_record,
            attempt_id=claim.attempt_id,
            job_id=job_id,
            lease_token=claim.lease_token,
            next_update_at=_utc_now() + timedelta(hours=random.uniform(SUCCESS_MIN_HOURS, SUCCESS_MAX_HOURS)),
            run_id=run_id,
            worker_id=worker_id,
            worker_name=WORKER_NAME,
            platform=claim.platform,
        )
        _log(
            "worker.item.succeeded",
            attempt_id=claim.attempt_id,
            changed=result.changed,
            store_item_id=store_item_id,
        )
    except ProductPageRemovedError as exc:
        repository.deactivate_claimed_store_item_update(
            claim.record,
            attempt_id=claim.attempt_id,
            job_id=job_id,
            lease_token=claim.lease_token,
            run_id=run_id,
            worker_id=worker_id,
            worker_name=WORKER_NAME,
        )
        _log("worker.item.deactivated", error=str(exc), store_item_id=store_item_id)
    except Exception as exc:
        status_code = exc.status_code if isinstance(exc, TransientProductFetchError) else None
        retry_after_seconds = exc.retry_after_seconds if isinstance(exc, TransientProductFetchError) else None
        next_update_at = _item_failure_retry_at(claim.consecutive_failures + 1)
        shopify_blocked_until = None
        if claim.platform == "shopify" and status_code == 429:
            shopify_blocked_until = _shopify_retry_at(
                claim.shopify_consecutive_429s + 1,
                retry_after_seconds=retry_after_seconds,
            )
            next_update_at = max(next_update_at, shopify_blocked_until)
        repository.fail_claimed_store_item_update(
            claim.record,
            attempt_id=claim.attempt_id,
            error=str(exc),
            http_status=status_code,
            lease_token=claim.lease_token,
            next_update_at=next_update_at,
            shopify_blocked_until=shopify_blocked_until,
            worker_id=worker_id,
            worker_name=WORKER_NAME,
            job_id=job_id,
            platform=claim.platform,
        )
        _log(
            "worker.item.failed",
            attempt_id=claim.attempt_id,
            error=str(exc),
            http_status=status_code,
            next_update_at=next_update_at.isoformat(),
            shopify_blocked_until=shopify_blocked_until.isoformat() if shopify_blocked_until else None,
            store_item_id=store_item_id,
        )


def _item_failure_retry_at(consecutive_failures: int) -> datetime:
    index = min(max(consecutive_failures, 1), len(ITEM_FAILURE_BACKOFF_MINUTES)) - 1
    minutes = ITEM_FAILURE_BACKOFF_MINUTES[index] * random.uniform(0.9, 1.1)
    return _utc_now() + timedelta(minutes=minutes)


def _shopify_retry_at(consecutive_429s: int, *, retry_after_seconds: float | None) -> datetime:
    index = min(max(consecutive_429s, 1), len(SHOPIFY_429_BACKOFF_MINUTES)) - 1
    configured_seconds = SHOPIFY_429_BACKOFF_MINUTES[index] * 60
    requested_seconds = max(0.0, retry_after_seconds or 0.0)
    delay_seconds = min(24 * 60 * 60, max(configured_seconds, requested_seconds))
    return _utc_now() + timedelta(seconds=delay_seconds)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _log(event: str, **payload: object) -> None:
    print(json.dumps({"event": event, **payload}, ensure_ascii=False, default=str), flush=True)


def _positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the continuous Ludora store item update worker")
    parser.add_argument("--env-file", default=".env")
    parser.add_argument("--poll-seconds", type=_positive_float, default=5.0)
    parser.add_argument("--lease-seconds", type=_positive_int, default=300)
    args = parser.parse_args()
    stop_event = threading.Event()

    def request_stop(_signum, _frame) -> None:
        stop_event.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    run_continuous_update_worker(
        env_file=args.env_file,
        poll_seconds=args.poll_seconds,
        lease_seconds=args.lease_seconds,
        stop_event=stop_event,
    )


if __name__ == "__main__":
    main()
