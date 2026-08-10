# Playwright Recycling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the continuous store-item updater's Playwright Node driver from exhausting its heap by recycling the full browser stack after 250 browser fetches or six hours.

**Architecture:** `BrowserTextFetcher` owns an optional count-and-age recycling policy and performs the recycle immediately before a fetch. The continuous updater opts into fixed thresholds through a focused factory helper; other callers retain disabled recycling defaults. Recycling preserves the Python worker, database connection, coordinator lock, job, and item scheduling behavior.

**Tech Stack:** Python 3.10+, Playwright Python sync API, `unittest`, `unittest.mock`.

## Global Constraints

- Recycle after exactly 250 completed browser-fetch calls or 21,600 seconds, whichever occurs first.
- Recycle only between browser fetches; never interrupt an in-flight navigation.
- A completed or normally failed fetch increments the count exactly once.
- A replacement-start failure follows the existing browser-fetch failure contract and leaves no stale Playwright handles.
- Emit `browser_fetch.recycle.started`, `browser_fetch.recycle.completed`, and `browser_fetch.recycle.failed` trace events with reason, prior count, and prior age.
- Preserve current behavior for every caller that omits the optional thresholds.
- Add no environment variables, database schema, DDL, DML, scheduler, lease, or cooldown changes.
- Do not deploy or restart production as part of implementation verification.

---

### Task 1: Add bounded lifecycle recycling to `BrowserTextFetcher`

**Files:**
- Modify: `ludora-discovery/src/ludora/browser_fetch.py:1-190`
- Test: `ludora-discovery/tests/test_browser_fetch.py:17-425`

**Interfaces:**
- Consumes: existing `BrowserTextFetcher.fetch()`, `BrowserTextFetcher.reset_context()`, Playwright sync browser/context/page objects, and `TraceLogger.log(event, **fields)`.
- Produces: `BrowserTextFetcher(..., max_fetches: int | None = None, max_age_seconds: float | None = None)`, private `_start_browser()`, `_stop_browser()`, `_recycle_details()`, and `_recycle_if_due()` lifecycle methods.

- [ ] **Step 1: Add the lifecycle, counter, and recycle-failure tests**

Add `import time` beside the existing imports, then add a helper inside `BrowserFetchTests` that installs a real fake context while mocking only the external Playwright start boundary:

```python
def _configured_recycling_fetcher(
    self,
    *,
    completed_fetches: int,
    driver_started_at: float,
    max_age_seconds: float = 21_600,
    max_fetches: int = 250,
):
    old_response = FakeResponse(
        "https://example.mx/products/old",
        "<html></html>",
        "text/html",
    )
    next_response = FakeResponse(
        "https://example.mx/products/catan",
        "<html></html>",
        "text/html",
    )
    old_page = FakePage(old_response, "<html><body>old</body></html>")
    next_page = FakePage(next_response, "<html><body><h1>Catan</h1></body></html>")
    trace_logger = Mock()
    fetcher = BrowserTextFetcher(
        trace_logger=trace_logger,
        max_fetches=max_fetches,
        max_age_seconds=max_age_seconds,
    )
    old_browser = Mock()
    old_playwright = Mock()
    fetcher._browser = old_browser
    fetcher._playwright = old_playwright
    fetcher._context = FakeContext([old_page])
    fetcher._page = old_page
    fetcher._completed_fetches = completed_fetches
    fetcher._driver_started_at = driver_started_at

    replacement_context = FakeContext([next_page])

    def start_replacement():
        fetcher._browser = Mock()
        fetcher._playwright = Mock()
        fetcher._context = replacement_context
        fetcher._page = Mock()
        fetcher._completed_fetches = 0
        fetcher._driver_started_at = time.monotonic()

    return fetcher, old_browser, old_playwright, replacement_context, trace_logger, start_replacement
```

Add these focused tests:

