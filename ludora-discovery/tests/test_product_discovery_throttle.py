import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.cancellation import CancellationToken, OperationCancelled, raise_if_cancelled
from ludora.product_discovery_throttle import ProductDiscoveryRequestThrottle


class FakeClock:
    def __init__(self):
        self.now = 100.0
        self.waits: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def wait(self, seconds: float, cancellation_token: CancellationToken | None) -> None:
        raise_if_cancelled(cancellation_token)
        self.waits.append(seconds)
        self.now += seconds


class ProductDiscoveryRequestThrottleTests(unittest.TestCase):
    def test_spaces_request_starts_globally_by_at_least_three_seconds(self):
        clock = FakeClock()
        throttle = ProductDiscoveryRequestThrottle(clock=clock.monotonic, waiter=clock.wait)

        first = throttle.wait_before_request()
        second = throttle.wait_before_request()
        clock.now += 1.25
        third = throttle.wait_before_request()

        self.assertEqual(first.delay_seconds, 0.0)
        self.assertEqual(second.delay_seconds, 3.0)
        self.assertEqual(third.delay_seconds, 1.75)
        self.assertEqual(clock.waits, [3.0, 1.75])

    def test_allows_next_request_immediately_when_previous_request_took_over_three_seconds(self):
        clock = FakeClock()
        throttle = ProductDiscoveryRequestThrottle(clock=clock.monotonic, waiter=clock.wait)

        throttle.wait_before_request()
        clock.now += 3.01
        next_request = throttle.wait_before_request()

        self.assertEqual(next_request.delay_seconds, 0.0)
        self.assertEqual(clock.waits, [])

    def test_clamps_shorter_configured_interval_to_three_seconds(self):
        clock = FakeClock()
        throttle = ProductDiscoveryRequestThrottle(
            minimum_interval_seconds=0.5,
            clock=clock.monotonic,
            waiter=clock.wait,
        )

        throttle.wait_before_request()
        second = throttle.wait_before_request()

        self.assertEqual(second.delay_seconds, 3.0)
        self.assertEqual(clock.waits, [3.0])

    def test_cancellation_during_wait_does_not_advance_next_request_start(self):
        clock = FakeClock()
        waiter_calls = 0

        def cancelling_waiter(seconds: float, token: CancellationToken | None) -> None:
            nonlocal waiter_calls
            waiter_calls += 1
            if waiter_calls == 1:
                self.assertEqual(seconds, 3.0)
                self.assertIsNotNone(token)
                token.cancel()
                raise_if_cancelled(token)
            clock.wait(seconds, token)

        throttle = ProductDiscoveryRequestThrottle(
            clock=clock.monotonic,
            waiter=cancelling_waiter,
        )
        throttle.wait_before_request()

        cancelled_token = CancellationToken()
        with self.assertRaises(OperationCancelled):
            throttle.wait_before_request(cancelled_token)

        subsequent = throttle.wait_before_request(CancellationToken())
        self.assertEqual(subsequent.delay_seconds, 3.0)
        self.assertEqual(clock.waits, [3.0])


if __name__ == "__main__":
    unittest.main()
