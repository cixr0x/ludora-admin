import {
  DiscoveryOperationError,
  type DiscoveryOperationsClient,
  type StoreDiscoveryRun
} from './discoveryOperations.js';

export type {
  DiscoveryOperationsClient,
  ItemDiscoveryRunResult,
  ItemEmbeddingRunResult,
  ItemUpdateRunResult,
  StoreDiscoveryRun,
  StoreDiscoveryRunResult,
  StoreDiscoveryRunStatus
} from './discoveryOperations.js';

export { DiscoveryOperationError };

type DataResponse<T> = {
  data: T;
};

type ErrorResponse = {
  error?: {
    message?: string;
  };
};

export function createDiscoveryOperationsClient(baseUrl: string): DiscoveryOperationsClient {
  return {
    cancelStoreDiscoveryRun: (runId: string) =>
      requestData<StoreDiscoveryRun>(baseUrl, `/operations/store-discovery-runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST'
      }),
    getLatestStoreDiscoveryRun: () => requestData<StoreDiscoveryRun | null>(baseUrl, '/operations/store-discovery-runs/latest'),
    getStoreDiscoveryRun: async (runId: string) => {
      try {
        return await requestData<StoreDiscoveryRun | null>(baseUrl, `/operations/store-discovery-runs/${encodeURIComponent(runId)}`);
      } catch (error) {
        if (error instanceof DiscoveryOperationError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    startItemDiscoveryRun: (storeId: number, websiteUrl: string, platform = '', storeName = '') =>
      requestData<StoreDiscoveryRun>(baseUrl, `/operations/stores/${encodeURIComponent(storeId)}/item-discovery-runs`, {
        body: JSON.stringify(itemDiscoveryRequestBody(websiteUrl, platform, storeName)),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      }),
    startItemUpdateRun: () =>
      requestData<StoreDiscoveryRun>(baseUrl, '/operations/item-update-runs', {
        method: 'POST'
      }),
    startItemEmbeddingRun: (refreshMode: 'full' | 'missing') =>
      requestData<StoreDiscoveryRun>(baseUrl, '/operations/item-embedding-runs', {
        body: JSON.stringify({ refresh_mode: refreshMode }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      }),
    startStoreDiscoveryRun: () =>
      requestData<StoreDiscoveryRun>(baseUrl, '/operations/store-discovery-runs', {
        method: 'POST'
      })
  };
}

async function requestData<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildUrl(baseUrl, path), init);
  const payload = (await response.json()) as DataResponse<T> & ErrorResponse;

  if (!response.ok) {
    throw new DiscoveryOperationError(payload.error?.message ?? `Discovery API request failed with ${response.status}`, response.status);
  }

  return payload.data;
}

function buildUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function itemDiscoveryRequestBody(
  websiteUrl: string,
  platform: string,
  storeName: string
): { platform?: string; store_name?: string; website_url: string } {
  const normalizedPlatform = platform.trim().toLowerCase();
  const normalizedStoreName = storeName.trim();
  return {
    ...(normalizedPlatform ? { platform: normalizedPlatform } : {}),
    ...(normalizedStoreName ? { store_name: normalizedStoreName } : {}),
    website_url: websiteUrl
  };
}
