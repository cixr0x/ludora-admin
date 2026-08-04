import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi, type StoreItemUpdateMonitor } from '../api/client';
import { StoreItemUpdateMonitorPage } from './StoreItemUpdateMonitorPage';

const monitor: StoreItemUpdateMonitor = {
  failures_by_store: [{ attempts: 40, failures: 3, platform: 'shopify', rate_limited: 3, store_id: 12, store_name: 'Alpha' }],
  generated_at: '2026-08-04T18:00:00Z',
  histogram: [
    { item_count: 6, label: '0h', overflow: false, staleness_hour: 0 },
    { item_count: 2, label: '24h', overflow: false, staleness_hour: 24 },
    { item_count: 1, label: '48h+', overflow: true, staleness_hour: 48 }
  ],
  range_hours: 48,
  recent_attempts: [{
    duration_ms: 820,
    id: 91,
    started_at: '2026-08-04T17:59:00Z',
    status: 'succeeded',
    store_item_id: 501,
    store_item_title: 'Catan',
    store_name: 'Alpha'
  }],
  summary: {
    attempts_24h: 110,
    daily_capacity: 17280,
    due_items: 12,
    eligible_items: 100,
    failures_24h: 10,
    fresh_items: 92,
    fresh_percent: 92,
    leased_items: 1,
    next_due_at: '2026-08-04T18:00:00Z',
    oldest_due_hours: 2.5,
    oldest_staleness_hours: 48,
    projected_daily_demand: 109,
    projected_utilization_percent: 0.63,
    rate_limited_24h: 3,
    stale_items: 8,
    success_rate_percent: 90.9,
    successes_24h: 100
  },
  worker: {
    health: 'healthy',
    heartbeat_at: '2026-08-04T18:00:00Z',
    shopify_blocked_until: '2026-08-04T19:00:00Z',
    shopify_is_blocked: true,
    status: 'idle'
  }
};

describe('StoreItemUpdateMonitorPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders worker health, cadence metrics, hourly staleness, and recent failures', async () => {
    vi.spyOn(adminApi, 'getStoreItemUpdateMonitor').mockResolvedValue(monitor);
    vi.spyOn(adminApi, 'getStoreItemUpdateFailureAttempts').mockResolvedValue([{
      duration_ms: 950,
      error: 'HTTP 429: Too Many Requests',
      http_status: 429,
      id: 92,
      platform: 'shopify',
      source_url: 'https://alpha.example/products/catan',
      started_at: '2026-08-04T17:58:00Z',
      status: 'failed',
      store_id: 12,
      store_item_id: 502,
      store_item_title: 'Catan Junior',
      store_name: 'Alpha'
    }]);

    render(<StoreItemUpdateMonitorPage />);

    expect(await screen.findByRole('heading', { name: 'Store Item Update Monitor' })).toBeInTheDocument();
    expect(screen.getByText('17,280')).toBeInTheDocument();
    expect(screen.getByText('3 HTTP 429 responses')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Store item staleness histogram' })).toBeInTheDocument();
    expect(screen.getByLabelText('24h: 2 items')).toBeInTheDocument();
    expect(screen.getAllByText('Alpha')).toHaveLength(2);
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Catan' })).toHaveAttribute('href', '#listings?id=501');
    await userEvent.click(screen.getByRole('button', { name: 'View failed attempts for Alpha (shopify)' }));
    expect(await screen.findByText('HTTP 429: Too Many Requests')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Catan Junior' })).toHaveAttribute('href', '#listings?id=502');
    expect(adminApi.getStoreItemUpdateFailureAttempts).toHaveBeenCalledWith('12', 'shopify', 24);
    await waitFor(() => expect(adminApi.getStoreItemUpdateMonitor).toHaveBeenCalledWith(48));
  });
});
