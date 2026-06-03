import { parseBggSearchResponse, parseBggThingResponse, type BggSearchItem, type BggThingDetails } from './bggParser.js';

export type BggThingResult = {
  details: BggThingDetails;
  rawXml: string;
};

export type BggClient = {
  fetchThing(bggId: number): Promise<BggThingResult | null>;
  search(query: string): Promise<BggSearchItem[]>;
};

export class BggApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export function createBggClient({
  apiToken,
  baseUrl = 'https://boardgamegeek.com/xmlapi2'
}: {
  apiToken: string;
  baseUrl?: string;
}): BggClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');

  async function getXml(path: string, params: URLSearchParams): Promise<string> {
    const url = `${normalizedBaseUrl}/${path}?${params.toString()}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/xml,text/xml'
      }
    });

    if (!response.ok) {
      throw new BggApiError(`BGG API request failed with ${response.status}`, response.status);
    }

    return response.text();
  }

  return {
    async fetchThing(bggId: number): Promise<BggThingResult | null> {
      const xml = await getXml(
        'thing',
        new URLSearchParams({
          id: String(bggId),
          type: 'boardgame,boardgameexpansion'
        })
      );
      const details = parseBggThingResponse(xml);
      return details ? { details, rawXml: xml } : null;
    },

    async search(query: string): Promise<BggSearchItem[]> {
      const xml = await getXml(
        'search',
        new URLSearchParams({
          query,
          type: 'boardgame,boardgameexpansion'
        })
      );
      return parseBggSearchResponse(xml);
    }
  };
}
