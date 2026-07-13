import type { AdminRecord, StoreInput } from './client';

const API_URL = import.meta.env.VITE_ADMIN_API_URL ?? 'http://127.0.0.1:4001';

export type StoreProfileDetection = {
  ai_used: boolean;
  profile: Omit<StoreInput, 'status'>;
  unresolved_fields: string[];
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
