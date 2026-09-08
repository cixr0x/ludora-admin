import io
import json
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

from ludora.browser_fetch import BrowserTextFetcher
from ludora.discovery_browser_lifecycle import discovery_browser_scope


class DiscoveryBrowserLifecycleTests(unittest.TestCase):
    def test_deadline_starts_before_new_page_and_ends_after_close(self):
        output = io.StringIO()
        steps = []
        event_counts_during_work = []

        def events():
            return [json.loads(line.split('@@LUDORA_OPERATION_EVENT@@')[1]) for line in output.getvalue().splitlines()]

        class Page:
            url = 'https://example.com/game/'

            def goto(self, *args, **kwargs):
                return None

            def content(self):
                steps.append('content')
                event_counts_during_work.append(len(events()))
                return '<html>game</html>'

            def close(self):
                steps.append('close')
                event_counts_during_work.append(len(events()))

        class Context:
            def new_page(self):
                steps.append('new_page')
                event_counts_during_work.append(len(events()))
                return Page()

        fetcher = BrowserTextFetcher()
        fetcher._context = Context()
        with patch.dict('os.environ', {'LUDORA_DISCOVERY_BROWSER_WATCHDOG': '1'}), redirect_stderr(output):
            with discovery_browser_scope('batch:17', 17, 'https://example.com/'):
                fetcher.fetch('https://user:secret@example.com/game/?token=secret#private')
        self.assertEqual(steps[0], 'new_page')
        self.assertEqual(steps[-1], 'close')
        self.assertIn('content', steps)
        self.assertTrue(event_counts_during_work)
        self.assertTrue(all(count == 1 for count in event_counts_during_work))
        self.assertEqual([event['event'] for event in events()], ['item_discovery.browser.started', 'item_discovery.browser.completed'])
        self.assertEqual(events()[0]['fetch_id'], events()[1]['fetch_id'])
        self.assertEqual(events()[0]['run_id'], 'batch:17')
        self.assertEqual(events()[0]['store_id'], 17)
        self.assertEqual(events()[0]['url'], 'https://example.com/game/')
        self.assertNotIn('secret', output.getvalue())

    def test_startup_and_teardown_are_also_guarded_and_unscoped_update_is_silent(self):
        output = io.StringIO()
        fetcher = BrowserTextFetcher()
        with patch.object(fetcher, '_start_browser'), patch.object(fetcher, '_stop_browser'):
            with patch.dict('os.environ', {'LUDORA_DISCOVERY_BROWSER_WATCHDOG': '1'}), redirect_stderr(output):
                with discovery_browser_scope('run', 17, 'https://example.com/'):
                    with fetcher:
                        pass
                with fetcher:
                    pass
        events = [json.loads(line.split('@@LUDORA_OPERATION_EVENT@@')[1]) for line in output.getvalue().splitlines()]
        self.assertEqual([event['phase'] for event in events], ['startup', 'startup', 'cleanup', 'cleanup'])

    def test_exception_in_new_page_still_completes_scope_without_changing_failure_classification(self):
        output = io.StringIO()
        fetcher = BrowserTextFetcher()
        class Context:
            def new_page(self):
                raise OSError('browser unavailable')
        fetcher._context = Context()
        with patch.dict('os.environ', {'LUDORA_DISCOVERY_BROWSER_WATCHDOG': '1'}), redirect_stderr(output):
            with discovery_browser_scope('run', 17, 'https://example.com/'):
                self.assertIsNone(fetcher.fetch('https://example.com/game'))
        self.assertEqual(len(output.getvalue().splitlines()), 2)
        self.assertEqual(fetcher.last_failure['error_type'], 'OSError')

    def test_session_reset_keeps_deadline_armed_during_context_close(self):
        output = io.StringIO()
        fetcher = BrowserTextFetcher()
        fetcher._browser = object()
        counts_during_close = []
        class Context:
            def close(self):
                counts_during_close.append(len(output.getvalue().splitlines()))
            def new_page(self):
                return object()
        fetcher._context = Context()
        with patch.dict('os.environ', {'LUDORA_DISCOVERY_BROWSER_WATCHDOG': '1'}), redirect_stderr(output):
            with discovery_browser_scope('run', 17, 'https://example.com/'):
                with patch.object(fetcher, '_create_context', return_value=Context()):
                    fetcher.reset_context()
        self.assertEqual(len(output.getvalue().splitlines()), 2)
        self.assertEqual(counts_during_close, [1])
