import { describe, expect, it } from 'vitest';

import { localMatchSearchTokens, normalizeTitleVariants, scoreBggThing, scoreLocalItem } from './itemMatcher.js';

describe('item matcher', () => {
  it('scores accessories as expansions without an item type conflict', () => {
    const result = scoreBggThing(
      { itemType: 'expansion', title: 'Catan Accessory' },
      { alternateNames: [], bggId: 337190, name: 'Catan Accessory', publishers: [], type: 'boardgameaccessory' }
    );

    expect(result.matchScore).toBe(0.9);
    expect(result.matchReasons).not.toContain('item type conflict');
  });

  it('ignores conflicting known item types when scoring an exact BGG name match', () => {
    const result = scoreBggThing(
      { itemType: 'base_game', title: 'Coffee Rush' },
      {
        alternateNames: [],
        bggId: 377061,
        name: 'Coffee Rush',
        publishers: [],
        type: 'boardgameexpansion'
      }
    );

    expect(result.matchScore).toBe(0.9);
    expect(result.matchReasons).toContain('exact BGG primary name match');
    expect(result.matchReasons).not.toContain('item type conflict');
  });

  it('scores exact BGG alternate name matches as strong matches', () => {
    const result = scoreBggThing(
      {
        title: 'Cafe Barista',
        itemType: 'base_game',
        maxPlayers: 4,
        minPlayers: 2,
        publisher: 'Korea Boardgames'
      },
      {
        alternateNames: ['Café Barista'],
        bggId: 377061,
        maxPlayers: 4,
        minPlayers: 2,
        name: 'Coffee Rush',
        publishers: [{ bggId: 8291, name: 'Korea Boardgames' }],
        type: 'boardgame',
        yearPublished: 2023
      }
    );

    expect(result.matchScore).toBeGreaterThanOrEqual(0.9);
    expect(result.matchReasons).toContain('exact BGG alternate name match');
  });

  it('does not score Catan Plus as an exact Catan match', () => {
    const result = scoreBggThing(
      {
        title: 'Catan Plus',
        itemType: 'base_game'
      },
      {
        alternateNames: [],
        bggId: 13,
        maxPlayers: 4,
        minPlayers: 3,
        name: 'Catan',
        publishers: [],
        type: 'boardgame',
        yearPublished: 1995
      }
    );

    expect(result.matchScore).toBeLessThan(0.8);
    expect(result.matchReasons).toContain('meaningful extra title token: plus');
    expect(result.matchReasons).not.toContain('exact BGG primary name match');
  });

  it('scores exact local alias matches as strong matches', () => {
    const result = scoreLocalItem(
      { title: 'Los Colonos de Catan', itemType: 'base_game' },
      {
        aliases: ['Los Colonos de Catán'],
        bggId: 13,
        id: 10,
        itemType: 'base_game',
        name: 'Catan',
        normalizedName: 'catan'
      }
    );

    expect(result.matchScore).toBe(0.99);
    expect(result.matchReasons).toContain('selected local name source: alias');
    expect(result.matchReasons).toContain('normalized local title token F1: 1.0000');
  });

  it('keeps the Arkham Horror Children of Blood false match below the correct title', () => {
    const candidate = {
      title: 'ASMODEE - Arkham Horror: Under Dark Waves Expansion (Inglés)',
      itemType: 'expansion',
      publisher: 'ASMODEE',
      storeName: 'Gamesmart'
    };
    const incorrectResult = scoreLocalItem(candidate, {
      aliases: [],
      id: 49057,
      itemType: 'expansion',
      name: 'Arkham Horror: The Card Game – Children of Blood Small Campaign Expansion',
      normalizedName: 'arkham horror the card game children of blood small campaign expansion'
    });
    const correctResult = scoreLocalItem(candidate, {
      aliases: [],
      id: 49058,
      itemType: 'expansion',
      name: 'Arkham Horror (Third Edition): Under Dark Waves',
      normalizedName: 'arkham horror third edition under dark waves'
    });

    expect(incorrectResult.matchScore).toBe(0.3077);
    expect(incorrectResult.matchScore).toBeLessThan(0.9);
    expect(incorrectResult.matchReasons).toContain('matched local title tokens: arkham, horror');
    expect(incorrectResult.matchReasons).toContain(
      'missing local title tokens: card, game, children, blood, small, campaign'
    );
    expect(incorrectResult.matchReasons).toContain('extra candidate title tokens: under, dark, waves');
    expect(incorrectResult.matchReasons).toContain(
      'excluded context tokens: asmodee, expansion, ingles, the, of'
    );
    expect(correctResult.matchScore).toBe(0.9091);
    expect(correctResult.matchScore).toBeGreaterThanOrEqual(0.9);
    expect(correctResult.matchScore).toBeGreaterThan(incorrectResult.matchScore);
    expect(correctResult.matchReasons).toContain('matched local title tokens: arkham, horror, under, dark, waves');
    expect(correctResult.matchReasons).toContain('missing local title tokens: third');
    expect(correctResult.matchReasons).toContain('extra candidate title tokens: none');
    expect(correctResult.matchReasons).toContain('excluded context tokens: asmodee, expansion, ingles, edition');
  });

  it('scores reordered local title words above the automatic threshold', () => {
    const result = scoreLocalItem(
      { title: 'Middle-earth Duel: The Lord of the Rings', itemType: 'base_game' },
      {
        aliases: [],
        id: 11,
        itemType: 'base_game',
        name: 'The Lord of the Rings: Duel for Middle-earth',
        normalizedName: 'the lord of the rings duel for middle earth'
      }
    );

    expect(result.matchScore).toBe(0.99);
    expect(result.matchReasons).toContain('selected local name source: item name');
    expect(result.matchReasons).toContain('normalized local title token F1: 1.0000');
  });

  it('scores an embedded title from all normalized tokens instead of a phrase shortcut', () => {
    const candidate = {
      title: 'La Expedición Perdida de Arnak Exp | Devir',
      itemType: 'expansion',
      publisher: 'Devir'
    };
    const result = scoreLocalItem(
      candidate,
      {
        aliases: [],
        id: 15,
        itemType: 'expansion',
        name: 'Las Ruinas perdidas de Arnak: Expansión La Expedición Perdida',
        normalizedName: 'las ruinas perdidas de arnak expansion la expedicion perdida',
        publishers: ['Devir']
      }
    );

    expect(localMatchSearchTokens(candidate)).toEqual(['expedicion', 'perdida', 'arnak']);
    expect(result.matchScore).toBe(0.75);
    expect(result.matchReasons).toContain('matched local title tokens: arnak, expedicion, perdida');
    expect(result.matchReasons).toContain('missing local title tokens: ruinas, perdidas');
    expect(result.matchReasons).toContain('extra candidate title tokens: none');
    expect(result.matchReasons).toContain('excluded context tokens: la, de, expansion, devir, las');
  });

  it('accepts a long shared phrase plus another shared token despite ordinary listing noise', () => {
    const result = scoreLocalItem(
      { title: 'Batman: El Regreso del Caballero Oscuro (Ed. Deluxe)Español' },
      {
        aliases: [],
        id: 18,
        name: 'Batman: El Regreso del Caballero Oscuro DELUXE',
        normalizedName: 'batman el regreso del caballero oscuro deluxe'
      }
    );

    expect(result.matchScore).toBe(0.9091);
    expect(result.matchReasons).toContain('normalized local title token F1: 0.9091');
    expect(result.matchReasons).toContain('extra candidate title tokens: ed');
  });

  it.each([
    ['Catan Junior', 0.6667, 'junior'],
    ['Catan Plus', 0.6667, 'plus'],
    ['Catan Big Box', 0.5, 'big, box'],
    ['Catan Legacy', 0.6667, 'legacy']
  ])('keeps the identity-bearing product variant %s below the automatic threshold', (title, expectedScore, extraTokens) => {
    const result = scoreLocalItem(
      { title, itemType: 'base_game' },
      {
        aliases: [],
        id: 19,
        itemType: 'base_game',
        name: 'Catan',
        normalizedName: 'catan'
      }
    );

    expect(result.matchScore).toBe(expectedScore);
    expect(result.matchScore).toBeLessThan(0.9);
    expect(result.matchReasons).toContain(`extra candidate title tokens: ${extraTokens}`);
  });

  it('does not accept a two-word phrase without reinforcing shared title tokens', () => {
    const result = scoreLocalItem(
      { title: 'Star Wars Card Game', itemType: 'base_game' },
      {
        aliases: [],
        id: 16,
        itemType: 'base_game',
        name: 'Star Wars: Rebellion',
        normalizedName: 'star wars rebellion'
      }
    );

    expect(result.matchScore).toBe(0.5714);
    expect(result.matchReasons).toContain('missing local title tokens: rebellion');
    expect(result.matchReasons).toContain('extra candidate title tokens: card, game');
  });

  it('scores a complete catalog title embedded in listing text from all normalized tokens', () => {
    const result = scoreLocalItem(
      { title: 'Lairs: Deeper Dungeons: Expansion | Kids Table Board Gaming' },
      {
        aliases: [],
        id: 17,
        name: 'Lairs: Deeper Dungeons',
        normalizedName: 'lairs deeper dungeons'
      }
    );

    expect(result.matchScore).toBe(0.6);
    expect(result.matchReasons).toContain('matched local title tokens: lairs, deeper, dungeons');
    expect(result.matchReasons).toContain('extra candidate title tokens: kids, table, board, gaming');
    expect(result.matchReasons).toContain('excluded context tokens: expansion');
  });

  it('ignores store, publisher, language, and generic listing context around a complete title', () => {
    const candidate = {
      title: 'Amazon México - Devir - CATAN Juego de Mesa Edición en Español Original',
      itemType: 'base_game',
      publisher: 'Devir',
      storeName: 'Amazon México'
    };
    const result = scoreLocalItem(
      candidate,
      {
        aliases: [],
        id: 12,
        itemType: 'base_game',
        name: 'Catan',
        normalizedName: 'catan',
        publishers: ['Devir']
      }
    );

    expect(localMatchSearchTokens(candidate)).toEqual(['catan']);
    expect(result.matchScore).toBe(0.99);
    expect(result.matchReasons).toContain('normalized local title token F1: 1.0000');
    expect(result.matchReasons).toContain(
      'excluded context tokens: amazon, mexico, devir, juego, de, mesa, edicion, en, espanol, original'
    );
  });

  it('ignores conflicting known item types when scoring an exact local token-set match', () => {
    const result = scoreLocalItem(
      { title: 'Middle-earth Duel: The Lord of the Rings', itemType: 'expansion' },
      {
        aliases: [],
        id: 14,
        itemType: 'base_game',
        name: 'The Lord of the Rings: Duel for Middle-earth',
        normalizedName: 'the lord of the rings duel for middle earth'
      }
    );

    expect(result.matchScore).toBe(0.99);
    expect(result.matchReasons).toContain('normalized local title token F1: 1.0000');
    expect(result.matchReasons).not.toContain('item type conflict');
  });

  it('scores local matches with language-only edition suffixes as strong matches', () => {
    const result = scoreLocalItem(
      { title: '7 Wonders: Architects (Español)', itemType: 'base_game' },
      {
        aliases: [],
        bggId: 346703,
        id: 77,
        itemType: 'base_game',
        name: '7 Wonders: Architects',
        normalizedName: '7 wonders architects'
      }
    );

    expect(result.matchScore).toBe(0.99);
    expect(result.matchReasons).toContain('selected local name source: item name');
    expect(result.matchReasons).toContain('excluded context tokens: espanol');
  });

  it('scores bare trailing language suffixes as strong local and BGG matches', () => {
    const title = 'Gloomhaven en ESPA\u00d1OL';

    expect(normalizeTitleVariants(title)).toEqual(['gloomhaven en espanol', 'gloomhaven']);

    const localResult = scoreLocalItem(
      { title, itemType: 'base_game' },
      {
        aliases: [],
        bggId: 174430,
        id: 88,
        itemType: 'base_game',
        name: 'Gloomhaven',
        normalizedName: 'gloomhaven'
      }
    );

    expect(localResult.matchScore).toBe(0.99);
    expect(localResult.matchReasons).toContain('selected local name source: item name');
    expect(localResult.matchReasons).toContain('excluded context tokens: en, espanol');

    const bggResult = scoreBggThing(
      { title, itemType: 'base_game' },
      {
        alternateNames: [],
        bggId: 174430,
        maxPlayers: 4,
        minPlayers: 1,
        name: 'Gloomhaven',
        publishers: [],
        type: 'boardgame',
        yearPublished: 2017
      }
    );

    expect(bggResult.matchScore).toBeGreaterThanOrEqual(0.9);
    expect(bggResult.matchReasons).toContain('exact BGG primary name match after ignoring language edition');
  });
});
