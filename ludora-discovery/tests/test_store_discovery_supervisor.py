import contextlib
import io
import json
import os
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.product_discovery_throttle import ProductDiscoveryRequestThrottle
from ludora.cancellation import CancellationToken, OperationCancelled


class StoreDiscoverySupervisorTests(unittest.TestCase):
    def test_store_child_uses_parent_throttle_and_returns_result(self):
        from ludora.store_discovery_supervisor import run_store_in_child

        script = """
import json,sys
json.loads(sys.stdin.readline())
print(json.dumps({'kind':'throttle','source_url':'https://example.mx/products/x'}),flush=True)
assert json.loads(sys.stdin.readline())['command']=='permit'
print(json.dumps({'kind':'result','value':{'store_id':12,'website_url':'https://example.mx/',
  'item_candidates':1,'new_items':1,'items_discovered':1,'confirmed_boardgames':1,
  'confirmed_non_boardgames':0,'unconfirmed_boardgames':0,'unconfirmed_non_boardgames':0,
  'stores_scanned':1}}),flush=True)
"""
        throttle = ProductDiscoveryRequestThrottle(waiter=lambda *_: None)
        result = run_store_in_child(
            database_url="unused", current_env={}, store_id=12, website_url="https://example.mx/",
            platform="custom", store_name="Example", env_file=".env", run_id="batch:12",
            product_request_throttle=throttle, worker_command=[sys.executable, "-c", script],
            store_stall_seconds=2,
        )
        self.assertEqual(result.store_id, 12)
        self.assertEqual(result.items_discovered, 1)

    def test_valid_result_survives_wrapper_cleanup_longer_than_three_seconds(self):
        from ludora.store_discovery_supervisor import run_store_in_child

        script = """
import json,sys,time
json.loads(sys.stdin.readline())
print(json.dumps({'kind':'result','value':{'store_id':12,'website_url':'https://example.mx/',
  'item_candidates':1,'new_items':1,'items_discovered':1,'confirmed_boardgames':1,
  'confirmed_non_boardgames':0,'unconfirmed_boardgames':0,'unconfirmed_non_boardgames':0,
  'stores_scanned':1}}),flush=True)
time.sleep(3.3)
"""
        result = run_store_in_child(
            database_url="unused", current_env={}, store_id=12, website_url="https://example.mx/",
            platform="custom", store_name="Example", env_file=".env", run_id="batch:12",
            product_request_throttle=ProductDiscoveryRequestThrottle(),
            worker_command=[sys.executable, "-c", script], store_stall_seconds=10,
        )

        self.assertEqual(result.item_candidates, 1)

    def test_throttle_state_survives_store_child_restart(self):
        from ludora.store_discovery_supervisor import run_store_in_child

        script = """
import json,sys
json.loads(sys.stdin.readline())
print(json.dumps({'kind':'throttle'}),flush=True)
response=json.loads(sys.stdin.readline())
assert response['command']=='permit'
print(json.dumps({'kind':'result','value':{'store_id':12,'website_url':'https://example.mx/',
  'item_candidates':0,'new_items':0,'items_discovered':0,'confirmed_boardgames':0,
  'confirmed_non_boardgames':0,'unconfirmed_boardgames':0,'unconfirmed_non_boardgames':0,
  'stores_scanned':1}}),flush=True)
"""
        clock = [100.0]
        waits = []

        def wait(seconds, _token):
            waits.append(seconds)
            clock[0] += seconds

        throttle = ProductDiscoveryRequestThrottle(clock=lambda: clock[0], waiter=wait)
        for store_id in (12, 34):
            run_store_in_child(
                database_url="unused", current_env={}, store_id=store_id,
                website_url="https://example.mx/", platform="custom", store_name="Example",
                env_file=".env", run_id=f"batch:{store_id}", product_request_throttle=throttle,
                worker_command=[sys.executable, "-c", script], store_stall_seconds=2,
            )
        self.assertEqual(waits, [3.0])

    def test_cancellation_reaps_store_child(self):
        from ludora.store_discovery_supervisor import run_store_in_child

        script = "import json,sys,time; json.loads(sys.stdin.readline()); time.sleep(60)"
        token = CancellationToken()
        timer = threading.Timer(0.2, token.cancel)
        timer.start()
        try:
            with self.assertRaises(OperationCancelled):
                run_store_in_child(
                    database_url="unused", current_env={}, store_id=12,
                    website_url="https://example.mx/", platform="custom", store_name="Example",
                    env_file=".env", run_id="batch:12",
                    product_request_throttle=ProductDiscoveryRequestThrottle(),
                    cancellation_token=token, worker_command=[sys.executable, "-c", script],
                    store_stall_seconds=2,
                )
        finally:
            timer.cancel()

    def test_child_error_racing_with_cancellation_stays_cancelled(self):
        from ludora.store_discovery_supervisor import run_store_in_child

        class RaceToken(CancellationToken):
            def __init__(self):
                super().__init__()
                self.checks = 0

            def raise_if_cancelled(self):
                self.checks += 1
                if self.checks >= 2:
                    raise OperationCancelled("cancelled")

        script = "import json,sys; json.loads(sys.stdin.readline()); print(json.dumps({'kind':'error','error':'Discovery operation cancelled'}),flush=True)"
        with self.assertRaises(OperationCancelled):
            run_store_in_child(
                database_url="unused", current_env={}, store_id=12,
                website_url="https://example.mx/", platform="custom", store_name="Example",
                env_file=".env", run_id="batch:12", product_request_throttle=ProductDiscoveryRequestThrottle(),
                cancellation_token=RaceToken(), worker_command=[sys.executable, "-c", script],
                store_stall_seconds=2,
            )

    def test_stalled_store_is_reaped_and_active_browser_frame_is_completed(self):
        from ludora.store_discovery_supervisor import StoreChildFailed, run_store_in_child

        frame = {'event':'item_discovery.browser.started','run_id':'batch:12','store_id':12,
                 'phase':'fetch','url':'https://example.mx/products/x','fetch_id':'fetch-1'}
        script = f"import json,sys,time; json.loads(sys.stdin.readline()); print('@@LUDORA_OPERATION_EVENT@@'+json.dumps({frame!r}),file=sys.stderr,flush=True); time.sleep(60)"
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            with self.assertRaises(StoreChildFailed):
                run_store_in_child(
                    database_url="unused", current_env={}, store_id=12, website_url="https://example.mx/",
                    platform="custom", store_name="Example", env_file=".env", run_id="batch:12",
                    product_request_throttle=ProductDiscoveryRequestThrottle(),
                    worker_command=[sys.executable, "-c", script], store_stall_seconds=0.25,
                )
        frames = [json.loads(line.split('@@LUDORA_OPERATION_EVENT@@', 1)[1])
                  for line in output.getvalue().splitlines() if '@@LUDORA_OPERATION_EVENT@@' in line]
        self.assertEqual([item['event'] for item in frames],
                         ['item_discovery.browser.started', 'item_discovery.browser.completed'])
        self.assertEqual(frames[0]['fetch_id'], frames[1]['fetch_id'])

    @unittest.skipUnless(os.name == "nt", "Windows fail-closed descendant limitation")
    def test_unreported_child_exit_is_cleanup_failure_on_windows(self):
        from ludora.store_discovery_supervisor import StoreChildCleanupFailed, run_store_in_child

        script = "import json,sys; json.loads(sys.stdin.readline()); sys.exit(3)"
        with self.assertRaises(StoreChildCleanupFailed):
            run_store_in_child(
                database_url="unused", current_env={}, store_id=12, website_url="https://example.mx/",
                platform="custom", store_name="Example", env_file=".env", run_id="batch:12",
                product_request_throttle=ProductDiscoveryRequestThrottle(),
                worker_command=[sys.executable, "-c", script], store_stall_seconds=2,
            )
