import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const backgroundSource = await readFile(new URL('./background.js', import.meta.url), 'utf8');

test('admin requests include the existing admin session cookie', async () => {
  const harness = createHarness({
    response: jsonResponse(200, { data: { id: 77 } })
  });

  const response = await harness.send({ type: 'loadNextItem' });

  assert.equal(response.ok, true);
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0].url, 'http://127.0.0.1:4001/admin/tutorial-curation/next');
  assert.equal(harness.fetchCalls[0].options.credentials, 'include');
});

test('authentication failures explain where to sign in', async () => {
  const harness = createHarness({
    response: jsonResponse(401, { error: { message: 'Authentication required' } })
  });

  const response = await harness.send({ type: 'loadNextItem' });

  assert.equal(response.ok, false);
  assert.equal(
    response.error,
    'Authentication required. Sign in to Ludora Admin at http://127.0.0.1:5173, then try again.'
  );
});

function createHarness({ response }) {
  const fetchCalls = [];
  const storage = {};
  let listener;
  const context = vm.createContext({
    URL,
    chrome: {
      runtime: {
        onMessage: {
          addListener(value) {
            listener = value;
          }
        }
      },
      storage: {
        local: {
          async get(defaults) {
            return { ...defaults, ...storage };
          },
          async set(values) {
            Object.assign(storage, values);
          }
        }
      }
    },
    fetch: async (url, options) => {
      fetchCalls.push({ options, url });
      return response;
    }
  });
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });

  return {
    fetchCalls,
    send(message) {
      return new Promise((resolve) => {
        assert.equal(listener(message, {}, resolve), true);
      });
    }
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}
