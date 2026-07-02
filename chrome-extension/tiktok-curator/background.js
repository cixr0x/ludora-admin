const DEFAULT_ADMIN_URL = 'http://127.0.0.1:4001';
const CURRENT_ITEM_KEY = 'currentItem';
const SKIPPED_ITEM_IDS_KEY = 'skippedItemIds';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function handleMessage(message) {
  if (!message || typeof message !== 'object') {
    throw new Error('Invalid extension message');
  }

  if (message.type === 'loadNextItem') {
    return loadNextItem();
  }

  if (message.type === 'getState') {
    const state = await readState();
    return {
      currentItem: state.currentItem,
      skippedItemIds: state.skippedItemIds
    };
  }

  if (message.type === 'skipCurrentItem') {
    const itemId = positiveInteger(message.itemId);
    if (!itemId) {
      throw new Error('Load an item before skipping');
    }
    const state = await readState();
    const skippedItemIds = [...new Set([...state.skippedItemIds, itemId])];
    await chrome.storage.local.set({
      [CURRENT_ITEM_KEY]: null,
      [SKIPPED_ITEM_IDS_KEY]: skippedItemIds
    });
    return loadNextItem();
  }

  if (message.type === 'saveTutorialLink') {
    const itemId = String(message.itemId || '').trim();
    if (!itemId) {
      throw new Error('Load an item before saving a video');
    }

    const saved = await adminFetch(`/admin/tutorial-curation/items/${encodeURIComponent(itemId)}/tutorial-links`, {
      method: 'POST',
      body: JSON.stringify({
        caption: message.caption || '',
        title: message.title || '',
        url: message.url || ''
      })
    });
    await chrome.storage.local.set({ [CURRENT_ITEM_KEY]: null });
    return saved;
  }

  throw new Error(`Unsupported extension message: ${message.type}`);
}

async function loadNextItem() {
  const state = await readState();
  const query = state.skippedItemIds.length > 0 ? `?exclude_item_ids=${state.skippedItemIds.join(',')}` : '';
  const item = await adminFetch(`/admin/tutorial-curation/next${query}`);
  await chrome.storage.local.set({ [CURRENT_ITEM_KEY]: item || null });
  return {
    currentItem: item || null,
    skippedItemIds: state.skippedItemIds
  };
}

async function readState() {
  const stored = await chrome.storage.local.get({
    [CURRENT_ITEM_KEY]: null,
    [SKIPPED_ITEM_IDS_KEY]: []
  });
  return {
    currentItem: stored[CURRENT_ITEM_KEY] || null,
    skippedItemIds: Array.isArray(stored[SKIPPED_ITEM_IDS_KEY])
      ? stored[SKIPPED_ITEM_IDS_KEY].map(positiveInteger).filter(Boolean)
      : []
  };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function adminFetch(path, options = {}) {
  const adminUrl = await readAdminUrl();
  const response = await fetch(`${adminUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Admin service returned ${response.status}`);
  }
  return payload.data;
}

async function readAdminUrl() {
  const stored = await chrome.storage.local.get({ adminUrl: DEFAULT_ADMIN_URL });
  return String(stored.adminUrl || DEFAULT_ADMIN_URL).trim() || DEFAULT_ADMIN_URL;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
