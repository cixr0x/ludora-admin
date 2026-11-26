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
      if (!['boardgame', 'boardgameexpansion', 'boardgameaccessory', 'boardgameversion', 'bgaccessoryversion', 'rpgitem'].includes(type)) return null;
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
  return bggId > 0 && Number.isSafeInteger(bggId) ? { bggId, type, isVersion: type === 'boardgameversion' || type === 'bgaccessoryversion' } : null;
}

function readGeekVersionDetails(main, versionBggId, versionType = 'boardgameversion') {
  if (!main) return null;

  const editionMarkers = [...main.querySelectorAll('a[href]')].map((link) => ({
    link,
    wikiId: link.pathname.match(/^\/wiki\/(?:edit|history)\/version:(\d+)\/?$/)?.[1],
    correction: link.pathname.match(/^\/item\/correction\/(boardgameversion|bgaccessoryversion)\/(\d+)\/?$/)
  })).filter(({ wikiId, correction }) => wikiId || correction);
  if (!editionMarkers.length || editionMarkers.some(({ wikiId, correction }) =>
    Number(wikiId || correction?.[2]) !== versionBggId || (correction && correction[1] !== versionType)
  )) return null;

  const isAccessory = versionType === 'bgaccessoryversion';
  const parentLabel = isAccessory ? 'Accessory' : 'Board Game';
  const nicknameLabel = isAccessory ? 'Nickname' : 'Version Nickname';
  const parentTypes = isAccessory ? ['boardgameaccessory'] : ['boardgame', 'boardgameexpansion', 'boardgameaccessory'];
  const parents = new Set();
  const nicknames = new Set();
  for (const row of main.querySelectorAll('tr')) {
    if (row.cells.length !== 2) continue;

    const label = row.cells[0].textContent.trim();
    const value = row.cells[1];
    if (label === nicknameLabel) {
      const field = value.querySelector('#edit_name') ?? value;
      if (field.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false) continue;
      const nickname = field.innerText?.replace(/\s+/g, ' ').trim();
      if (nickname) nicknames.add(nickname);
    } else if (label === parentLabel) {
      for (const link of value.querySelectorAll('a[href]')) {
        const route = getGeekRoute(link.href);
        if (route && parentTypes.includes(route.type)) parents.add(route.bggId);
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
  const [nickname] = nicknames;
  return { parentBggId: [...parents][0], description, ...(nicknames.size === 1 ? { nickname } : {}) };
}
