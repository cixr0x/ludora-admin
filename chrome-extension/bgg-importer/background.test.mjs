import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const scripts = {};
for (const name of ['routes.js', 'background.js']) {
  scripts[name] = await readFile(new URL(name, import.meta.url), 'utf8');
}

const api = 'https://admin.ludora.bobbycrimson.com/api';
const sender = {
  id: 'extension-id',
  frameId: 0,
  tab: { id: 6, url: 'https://boardgamegeek.com/boardgame/13/catan' },
  origin: 'https://boardgamegeek.com',
  url: 'https://boardgamegeek.com/boardgame/13/catan'
};

const item = {
  id: '91',
  canonical_name: 'Catan',
  normalized_name: 'catan',
  canonical_name_es: ' Catán ',
  normalized_name_es: 'catan',
  item_type: 'base_game',
  parent_item_id: null,
  bgg_id: 13,
  bgg_url: sender.url,
  year_published: 1995,
  description: ' Build a settlement. ',
  description_es: '',
  min_players: 3,
  max_players: 4,
  min_minutes: 60,
  max_minutes: 120,
  complexity: null,
  rating: '7.14',
  weight: '2.29',
  min_age: 10,
  image_url: 'https://images.example/catan.jpg',
  image_url_es: '',
  status: 'active'
};

test('imports the sender BGG ID, generates Spanish text and updates the fresh item record', async () => {
  const latest = { ...item, image_url_es: 'https://images.example/spanish.jpg', min_age: 12 };
  const harness = createHarness([
    data(item),
    data([{ description: ' ' }, { description: ' Record from a store. ' }]),
    data({ description_es: ' Construye un poblado. ' }),
    data(latest),
    data({ ...latest, description_es: 'Construye un poblado.' })
  ]);
  const result = await harness.send(sender, { type: 'import-bgg-item', bggId: 13, bgg_id: 500, url: 'https://example.org' });

  assert.deepEqual(result, { status: 'saved', itemId: '91' });
  assert.deepEqual(harness.requests, [
    { method: 'POST', url: api + '/items/import-from-bgg', body: { bgg_id: 13 } },
    { method: 'GET', url: api + '/items/91/store-items', body: undefined },
    {
      method: 'POST',
      url: api + '/admin/description-generations',
      body: { boardgame_name: 'Catán', description_1: 'Build a settlement.', description_2: 'Record from a store.' }
    },
    { method: 'GET', url: api + '/items/91', body: undefined },
    { method: 'PATCH', url: api + '/items/91', body: { ...latest, description_es: 'Construye un poblado.' } }
  ]);
  assert.equal(harness.activeIntervals, 0);
});

test('preserves a Spanish description returned by the import', async () => {
  const harness = createHarness([data({ ...item, description_es: 'Ya traducido.' })]);
  assert.deepEqual(await harness.send(sender), { status: 'already-translated', itemId: '91' });
  assert.equal(harness.requests.length, 1);
});

test('preserves a Spanish description saved while generation was in progress', async () => {
  const harness = createHarness([
    data({ ...item, id: 91 }),
    data([]),
    data({ description_es: 'Texto generado.' }),
    data({ ...item, description_es: 'Editado por un usuario.' })
  ]);
  assert.deepEqual(await harness.send(sender), { status: 'already-translated', itemId: '91' });
  assert.deepEqual(harness.requests.map(({ method }) => method), ['POST', 'GET', 'POST', 'GET']);
});

test('uses the first nonblank linked store description when the imported description is blank', async () => {
  const harness = createHarness([
    data({ ...item, canonical_name_es: ' ', description: '\t' }),
    data([{ description: ' ' }, { description: ' Build roads. ' }, { description: 'Other text.' }]),
    data({ description_es: 'Construye caminos.' }),
    data(item),
    data({ ...item, description_es: 'Construye caminos.' })
  ]);
  assert.deepEqual(await harness.send(sender), { status: 'saved', itemId: '91' });
  assert.deepEqual(harness.requests.slice(1, 3), [
    { method: 'GET', url: api + '/items/91/store-items', body: undefined },
    {
      method: 'POST',
      url: api + '/admin/description-generations',
      body: { boardgame_name: 'Catan', description_1: '', description_2: 'Build roads.' }
    }
  ]);
});

