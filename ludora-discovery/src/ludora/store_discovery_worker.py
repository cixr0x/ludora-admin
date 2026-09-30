"""One batch store in an isolated process with parent-owned throttle RPC."""
from __future__ import annotations

import json
import signal
import sys

from ludora.cancellation import CancellationToken
from ludora.operations import _run_item_discovery_for_store
from ludora.product_discovery_throttle import ProductDiscoveryThrottleWait


class _RemoteProductThrottle:
    def wait_before_request(self, cancellation_token=None, *, on_wait=None):
        # Only the coordinator owns throttle state, including between stores.
        print(json.dumps({"kind": "throttle"}), flush=True)
        response = json.loads(sys.stdin.readline())
        if response.get("command") != "permit":
            raise RuntimeError("Batch coordinator did not grant product request")
        wait = ProductDiscoveryThrottleWait(float(response.get("delay_seconds", 0)))
        if on_wait is not None and wait.delay_seconds > 0:
            on_wait(wait)
        if cancellation_token is not None:
            cancellation_token.raise_if_cancelled()
        return wait


def main() -> int:
    token = CancellationToken()
    signal.signal(signal.SIGINT, lambda *_: token.cancel())
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, lambda *_: token.cancel())
    configuration = json.loads(sys.stdin.readline())
    try:
        result = _run_item_discovery_for_store(
            **configuration, cancellation_token=token,
            product_request_throttle=_RemoteProductThrottle(),
        )
        print(json.dumps({"kind": "result", "value": result.to_dict()}), flush=True)
        return 0
    except Exception as exc:
        print(json.dumps({"kind": "error", "error": str(exc)[:2000],
                          "error_type": type(exc).__name__}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
