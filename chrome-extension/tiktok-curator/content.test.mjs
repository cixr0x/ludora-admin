import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const contentSource = await readFile(new URL('./content.js', import.meta.url), 'utf8');
const context = vm.createContext({
  document: {
    getElementById() {
      return {};
    }
  },
  URL
});
vm.runInContext(contentSource, context, { filename: 'content.js' });

test('keeps Spanish and English catalog names separately available to the panel', () => {
  const names = vm.runInContext(
    `localizedNames({ id: 77, canonical_name_es: 'Aventureros al Tren', canonical_name: 'Ticket to Ride' })`,
    context
  );

  assert.equal(names.spanish, 'Aventureros al Tren');
  assert.equal(names.english, 'Ticket to Ride');
});

test('uses an item fallback independently for a missing localized name', () => {
  const names = vm.runInContext(`localizedNames({ id: 88, canonical_name_es: '', canonical_name: 'Azul' })`, context);

  assert.equal(names.spanish, 'Item 88');
  assert.equal(names.english, 'Azul');
});