test('continues with the BGG source when the linked store lookup fails without an auth error', async () => {
  const harness = createHarness([
    data(item),
    new Response(null, { status: 503 }),
    data({ description_es: 'Construye un poblado.' }),
    data(item),
    data({ ...item, description_es: 'Construye un poblado.' })
  ]);
  assert.deepEqual(await harness.send(sender), { status: 'saved', itemId: '91' });
  assert.deepEqual(harness.requests.slice(1, 3), [
    { method: 'GET', url: api + '/items/91/store-items', body: undefined },
    {
      method: 'POST',
      url: api + '/admin/description-generations',
      body: { boardgame_name: 'Catán', description_1: 'Build a settlement.', description_2: '' }
    }
  ]);
});

test('reports a partial failure if a failed store lookup leaves no BGG source', async () => {
  const harness = createHarness([data({ ...item, description: '' }), new Response(null, { status: 503 })]);
  assert.deepEqual(await harness.send(sender), { status: 'description-failed', itemId: '91' });
  assert.equal(harness.requests.length, 2);
});

test('reports a partial import with no source description', async () => {
  const harness = createHarness([data({ ...item, description: null }), data([{ description: ' ' }])]);
  assert.deepEqual(await harness.send(sender), { status: 'no-source', itemId: '91' });
  assert.equal(harness.requests.length, 2);
});

test('reports authorization failure without forwarding the response body', async () => {
  const denied = () => Response.json({ error: { message: 'Private error text' } }, { status: 401 });
  const importDenied = createHarness([denied()]);
  assert.deepEqual(await importDenied.send(sender), { status: 'sign-in' });
  const storesDenied = createHarness([data(item), denied()]);
  assert.deepEqual(await storesDenied.send(sender), { status: 'sign-in', itemId: '91' });
  assert.equal(storesDenied.requests.length, 2);
  const saveDenied = createHarness([data(item), data([]), data({ description_es: 'Texto válido.' }), data(item), denied()]);
  assert.deepEqual(await saveDenied.send(sender), { status: 'sign-in', itemId: '91' });
  assert.equal(saveDenied.activeIntervals, 0);
});

test('reports an import failure without attempting to generate a description', async () => {
  const harness = createHarness([new Response('Private error text', { status: 500 })]);
  assert.deepEqual(await harness.send(sender), { status: 'import-failed' });
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.activeIntervals, 0);
});

test('does not save blank generated text or patch an incomplete fresh record', async () => {
  const blank = createHarness([data(item), data([]), data({ description_es: '  ' })]);
  assert.deepEqual(await blank.send(sender), { status: 'description-failed', itemId: '91' });
  assert.equal(blank.requests.length, 3);

  const incomplete = createHarness([
    data(item), data([]), data({ description_es: 'Texto válido.' }), data({ id: '91', canonical_name: 'Catan' })
  ]);
  assert.deepEqual(await incomplete.send(sender), { status: 'description-failed', itemId: '91' });
  assert.equal(incomplete.requests.length, 4);
});

test('a failed save remains a partial import and stops the worker heartbeat', async () => {
  const harness = createHarness([
    data(item),
    data([]),
    data({ description_es: 'Texto válido.' }),
    data(item),
    new Response('Private error text', { status: 503 })
  ]);
  assert.deepEqual(await harness.send(sender), { status: 'description-failed', itemId: '91' });
  assert.equal(harness.activeIntervals, 0);
});

test('uses one import workflow for the same in-flight BGG ID across tabs', async () => {
  const harness = createHarness([data({ ...item, description_es: 'Ya traducido.' })]);
  const first = harness.send(sender);
  const second = harness.send({ ...sender, tab: { id: 7, url: sender.tab.url } });
  assert.equal(harness.activeIntervals, 1);
  assert.deepEqual(await Promise.all([first, second]), [
    { status: 'already-translated', itemId: '91' },
    { status: 'already-translated', itemId: '91' }
  ]);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.activeIntervals, 0);
});

test('imports the current tab route when the original document path has gone stale', async () => {
  const harness = createHarness([data({ ...item, description_es: 'Ya traducido.' })]);
  const source = { ...sender, url: 'https://boardgamegeek.com/browse/boardgame' };
  assert.deepEqual(await harness.send(source), { status: 'already-translated', itemId: '91' });
  assert.deepEqual(harness.requests[0].body, { bgg_id: 13 });
});

test('rejects a click if the tab moved to another item before delivery', async () => {
  const harness = createHarness([]);
  const source = { ...sender, tab: { ...sender.tab, url: 'https://boardgamegeek.com/boardgame/14' } };
  assert.deepEqual(await harness.send(source), { status: 'unsupported' });
  assert.deepEqual(harness.requests, []);
});

