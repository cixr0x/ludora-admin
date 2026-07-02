export type StoreDiscoveryRunStatus = 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed';

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

export type DiscoveryOperationsClient = {
  cancelStoreDiscoveryRun(runId: string): Promise<StoreDiscoveryRun>;
  getLatestStoreDiscoveryRun(): Promise<StoreDiscoveryRun | null>;
  getStoreDiscoveryRun(runId: string): Promise<StoreDiscoveryRun | null>;
  startItemDiscoveryRun(storeId: number, websiteUrl: string, platform?: string, storeName?: string): Promise<StoreDiscoveryRun>;
  startItemEmbeddingRun(refreshMode: 'full' | 'missing'): Promise<StoreDiscoveryRun>;
  startItemUpdateRun(): Promise<StoreDiscoveryRun>;
  startStoreDiscoveryRun(): Promise<StoreDiscoveryRun>;
};

export class DiscoveryOperationError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}
