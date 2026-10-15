import type { AdminRecord, StoreInput } from './client';

const API_URL = import.meta.env.VITE_ADMIN_API_URL ?? 'http://127.0.0.1:4001';

export type StoreProfileDetection = {
  ai_used: boolean;
  profile: Omit<StoreInput, 'active' | 'status'>;
  unresolved_fields: string[];
};

export type StoreItemStatistics = {
  total_items: number;
  boardgame_true_confirmed_true: number;
  boardgame_true_confirmed_false: number;
  boardgame_false_confirmed_true: number;
  boardgame_false_confirmed_false: number;
  confirmed_boardgame_listed: number;
  confirmed_boardgame_pending: number;
  confirmed_boardgame_rejected: number;
};

export const storeStatisticsApi = {
  getItemStatistics: async (storeId: string, signal?: AbortSignal): Promise<StoreItemStatistics> => {
    const response = await fetch(`${API_URL}/stores/${encodeURIComponent(storeId)}/item-statistics`, {
      credentials: 'include',
      method: 'GET',
      signal
    });
    return readResponse<StoreItemStatistics>(response);
  }
};

export const storeCreationApi = {
  createStore: (input: StoreInput) => sendJson<AdminRecord>('/stores', input),
  detectStoreProfile: (websiteUrl: string) =>
    sendJson<StoreProfileDetection>('/admin/store-profile-detections', { website_url: websiteUrl })
};

async function sendJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    body: JSON.stringify(body),
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  });
  return readResponse<T>(response);
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message || `Request failed with status ${response.status}`);
  }
  if (!('data' in payload)) {
    throw new Error('Invalid API response: data is required');
  }
  return payload.data as T;
}
