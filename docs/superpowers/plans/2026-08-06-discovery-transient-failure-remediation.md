# Discovery Transient Failure Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retry raw peer connection resets during static product fetches and complete Amazon discovery runs while leaving exhausted invalid detail pages unpersisted.

**Architecture:** Extend the existing `FetchResult`-based transient error path with an error-type-specific retry rule for `ConnectionResetError`. Change the Amazon crawl aggregate from a run-level exception to a completed-with-skips trace while preserving every per-attempt and per-product diagnostic.

**Tech Stack:** Python 3, standard-library `urllib`, `unittest`, existing Ludora discovery trace and crawler modules.

## Global Constraints

- Do not add or execute DDL or DML patches.
- Preserve the existing three-attempt Amazon detail validation and context-reset behavior.
- Leave exhausted invalid Amazon URLs absent from `store_items` so future discovery runs can retry them.
- Do not weaken Amazon product-title, expected-ASIN, redirect, or brand-byline validation.
- Follow strict red-green TDD for each behavior change.

---

### Task 1: Retry raw connection resets

**Files:**
- Modify: `ludora-discovery/tests/test_webfetch.py`
- Modify: `ludora-discovery/src/ludora/webfetch.py:19-22,138-168,189-223`

**Interfaces:**
- Consumes: `fetch_html(url, include_http_error_status=True)` and `fetch_with_transient_retries(...)`.
- Produces: `ConnectionResetError` becomes a status-zero `FetchResult`, and that error type uses all configured retry attempts.

- [ ] **Step 1: Add failing raw-reset preservation test**

Add this test to `WebFetchTests`:

```python
def test_fetch_html_can_preserve_connection_reset_for_retry(self):
    error = ConnectionResetError(104, "Connection reset by peer")
    with patch("ludora.webfetch.urlopen", side_effect=error):
        result = fetch_html(
            "https://example.mx/products/catan",
            include_http_error_status=True,
        )

    self.assertIsNotNone(result)
    assert result is not None
    self.assertEqual(result.status_code, 0)
    self.assertEqual(result.error_type, "ConnectionResetError")
    self.assertIn("Connection reset by peer", result.error or "")
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `ludora-discovery`:

```powershell
python -m unittest tests.test_webfetch.WebFetchTests.test_fetch_html_can_preserve_connection_reset_for_retry -v
```

Expected: error because raw `ConnectionResetError` currently escapes `fetch_html`.

- [ ] **Step 3: Add failing bounded-retry test**

Add this test to `WebFetchTests`:

```python
def test_connection_reset_uses_configured_transient_attempts(self):
    fetcher = Mock(
        side_effect=[
            FetchResult(
                url="https://example.mx/products/catan",
                text="",
                status_code=0,
                error="[Errno 104] Connection reset by peer",
                error_type="ConnectionResetError",
            ),
            FetchResult(
                url="https://example.mx/products/catan",
                text="<html></html>",
            ),
        ]
    )

    result = fetch_with_transient_retries(
        "https://example.mx/products/catan",
        fetcher,
        trace_event="inventory.candidate.detail_fetch.http_error",
        ambiguous_failure_attempts=1,
        max_attempts=3,
    )

    self.assertIsNotNone(result)
    self.assertEqual(fetcher.call_count, 2)
