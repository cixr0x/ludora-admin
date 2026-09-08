"""Small stderr watchdog protocol, independent of database trace writes."""
from __future__ import annotations

import json
import os
import sys
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from urllib.parse import urlsplit, urlunsplit

_scope: ContextVar[dict | None] = ContextVar('discovery_browser_scope', default=None)
_active: ContextVar[bool] = ContextVar('discovery_browser_active', default=False)


@contextmanager
def discovery_browser_scope(run_id: str, store_id: int, website_url: str):
    token = _scope.set({'run_id': run_id, 'store_id': store_id, 'url': website_url})
    try:
        yield
    finally:
        _scope.reset(token)


@contextmanager
def browser_watchdog_scope(url: str | None = None, *, phase: str = 'fetch'):
    scope = _scope.get()
    if scope is None or _active.get() or os.environ.get('LUDORA_DISCOVERY_BROWSER_WATCHDOG') != '1':
        yield
        return
    parsed = urlsplit(url or scope['url'])
    # Product identity is useful; credentials, signed query strings and fragments are not.
    host = parsed.netloc.rsplit('@', 1)[-1]
    safe_url = urlunsplit((parsed.scheme, host, parsed.path, '', ''))[:2048]
    fields = {**scope, 'url': safe_url, 'phase': phase, 'fetch_id': str(uuid.uuid4())}
    token = _active.set(True)
    try:
        _emit('started', fields)
        try:
            yield
        finally:
            _emit('completed', fields)
    finally:
        _active.reset(token)


def _emit(event: str, fields: dict) -> None:
    payload = json.dumps({'event': f'item_discovery.browser.{event}', **fields}, separators=(',', ':'))
    print(f'@@LUDORA_OPERATION_EVENT@@{payload}', file=sys.stderr, flush=True)
