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

const BGG_REQUEST_INTERVAL_MS = 1000;
const BGG_429_RETRY_DELAY_MS = 5000;

export function createBggClient({
  apiToken,
  baseUrl = 'https://boardgamegeek.com/xmlapi2'
}: {
  apiToken: string;
  baseUrl?: string;
}): BggClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  let requestQueue: Promise<void> = Promise.resolve();
  let lastRequestStartedAt: number | null = null;

  function enqueueRequest<T>(request: () => Promise<T>): Promise<T> {
    const queuedRequest = requestQueue.then(request);
    requestQueue = queuedRequest.then(
      () => undefined,
      () => undefined
    );
    return queuedRequest;
  }

  async function getXml(path: string, params: URLSearchParams): Promise<string> {
    return enqueueRequest(() => getXmlWithRetry(path, params));
  }

  async function getXmlWithRetry(path: string, params: URLSearchParams): Promise<string> {
    while (true) {
      const response = await sendXmlRequest(path, params);
      if (response.status === 429) {
        await sleep(BGG_429_RETRY_DELAY_MS);
        continue;
      }

      if (!response.ok) {
        throw new BggApiError(`BGG API request failed with ${response.status}`, response.status);
      }

      return response.text();
    }
  }

  async function sendXmlRequest(path: string, params: URLSearchParams): Promise<Response> {
    await waitForRequestSlot();
    return fetch(`${normalizedBaseUrl}/${path}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/xml,text/xml'
      }
    });
  }

  async function waitForRequestSlot(): Promise<void> {
    if (lastRequestStartedAt !== null) {
      const nextAllowedStart = lastRequestStartedAt + BGG_REQUEST_INTERVAL_MS;
      const delayMs = Math.max(0, nextAllowedStart - Date.now());
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
    lastRequestStartedAt = Date.now();
  }

  return {
    async fetchThing(bggId: number): Promise<BggThingResult | null> {
      const xml = await getXml(
        'thing',
        new URLSearchParams({
          id: String(bggId),
          stats: '1',
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
