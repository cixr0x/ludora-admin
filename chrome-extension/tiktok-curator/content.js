(function () {
  const ROOT_ID = 'ludora-tiktok-curator-root';
  let currentItem = null;

  if (document.getElementById(ROOT_ID)) {
    return;
  }

  const root = document.createElement('aside');
  root.id = ROOT_ID;
  root.className = 'ludora-tiktok-curator';
  root.innerHTML = `
    <div class="ludora-tiktok-curator__header">
      <span>Ludora TikTok</span>
      <button class="ludora-tiktok-curator__close" type="button" title="Hide">×</button>
    </div>
    <div class="ludora-tiktok-curator__body">
      <div class="ludora-tiktok-curator__item" data-role="item">
        <span class="ludora-tiktok-curator__item-name">No item loaded</span>
        <span class="ludora-tiktok-curator__item-meta">Load the next catalog item to curate.</span>
      </div>
      <div class="ludora-tiktok-curator__actions">
        <button type="button" data-action="load-next">Load next</button>
        <button type="button" data-action="skip-item" disabled>Skip item</button>
        <button type="button" data-action="open-search" disabled>Search</button>
        <button class="ludora-tiktok-curator__primary" type="button" data-action="save-video" disabled>Save current video</button>
      </div>
      <div class="ludora-tiktok-curator__status" data-role="status"></div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const itemNode = root.querySelector('[data-role="item"]');
  const statusNode = root.querySelector('[data-role="status"]');
  const loadNextButton = root.querySelector('[data-action="load-next"]');
  const skipItemButton = root.querySelector('[data-action="skip-item"]');
  const openSearchButton = root.querySelector('[data-action="open-search"]');
  const saveVideoButton = root.querySelector('[data-action="save-video"]');

  root.querySelector('.ludora-tiktok-curator__close')?.addEventListener('click', () => root.remove());
  loadNextButton?.addEventListener('click', () => loadNextItem());
  skipItemButton?.addEventListener('click', () => skipCurrentItem());
  openSearchButton?.addEventListener('click', () => openTikTokSearch());
  saveVideoButton?.addEventListener('click', () => saveCurrentVideo());

  restoreState();
  render();

  async function restoreState() {
    try {
      const state = await sendMessage({ type: 'getState' });
      currentItem = state.currentItem || null;
      render();
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function loadNextItem() {
    setStatus('Loading next item...');
    setBusy(true);
    try {
      const state = await sendMessage({ type: 'loadNextItem' });
      currentItem = state.currentItem || null;
      if (!currentItem) {
        setStatus('No remaining items without TikTok candidates.', 'success');
      } else {
        setStatus('Item loaded.', 'success');
      }
      render();
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function skipCurrentItem() {
    if (!currentItem) {
      setStatus('Load an item before skipping.', 'error');
      return;
    }

    setStatus('Skipping item...');
    setBusy(true);
    try {
      const state = await sendMessage({
        type: 'skipCurrentItem',
        itemId: currentItem.id
      });
      currentItem = state.currentItem || null;
      if (!currentItem) {
        setStatus('Skipped. No remaining items without TikTok candidates.', 'success');
      } else {
        setStatus('Skipped. Next item loaded.', 'success');
      }
      render();
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function openTikTokSearch() {
    if (!currentItem) {
      setStatus('Load an item first.', 'error');
      return;
    }

    window.location.href = `https://www.tiktok.com/search/video?q=${encodeURIComponent(searchQuery(currentItem))}`;
  }

  async function saveCurrentVideo() {
    if (!currentItem) {
      setStatus('Load an item before saving a video.', 'error');
      return;
    }

    const video = extractCurrentTikTokVideo();
    if (!video) {
      setStatus('Open a TikTok video page before saving.', 'error');
      return;
    }

    setStatus('Saving video...');
    setBusy(true);
    try {
      const saved = await sendMessage({
        type: 'saveTutorialLink',
        itemId: currentItem.id,
        ...video
      });
      setStatus(`Saved candidate #${saved.id}.`, 'success');
      currentItem = null;
      render();
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function render() {
    if (!itemNode || !skipItemButton || !openSearchButton || !saveVideoButton) {
      return;
    }

    if (!currentItem) {
      itemNode.classList.add('ludora-tiktok-curator__item--empty');
      itemNode.innerHTML = `
        <span class="ludora-tiktok-curator__item-name">No item loaded</span>
        <span class="ludora-tiktok-curator__item-meta">Load the next catalog item to curate.</span>
      `;
      openSearchButton.disabled = true;
      skipItemButton.disabled = true;
      saveVideoButton.disabled = true;
      return;
    }

    const imageUrl = productImageUrl(currentItem);
    const description = productDescription(currentItem);
    itemNode.classList.remove('ludora-tiktok-curator__item--empty');
    itemNode.innerHTML = `
      ${
        imageUrl
          ? `<img class="ludora-tiktok-curator__image" data-role="item-image" src="${escapeHtml(imageUrl)}" alt="">`
          : '<span class="ludora-tiktok-curator__image-placeholder">No image</span>'
      }
      <div class="ludora-tiktok-curator__details">
        <span class="ludora-tiktok-curator__item-name">${escapeHtml(displayName(currentItem))}</span>
        <span class="ludora-tiktok-curator__item-meta">ID ${escapeHtml(String(currentItem.id))} - ${escapeHtml(currentItem.item_type || 'item')}</span>
        ${description ? `<p class="ludora-tiktok-curator__description">${escapeHtml(description)}</p>` : ''}
      </div>
    `;
    itemNode.querySelector('[data-role="item-image"]')?.addEventListener('error', (event) => {
      const placeholder = document.createElement('span');
      placeholder.className = 'ludora-tiktok-curator__image-placeholder';
      placeholder.textContent = 'No image';
      event.currentTarget.replaceWith(placeholder);
    });
    openSearchButton.disabled = false;
    skipItemButton.disabled = false;
    saveVideoButton.disabled = false;
  }

  function setBusy(isBusy) {
    [loadNextButton, skipItemButton, openSearchButton, saveVideoButton].forEach((button) => {
      if (button) {
        button.disabled = isBusy || (button !== loadNextButton && !currentItem);
      }
    });
  }

  function setStatus(message, tone = '') {
    if (!statusNode) {
      return;
    }
    statusNode.textContent = message;
    statusNode.dataset.tone = tone;
  }
})();

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || 'Extension request failed'));
        return;
      }
      resolve(response.data);
    });
  });
}

