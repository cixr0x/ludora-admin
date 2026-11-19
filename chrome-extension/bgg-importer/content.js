(() => {
  const adminUrl = 'https://admin.ludora.bobbycrimson.com/';
  const defaultLabel = 'Import to Ludoradar';
  let activeId = null;
  let activeControl = null;

  const styles = new CSSStyleSheet();
  styles.replaceSync(`
    :host {
      all: initial !important;
      display: grid !important;
      justify-items: end !important;
      gap: 8px !important;
      position: fixed !important;
      right: 16px !important;
      bottom: 16px !important;
      max-width: calc(100vw - 32px) !important;
      z-index: 2147483647 !important;
      color: #152733 !important;
      font: 14px/1.45 system-ui, sans-serif !important;
    }
    button, p {
      box-sizing: border-box;
      border: 1px solid #627c88;
      border-radius: 8px;
      box-shadow: 0 3px 12px #15273330;
    }
    button {
      max-width: 100%;
      padding: 9px 13px;
      background: #143e50;
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-weight: 650;
    }
    button:hover:enabled { background: #245c70; }
    button:disabled { cursor: default; }
    button:focus-visible, a:focus-visible {
      outline: 2px solid #247587;
      outline-offset: 3px;
    }
    p {
      width: min(285px, calc(100vw - 32px));
      margin: 0;
      padding: 9px 12px;
      background: #fff;
    }
    a { color: #145d72; }
  `);

  function updateRoute() {
    const itemId = getGeekItemId(location.href);
    if (itemId === activeId) return;

    activeControl?.remove();
    activeId = itemId;
    activeControl = itemId === null ? null : createControl(itemId);
    if (activeControl) document.documentElement.append(activeControl);
  }

  function createControl(bggId) {
    const control = document.createElement('div');
    control.id = 'ludoradar-bgg-importer';
    const shadow = control.attachShadow({ mode: 'closed' });
    shadow.adoptedStyleSheets = [styles];

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = defaultLabel;
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.hidden = true;
    shadow.append(button, status);

    button.addEventListener('click', async (event) => {
      if (!event.isTrusted || button.disabled || getGeekItemId(location.href) !== bggId) return;
      event.stopPropagation();
      button.disabled = true;
      button.textContent = 'Importing…';
      status.hidden = false;
      status.textContent = 'Importing the item and checking its Spanish description…';

      let result;
      try {
        result = await chrome.runtime.sendMessage({ type: 'import-bgg-item', bggId });
      } catch {
        // Reloads and extension worker shutdowns can interrupt the response.
      }
      if (activeControl !== control || getGeekItemId(location.href) !== bggId) return;
      showOutcome(button, status, result);
    });
    return control;
  }

  function showOutcome(button, status, result) {
    const itemId = typeof result?.itemId === 'string' && /^[1-9]\d*$/.test(result.itemId) ? result.itemId : null;
    const itemUrl = itemId ? `${adminUrl}#items?id=${itemId}` : adminUrl;
    button.disabled = false;
    button.textContent = 'Retry import';

    switch (result?.status) {
      case 'saved':
      case 'already-translated':
        button.disabled = true;
        button.textContent = 'Imported';
        status.textContent = result.status === 'saved'
          ? 'Spanish description saved. '
          : 'Spanish description already exists. ';
        appendLink(status, itemUrl, 'Open in Admin');
        break;
      case 'sign-in':
        status.textContent = itemId ? 'Item imported. ' : '';
        appendLink(status, adminUrl, 'Sign in to Ludora Admin');
        status.append(', then retry.');
        break;
      case 'no-source':
        status.textContent = 'Item imported. Add a source description in Admin, then retry. ';
        appendLink(status, itemUrl, 'Open in Admin');
        break;
      case 'description-failed':
        status.textContent = 'Item imported. The Spanish description could not be saved. ';
        appendLink(status, itemUrl, 'Open in Admin');
        break;
      case 'import-failed':
        status.textContent = 'The import could not be confirmed. Try again.';
        break;
      default:
        status.textContent = 'Import status unavailable. Try again.';
    }
  }

  function appendLink(status, href, label) {
    const link = document.createElement('a');
    link.href = href;
    link.rel = 'noopener noreferrer';
    link.target = '_blank';
    link.textContent = label;
    status.append(link);
  }

  navigation.addEventListener('currententrychange', updateRoute);
  updateRoute();
})();
