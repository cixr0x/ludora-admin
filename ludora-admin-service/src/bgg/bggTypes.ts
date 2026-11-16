const BGG_BOARD_GAME_TYPES = ['boardgame', 'boardgameexpansion', 'boardgameaccessory'] as const;
export const BGG_BOARD_GAME_REQUEST_TYPE = BGG_BOARD_GAME_TYPES.join(',');
export const BGG_SUPPORTED_TYPES = [...BGG_BOARD_GAME_TYPES, 'rpgitem'] as const;
export const BGG_REQUEST_TYPE = BGG_SUPPORTED_TYPES.join(',');
export const BGG_CACHE_REQUEST_TYPES = [BGG_REQUEST_TYPE, BGG_BOARD_GAME_REQUEST_TYPE, 'boardgame,boardgameexpansion'];

export function bggTypeToItemType(type: string): 'base_game' | 'expansion' | 'unknown' {
  if (type === 'boardgameexpansion' || type === 'boardgameaccessory') return 'expansion';
  if (type === 'boardgame' || type === 'rpgitem') return 'base_game';
  return 'unknown';
}

export function isBggAccessory(type: string): boolean {
  return type === 'boardgameaccessory';
}