test('accepts only supported routes from top-level Geek tabs', async () => {
  const supported = [
    ['https://boardgamegeek.com/boardgame/13', 13],
    ['https://www.boardgamegeek.com/boardgameexpansion/343/slug?sort=name', 343],
    ['https://www.boardgamegeek.com/boardgameaccessory/443/slug/credits#item', 443],
    ['https://boardgamegeek.com/rpgitem/540/', 540],
    ['https://rpggeek.com/rpgitem/541/slug', 541],
    ['https://www.rpggeek.com/rpgitem/542', 542]
  ];
  for (const [url, id] of supported) {
    const harness = createHarness([data({ ...item, description_es: 'Ya traducido.' })]);
    await harness.send(
      { ...sender, tab: { ...sender.tab, url }, origin: new URL(url).origin },
      { type: 'import-bgg-item', bggId: id }
    );
    assert.deepEqual(harness.requests[0].body, { bgg_id: id }, url);
  }

  const invalidSenders = [
    { frameId: 1 },
    { id: 'other-extension' },
    { tab: undefined },
    { tab: { id: 6 } },
    { origin: undefined },
    { origin: 'https://www.boardgamegeek.com' }
  ];
  const invalidUrls = [
    'https://rpggeek.com/boardgame/13',
    'https://boardgamegeek.com/geeksearch.php?action=search',
    'https://boardgamegeek.com/forum/13/boardgamegeek',
    'https://boardgamegeek.com/boardgame/0',
    'https://www.boardgamegeek.com/boardgame/-13',
    'https://www.boardgamegeek.com/boardgame/13a',
    'https://rpggeek.com/rpgitem/9007199254740992',
    'https://boardgamegeek.com.example.org/boardgame/13',
    'https://boardgamegeek.com:444/boardgame/13',
    'http://boardgamegeek.com/boardgame/13'
  ];
  for (const url of invalidUrls) {
    invalidSenders.push({ tab: { ...sender.tab, url }, origin: new URL(url).origin });
  }
  for (const overrides of invalidSenders) {
    const harness = createHarness([]);
    assert.deepEqual(await harness.send({ ...sender, ...overrides }), { status: 'unsupported' });
    assert.deepEqual(harness.requests, []);
  }
});

function createHarness(responses) {
  const requests = [];
  const intervals = new Set();
  let listener;
  const context = vm.createContext({
    URL,
    AbortSignal,
    setInterval(callback, delay) {
      assert.ok(delay > 0 && delay < 30_000);
      const interval = { callback, delay };
      intervals.add(interval);
      return interval;
    },
    clearInterval(interval) {
      intervals.delete(interval);
    },
    importScripts(name) {
      vm.runInContext(scripts[name], context, { filename: name });
    },
    chrome: {
      runtime: {
        id: 'extension-id',
        getPlatformInfo: async () => ({ os: 'win' }),
        onMessage: { addListener(value) { listener = value; } }
      }
    },
    fetch: async (url, options) => {
      assert.equal(options.credentials, 'include');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      requests.push({ method: options.method, url: String(url), body: options.body && JSON.parse(options.body) });
      assert.ok(responses.length, 'no unexpected API request');
      return responses.shift();
    }
  });
  vm.runInContext(scripts['background.js'], context, { filename: 'background.js' });

  return {
    requests,
    get activeIntervals() { return intervals.size; },
    send(source, message = { type: 'import-bgg-item', bggId: 13 }) {
      return new Promise((resolve, reject) => {
        let responded = false;
        const retainChannel = listener(message, source, (result) => {
          responded = true;
          resolve(JSON.parse(JSON.stringify(result)));
        });
        if (!responded && retainChannel !== true) reject(new Error('The listener did not respond'));
      });
    }
  };
}

function data(value) {
  return Response.json({ data: value });
}

test('version imports route through the version endpoint with parent and description', async () => {
  const url = 'https://boardgamegeek.com/boardgameversion/350656/english-deluxe-edition';
  const versionSender = { ...sender, url, tab: { ...sender.tab, url } };
  const harness = createHarness([data({ ...item, description_es: 'Traducido.' })]);
  const message = { type: 'import-bgg-version', bggId: 350656, parentBggId: 220368, description: 'Foil cards.' };
  assert.deepEqual(await harness.send(versionSender, message), { status: 'already-translated', itemId: '91' });
  assert.deepEqual(harness.requests, [{
    method: 'POST',
    url: api + '/items/import-bgg-version',
    body: { parent_bgg_id: 220368, version_bgg_id: 350656, description: 'Foil cards.' }
  }]);
});

test('a normal item page cannot send a version import even with the same numeric ID', async () => {
  const harness = createHarness([]);
  assert.deepEqual(await harness.send(sender, { type: 'import-bgg-version', bggId: 13, parentBggId: 42 }), { status: 'unsupported' });
  assert.deepEqual(harness.requests, []);
});
