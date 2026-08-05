import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi, type StoreItemUpdateMonitor } from '../api/client';
import { StoreItemUpdateMonitorPage } from './StoreItemUpdateMonitorPage';

const monitor: StoreItemUpdateMonitor = {
  control_status: 'running',
  generated_at: '2026-08-04T18:00:00Z',
  histogram: [
    { item_count: 6, label: '0h', overflow: false, staleness_hour: 0 },
    { item_count: 2, label: '24h', overflow: false, staleness_hour: 24 },
    { item_count: 1, label: '48h+', overflow: true, staleness_hour: 48 }
  ],
  histogram_store_id: null,
  platform_cooldowns: [
    {
      active: false,
      blocked_until: null,
      consecutive_429s: 0,
      platform: 'shopify'
    },
    {
      active: true,
      blocked_until: '2026-08-04T19:00:00Z',
      consecutive_429s: 2,
      platform: 'woocommerce'
    }
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
  store_statistics: [
    {
      attempts: 40,
      eligible_items: 120,
      failures: 3,
      last_attempt_at: '2026-08-04T17:59:00Z',
      platform: 'shopify',
      rate_limited: 3,
      store_id: 12,
      store_name: 'Alpha',
      success_rate_percent: 92.5,
      successes: 37
    },
    {
      attempts: 0,
      eligible_items: 45,
      failures: 0,
      last_attempt_at: null,
      platform: 'woocommerce',
      rate_limited: 0,
      store_id: 13,
      store_name: 'Beta',
      success_rate_percent: 0,
      successes: 0
    }
  ],
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

  it('renders worker health, cadence metrics, hourly staleness, and every active store', async () => {
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
    expect(screen.getByText(/WooCommerce paused until/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause automatic updates' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Store item staleness histogram' })).toBeInTheDocument();
    expect(screen.getByLabelText('24h: 2 items')).toBeInTheDocument();
    expect(screen.getByText('All stores')).toBeInTheDocument();
    expect(screen.getByText(/Showing all active stores/)).toBeInTheDocument();
    expect(screen.getAllByText('Alpha')).toHaveLength(2);
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Store update statistics · last 24h' })).toBeInTheDocument();
    expect(screen.getByText(/All 2 active stores/)).toBeInTheDocument();
    expect(screen.getByText('92.5%')).toBeInTheDocument();
    expect(screen.getByText('No data')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Catan' })).toHaveAttribute('href', '#listings?id=501');
    await userEvent.click(screen.getByRole('button', { name: 'View failed attempts for Alpha (shopify)' }));
    expect(await screen.findByText('HTTP 429: Too Many Requests')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Catan Junior' })).toHaveAttribute('href', '#listings?id=502');
    expect(adminApi.getStoreItemUpdateFailureAttempts).toHaveBeenCalledWith('12', 24);
    await waitFor(() => expect(adminApi.getStoreItemUpdateMonitor).toHaveBeenCalledWith(48, undefined));

    await userEvent.click(screen.getByLabelText('Histogram store'));
    await userEvent.click(screen.getByRole('option', { name: 'Alpha' }));

    await waitFor(() => expect(adminApi.getStoreItemUpdateMonitor).toHaveBeenCalledWith(48, 12));
    expect(screen.getByText(/Showing Alpha/)).toBeInTheDocument();
  });

  it('pauses the automatic updater and refreshes monitor state', async () => {
    vi.spyOn(adminApi, 'getStoreItemUpdateMonitor').mockResolvedValue(monitor);
    vi.spyOn(adminApi, 'getStoreItemUpdateFailureAttempts').mockResolvedValue([]);
    const pause = vi.spyOn(adminApi, 'pauseContinuousStoreItemUpdates').mockResolvedValue({ status: 'stopping' });

    render(<StoreItemUpdateMonitorPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Pause automatic updates' }));

    await waitFor(() => expect(pause).toHaveBeenCalledOnce());
    await waitFor(() => expect(adminApi.getStoreItemUpdateMonitor).toHaveBeenCalledTimes(2));
  });

  it('renders stopping and paused controls and resumes the updater', async () => {
    const getMonitor = vi.spyOn(adminApi, 'getStoreItemUpdateMonitor')
      .mockResolvedValueOnce({ ...monitor, control_status: 'stopping' })
      .mockResolvedValue({ ...monitor, control_status: 'paused' });
    vi.spyOn(adminApi, 'getStoreItemUpdateFailureAttempts').mockResolvedValue([]);
    const resume = vi.spyOn(adminApi, 'resumeContinuousStoreItemUpdates').mockResolvedValue({ status: 'running' });

    render(<StoreItemUpdateMonitorPage />);

    const stopping = await screen.findByRole('button', { name: 'Stopping automatic updates' });
    expect(stopping).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const resumeButton = await screen.findByRole('button', { name: 'Resume automatic updates' });
    await userEvent.click(resumeButton);

    await waitFor(() => expect(resume).toHaveBeenCalledOnce());
    expect(getMonitor).toHaveBeenCalledTimes(3);
  });

  it('keeps the monitor visible when a pause request fails', async () => {
    vi.spyOn(adminApi, 'getStoreItemUpdateMonitor').mockResolvedValue(monitor);
    vi.spyOn(adminApi, 'getStoreItemUpdateFailureAttempts').mockResolvedValue([]);
    vi.spyOn(adminApi, 'pauseContinuousStoreItemUpdates').mockRejectedValue(new Error('Pause failed'));

    render(<StoreItemUpdateMonitorPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Pause automatic updates' }));

    expect(await screen.findByText('Pause failed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Store Item Update Monitor' })).toBeInTheDocument();
  });
});
