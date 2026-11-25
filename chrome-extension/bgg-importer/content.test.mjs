import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const routes = await readFile(new URL('./routes.js', import.meta.url), 'utf8');
const content = await readFile(new URL('./content.js', import.meta.url), 'utf8');
const itemPage = 'https://boardgamegeek.com/boardgame/13/catan';

test('sends the visible item ID on a genuine click and prevents duplicate clicks while busy', async () => {
  const harness = createHarness(itemPage);
  const button = harness.button;
  assert.equal(button.textContent, 'Import to Ludoradar');
  await harness.click(false);
  assert.deepEqual(harness.messages, []);
  const click = harness.click(true);
  await harness.click(true);
  assert.deepEqual(harness.messages, [{ type: 'import-bgg-item', bggId: 13 }]);
  assert.equal(button.disabled, true);
  harness.finish({ status: 'saved', itemId: '91' });
  await click;
  assert.equal(harness.status.children[0].href, 'https://admin.ludora.bobbycrimson.com/#items?id=91');
});

test('adds and removes the control as route changes cross item and non-item pages', () => {
  const harness = createHarness('https://boardgamegeek.com/browse/boardgame');
  assert.equal(harness.button, undefined);
  harness.navigate(itemPage);
  assert.equal(harness.button.textContent, 'Import to Ludoradar');
  const button = harness.button;
  harness.navigate(itemPage + '#ratings');
  assert.equal(harness.button, button);
  harness.navigate('https://boardgamegeek.com/browse/boardgame');
  assert.equal(harness.button, undefined);
});

test('never shows a previous import result after navigating to a different item', async () => {
  const harness = createHarness(itemPage);
  const click = harness.click(true);
  harness.navigate('https://boardgamegeek.com/boardgame/14/another-game');
  harness.finish({ status: 'saved', itemId: '91' });
  await click;
  assert.equal(harness.button.textContent, 'Import to Ludoradar');
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.status.hidden, true);
});

test('a partial authentication failure supplies the sign-in link and enables retry', async () => {
  const harness = createHarness(itemPage);
  const click = harness.click(true);
  harness.finish({ status: 'sign-in', itemId: '91' });
  await click;
  assert.match(harness.status.textContent, /imported/i);
  assert.equal(harness.status.children[0].href, 'https://admin.ludora.bobbycrimson.com/');
  assert.equal(harness.button.disabled, false);
  assert.match(harness.button.textContent, /retry/i);
});

function createHarness(url, main = null) {
  const body = new Element();
  const navigation = new EventTarget();
  const location = { href: url };
  const messages = [];
  let respond;
  const context = vm.createContext({
    URL,
    navigation,
    location,
    document: { documentElement: body, createElement: () => new Element(), querySelector: () => main },
    CSSStyleSheet: class { replaceSync() {} },
    chrome: {
      runtime: {
        sendMessage(message) {
          messages.push(JSON.parse(JSON.stringify(message)));
          return new Promise((resolve) => { respond = resolve; });
        }
      }
    }
  });
  vm.runInContext(routes, context);
  vm.runInContext(content, context);
  return {
    messages,
    get button() { return body.children[0]?.shadow.children[0]; },
    get status() { return body.children[0]?.shadow.children[1]; },
    click(isTrusted) { return this.button.listeners.get('click')({ isTrusted, stopPropagation() {} }); },
    finish(result) { respond(result); },
    navigate(href) {
      location.href = href;
      navigation.dispatchEvent(new Event('currententrychange'));
    }
  };
}

class Element {
  children = [];
  listeners = new Map();
  disabled = false;
  hidden = false;
  textContent = '';

  append(...children) {
    for (const child of children) {
      if (typeof child === 'string') {
        this.textContent += child;
      } else {
        child.parent = this;
        this.children.push(child);
      }
    }
  }

  remove() {
    this.parent.children = this.parent.children.filter((child) => child !== this);
  }

  attachShadow({ mode }) {
    assert.equal(mode, 'closed');
    this.shadow = new Element();
    return this.shadow;
  }

  addEventListener(name, callback) { this.listeners.set(name, callback); }

  setAttribute() {}
}

test('an edition route with a missing parent keeps the import from being sent', async () => {
  const editionPage = 'https://boardgamegeek.com/boardgameversion/13/example-edition';
  const harness = createHarness(itemPage);
  const itemButton = harness.button;
  harness.navigate(editionPage);
  assert.notEqual(harness.button, itemButton);
  await harness.click(true);
  assert.deepEqual(harness.messages, []);
  assert.match(harness.status.textContent, /parent game could not be identified/i);
});

test('extracts the parent and edition text from the BGG version module', () => {
  const descriptionAnchor = (innerText) => ({
    pathname: '/wiki/edit/version:350656',
    closest: () => ({
      closest: () => ({ parentElement: { closest: () => ({ rows: [{}, { cells: [{
        querySelector: () => ({ innerText })
      }] }] }) } })
    })
  });
  const edit = descriptionAnchor('Foil cards and special box.');
  const parent = { href: 'https://boardgamegeek.com/boardgame/220368/sword-of-fellows' };
  const row = { cells: [{ textContent: 'Board Game' }, { querySelectorAll: () => [parent] }] };
  const main = { querySelectorAll: (selector) => selector === 'tr' ? [row] : [edit] };
  const context = vm.createContext({ URL });
  vm.runInContext(routes, context);
  const version = context.readGeekVersionDetails(main, 350656);
  assert.deepEqual(JSON.parse(JSON.stringify(version)), { parentBggId: 220368, description: 'Foil cards and special box.' });
  const noParent = { querySelectorAll: (selector) => selector === 'tr' ? [] : [edit] };
  assert.equal(context.readGeekVersionDetails(noParent, 350656), null);
  const placeholder = descriptionAnchor('This page does not exist. You can edit this page to create it.');
  const noDescription = { querySelectorAll: (selector) => selector === 'tr' ? [row] : [placeholder] };
  assert.deepEqual(JSON.parse(JSON.stringify(context.readGeekVersionDetails(noDescription, 350656))), { parentBggId: 220368, description: '' });
});
