export type StoreDiscoveryRunStatus = 'running' | 'completed' | 'failed';

export type StoreDiscoveryRunResult = {
  accepted_stores: number;
  candidate_domains: number;
  searched_queries: number;
};

export type ItemDiscoveryRunResult = {
  item_candidates: number;
  store_id: number;
  website_url: string;
};

export type ItemUpdateRunResult = {
  updated_items: number;
};

export type StoreDiscoveryRun = {
  completed_at: string | null;
  error: string | null;
  id: string;
  result: StoreDiscoveryRunResult | ItemDiscoveryRunResult | ItemUpdateRunResult | null;
  started_at: string;
  status: StoreDiscoveryRunStatus;
  type: 'item_discovery' | 'item_update' | 'store_discovery';
};

export type DiscoveryOperationsClient = {
  getLatestStoreDiscoveryRun(): Promise<StoreDiscoveryRun | null>;
  getStoreDiscoveryRun(runId: string): Promise<StoreDiscoveryRun | null>;
  startItemDiscoveryRun(storeId: number, websiteUrl: string): Promise<StoreDiscoveryRun>;
  startItemUpdateRun(): Promise<StoreDiscoveryRun>;
  startStoreDiscoveryRun(): Promise<StoreDiscoveryRun>;
};

export class DiscoveryApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

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
    getLatestStoreDiscoveryRun: () => requestData<StoreDiscoveryRun | null>(baseUrl, '/operations/store-discovery-runs/latest'),
    getStoreDiscoveryRun: (runId: string) =>
      requestData<StoreDiscoveryRun | null>(baseUrl, `/operations/store-discovery-runs/${encodeURIComponent(runId)}`),
    startItemDiscoveryRun: (storeId: number, websiteUrl: string) =>
      requestData<StoreDiscoveryRun>(baseUrl, `/operations/stores/${encodeURIComponent(storeId)}/item-discovery-runs`, {
        body: JSON.stringify({ website_url: websiteUrl }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      }),
    startItemUpdateRun: () =>
      requestData<StoreDiscoveryRun>(baseUrl, '/operations/item-update-runs', {
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
    throw new DiscoveryApiError(payload.error?.message ?? `Discovery API request failed with ${response.status}`, response.status);
  }

  return payload.data;
}

function buildUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
