import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi, type StoreItemUpdateMonitor } from '../api/client';
import { StoreItemUpdateMonitorPage } from './StoreItemUpdateMonitorPage';

const monitor: StoreItemUpdateMonitor = {
  failures_by_store: [{ failures: 3, platform: 'shopify', rate_limited: 3, store_id: 12, store_name: 'Alpha' }],
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

    render(<StoreItemUpdateMonitorPage />);

    expect(await screen.findByRole('heading', { name: 'Store Item Update Monitor' })).toBeInTheDocument();
    expect(screen.getByText('17,280')).toBeInTheDocument();
    expect(screen.getByText('3 HTTP 429 responses')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Store item staleness histogram' })).toBeInTheDocument();
    expect(screen.getByLabelText('24h: 2 items')).toBeInTheDocument();
    expect(screen.getAllByText('Alpha')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Catan' })).toHaveAttribute('href', '#listings?id=501');
    await waitFor(() => expect(adminApi.getStoreItemUpdateMonitor).toHaveBeenCalledWith(48));
  });
});
