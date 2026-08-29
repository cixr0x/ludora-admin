export const BGG_SUPPORTED_TYPES = ['boardgame', 'boardgameexpansion', 'boardgameaccessory'] as const;
export const BGG_REQUEST_TYPE = BGG_SUPPORTED_TYPES.join(',');
export const BGG_LEGACY_REQUEST_TYPE = 'boardgame,boardgameexpansion';

export function bggTypeToItemType(type: string): 'base_game' | 'expansion' | 'unknown' {
  if (type === 'boardgameexpansion' || type === 'boardgameaccessory') return 'expansion';
  if (type === 'boardgame') return 'base_game';
  return 'unknown';
}

export function isBggAccessory(type: string): boolean {
  return type === 'boardgameaccessory';
}