```python
def test_fetch_recycles_before_fetch_251_and_resets_the_count(self):
    fetcher, old_browser, old_playwright, context, trace, start = (
        self._configured_recycling_fetcher(completed_fetches=250, driver_started_at=100.0)
    )
    with (
        patch("ludora.browser_fetch.time.monotonic", side_effect=[200.0, 200.0]),
        patch.object(fetcher, "_start_browser", side_effect=start),
    ):
        result = fetcher.fetch("https://example.mx/products/catan")

    self.assertEqual(result.text, "<html><body><h1>Catan</h1></body></html>")
    old_browser.close.assert_called_once_with()
    old_playwright.stop.assert_called_once_with()
    self.assertEqual(len(context.created_pages), 1)
    self.assertEqual(fetcher._completed_fetches, 1)
    trace.log.assert_any_call(
        "browser_fetch.recycle.started",
        reason="max_fetches",
        completed_fetches=250,
        age_seconds=100.0,
    )
    trace.log.assert_any_call(
        "browser_fetch.recycle.completed",
        reason="max_fetches",
        completed_fetches=250,
        age_seconds=100.0,
    )

def test_fetch_recycles_a_six_hour_old_driver_below_the_count_limit(self):
    fetcher, _, _, _, trace, start = self._configured_recycling_fetcher(
        completed_fetches=10,
        driver_started_at=100.0,
    )
    with (
        patch("ludora.browser_fetch.time.monotonic", side_effect=[21_700.0, 21_700.0]),
        patch.object(fetcher, "_start_browser", side_effect=start),
    ):
        fetcher.fetch("https://example.mx/products/catan")

    trace.log.assert_any_call(
        "browser_fetch.recycle.started",
        reason="max_age",
        completed_fetches=10,
        age_seconds=21_600.0,
    )

def test_fetch_does_not_recycle_below_both_limits(self):
    response = FakeResponse("https://example.mx/products/catan", "<html></html>", "text/html")
    page = FakePage(response, "<html><body><h1>Catan</h1></body></html>")
    fetcher = BrowserTextFetcher(max_fetches=250, max_age_seconds=21_600)
    fetcher._context = FakeContext([page])
    fetcher._driver_started_at = 100.0
    fetcher._completed_fetches = 249

    with (
        patch("ludora.browser_fetch.time.monotonic", return_value=21_699.0),
        patch.object(fetcher, "_start_browser") as start,
    ):
        fetcher.fetch("https://example.mx/products/catan")

    start.assert_not_called()
    self.assertEqual(fetcher._completed_fetches, 250)

def test_fetch_prefers_count_reason_when_both_limits_are_due(self):
    fetcher, _, _, _, trace, start = self._configured_recycling_fetcher(
        completed_fetches=250,
        driver_started_at=0.0,
    )
    with (
        patch("ludora.browser_fetch.time.monotonic", side_effect=[30_000.0, 30_000.0]),
        patch.object(fetcher, "_start_browser", side_effect=start),
    ):
        fetcher.fetch("https://example.mx/products/catan")

    self.assertEqual(trace.log.call_args_list[0].args, ("browser_fetch.recycle.started",))
    self.assertEqual(trace.log.call_args_list[0].kwargs["reason"], "max_fetches")
```

Extend `test_fetch_logs_exact_exception_to_trace_logger` with:

```python
self.assertEqual(fetcher._completed_fetches, 1)
```

Add the replacement-start recovery test:

```python
def test_failed_recycle_start_uses_fetch_failure_contract_and_retries_next_fetch(self):
    fetcher, _, _, replacement_context, trace, start = self._configured_recycling_fetcher(
        completed_fetches=250,
        driver_started_at=100.0,
    )
    failed_start = RuntimeError("playwright driver failed to start")
    start_attempt = 0

    def fail_then_start():
        nonlocal start_attempt
        start_attempt += 1
        if start_attempt == 1:
            raise failed_start
        start()

    with (
        patch("ludora.browser_fetch.time.monotonic", side_effect=[200.0, 200.0, 200.0]),
        patch.object(fetcher, "_start_browser", side_effect=fail_then_start),
    ):
        first_result = fetcher.fetch("https://example.mx/products/catan")
        first_failure = fetcher.last_failure
        second_result = fetcher.fetch("https://example.mx/products/catan")

    self.assertIsNone(first_result)
    self.assertIsNotNone(second_result)
    self.assertIn("Failed to recycle Playwright browser", first_failure["error"])
    trace.log.assert_any_call(
        "browser_fetch.recycle.failed",
        reason="max_fetches",
        completed_fetches=250,
        age_seconds=100.0,
        error="playwright driver failed to start",
        error_type="RuntimeError",
    )
    self.assertEqual(len(replacement_context.created_pages), 1)
    self.assertEqual(fetcher._completed_fetches, 1)
```

- [ ] **Step 2: Run all browser-fetch tests and verify RED**

Run from `ludora-discovery`:

