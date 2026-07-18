const API_URL = import.meta.env.VITE_ADMIN_API_URL ?? 'http://127.0.0.1:4001';
const INVALID_DATA_ERROR = 'Invalid API response: data must be an array';

type DataResponse<T> = {
  data: T;
  meta?: {
    page?: number;
    page_size?: number;
    total?: number;
  };
};
type ErrorResponse = {
  error?: {
    message?: string;
  };
};

export type AdminRecord = Record<string, unknown>;

export type StoreItemDiscoveryTraceEntry = {
  created_at: string;
  event: string;
  id: number;
  payload: AdminRecord;
  run_id: string;
  source: string;
};

export type StoreItemDiscoveryJobLog = {
  entries: StoreItemDiscoveryTraceEntry[];
  has_more: boolean;
  job: AdminRecord;
  next_cursor: number;
};

export type StoreItemUpdateHistory = {
  changes: AdminRecord[];
  job: AdminRecord;
};

export type AdminIdentity = {
  username: string;
};

export type LoginInput = {
  password: string;
  username: string;
};

export type PagedRows<T extends AdminRecord> = {
  page: number;
  pageSize: number;
  rows: T[];
  total: number;
};

export type StoreItemUpdateHistoryPage = PagedRows<AdminRecord> & {
  job: AdminRecord;
};

export type ItemTaxonomy = {
  categories: AdminRecord[];
  families: AdminRecord[];
  mechanics: AdminRecord[];
};

export type LocalCoverWorkflow = {
  error: string | null;
  expected_path: string;
  expected_paths?: string[];
  filename: string;
  item_id: number;
  public_url: string;
  source_path: string;
  status: 'completed' | 'failed' | 'uploading' | 'waiting_for_edit';
  store_item_id: number | null;
  target_field?: 'image_url' | 'image_url_es' | null;
  workflow_id: string;
};

export type CoverImageField = 'image_url' | 'image_url_es';

export type CoverPoint = {
  x: number;
  y: number;
};

export type CoverFlatteningCandidate = {
  aspect_ratio: number;
  aspect_ratio_method: 'edge_average' | 'near_square' | 'vanishing_points';
  construction: string;
  height: number;
  index: number;
  square_snapped: boolean;
  vanishing_confidence: number;
  width: number;
};

export type CoverFlatteningWorkflow = {
  automatic_error: string | null;
  candidates: CoverFlatteningCandidate[];
  created_at: string;
  expires_at: string;
  item_id: number;
  perspective: 'two_faces' | 'three_faces' | null;
  source_field: CoverImageField | 'store_item_image';
  store_item_id: number | null;
  workflow_id: string;
};

export type AcceptedCoverFlattening = {
  item_id: number;
  optimized_size_bytes: number;
  output_aspect_ratio: number;
  public_url: string;
  s3_key: string;
  target_field: CoverImageField;
  trim_fraction: number;
};

export type OptimizedCoverImage = {
  applied: boolean;
  field: CoverImageField;
  itemId: number;
  newName: string;
  optimizedSizeBytes: number;
  originalSizeBytes: number | null;
  publicUrl: string;
  s3Key: string;
  sourceName: string;
  sourceUrl: string;
};

export type SkippedCoverImage = {
  field: CoverImageField;
  itemId: number;
  reason: 'blank' | 'managed' | 'within_limit';
  sizeBytes?: number | null;
  sourceUrl?: string;
};

export type FailedCoverImage = {
  error: string;
  field: CoverImageField;
  itemId: number;
  sourceUrl: string;
};

export type ExternalCoverImageOptimizationResult = {
  failures: FailedCoverImage[];
  optimized: OptimizedCoverImage[];
  skipped: SkippedCoverImage[];
  summary: {
    downloadedImages: number;
    failedImages: number;
    imageFields: number;
    itemsScanned: number;
    optimizedImages: number;
    skippedBlank: number;
    skippedManaged: number;
    skippedWithinLimit: number;
    updatedRows: number;
    uploadedImages: number;
  };
};

export type TableQuery = {
  filters?: Record<string, string>;
  page: number;
  pageSize: number;
  sortColumnId?: string;
  sortDirection?: 'asc' | 'desc';
};

