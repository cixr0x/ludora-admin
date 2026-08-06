from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

from ludora.cancellation import CancellationToken, raise_if_cancelled


MINIMUM_PRODUCT_DISCOVERY_INTERVAL_SECONDS = 3.0
ThrottleWaiter = Callable[[float, CancellationToken | None], None]


def wait_for_discovery_delay(
    delay_seconds: float,
    cancellation_token: CancellationToken | None,
) -> None:
    deadline = time.monotonic() + max(0.0, delay_seconds)
    while True:
        raise_if_cancelled(cancellation_token)
        remaining = deadline - time.monotonic()
        if remaining <= 0.0:
            return
        time.sleep(min(1.0, remaining))


@dataclass(frozen=True)
class ProductDiscoveryThrottleWait:
    delay_seconds: float


class ProductDiscoveryRequestThrottle:
    def __init__(
        self,
        *,
        minimum_interval_seconds: float = MINIMUM_PRODUCT_DISCOVERY_INTERVAL_SECONDS,
        clock: Callable[[], float] | None = None,
        waiter: ThrottleWaiter | None = None,
    ) -> None:
        self.minimum_interval_seconds = max(
            MINIMUM_PRODUCT_DISCOVERY_INTERVAL_SECONDS,
            float(minimum_interval_seconds),
        )
        self._clock = clock or time.monotonic
        self._waiter = waiter or wait_for_discovery_delay
        self._next_request_at = 0.0

    def wait_before_request(
        self,
        cancellation_token: CancellationToken | None = None,
        *,
        on_wait: Callable[[ProductDiscoveryThrottleWait], None] | None = None,
    ) -> ProductDiscoveryThrottleWait:
        raise_if_cancelled(cancellation_token)
        delay_seconds = max(0.0, self._next_request_at - self._clock())
        wait = ProductDiscoveryThrottleWait(delay_seconds=delay_seconds)
        if delay_seconds > 0.0:
            if on_wait is not None:
                on_wait(wait)
            self._waiter(delay_seconds, cancellation_token)
        raise_if_cancelled(cancellation_token)
        self._next_request_at = self._clock() + self.minimum_interval_seconds
        return wait