```powershell
python -m unittest tests.test_browser_fetch -v
```

Expected: the new and modified tests fail because `BrowserTextFetcher.__init__()` does not accept `max_fetches` or `max_age_seconds`, the lifecycle methods do not exist, and failed fetches do not have a completed-fetch counter.

- [ ] **Step 3: Implement the minimal lifecycle policy**

Add `import time` and extend the constructor without changing existing positional arguments:

```python
def __init__(
    self,
    timeout_ms: int = 30_000,
    trace_logger: TraceLogger | None = None,
    *,
    max_fetches: int | None = None,
    max_age_seconds: float | None = None,
) -> None:
    self.timeout_ms = timeout_ms
    self.trace_logger = trace_logger
    self.max_fetches = max_fetches
    self.max_age_seconds = max_age_seconds
    self._completed_fetches = 0
    self._driver_started_at: float | None = None
    # Preserve the existing Playwright/browser/context/page fields below.
```

Move the existing `__enter__()` startup body into `_start_browser()`. Only commit new handles and reset counters after the browser, context, and initial page have all been created successfully:

```python
def __enter__(self) -> BrowserTextFetcher:
    self._start_browser()
    return self

def _start_browser(self) -> None:
    try:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise BrowserFetchUnavailable(
            "Playwright is not installed. Install discovery dependencies first."
        ) from exc

    self._playwright_error = PlaywrightError
    self._playwright_timeout_error = PlaywrightTimeoutError
    playwright = sync_playwright().start()
    browser = None
    try:
        chrome_path = _chrome_executable_path()
        browser = playwright.chromium.launch(
            executable_path=chrome_path,
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        self._chrome_path = chrome_path
        self._browser_version = str(getattr(browser, "version", "") or "")
        self._browser = browser
        self._playwright = playwright
        self._context = self._create_context()
        self._page = self._context.new_page()
    except Exception:
        if browser is not None:
            try:
                browser.close()
            except PlaywrightError:
                pass
        try:
            playwright.stop()
        except PlaywrightError:
            pass
        self._browser = None
        self._playwright = None
        self._context = None
        self._page = None
        self._chrome_path = None
        self._browser_version = None
        raise
    self._completed_fetches = 0
    self._driver_started_at = time.monotonic()
```

Add best-effort full-stack teardown and have `__exit__()` use it:

```python
def _stop_browser(self) -> None:
    browser = self._browser
    playwright = self._playwright
    self._browser = None
    self._playwright = None
    self._context = None
    self._page = None
    self._chrome_path = None
    self._browser_version = None
    if browser is not None:
        try:
            browser.close()
        except self._playwright_error:
            pass
    if playwright is not None:
        try:
            playwright.stop()
        except self._playwright_error:
            pass

def __exit__(self, exc_type, exc, traceback) -> None:
    self._stop_browser()
```

Add deterministic count-first threshold selection and recycle tracing:

```python
def _recycle_details(self) -> tuple[str, float] | None:
    if self._driver_started_at is None:
        return None
    age_seconds = max(0.0, time.monotonic() - self._driver_started_at)
    if self.max_fetches is not None and self._completed_fetches >= self.max_fetches:
        return "max_fetches", age_seconds
    if self.max_age_seconds is not None and age_seconds >= self.max_age_seconds:
        return "max_age", age_seconds
    return None

def _recycle_if_due(self) -> None:
    details = self._recycle_details()
    if details is None:
        return
    reason, age_seconds = details
    fields = {
        "reason": reason,
        "completed_fetches": self._completed_fetches,
        "age_seconds": age_seconds,
    }
    if self.trace_logger is not None:
        self.trace_logger.log("browser_fetch.recycle.started", **fields)
    self._stop_browser()
    try:
        self._start_browser()
    except Exception as exc:
        if self.trace_logger is not None:
            self.trace_logger.log(
                "browser_fetch.recycle.failed",
                **fields,
                error=str(exc),
                error_type=type(exc).__name__,
            )
        raise BrowserFetchUnavailable(f"Failed to recycle Playwright browser: {exc}") from exc
    if self.trace_logger is not None:
        self.trace_logger.log("browser_fetch.recycle.completed", **fields)
```

In `fetch()`, move the current startup precondition into the existing exception-handled block, call `_recycle_if_due()` before creating the request page, include `BrowserFetchUnavailable` in the handled exception tuple, and increment `_completed_fetches` once in `finally` only after recycling succeeded and the requested fetch began. Keep the existing navigation block from `_configure_lightweight_amazon_page(...)` through the final `FetchResult(...)` return unchanged between page creation and `except`:

