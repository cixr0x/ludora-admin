const API_URL = import.meta.env.VITE_ADMIN_API_URL ?? 'http://localhost:4001';
const INVALID_DATA_ERROR = 'Invalid API response: data must be an array';

type DataResponse<T> = {
  data: T;
  meta?: {
    page?: number;
    page_size?: number;
    total?: number;
  };
};

export type AdminRecord = Record<string, unknown>;

export type PagedRows<T extends AdminRecord> = {
  page: number;
  pageSize: number;
  rows: T[];
  total: number;
};

export type TableQuery = {
  filters?: Record<string, string>;
  page: number;
  pageSize: number;
  sortColumnId?: string;
  sortDirection?: 'asc' | 'desc';
};

export type StoreCandidateStatus = 'ACCEPTED' | 'PENDING' | 'REJECTED';

export type StoreCandidateInput = {
  canonical_domain: string;
  city?: string;
  confidence?: number;
  country?: string;
  evidence?: string[];
  facebook_url?: string;
  instagram_url?: string;
  state?: string;
  store_logo?: string;
  store_name: string;
  website_url: string;
};

export type StoreInput = {
  canonical_domain: string;
  city?: string;
  country?: string;
  facebook_url?: string;
  instagram_url?: string;
  logo_url?: string;
  name: string;
  state?: string;
  status?: string;
  website_url: string;
};

export type ItemCandidateInput = AdminRecord;
export type CreateItemFromCandidateInput = {
  bgg_id?: string;
  implements?: boolean;
};
export type ItemInput = AdminRecord;

export type DescriptionGenerationInput = {
  boardgame_name: string;
  description_1: string;
  description_2: string;
};

export type DescriptionGenerationResult = {
  description_es: string;
  metadata: Record<string, unknown>;
  model: string;
  prompt_version: string;
};

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

export type StoreDiscoveryRun = {
  completed_at: string | null;
  error: string | null;
  id: string;
  result: StoreDiscoveryRunResult | ItemDiscoveryRunResult | null;
  started_at: string;
  status: StoreDiscoveryRunStatus;
  type: 'item_discovery' | 'store_discovery';
};

