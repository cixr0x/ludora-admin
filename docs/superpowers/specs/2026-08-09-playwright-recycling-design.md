# Playwright Recycling Design

## Context

The production continuous store-item updater owns one `BrowserTextFetcher` for
the entire worker session. On August 9, 2026, that session had lived for almost
59 hours and handled 1,237 browser fallback fetches when Playwright's Node
driver exhausted its V8 heap. The driver crashed while the parent Python worker
remained alive, leaving one update attempt running with a stale heartbeat and
preventing the admin-service child-process manager from restarting the worker.

The affected store item had completed successfully on previous days through
the same Amazon redirect and browser fallback. The permanent fix therefore
needs to bound the Playwright driver's lifetime rather than special-case an
item, store, or platform.

## Goals

- Recycle the complete Playwright driver and browser after 250 browser fetches
  or six hours, whichever occurs first.
- Recycle only between browser fetches so an in-flight navigation is never
  interrupted by the lifecycle policy.
- Keep the database connection, continuous worker session, job record,
  coordinator lock, request throttle, and item claim flow unchanged.
- Preserve the existing default `BrowserTextFetcher` behavior for discovery
  workflows that do not opt into recycling.
- Emit trace evidence for every recycle attempt and outcome.
- Convert recycle startup failures into the existing per-item browser-fetch
  failure and retry path.

## Non-goals

- Adding a worker heartbeat watchdog or process-memory monitor.
- Changing update schedules, leases, cooldowns, database schema, or persisted
  data.
- Making recycle thresholds configurable through environment variables or the
  admin UI.
- Changing browser navigation, Amazon validation, or product extraction.

## Selected Approach

`BrowserTextFetcher` will own its optional recycling policy. Its constructor
will accept a maximum completed-fetch count and maximum age in seconds. Both
limits remain disabled when omitted. The continuous updater will instantiate
the fetcher with fixed constants of 250 fetches and 21,600 seconds; all other
callers continue using the existing defaults.

This boundary is preferred over recycling the whole continuous worker because
it disposes the memory-owning Playwright Node process without closing the job,
releasing the coordinator lock, reconnecting to PostgreSQL, or invoking
interrupted-attempt recovery. It is preferred over a memory watchdog because it
prevents the known exhaustion instead of reacting after the process becomes
unhealthy.

## Lifecycle

Starting a `BrowserTextFetcher` records a monotonic start time and resets its
completed-fetch count to zero. Each call to `fetch()` performs this sequence:

1. If the fetcher has reached 250 completed calls, recycle with reason
   `max_fetches`.
2. Otherwise, if its current driver is at least 21,600 seconds old, recycle
   with reason `max_age`.
3. Perform the requested browser fetch through the current driver.
4. Increment the completed-fetch count in the fetch cleanup path, regardless
   of whether the fetch returned a result or a normal browser failure.

When recycling, the fetcher logs the start event, closes the existing browser
and Playwright client, clears the old handles, starts a new Playwright client,
browser, context, and page, resets its count and monotonic start time, and logs
completion. The threshold-triggering request runs only after the fresh stack is
ready, so the first recycle occurs immediately before fetch 251.

If both thresholds are due, `max_fetches` is the reported reason because the
count check is deterministic and performed first. A successful recycle resets
both limits.

## Error Handling and Observability

The fetcher will emit these trace events through its current trace logger:

- `browser_fetch.recycle.started`
- `browser_fetch.recycle.completed`
- `browser_fetch.recycle.failed`

Events include the recycle reason, the prior completed-fetch count, and the
prior driver age in seconds. Completed events confirm that a fresh driver is
ready. Failed events also include the exact exception type and message.

Teardown will make a best effort to stop both the browser and Playwright client
and will clear old handles even when an individual close operation fails. A
failure to start the replacement stack is represented as a normal browser-fetch
failure: `fetch()` returns no result and populates `last_failure`, allowing the
existing product refresh path to fail the claimed item, release its lease, and
apply the standard retry delay. The next browser fetch may attempt a fresh
start again; it must not reuse partially initialized handles.

This proactive policy does not claim to recover a driver that has already
entered the observed out-of-memory transport hang. The bounded lifetime keeps
normal production operation well below that condition. A stale-heartbeat
watchdog remains a separate defense-in-depth enhancement.

## Testing

Focused unit tests will verify:

- A fetch below both thresholds reuses the existing driver.
- Fetch 251 recycles the full Playwright stack before navigating.
- A driver older than six hours recycles even below 250 fetches.
- A successful recycle resets both the fetch count and age baseline.
- When both limits are due, the trace reason is `max_fetches`.
- Every completed or normally failed fetch increments the count exactly once.
- A replacement-start failure records recycle diagnostics and follows the
  existing browser-fetch failure contract without navigating on stale handles.
- The continuous worker supplies 250 and 21,600 while other callers retain
  disabled recycling defaults.

The focused verification command is:

```powershell
python -m unittest tests.test_browser_fetch tests.test_continuous_update_worker -v
```

The complete discovery test suite remains the final regression check:

```powershell
python -m unittest discover -s tests -v
```

## Operational Outcome

Recycling adds a short browser startup pause only to the threshold-triggering
fallback fetch. It does not restart the admin service or Python worker, does not
alter the current job ID, and does not run SQL. Production traces will show the
reason and cadence of every recycle so the thresholds can be evaluated against
real runtime behavior after deployment.