```python
count_fetch = False
try:
    self._recycle_if_due()
    if self._context is None and self._page is None:
        raise BrowserFetchUnavailable("Browser fetcher has not been started.")
    count_fetch = True
    page = self._context.new_page() if self._context is not None else self._page
    if page is None:
        raise BrowserFetchUnavailable("Browser fetcher has not been started.")
    amazon_resource_counts = _configure_lightweight_amazon_page(page, url)
    amazon_detail_request = _is_amazon_product_detail_url(url)
    response = _navigate_past_reload_challenge(
        page,
        url,
        timeout_ms=self.timeout_ms,
        before_navigation=before_navigation,
        cancellation_token=cancellation_token,
    )
    # Keep the current response, rendered HTML, and Amazon storefront handling here unchanged.
except (
    AmazonStoreSearchIncomplete,
    BrowserFetchUnavailable,
    self._playwright_error,
    self._playwright_timeout_error,
    OSError,
    ValueError,
) as exc:
    failure = {
        "error": str(exc),
        "error_type": type(exc).__name__,
        "final_url": getattr(page, "url", ""),
        "timeout_ms": self.timeout_ms,
        "url": url,
    }
    self.last_failure = failure
    if self.trace_logger is not None:
        self.trace_logger.log("browser_fetch.failed", **failure)
    return None
finally:
    if count_fetch:
        self._completed_fetches += 1
    if close_page_after_fetch and page is not None:
        try:
            page.close()
        except self._playwright_error as exc:
            if self.trace_logger is not None:
                self.trace_logger.log(
                    "browser_fetch.page_close.failed",
                    error=str(exc),
                    error_type=type(exc).__name__,
                    final_url=getattr(page, "url", ""),
                    url=url,
                )
    if amazon_resource_counts and self.trace_logger is not None:
        self.trace_logger.log(
            "browser_fetch.amazon_resources.blocked",
            blocked_by_type=dict(sorted(amazon_resource_counts.items())),
            blocked_requests=sum(amazon_resource_counts.values()),
            url=url,
        )
```

- [ ] **Step 4: Run all browser-fetch tests and verify GREEN**

Run the Step 2 command again.

Expected: all browser-fetch tests pass; fetch 251 and a six-hour-old driver recycle before navigation, below-threshold fetches reuse the current driver, failed fetches increment once, and a replacement-start failure returns through `last_failure` before the next fetch retries successfully.

- [ ] **Step 5: Commit the lifecycle component**

```powershell
git add -- ludora-discovery/src/ludora/browser_fetch.py ludora-discovery/tests/test_browser_fetch.py
git commit -m "Fix Playwright driver lifetime"
```

---

### Task 2: Enable recycling only for the continuous updater

**Files:**
- Modify: `ludora-discovery/src/ludora/continuous_update_worker.py:25-145`
- Test: `ludora-discovery/tests/test_continuous_update_worker.py:1-55`
- Modify: `docs/production-deployment.md:80-105`

**Interfaces:**
- Consumes: Task 1's `BrowserTextFetcher(max_fetches=..., max_age_seconds=...)` constructor.
- Produces: `BROWSER_RECYCLE_MAX_FETCHES = 250`, `BROWSER_RECYCLE_MAX_AGE_SECONDS = 6 * 60 * 60`, and `_create_continuous_browser_session(trace_logger: TraceLogger) -> BrowserTextFetcher`.

- [ ] **Step 1: Add a failing continuous-worker configuration test**

Update the test import and add:

```python
from ludora.continuous_update_worker import (
    BROWSER_RECYCLE_MAX_AGE_SECONDS,
    BROWSER_RECYCLE_MAX_FETCHES,
    _ContextTraceLogger,
    _create_continuous_browser_session,
    _process_claim,
)

def test_continuous_browser_session_uses_bounded_playwright_lifetime(self):
    trace_logger = Mock()

    session = _create_continuous_browser_session(trace_logger)

    self.assertIs(session.trace_logger, trace_logger)
    self.assertEqual(BROWSER_RECYCLE_MAX_FETCHES, 250)
    self.assertEqual(BROWSER_RECYCLE_MAX_AGE_SECONDS, 21_600)
    self.assertEqual(session.max_fetches, 250)
    self.assertEqual(session.max_age_seconds, 21_600)
```