function extractCurrentTikTokVideo() {
  const identity = tiktokVideoIdentityFromUrl(window.location.href);
  if (!identity) {
    return null;
  }

  const caption = textFromSelector('[data-e2e="browse-video-desc"]') || textFromSelector('h1');
  const metaTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
  return {
    caption,
    title: cleanTitle(metaTitle) || caption,
    url: `https://www.tiktok.com/@${identity.user}/video/${identity.videoId}`
  };
}

function tiktokVideoIdentityFromUrl(value) {
  try {
    const parsed = new URL(value);
    if (!parsed.hostname.toLowerCase().endsWith('tiktok.com')) {
      return null;
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    const userIndex = parts.findIndex((part) => part.startsWith('@'));
    if (userIndex < 0 || parts[userIndex + 1] !== 'video') {
      return null;
    }

    const videoId = parts[userIndex + 2] || '';
    if (!/^\d+$/.test(videoId)) {
      return null;
    }

    return {
      user: parts[userIndex].replace(/^@/, ''),
      videoId
    };
  } catch {
    return null;
  }
}

function searchQuery(item) {
  const names = [];
  const spanishName = String(item.canonical_name_es || '').trim();
  const canonicalName = String(item.canonical_name || '').trim();
  if (spanishName) {
    names.push(spanishName);
  }
  if (canonicalName && normalizeName(canonicalName) !== normalizeName(spanishName)) {
    names.push(canonicalName);
  }
  if (names.length === 0) {
    names.push(String(item.id));
  }
  return `${names.join(' ')} juego de mesa como jugar tutorial`;
}

function displayName(item) {
  return item.canonical_name_es || item.canonical_name || `Item ${item.id}`;
}

function productImageUrl(item) {
  return String(item.image_url_es || item.image_url || '').trim();
}

function productDescription(item) {
  return String(item.description_es || item.description || '').trim();
}

function textFromSelector(selector) {
  return String(document.querySelector(selector)?.textContent || '').trim();
}

function cleanTitle(value) {
  return String(value || '').replace(/\s*\|\s*TikTok\s*$/i, '').trim();
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
