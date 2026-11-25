importScripts('routes.js');

const adminApi = 'https://admin.ludora.bobbycrimson.com/api';
const signInRequired = Symbol('sign-in');
const importsInProgress = new Map();

// The item PATCH replaces all editable fields, so an incomplete snapshot is unsafe to save.
const editableItemFields = [
  'canonical_name', 'normalized_name', 'canonical_name_es', 'normalized_name_es',
  'item_type', 'parent_item_id', 'bgg_id', 'bgg_url', 'year_published',
  'description', 'description_es', 'min_players', 'max_players', 'min_minutes',
  'max_minutes', 'complexity', 'rating', 'weight', 'min_age', 'image_url', 'image_url_es', 'status'
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const isVersion = message?.type === 'import-bgg-version';
  if (!isVersion && message?.type !== 'import-bgg-item') return false;
  // Chrome can retain the original sender.url after a same-document navigation.
  const route = sender.id === chrome.runtime.id && sender.frameId === 0
    && Number.isInteger(sender.tab?.id) && typeof sender.origin === 'string'
    ? getGeekRoute(sender.tab.url, sender.origin)
    : null;
  if (!route || route.bggId !== message.bggId || route.isVersion !== isVersion ||
      (isVersion && (!Number.isSafeInteger(message.parentBggId) || message.parentBggId <= 0))) {
    sendResponse({ status: 'unsupported' });
    return false;
  }

  const importKey = isVersion ? `version:${route.bggId}` : `item:${route.bggId}`;
  const path = isVersion ? '/items/import-bgg-version' : '/items/import-from-bgg';
  const body = isVersion
    ? { parent_bgg_id: message.parentBggId, version_bgg_id: route.bggId, description: cleanText(message.description) }
    : { bgg_id: route.bggId };
  let operation = importsInProgress.get(importKey);
  if (!operation) {
    // Reset the Manifest V3 worker's idle timer only during the active import.
    const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
    operation = importItem(path, body).finally(() => {
      clearInterval(keepAlive);
      importsInProgress.delete(importKey);
    });
    importsInProgress.set(importKey, operation);
  }
  operation.then(sendResponse);
  return true;
});

async function importItem(path, body) {
  const signal = AbortSignal.timeout(240_000);
  let itemId;
  try {
    const item = await request(path, signal, { method: 'POST', body });
    itemId = internalItemId(item?.id);
    if (!itemId) throw new Error('Invalid imported item ID');
    if (cleanText(item.description_es)) return { status: 'already-translated', itemId };

    const name = cleanText(item.canonical_name_es) || cleanText(item.canonical_name);
    if (!name) throw new Error('Missing item name');
    const bggDescription = cleanText(item.description);
    let storeDescription = '';
    try {
      storeDescription = await readStoreDescription(itemId, signal);
    } catch (error) {
      if (error === signInRequired || !bggDescription) throw error;
    }
    if (!bggDescription && !storeDescription) return { status: 'no-source', itemId };

    const generated = await request('/admin/description-generations', signal, {
      method: 'POST',
      body: { boardgame_name: name, description_1: bggDescription, description_2: storeDescription }
    });
    const spanishDescription = cleanText(generated?.description_es);
    if (!spanishDescription) throw new Error('Empty generated description');

    const itemPath = `/items/${itemId}`;
    const latest = await request(itemPath, signal);
    if (internalItemId(latest?.id) !== itemId) throw new Error('Invalid item record');
    if (cleanText(latest.description_es)) return { status: 'already-translated', itemId };
    if (!cleanText(latest.canonical_name) || !editableItemFields.every((field) => Object.hasOwn(latest, field))) {
      throw new Error('Incomplete item record');
    }

    const saved = await request(itemPath, signal, {
      method: 'PATCH',
      body: { ...latest, description_es: spanishDescription }
    });
    if (internalItemId(saved?.id) !== itemId || cleanText(saved.description_es) !== spanishDescription) {
      throw new Error('Unexpected saved item');
    }
    return { status: 'saved', itemId };
  } catch (error) {
    if (error === signInRequired) {
      return itemId ? { status: 'sign-in', itemId } : { status: 'sign-in' };
    }
    return itemId ? { status: 'description-failed', itemId } : { status: 'import-failed' };
  }
}

async function readStoreDescription(itemId, signal) {
  const storeItems = await request(`/items/${itemId}/store-items`, signal);
  if (!Array.isArray(storeItems)) throw new Error('Invalid linked store items');
  for (const storeItem of storeItems) {
    const description = cleanText(storeItem?.description);
    if (description) return description;
  }
  return '';
}

async function request(path, signal, { method = 'GET', body } = {}) {
  const options = { method, credentials: 'include', redirect: 'error', cache: 'no-store', signal };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(adminApi + path, options);
  if (response.status === 401) throw signInRequired;
  if (!response.ok) throw new Error('Admin request failed');
  return (await response.json()).data;
}

function internalItemId(value) {
  if (typeof value === 'number') return value > 0 && Number.isSafeInteger(value) ? String(value) : null;
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}