- [ ] **Step 2: Run the wiring test and verify RED**

Run:

```powershell
python -m unittest tests.test_continuous_update_worker.ContinuousUpdateWorkerTests.test_continuous_browser_session_uses_bounded_playwright_lifetime -v
```

Expected: import failure because the constants and helper do not exist.

- [ ] **Step 3: Add the constants, factory, and worker wiring**

Import `TraceLogger` for the helper type and add:

```python
BROWSER_RECYCLE_MAX_FETCHES = 250
BROWSER_RECYCLE_MAX_AGE_SECONDS = 6 * 60 * 60


def _create_continuous_browser_session(trace_logger: TraceLogger) -> BrowserTextFetcher:
    return BrowserTextFetcher(
        trace_logger=trace_logger,
        max_fetches=BROWSER_RECYCLE_MAX_FETCHES,
        max_age_seconds=BROWSER_RECYCLE_MAX_AGE_SECONDS,
    )
```

Replace only the continuous session construction:

```python
if browser_fetch_enabled:
    browser_session = _create_continuous_browser_session(trace_logger)
    browser_fetcher = browser_session.__enter__().fetch
```

Do not modify product discovery's separate `BrowserTextFetcher` construction sites.

- [ ] **Step 4: Run the focused worker and browser suites**

Run:

```powershell
python -m unittest tests.test_browser_fetch tests.test_continuous_update_worker -v
```

Expected: all focused tests pass.

- [ ] **Step 5: Document the fixed production behavior**

In the continuous updater section of `docs/production-deployment.md`, add:

```markdown
The continuous worker recycles its complete Playwright browser and Node driver
after 250 browser fallback fetches or six hours, whichever occurs first. The
recycle happens between item fetches and preserves the worker session, database
connection, coordinator lock, and current job. Review
`browser_fetch.recycle.started`, `browser_fetch.recycle.completed`, and
`browser_fetch.recycle.failed` entries in the item-update trace when validating
the lifecycle in production.
```

- [ ] **Step 6: Run focused tests once more after documentation**

Run the Step 4 command again.

Expected: all focused tests still pass.

- [ ] **Step 7: Commit continuous-worker wiring and documentation**

```powershell
git add -- ludora-discovery/src/ludora/continuous_update_worker.py ludora-discovery/tests/test_continuous_update_worker.py docs/production-deployment.md
git commit -m "Recycle continuous update browser"
```

---

### Task 3: Verify the complete discovery package and final diff

**Files:**
- Verify only: `ludora-discovery/`
- Verify only: `docs/production-deployment.md`
- Verify only: `docs/superpowers/specs/2026-08-09-playwright-recycling-design.md`

**Interfaces:**
- Consumes: Tasks 1 and 2 committed implementation.
- Produces: focused and full-suite evidence that the bounded lifecycle preserves existing discovery behavior.

- [ ] **Step 1: Run the complete discovery test suite**

From `ludora-discovery` run:

```powershell
python -m unittest discover -s tests -v
```

Expected: every discovery test passes; report the exact test count and duration from the command output.

- [ ] **Step 2: Run static syntax compilation for changed Python modules**

```powershell
python -m py_compile src/ludora/browser_fetch.py src/ludora/continuous_update_worker.py
```

Expected: exit code 0 with no output.

- [ ] **Step 3: Inspect the committed diff and workspace state**

From the repository root run:

```powershell
git diff --check HEAD~2..HEAD
git diff --stat HEAD~2..HEAD
git status --short
git log -3 --oneline
```

Expected: no whitespace errors, only the planned source/test/runbook changes plus the previously approved spec and plan commits, and a clean worktree.

- [ ] **Step 4: Review the operational contract**

Confirm directly from the final code that:

- fetch 251 recycles before navigation;
- age recycling uses `time.monotonic()` and the exact 21,600-second threshold;
- successful recycling resets count and age;
- replacement startup failures return through `last_failure` and do not count as a completed browser fetch;
- only the continuous updater passes threshold arguments;
- no SQL, schema, environment, lease, scheduler, cooldown, or deployment files outside the runbook changed.

- [ ] **Step 5: Record verification evidence without deploying**

Summarize the focused suite, full suite, syntax compilation, commits, and clean status. Explicitly state that production remains stalled until a separately approved recovery action and that no deployment or restart was performed by this plan.
