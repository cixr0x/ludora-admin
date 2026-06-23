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

  it('decodes HTML entities in BGG names after XML parsing', () => {
    const searchXml = `
      <items total="1" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
        <item type="boardgame" id="421098">
          <name type="primary" value="The Old King&amp;#039;s Crown" />
          <yearpublished value="2024" />
        </item>
      </items>
    `;
    const thingXml = `
      <items termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
        <item type="boardgame" id="421098">
          <name type="primary" sortindex="1" value="The Old King&amp;#039;s Crown" />
          <name type="alternate" sortindex="1" value="King&amp;rsquo;s Crown: L&amp;#039;Édition" />
          <link type="boardgamefamily" id="1234" value="Crowns &amp;amp; Courts" />
          <link type="boardgameimplementation" id="5678" value="King&amp;#039;s Crown Duel" />
        </item>
      </items>
    `;

    expect(parseBggSearchResponse(searchXml)[0].name).toBe("The Old King's Crown");
    expect(parseBggThingResponse(thingXml)).toMatchObject({
      alternateNames: ["King’s Crown: L'Édition"],
      families: [{ bggId: 1234, name: 'Crowns & Courts' }],
      implementationLinks: [{ bggId: 5678, name: "King's Crown Duel" }],
      name: "The Old King's Crown"
    });
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
          <link type="boardgameexpansion" id="411435" value="Coffee Rush: Piece of Cake" inbound="true" />
          <link type="boardgameimplementation" id="999001" value="Coffee Rush Dice" />
          <statistics page="1">
            <ratings>
              <average value="7.48231" />
              <averageweight value="1.9234" />
            </ratings>
          </statistics>
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
      parentLinks: [{ bggId: 411435, inbound: true, name: 'Coffee Rush: Piece of Cake' }],
      playingTime: 30,
      publishers: [{ bggId: 8291, name: 'Korea Boardgames' }],
      rating: 7.48231,
      thumbnail: 'https://example.com/small.jpg',
      type: 'boardgame',
      implementationLinks: [{ bggId: 999001, inbound: false, name: 'Coffee Rush Dice' }],
      weight: 1.9234,
      yearPublished: 2023
    });
  });
});
