import { describe, expect, it } from 'vitest';

import { scoreBggThing, scoreLocalItem } from './itemMatcher.js';

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
});