export type StoreCandidateStatus = 'ACCEPTED' | 'PENDING' | 'REJECTED';
export type StoreItemListingStatus = 'LISTED' | 'PENDING' | 'REJECTED' | 'UNLISTED';

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
  platform?: string;
  state?: string;
  status?: string;
  website_url: string;
};

export type FrontPageCategoryInput = {
  category_id: number;
  category_type: 'category' | 'family' | 'mechanic';
  order: number;
  title: string;
};

export type FrontPageCategoryOption = AdminRecord & {
  bgg_id: number | null;
  category_id: number;
  category_type: FrontPageCategoryInput['category_type'];
  front_page_category_id: number | null;
  game_count: number;
  name: string;
  name_es: string;
};

export type FrontPageCategoryOptionsQuery = {
  onlyUnlinkedGames?: boolean;
};

export type FrontPageCategoryProduct = AdminRecord & {
  canonical_name: string;
  canonical_name_es: string;
  id: number;
  image_url: string;
  image_url_es: string;
  item_type: string;
  year_published: number | null;
};

export type FrontPageCategoryRandomAssignmentResult = {
  assigned_count: number;
  removed_count?: number;
  replaced_count?: number;
  skipped_count: number;
};

export type FrontPagePreviewCategory = AdminRecord & {
  category_id: number;
  category_name: string;
  category_name_es?: string;
  category_type: FrontPageCategoryInput['category_type'];
  id: number;
  order: number;
  products: FrontPageCategoryProduct[];
  title: string;
};

export type ItemCandidateInput = AdminRecord;
export type CreateItemFromCandidateInput = {
  bgg_id?: string;
  extends?: boolean;
  extends_item_id?: string;
  implements?: boolean;
};
export type ItemInput = AdminRecord;
export type ItemRelationshipInput = {
  direction?: 'incoming' | 'outgoing';
  link_type: string;
  related_item_id: string;
  source?: string;
  source_ref?: string;
};

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

export type StoreDiscoveryRunStatus = 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed';

export type StoreDiscoveryRunResult = {
  accepted_stores: number;
  candidate_domains: number;
  searched_queries: number;
};

export type ItemDiscoveryRunResult = {
  item_candidates: number;
  new_items?: number;
  store_id: number | null;
  stores_scanned?: number;
  website_url: string;
};

export type ItemUpdateRunResult = {
  updated_items: number;
};

export type ItemDiscoveryRunScope = { all_stores: true } | { store_ids: number[] };
export type ItemUpdateRunScope = { all_stores: true } | { store_ids: number[] };

export type ItemEmbeddingRunResult = {
  embedded_items: number;
  model: string;
  refresh_mode: 'full' | 'missing';
  selected_items: number;
};

export type StoreDiscoveryRun = {
  completed_at: string | null;
  error: string | null;
  id: string;
  result: StoreDiscoveryRunResult | ItemDiscoveryRunResult | ItemUpdateRunResult | ItemEmbeddingRunResult | null;
  started_at: string;
  status: StoreDiscoveryRunStatus;
  type: 'item_discovery' | 'item_embeddings' | 'item_update' | 'store_discovery';
};

