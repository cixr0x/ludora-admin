import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.cancellation import CancellationToken, OperationCancelled
from ludora.webfetch import FetchResult


class FakeWorker:
    def __init__(self, outcome):
        self.outcome = outcome
        self.requests = []
        self.reaped = False

    def start(self, **_kwargs):
        return None

    def request(self, command, url=None, *, before_navigation=None, **_kwargs):
        self.requests.append((command, url))
        if before_navigation is not None:
            before_navigation(url)
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome

    def terminate_and_reap(self):
        self.reaped = True


class SupervisedBrowserTests(unittest.TestCase):
    def test_process_worker_relays_every_navigation_to_shared_throttle(self):
        from ludora.supervised_browser import _ProcessBrowserWorker

        script = """
import json,sys
assert json.loads(sys.stdin.readline())['command']=='start'
print(json.dumps({'kind':'result','value':None}),flush=True)
request=json.loads(sys.stdin.readline())
assert request['command']=='fetch'
for _ in range(2):
    print(json.dumps({'kind':'navigation','url':request['url']}),flush=True)
    assert json.loads(sys.stdin.readline())['command']=='permit'
print(json.dumps({'kind':'result','value':{'url':request['url'],'text':'<h1>ok</h1>','status_code':200}}),flush=True)
assert json.loads(sys.stdin.readline())['command']=='close'
print(json.dumps({'kind':'result','value':None}),flush=True)
"""
        worker = _ProcessBrowserWorker(timeout_seconds=2, worker_command=[sys.executable, "-c", script])
        worker.start()
        navigations = []
        try:
            result = worker.request("fetch", "https://example.mx/product/x", before_navigation=navigations.append)
            self.assertEqual(result.text, "<h1>ok</h1>")
            self.assertEqual(navigations, ["https://example.mx/product/x"] * 2)
            worker.request("close")
        finally:
            worker.terminate_and_reap()

    def test_two_real_worker_stalls_do_not_block_the_next_product(self):
        from ludora.supervised_browser import BrowserFetchTimeout, SupervisedBrowserFetcher, _ProcessBrowserWorker

        stalled_script = """
import json,sys,time
assert json.loads(sys.stdin.readline())['command']=='start'
print(json.dumps({'kind':'result','value':None}),flush=True)
request=json.loads(sys.stdin.readline())
print(json.dumps({'kind':'navigation','url':request['url']}),flush=True)
assert json.loads(sys.stdin.readline())['command']=='permit'
time.sleep(60)
"""
        good_script = """
import json,sys
assert json.loads(sys.stdin.readline())['command']=='start'
print(json.dumps({'kind':'result','value':None}),flush=True)
request=json.loads(sys.stdin.readline())
print(json.dumps({'kind':'navigation','url':request['url']}),flush=True)
assert json.loads(sys.stdin.readline())['command']=='permit'
print(json.dumps({'kind':'result','value':{'url':request['url'],'text':'<h1>next</h1>','status_code':200}}),flush=True)
assert json.loads(sys.stdin.readline())['command']=='close'
print(json.dumps({'kind':'result','value':None}),flush=True)
"""
        scripts = [stalled_script, stalled_script, good_script]
        navigations = []

        def create_worker():
            return _ProcessBrowserWorker(timeout_seconds=0.25,
                                         worker_command=[sys.executable, "-c", scripts.pop(0)])

        with SupervisedBrowserFetcher(worker_factory=create_worker) as fetcher:
            with self.assertRaises(BrowserFetchTimeout):
                fetcher.fetch("https://example.mx/products/stalled", before_navigation=navigations.append)
            next_product = fetcher.fetch("https://example.mx/products/next",
                                         before_navigation=navigations.append)
        self.assertEqual(next_product.text, "<h1>next</h1>")
        self.assertEqual(navigations, ["https://example.mx/products/stalled"] * 2 +
                         ["https://example.mx/products/next"])

    def test_two_worker_fetch_errors_skip_product_and_next_product_succeeds(self):
        from ludora.supervised_browser import BrowserFetchFailed, SupervisedBrowserFetcher, _ProcessBrowserWorker

        error_script = """
import json,sys,time
assert json.loads(sys.stdin.readline())['command']=='start'
print(json.dumps({'kind':'result','value':None}),flush=True)
assert json.loads(sys.stdin.readline())['command']=='fetch'
print(json.dumps({'kind':'error','error_type':'Error','error':'Page.content failed'}),flush=True)
time.sleep(60)
"""
        good_script = """
import json,sys
assert json.loads(sys.stdin.readline())['command']=='start'
print(json.dumps({'kind':'result','value':None}),flush=True)
request=json.loads(sys.stdin.readline())
print(json.dumps({'kind':'result','value':{'url':request['url'],'text':'<h1>next</h1>','status_code':200}}),flush=True)
assert json.loads(sys.stdin.readline())['command']=='close'
print(json.dumps({'kind':'result','value':None}),flush=True)
"""
        scripts = [error_script, error_script, good_script]
        workers = []

        def create_worker():
            worker = _ProcessBrowserWorker(timeout_seconds=2,
                                           worker_command=[sys.executable, "-c", scripts.pop(0)])
            workers.append(worker)
            return worker

        with SupervisedBrowserFetcher(worker_factory=create_worker) as fetcher:
            with self.assertRaises(BrowserFetchFailed):
                fetcher.fetch("https://example.mx/products/broken")
            next_product = fetcher.fetch("https://example.mx/products/next")
        self.assertEqual(next_product.text, "<h1>next</h1>")
        self.assertEqual(len(workers), 3)

    def test_protocol_error_is_store_fatal_without_product_retry(self):
        from ludora.supervised_browser import BrowserWorkerProtocolError, SupervisedBrowserFetcher

        class ProtocolWorker(FakeWorker):
            def request(self, command, url=None, **_kwargs):
                if command == "fetch":
                    raise BrowserWorkerProtocolError("malformed worker frame")
                return None

        created = []

        def create_worker():
            worker = ProtocolWorker(None)
            created.append(worker)
            return worker

        with SupervisedBrowserFetcher(worker_factory=create_worker) as fetcher:
            with self.assertRaises(BrowserWorkerProtocolError):
                fetcher.fetch("https://example.mx/products/x")
        self.assertEqual(len(created), 1)

    def test_watchdog_fetch_scope_remains_active_while_worker_is_reaped(self):
        from ludora.supervised_browser import BrowserFetchTimeout, BrowserWorkerTimeout, SupervisedBrowserFetcher

        active = [False]

        @contextmanager
        def scope(*_args, **_kwargs):
            active[0] = True
            try:
                yield
            finally:
                active[0] = False

        class CheckedWorker(FakeWorker):
            def terminate_and_reap(self):
                if not active[0]:
                    raise AssertionError("Node watchdog was disarmed before process cleanup")
                super().terminate_and_reap()

        workers = [CheckedWorker(BrowserWorkerTimeout("stalled")),
                   CheckedWorker(BrowserWorkerTimeout("stalled"))]
        with patch("ludora.supervised_browser.browser_watchdog_scope", side_effect=scope):
            with SupervisedBrowserFetcher(worker_factory=lambda: workers.pop(0)) as fetcher:
                with self.assertRaises(BrowserFetchTimeout):
                    fetcher.fetch("https://example.mx/products/stalled")

    def test_hard_timeout_reaps_worker_and_retries_url_once_in_fresh_worker(self):
        from ludora.supervised_browser import BrowserWorkerTimeout, SupervisedBrowserFetcher

        url = "https://example.mx/product/catan"
        workers = [
            FakeWorker(BrowserWorkerTimeout("fetch stalled")),
            FakeWorker(FetchResult(url=url, text="<h1>Catan</h1>")),
        ]
        navigation_urls = []
        with SupervisedBrowserFetcher(worker_factory=lambda: workers.pop(0), timeout_seconds=120) as fetcher:
            result = fetcher.fetch(url, before_navigation=navigation_urls.append)

        self.assertEqual(result.text, "<h1>Catan</h1>")
        self.assertEqual(navigation_urls, [url, url])

    def test_two_hard_timeouts_raise_typed_error_after_both_workers_are_reaped(self):
        from ludora.supervised_browser import BrowserFetchTimeout, BrowserWorkerTimeout, SupervisedBrowserFetcher

        workers = [FakeWorker(BrowserWorkerTimeout("stalled")), FakeWorker(BrowserWorkerTimeout("stalled"))]
        created = []

        def worker_factory():
            worker = workers.pop(0)
            created.append(worker)
            return worker

        with SupervisedBrowserFetcher(worker_factory=worker_factory, timeout_seconds=120) as fetcher:
            with self.assertRaises(BrowserFetchTimeout):
                fetcher.fetch("https://example.mx/product/stalled")

        self.assertEqual(len(created), 2)
        self.assertTrue(all(worker.reaped for worker in created))

    def test_fresh_worker_startup_timeout_fails_store_instead_of_skipping_product(self):
        from ludora.supervised_browser import BrowserFetchTimeout, BrowserWorkerTimeout, SupervisedBrowserFetcher

        class StartupTimeoutWorker(FakeWorker):
            def start(self, **_kwargs):
                raise BrowserWorkerTimeout("Chromium startup stalled")

        workers = [FakeWorker(BrowserWorkerTimeout("fetch stalled")), StartupTimeoutWorker(None)]
        with SupervisedBrowserFetcher(worker_factory=lambda: workers.pop(0), timeout_seconds=120) as fetcher:
            with self.assertRaises(BrowserWorkerTimeout) as raised:
                fetcher.fetch("https://example.mx/product/x")
        self.assertNotIsInstance(raised.exception, BrowserFetchTimeout)

    def test_cancelled_store_does_not_start_browser_worker(self):
        from ludora.supervised_browser import SupervisedBrowserFetcher

        token = CancellationToken()
        token.cancel()
        created = []

        def create_worker():
            created.append(FakeWorker(None))
            return created[-1]

        with self.assertRaises(OperationCancelled):
            with SupervisedBrowserFetcher(worker_factory=create_worker, cancellation_token=token):
                pass
        self.assertEqual(created, [])

    def test_cancellation_reaps_current_worker_without_retry(self):
        from ludora.supervised_browser import SupervisedBrowserFetcher

        token = CancellationToken()
        worker = FakeWorker(OperationCancelled("cancelled"))
        with SupervisedBrowserFetcher(worker_factory=lambda: worker, timeout_seconds=120) as fetcher:
            with self.assertRaises(OperationCancelled):
                fetcher.fetch("https://example.mx/product/catan", cancellation_token=token)

        self.assertTrue(worker.reaped)
        self.assertEqual(worker.requests, [("fetch", "https://example.mx/product/catan")])