```

- [ ] **Step 4: Run the retry test and verify RED**

```powershell
python -m unittest tests.test_webfetch.WebFetchTests.test_connection_reset_uses_configured_transient_attempts -v
```

Expected: failure because the helper currently stops after the first ambiguous failure when `ambiguous_failure_attempts=1`.

- [ ] **Step 5: Implement the minimal connection-reset handling**

In `webfetch.py`, add:

```python
TRANSIENT_FETCH_ERROR_TYPES = {"ConnectionResetError"}
```

Include `ConnectionResetError` in the exception tuple handled by `fetch_html`. In the `fetched is None or fetched.error` branch of `fetch_with_transient_retries`, choose the attempt limit by error type:

```python
error_attempts = (
    resolved_max_attempts
    if fetched is not None and fetched.error_type in TRANSIENT_FETCH_ERROR_TYPES
    else resolved_ambiguous_attempts
)
will_retry = attempt < error_attempts
```

Keep the current trace payload and zero-delay retry scheduling behavior unchanged.

- [ ] **Step 6: Run the web-fetch suite and verify GREEN**

```powershell
python -m unittest tests.test_webfetch -v
```

Expected: all web-fetch tests pass.

### Task 2: Skip exhausted invalid Amazon details without failing the run

**Files:**
- Modify: `ludora-discovery/tests/test_amazon_discovery.py:432-564`
- Modify: `ludora-discovery/src/ludora/amazon_discovery.py:343-353,619-641`

**Interfaces:**
- Consumes: existing `AmazonDetailFetchError` collection and trace logger.
- Produces: valid records are returned, invalid URLs remain unpersisted, and `amazon_inventory.crawl.completed_with_skips` summarizes exhausted pages.

- [ ] **Step 1: Change the all-invalid test to the desired contract**

Rename `test_raises_after_invalid_amazon_detail_page_retries` to `test_skips_invalid_amazon_detail_page_after_retries_without_failing_run`. Remove `assertRaisesRegex`, capture the returned records, and assert:

```python
self.assertEqual(records, [])
self.assertEqual(detail_fetches, [product_url, product_url, product_url])
self.assertEqual(extractor_inputs, [])
self.assertEqual(repository.item_records, [])
self.assertEqual(
    [fields for event, fields in trace.entries if event == "amazon_inventory.crawl.completed_with_skips"],
    [
        {
            "skipped_detail_pages": 1,
            "skipped_source_urls": [product_url],
            "processed_items": 0,
            "store_id": 11,
        }
    ],
)
```

Keep the current three `amazon_inventory.candidate.detail_fetch.invalid` assertions and add an assertion that one `detail_fetch.exhausted` entry remains.

- [ ] **Step 2: Run the all-invalid test and verify RED**

```powershell
python -m unittest tests.test_amazon_discovery.AmazonDiscoveryTests.test_skips_invalid_amazon_detail_page_after_retries_without_failing_run -v
```

Expected: error because the crawl still raises a run-level `RuntimeError`.

- [ ] **Step 3: Change the mixed-result test to the desired contract**

Rename `test_preserves_valid_products_after_an_exhausted_detail_page_and_reports_partial_failure` to `test_returns_valid_products_and_reports_skipped_exhausted_detail_page`. Remove `assertRaisesRegex`, capture `records`, retain the exact exhausted-entry assertion, and assert:

```python
self.assertEqual([record.source_url for record in records], [valid_url])
self.assertEqual([record.source_url for record in repository.item_records], [valid_url])
self.assertEqual(
    [fields for event, fields in trace.entries if event == "amazon_inventory.crawl.completed_with_skips"],
    [
        {
            "skipped_detail_pages": 1,
            "skipped_source_urls": [failed_url],
            "processed_items": 1,
            "store_id": 11,
        }
    ],
)
```

- [ ] **Step 4: Run the mixed-result test and verify RED**

```powershell
python -m unittest tests.test_amazon_discovery.AmazonDiscoveryTests.test_returns_valid_products_and_reports_skipped_exhausted_detail_page -v
```

Expected: error because the aggregate helper still raises after processing the valid record.

- [ ] **Step 5: Replace the aggregate exception with a completion trace**

Rename `_raise_amazon_detail_failures` to `_log_amazon_detail_skips` and update all three callers. Replace its body after the empty-list guard with:

```python
skipped_urls = [failure.source_url for failure in failures]
trace.log(
    "amazon_inventory.crawl.completed_with_skips",
    skipped_detail_pages=len(skipped_urls),
    skipped_source_urls=skipped_urls,
    processed_items=len(records),
    store_id=store_id,
)
```

Do not insert a placeholder record and do not raise an exception.

- [ ] **Step 6: Run the Amazon discovery suite and verify GREEN**

```powershell
python -m unittest tests.test_amazon_discovery -v
```

Expected: all Amazon discovery tests pass.

### Task 3: Verify the integrated discovery package

**Files:**
- Verify only; no additional production files are expected.

**Interfaces:**
- Consumes: completed changes from Tasks 1 and 2.
- Produces: evidence that the focused behavior and the full discovery package remain green.

- [ ] **Step 1: Run both focused suites together**

```powershell
python -m unittest tests.test_webfetch tests.test_amazon_discovery -v
```

Expected: all focused tests pass with zero failures and zero errors.

- [ ] **Step 2: Run the complete discovery suite**

```powershell
python -m unittest discover -s tests -v
```

Expected: all discovery tests pass with zero failures and zero errors.

- [ ] **Step 3: Review repository state**

```powershell
git diff --check
git status --short
git diff -- ludora-discovery/src/ludora/webfetch.py ludora-discovery/src/ludora/amazon_discovery.py ludora-discovery/tests/test_webfetch.py ludora-discovery/tests/test_amazon_discovery.py
```

Expected: only the approved discovery code, regression tests, and planning documentation are changed; `git diff --check` exits successfully.

- [ ] **Step 4: Commit the implementation**

```powershell
git add -- ludora-discovery/src/ludora/webfetch.py ludora-discovery/src/ludora/amazon_discovery.py ludora-discovery/tests/test_webfetch.py ludora-discovery/tests/test_amazon_discovery.py docs/superpowers/plans/2026-08-06-discovery-transient-failure-remediation.md
git commit -m "Fix transient discovery failure handling"
```
