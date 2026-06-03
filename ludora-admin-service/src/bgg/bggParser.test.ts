import { describe, expect, it } from 'vitest';

import { parseBggSearchResponse, parseBggThingResponse } from './bggParser.js';

describe('BGG XML parser', () => {
  it('parses search result items', () => {
    const xml = `
      <items total="2" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
        <item type="boardgame" id="377061">
          <name type="primary" value="Coffee Rush" />
          <yearpublished value="2023" />
        </item>
        <item type="boardgameexpansion" id="411435">
          <name type="primary" value="Coffee Rush: Piece of Cake" />
          <yearpublished value="2024" />
        </item>
      </items>
    `;

    expect(parseBggSearchResponse(xml)).toEqual([
      { bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 },
      { bggId: 411435, name: 'Coffee Rush: Piece of Cake', type: 'boardgameexpansion', yearPublished: 2024 }
    ]);
  });

  it('parses thing details including alternate names and links', () => {
    const xml = `
      <items termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
        <item type="boardgame" id="377061">
          <thumbnail>https://example.com/small.jpg</thumbnail>
          <image>https://example.com/original.jpg</image>
          <name type="primary" sortindex="1" value="Coffee Rush" />
          <name type="alternate" sortindex="1" value="Café Barista" />
          <description>A coffee shop game.</description>
          <yearpublished value="2023" />
          <minplayers value="2" />
          <maxplayers value="4" />
          <playingtime value="30" />
          <minplaytime value="20" />
          <maxplaytime value="40" />
          <minage value="8" />
          <link type="boardgamecategory" id="1021" value="Economic" />
          <link type="boardgamemechanic" id="2912" value="Contracts" />
          <link type="boardgamefamily" id="46953" value="Food &amp; Drink: Coffee" />
          <link type="boardgamedesigner" id="150113" value="Euijin Han" />
          <link type="boardgameartist" id="157654" value="Siwon Hwang" />
          <link type="boardgamepublisher" id="8291" value="Korea Boardgames" />
        </item>
      </items>
    `;

    expect(parseBggThingResponse(xml)).toEqual({
      alternateNames: ['Café Barista'],
      artists: [{ bggId: 157654, name: 'Siwon Hwang' }],
      bggId: 377061,
      categories: [{ bggId: 1021, name: 'Economic' }],
      description: 'A coffee shop game.',
      designers: [{ bggId: 150113, name: 'Euijin Han' }],
      families: [{ bggId: 46953, name: 'Food & Drink: Coffee' }],
      image: 'https://example.com/original.jpg',
      maxPlayers: 4,
      maxPlaytime: 40,
      mechanics: [{ bggId: 2912, name: 'Contracts' }],
      minAge: 8,
      minPlayers: 2,
      minPlaytime: 20,
      name: 'Coffee Rush',
      playingTime: 30,
      publishers: [{ bggId: 8291, name: 'Korea Boardgames' }],
      thumbnail: 'https://example.com/small.jpg',
      type: 'boardgame',
      yearPublished: 2023
    });
  });
});
