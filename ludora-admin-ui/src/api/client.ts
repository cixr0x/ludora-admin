const API_URL = import.meta.env.VITE_ADMIN_API_URL ?? 'http://localhost:4001';
const INVALID_DATA_ERROR = 'Invalid API response: data must be an array';

type DataResponse<T> = {
  data: T[];
};

export type AdminRecord = Record<string, unknown>;

function buildApiUrl(path: string) {
  return `${API_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export async function fetchRows<T extends AdminRecord>(path: string): Promise<T[]> {
  const response = await fetch(buildApiUrl(path));

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  const data = (await response.json()) as DataResponse<T>;
  if (!Array.isArray(data.data)) {
    throw new Error(INVALID_DATA_ERROR);
  }

  return data.data;
}

export const adminApi = {
  getStoreCandidates: () => fetchRows('/discovery/stores'),
  getListingCandidates: () => fetchRows('/discovery/listings'),
  getReviewTasks: () => fetchRows('/admin/review-tasks')
};
