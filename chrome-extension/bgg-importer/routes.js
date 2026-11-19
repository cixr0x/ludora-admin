function getGeekItemId(address, expectedOrigin) {
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
      if (!['boardgame', 'boardgameexpansion', 'boardgameaccessory', 'rpgitem'].includes(type)) return null;
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
  return bggId > 0 && Number.isSafeInteger(bggId) ? bggId : null;
}