function buildApiUrl(path: string) {
  return `${API_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export async function fetchRows<T extends AdminRecord>(path: string): Promise<T[]> {
  const rows = await fetchData<T[]>(path);

  if (!Array.isArray(rows)) {
    throw new Error(INVALID_DATA_ERROR);
  }

  return rows;
}

async function fetchData<T>(path: string, init?: RequestInit): Promise<T> {
  const data = await fetchEnvelope<T>(path, init);
  return data.data;
}

async function fetchEnvelope<T>(path: string, init?: RequestInit): Promise<DataResponse<T>> {
  const url = buildApiUrl(path);
  const response = init ? await fetch(url, init) : await fetch(url);

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return (await response.json()) as DataResponse<T>;
}

async function fetchPagedRows<T extends AdminRecord>(
  path: string,
  fallback: { page: number; pageSize: number }
): Promise<PagedRows<T>> {
  const response = await fetchEnvelope<T[]>(path);
  if (!Array.isArray(response.data)) {
    throw new Error(INVALID_DATA_ERROR);
  }

  return {
    page: response.meta?.page ?? fallback.page,
    pageSize: response.meta?.page_size ?? fallback.pageSize,
    rows: response.data,
    total: response.meta?.total ?? response.data.length
  };
}

function sendJson<T>(path: string, method: 'PATCH' | 'POST', body: unknown): Promise<T> {
  return fetchData<T>(path, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method
  });
}

function pagedPath(path: string, query: TableQuery) {
  const searchParams = new URLSearchParams({
    page: String(query.page),
    page_size: String(query.pageSize)
  });

  if (query.sortColumnId) {
    searchParams.set('sort', query.sortColumnId);
  }
  if (query.sortDirection) {
    searchParams.set('sort_direction', query.sortDirection);
  }

  for (const [key, value] of Object.entries(query.filters ?? {})) {
    const trimmedValue = value.trim();
    if (trimmedValue) {
      searchParams.set(`filter_${key}`, trimmedValue);
    }
  }

  return `${path}?${searchParams.toString()}`;
}

export const adminApi = {
  getStores: () => fetchRows('/stores'),
  getStoresPage: (query: TableQuery) => fetchPagedRows<AdminRecord>(pagedPath('/stores', query), query),
  updateStore: (id: string, input: StoreInput) => sendJson<AdminRecord>(`/stores/${encodeURIComponent(id)}`, 'PATCH', input),
  getStoreCandidates: () => fetchRows('/discovery/stores'),
  getStoreCandidatesPage: (query: TableQuery) => fetchPagedRows<AdminRecord>(pagedPath('/discovery/stores', query), query),
  createStoreCandidate: (input: StoreCandidateInput) => sendJson<AdminRecord>('/discovery/stores', 'POST', input),
  updateStoreCandidate: (id: string, input: StoreCandidateInput) =>
    sendJson<AdminRecord>(`/discovery/stores/${encodeURIComponent(id)}`, 'PATCH', input),
  approveStoreCandidate: (id: string) =>
    fetchData<AdminRecord>(`/discovery/stores/${encodeURIComponent(id)}/approve`, {
      method: 'POST'
    }),
  rejectStoreCandidate: (id: string) =>
    fetchData<AdminRecord>(`/discovery/stores/${encodeURIComponent(id)}/reject`, {
      method: 'POST'
    }),
  getItemCandidates: () => fetchRows('/discovery/listings'),
  getItemCandidate: (id: string) => fetchData<AdminRecord>(`/discovery/listings/${encodeURIComponent(id)}`),
  getItemCandidatesPage: (query: TableQuery) => fetchPagedRows<AdminRecord>(pagedPath('/discovery/listings', query), query),
  createItemFromCandidate: (id: string, input: CreateItemFromCandidateInput = {}) =>
    sendJson<AdminRecord>(`/discovery/listings/${encodeURIComponent(id)}/create-item`, 'POST', {
      bgg_id: input.bgg_id ?? '',
      implements: Boolean(input.implements)
    }),
  createItemFromBggId: (id: string, bggId: string) =>
    sendJson<AdminRecord>(`/discovery/listings/${encodeURIComponent(id)}/create-item-from-bgg`, 'POST', {
      bgg_id: bggId
    }),
  updateItemCandidate: (id: string, input: ItemCandidateInput) =>
    sendJson<AdminRecord>(`/discovery/listings/${encodeURIComponent(id)}`, 'PATCH', input),
  getItem: (id: string) => fetchData<AdminRecord>(`/items/${encodeURIComponent(id)}`),
  getItemLinkedCandidates: (id: string) => fetchRows(`/items/${encodeURIComponent(id)}/candidates`),
  getItemStoreItems: (id: string) => fetchRows(`/items/${encodeURIComponent(id)}/store-items`),
  getItemsPage: (query: TableQuery) => fetchPagedRows<AdminRecord>(pagedPath('/items', query), query),
  updateItem: (id: string, input: ItemInput) => sendJson<AdminRecord>(`/items/${encodeURIComponent(id)}`, 'PATCH', input),
  getListingCandidates: () => fetchRows('/discovery/listings'),
  generateDescription: (input: DescriptionGenerationInput) =>
    sendJson<DescriptionGenerationResult>('/admin/description-generations', 'POST', input),
  getOfferReviews: () => fetchRows('/admin/discovery/offer-reviews'),
  getOfferReviewsPage: (query: TableQuery) => fetchPagedRows<AdminRecord>(pagedPath('/admin/discovery/offer-reviews', query), query),
  getReviewTasks: () => fetchRows('/admin/review-tasks'),
  getReviewTasksPage: (query: TableQuery) => fetchPagedRows<AdminRecord>(pagedPath('/admin/review-tasks', query), query),
  getLatestStoreDiscoveryRun: () => fetchData<StoreDiscoveryRun | null>('/admin/operations/store-discovery-runs/latest'),
  getStoreDiscoveryRun: (runId: string) =>
    fetchData<StoreDiscoveryRun | null>(`/admin/operations/store-discovery-runs/${encodeURIComponent(runId)}`),
  startStoreItemDiscoveryRun: (storeId: string) =>
    fetchData<StoreDiscoveryRun>(`/admin/operations/stores/${encodeURIComponent(storeId)}/item-discovery-runs`, {
      method: 'POST'
    }),
  startStoreDiscoveryRun: () =>
    fetchData<StoreDiscoveryRun>('/admin/operations/store-discovery-runs', {
      method: 'POST'
    })
};
