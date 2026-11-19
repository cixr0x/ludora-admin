import { parseBggSearchResponse, parseBggThingResponse, type BggSearchItem, type BggThingDetails } from './bggParser.js';
import { BGG_REQUEST_TYPE } from './bggTypes.js';

export type BggThingResult = {
  details: BggThingDetails;
  rawXml: string;
};

export type BggClient = {
  fetchThing(bggId: number): Promise<BggThingResult | null>;
  search(query: string): Promise<BggSearchItem[]>;
  searchFresh?(query: string): Promise<BggSearchItem[]>;
};

export type BggThingXmlClient = BggClient & {
  fetchThing(bggId: number, signal?: AbortSignal): Promise<BggThingResult | null>;
  fetchThingXml(bggId: number): Promise<string>;
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
}): BggThingXmlClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  let requestQueue: Promise<void> = Promise.resolve();
  let lastRequestStartedAt: number | null = null;

  function enqueueRequest<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const queuedRequest = requestQueue.then(() => {
      signal?.throwIfAborted();
      return request();
    });
    requestQueue = queuedRequest.then(
      () => undefined,
      () => undefined
    );
    if (!signal) {
      return queuedRequest;
    }

    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      queuedRequest.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  async function getXml(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<string> {
    return enqueueRequest(() => getXmlWithRetry(path, params, signal), signal);
  }

  async function getXmlWithRetry(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<string> {
    while (true) {
      const response = await sendXmlRequest(path, params, signal);
      if (response.status === 429) {
        await sleep(BGG_429_RETRY_DELAY_MS, signal);
        continue;
      }

      if (!response.ok) {
        throw new BggApiError(`BGG API request failed with ${response.status}`, response.status);
      }

      return response.text();
    }
  }

  async function sendXmlRequest(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<Response> {
    await waitForRequestSlot(signal);
    return fetch(`${normalizedBaseUrl}/${path}?${params.toString()}`, {
      signal,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/xml,text/xml'
      }
    });
  }

  async function waitForRequestSlot(signal?: AbortSignal): Promise<void> {
    if (lastRequestStartedAt !== null) {
      const nextAllowedStart = lastRequestStartedAt + BGG_REQUEST_INTERVAL_MS;
      const delayMs = Math.max(0, nextAllowedStart - Date.now());
      if (delayMs > 0) {
        await sleep(delayMs, signal);
      }
    }
    signal?.throwIfAborted();
    lastRequestStartedAt = Date.now();
  }

  async function fetchThingXml(bggId: number, signal?: AbortSignal): Promise<string> {
    return getXml(
      'thing',
      new URLSearchParams({
        id: String(bggId),
        stats: '1',
        type: BGG_REQUEST_TYPE
      }),
      signal
    );
  }

  async function search(query: string): Promise<BggSearchItem[]> {
    const xml = await getXml(
      'search',
      new URLSearchParams({
        query,
        type: BGG_REQUEST_TYPE
      })
    );
    return parseBggSearchResponse(xml);
  }

  return {
    fetchThingXml,

    async fetchThing(bggId: number, signal?: AbortSignal): Promise<BggThingResult | null> {
      const xml = await fetchThingXml(bggId, signal);
      const details = parseBggThingResponse(xml);
      return details ? { details, rawXml: xml } : null;
    },

    search,
    searchFresh: search
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
