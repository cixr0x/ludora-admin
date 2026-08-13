import { describe, expect, it } from 'vitest';

import { localMatchSearchTokens, normalizeTitleVariants, scoreBggThing, scoreLocalItem } from './itemMatcher.js';

describe('item matcher', () => {
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

    expect(result.matchScore).toBeGreaterThanOrEqual(0.9);
    expect(result.matchReasons).toContain('exact local alias match');
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

    expect(result.matchScore).toBe(0.92);
    expect(result.matchReasons).toContain('order-independent local item name match');
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
    expect(result.matchScore).toBe(0.92);
    expect(result.matchReasons).toContain('order-independent local item name match');
    expect(result.matchReasons.some((reason) => reason.startsWith('ignored listing context tokens:'))).toBe(true);
  });

  it('keeps meaningful product suffixes below the automatic threshold', () => {
    const result = scoreLocalItem(
      { title: 'Catan Plus', itemType: 'base_game' },
      {
        aliases: [],
        id: 13,
        itemType: 'base_game',
        name: 'Catan',
        normalizedName: 'catan'
      }
    );

    expect(result.matchScore).toBeLessThan(0.9);
    expect(result.matchReasons).toContain('meaningful extra title token: plus');
  });

  it('rejects an otherwise strong fuzzy match when the item types conflict', () => {
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

    expect(result.matchScore).toBe(0.67);
    expect(result.matchReasons).toContain('item type conflict');
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

    expect(result.matchScore).toBeGreaterThanOrEqual(0.9);
    expect(result.matchReasons).toContain('exact local item name match after ignoring language edition');
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

    expect(localResult.matchScore).toBeGreaterThanOrEqual(0.9);
    expect(localResult.matchReasons).toContain('exact local item name match after ignoring language edition');

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