function buildApiUrl(path: string) {
  return `${API_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
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
  const response = await fetch(url, {
    credentials: 'include',
    ...(init ?? {})
  });

  if (!response.ok) {
    if (response.status === 401) {
      unauthorizedHandler?.();
    }
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as DataResponse<T>;
}

async function fetchBlob(path: string): Promise<Blob> {
  const response = await fetch(buildApiUrl(path), { credentials: 'include' });
  if (!response.ok) {
    if (response.status === 401) {
      unauthorizedHandler?.();
    }
    throw new Error(await readErrorMessage(response));
  }
  return response.blob();
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ErrorResponse;
    if (payload.error?.message) {
      return payload.error.message;
    }
  } catch {
    // Fall back to the status code when the server does not return a JSON error envelope.
  }
  return `Request failed with ${response.status}`;
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

async function fetchStoreItemUpdateHistoryPage(
  path: string,
  fallback: { page: number; pageSize: number }
): Promise<StoreItemUpdateHistoryPage> {
  const response = await fetchEnvelope<StoreItemUpdateHistory>(path);
  if (!Array.isArray(response.data.changes)) {
    throw new Error(INVALID_DATA_ERROR);
  }

  return {
    job: response.data.job,
    page: response.meta?.page ?? fallback.page,
    pageSize: response.meta?.page_size ?? fallback.pageSize,
    rows: response.data.changes,
    total: response.meta?.total ?? response.data.changes.length
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
  getCurrentAdmin: () => fetchData<AdminIdentity>('/admin/auth/me'),
  login: (input: LoginInput) => sendJson<AdminIdentity>('/admin/auth/login', 'POST', input),
  logout: () =>
    fetchData<{ ok: true }>('/admin/auth/logout', {
      method: 'POST'
    }),
  getStores: () => fetchRows('/stores'),
  getStoresPage: (query: TableQuery) => fetchPagedRows<AdminRecord>(pagedPath('/stores', query), query),
  updateStore: (id: string, input: StoreInput) => sendJson<AdminRecord>(`/stores/${encodeURIComponent(id)}`, 'PATCH', input),
  getFrontPageCategoriesPage: (query: TableQuery) =>
    fetchPagedRows<AdminRecord>(pagedPath('/front-page-categories', query), query),
  getFrontPageCategoryOptions: (query: FrontPageCategoryOptionsQuery = {}) => {
    const searchParams = new URLSearchParams();
    if (query.onlyUnlinkedGames) {
      searchParams.set('only_unlinked_games', 'true');
    }
    const queryString = searchParams.toString();
    return fetchRows<FrontPageCategoryOption>(`/front-page-category-options${queryString ? `?${queryString}` : ''}`);
  },
  getFrontPageCategoryProducts: (categoryType: FrontPageCategoryInput['category_type'], categoryId: number | string) =>
    fetchRows<FrontPageCategoryProduct>(
      `/front-page-category-options/${encodeURIComponent(categoryType)}/${encodeURIComponent(String(categoryId))}/products`
    ),
  createFrontPageCategory: (input: FrontPageCategoryInput) =>
    sendJson<AdminRecord>('/front-page-categories', 'POST', input),
  updateFrontPageCategory: (id: string, input: FrontPageCategoryInput) =>
    sendJson<AdminRecord>(`/front-page-categories/${encodeURIComponent(id)}`, 'PATCH', input),
  deleteFrontPageCategory: (id: string) =>
    fetchData<AdminRecord>(`/front-page-categories/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    }),
  assignRandomFrontPageCategoryItems: () =>
    fetchData<FrontPageCategoryRandomAssignmentResult>('/front-page-categories/random-item-assignments', {
      method: 'POST'
    }),
  assignBalancedFrontPageCategoryItems: () =>
    fetchData<FrontPageCategoryRandomAssignmentResult>('/front-page-categories/balanced-random-item-assignments', {
      method: 'POST'
    }),
  getFrontPagePreview: () => fetchRows<FrontPagePreviewCategory>('/front-page-preview'),
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
  deleteItemCandidate: (id: string) =>
    fetchData<AdminRecord>(`/discovery/listings/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    }),
  createItemFromCandidate: (id: string, input: CreateItemFromCandidateInput = {}) =>
    sendJson<AdminRecord>(`/discovery/listings/${encodeURIComponent(id)}/create-item`, 'POST', {
      bgg_id: input.bgg_id ?? '',
      implements: Boolean(input.implements),
      ...(input.extends
        ? {
            extends: true,
            extends_item_id: input.extends_item_id ?? ''
          }
        : {})
    }),
  createItemFromBggId: (id: string, bggId: string) =>
    sendJson<AdminRecord>(`/discovery/listings/${encodeURIComponent(id)}/create-item-from-bgg`, 'POST', {
      bgg_id: bggId
    }),
  confirmItemCandidateBoardgame: (id: string) =>
    fetchData<AdminRecord>(`/discovery/listings/${encodeURIComponent(id)}/confirm-boardgame`, {
      method: 'POST'
    }),
  associateItemCandidate: (id: string, itemId: string) =>
    sendJson<AdminRecord>(`/discovery/listings/${encodeURIComponent(id)}/associate-item`, 'POST', {
      item_id: itemId
    }),
  updateItemCandidateListingStatus: (id: string, listingStatus: StoreItemListingStatus) =>
    sendJson<AdminRecord>(`/discovery/listings/${encodeURIComponent(id)}/listing-status`, 'PATCH', {
      listing_status: listingStatus
    }),
  updateItemCandidate: (id: string, input: ItemCandidateInput) =>
    sendJson<AdminRecord>(`/discovery/listings/${encodeURIComponent(id)}`, 'PATCH', input),
  getItem: (id: string) => fetchData<AdminRecord>(`/items/${encodeURIComponent(id)}`),
  getItemLinkedCandidates: (id: string) => fetchRows(`/items/${encodeURIComponent(id)}/candidates`),
  getItemRelationships: (id: string) => fetchRows(`/items/${encodeURIComponent(id)}/relationships`),
  getItemStoreItems: (id: string) => fetchRows(`/items/${encodeURIComponent(id)}/store-items`),
  getItemTaxonomy: (id: string) => fetchData<ItemTaxonomy>(`/items/${encodeURIComponent(id)}/taxonomy`),
  getItemsPage: (query: TableQuery) => fetchPagedRows<AdminRecord>(pagedPath('/items', query), query),
  createItemRelationship: (id: string, input: ItemRelationshipInput) =>
    sendJson<AdminRecord>(`/items/${encodeURIComponent(id)}/relationships`, 'POST', input),
  deleteItemRelationship: (itemId: string, relationshipId: string) =>
    fetchData<AdminRecord>(
      `/items/${encodeURIComponent(itemId)}/relationships/${encodeURIComponent(relationshipId)}`,
      {
        method: 'DELETE'
      }
    ),
  updateItem: (id: string, input: ItemInput) => sendJson<AdminRecord>(`/items/${encodeURIComponent(id)}`, 'PATCH', input),
  getListingCandidates: () => fetchRows('/discovery/listings'),
  generateDescription: (input: DescriptionGenerationInput) =>
    sendJson<DescriptionGenerationResult>('/admin/description-generations', 'POST', input),
  getOfferReviews: () => fetchRows('/admin/discovery/offer-reviews'),
  getOfferReviewsPage: (query: TableQuery) => fetchPagedRows<AdminRecord>(pagedPath('/admin/discovery/offer-reviews', query), query),
  getReviewTasks: () => fetchRows('/admin/review-tasks'),
  getReviewTasksPage: (query: TableQuery) => fetchPagedRows<AdminRecord>(pagedPath('/admin/review-tasks', query), query),
  getStoreItemDiscoveryJobsPage: (query: TableQuery) =>
    fetchPagedRows<AdminRecord>(pagedPath('/admin/operations/store-item-discovery-jobs', query), query),
  getStoreItemDiscoveryJobLog: (jobId: string, afterId = 0) =>
    fetchData<StoreItemDiscoveryJobLog>(
      `/admin/operations/store-item-discovery-jobs/${encodeURIComponent(jobId)}/log?after_id=${encodeURIComponent(afterId)}`
    ),
  getStoreItemUpdateJobsPage: (query: TableQuery) =>
    fetchPagedRows<AdminRecord>(pagedPath('/admin/operations/store-item-update-jobs', query), query),
  getStoreItemUpdateHistoryPage: (runId: string, query: TableQuery) =>
    fetchStoreItemUpdateHistoryPage(
      pagedPath(`/admin/operations/store-item-update-jobs/${encodeURIComponent(runId)}/changes`, query),
      query
    ),
  getLatestStoreDiscoveryRun: () => fetchData<StoreDiscoveryRun | null>('/admin/operations/store-discovery-runs/latest'),
  getCurrentLocalCoverWorkflow: () => fetchData<LocalCoverWorkflow | null>('/admin/local-cover-workflows/current'),
  startLocalCoverWorkflow: (storeItemId: string) =>
    sendJson<LocalCoverWorkflow>('/admin/local-cover-workflows', 'POST', {
      store_item_id: storeItemId
    }),
  startItemLocalCoverWorkflow: (itemId: string) =>
    sendJson<LocalCoverWorkflow>('/admin/local-cover-workflows/items', 'POST', {
      item_id: itemId
    }),
  startStoreItemCoverFlattening: (storeItemId: string) =>
    sendJson<CoverFlatteningWorkflow>('/admin/cover-flattening-workflows/store-items', 'POST', {
      store_item_id: storeItemId
    }),
  startItemCoverFlattening: (itemId: string, sourceField: CoverImageField) =>
    sendJson<CoverFlatteningWorkflow>('/admin/cover-flattening-workflows/items', 'POST', {
      item_id: itemId,
      source_field: sourceField
    }),
  getCoverFlatteningCandidate: (workflowId: string, candidateIndex: number) =>
    fetchBlob(
      `/admin/cover-flattening-workflows/${encodeURIComponent(workflowId)}/candidates/${encodeURIComponent(candidateIndex)}`
    ),
  getCoverFlatteningSource: (workflowId: string) =>
    fetchBlob(`/admin/cover-flattening-workflows/${encodeURIComponent(workflowId)}/source`),
  createManualCoverFlatteningCandidate: (workflowId: string, points: CoverPoint[]) =>
    sendJson<CoverFlatteningWorkflow>(
      `/admin/cover-flattening-workflows/${encodeURIComponent(workflowId)}/manual-candidate`,
      'POST',
      { points }
    ),
  acceptCoverFlattening: (
    workflowId: string,
    candidateIndex: number,
    targetField: CoverImageField,
    aspectRatio: number | null,
    trimFraction = 0
  ) =>
    sendJson<AcceptedCoverFlattening>(
      `/admin/cover-flattening-workflows/${encodeURIComponent(workflowId)}/accept`,
      'POST',
      {
        candidate_index: candidateIndex,
        aspect_ratio: aspectRatio,
        target_field: targetField,
        trim_fraction: trimFraction
      }
    ),
  cancelCoverFlattening: (workflowId: string) =>
    fetchData<{ cancelled: true }>(`/admin/cover-flattening-workflows/${encodeURIComponent(workflowId)}`, {
      method: 'DELETE'
    }),
  getStoreDiscoveryRun: (runId: string) =>
    fetchData<StoreDiscoveryRun | null>(`/admin/operations/store-discovery-runs/${encodeURIComponent(runId)}`),
  startStoreItemDiscoveryRun: (storeIdOrScope: string | ItemDiscoveryRunScope) =>
    typeof storeIdOrScope === 'string'
      ? fetchData<StoreDiscoveryRun>(`/admin/operations/stores/${encodeURIComponent(storeIdOrScope)}/item-discovery-runs`, {
          method: 'POST'
        })
      : sendJson<StoreDiscoveryRun>('/admin/operations/item-discovery-runs', 'POST', storeIdOrScope),
  startItemUpdateRun: (scope?: ItemUpdateRunScope) =>
    scope
      ? sendJson<StoreDiscoveryRun>('/admin/operations/item-update-runs', 'POST', scope)
      : fetchData<StoreDiscoveryRun>('/admin/operations/item-update-runs', {
          method: 'POST'
        }),
  startItemEmbeddingRun: (refreshMode: 'full' | 'missing') =>
    sendJson<StoreDiscoveryRun>('/admin/operations/item-embedding-runs', 'POST', {
      refresh_mode: refreshMode
    }),
  startStoreDiscoveryRun: () =>
    fetchData<StoreDiscoveryRun>('/admin/operations/store-discovery-runs', {
      method: 'POST'
    }),
  optimizeExternalCoverImages: () =>
    fetchData<ExternalCoverImageOptimizationResult>('/admin/operations/external-cover-image-optimizations', {
      method: 'POST'
    }),
  cancelStoreDiscoveryRun: (runId: string) =>
    fetchData<StoreDiscoveryRun>(`/admin/operations/store-discovery-runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST'
    })
};
