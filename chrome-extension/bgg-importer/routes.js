function getGeekRoute(address, expectedOrigin) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  if (expectedOrigin !== undefined && url.origin !== expectedOrigin) return null;

  const [, type, id] = url.pathname.split('/');
  switch (url.hostname) {
    case 'boardgamegeek.com':
    case 'www.boardgamegeek.com':
      if (!['boardgame', 'boardgameexpansion', 'boardgameaccessory', 'boardgameversion', 'rpgitem'].includes(type)) return null;
      break;
    case 'rpggeek.com':
    case 'www.rpggeek.com':
      if (type !== 'rpgitem') return null;
      break;
    default:
      return null;
  }

  if (!/^\d+$/.test(id)) return null;
  const bggId = Number(id);
  return bggId > 0 && Number.isSafeInteger(bggId) ? { bggId, type, isVersion: type === 'boardgameversion' } : null;
}

function readGeekVersionDetails(main, versionBggId) {
  if (!main) return null;

  const editionMarkers = [...main.querySelectorAll('a[href]')].map((link) => ({
    link,
    wikiId: link.pathname.match(/^\/wiki\/(?:edit|history)\/version:(\d+)\/?$/)?.[1],
    correctionId: link.pathname.match(/^\/item\/correction\/boardgameversion\/(\d+)\/?$/)?.[1]
  })).filter(({ wikiId, correctionId }) => wikiId || correctionId);
  if (!editionMarkers.length || editionMarkers.some(({ wikiId, correctionId }) =>
    Number(wikiId || correctionId) !== versionBggId
  )) return null;

  const parents = new Set();
  for (const row of main.querySelectorAll('tr')) {
    if (row.cells.length !== 2 || row.cells[0].textContent.trim() !== 'Board Game') continue;
    for (const link of row.cells[1].querySelectorAll('a[href]')) {
      const route = getGeekRoute(link.href);
      if (route && ['boardgame', 'boardgameexpansion', 'boardgameaccessory'].includes(route.type)) {
        parents.add(route.bggId);
      }
    }
  }
  if (parents.size !== 1) return null;

  const descriptionHeading = editionMarkers.find(({ wikiId }) => wikiId)?.link;
  const headingTable = descriptionHeading?.closest('tr')?.closest('table');
  const moduleTable = headingTable?.parentElement?.closest('table');
  const descriptionCell = moduleTable?.rows[1]?.cells[0];
  const text = descriptionCell?.querySelector('div')?.innerText?.trim() ?? '';
  const description = /^this page does not exist\b/i.test(text) ? '' : text;
  return { parentBggId: [...parents][0], description };
}
