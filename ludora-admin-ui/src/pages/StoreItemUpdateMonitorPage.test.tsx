import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi, type StoreItemUpdateMonitor } from '../api/client';
import { StoreItemUpdateMonitorPage } from './StoreItemUpdateMonitorPage';

const completedManualScheduleRun = {
  automatic_schedule_date: null,
  completed_at: '2026-08-05T10:00:01.000Z',
  error_detail: '',
  id: 9,
  scheduled_item_count: 100,
  scheduled_store_count: 4,
  started_at: '2026-08-05T10:00:00.000Z',
  status: 'COMPLETED' as const,
  trigger: 'MANUAL' as const,
  window_end: '2026-08-06T06:00:00.000Z',
  window_start: '2026-08-05T10:00:00.000Z'
};

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const monitor: StoreItemUpdateMonitor = {
  control_status: 'running',
  generated_at: '2026-08-04T18:00:00Z',
  histogram: [
    { item_count: 6, label: '0h', overflow: false, staleness_hour: 0 },
    { item_count: 2, label: '24h', overflow: false, staleness_hour: 24 },
    { item_count: 1, label: '48h+', overflow: true, staleness_hour: 48 }
  ],
  histogram_store_id: null,
  latest_automatic_schedule_run: {
    ...completedManualScheduleRun,
    automatic_schedule_date: '2026-08-04',
    id: 8,
    trigger: 'AUTOMATIC'
  },
  latest_schedule_attempt: completedManualScheduleRun,
  latest_schedule_run: completedManualScheduleRun,
  store_cooldowns: [
    {
      active: false,
      blocked_until: null,
      consecutive_429s: 0,
      platform: 'shopify',
      store_id: 12,
      store_name: 'Alpha'
    },
    {
      active: true,
      blocked_until: '2026-08-04T19:00:00Z',
      consecutive_429s: 2,
      platform: 'woocommerce',
      store_id: 13,
      store_name: 'Beta'
    }
  ],
  range_hours: 48,
  recent_attempts: [{
    duration_ms: 820,
    id: 91,
    started_at: '2026-08-04T17:59:00Z',
    status: 'deactivated',
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
      stale_items: 7,
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
      stale_items: 3,
      success_rate_percent: 0,
      successes: 0
    },
    {
      attempts: 0,
      eligible_items: 0,
      failures: 0,
      last_attempt_at: null,
      platform: 'unknown',
      rate_limited: 0,
      store_id: 14,
      store_name: 'Gamma',
      stale_items: 0,
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
    scheduled_items: 96,
    scheduled_later_items: 84,
    schedule_utilization_percent: 100,
    schedule_window_capacity: 16560,
    schedule_window_hours: 23,
    stale_items: 8,
    success_rate_percent: 90.9,
    successes_24h: 100,
    unscheduled_items: 4
  },
  worker: {
    health: 'healthy',
    heartbeat_at: '2026-08-04T18:00:00Z',
    status: 'idle'
  }
};

describe('StoreItemUpdateMonitorPage', () => {
  it.each(['loading', 'unavailable'] as const)('keeps live status and actions visible with %s totals', async (status) => {
    vi.spyOn(adminApi, 'getStoreItemUpdateMonitor').mockResolvedValue({
      ...monitor,
      schedule_mode: 'per_store',
      live_queue: { due_items: 3, scheduled_items: 10, scheduled_later_items: 7, oldest_due_hours: 2, next_due_at: '2026-08-04T18:00:00Z' },
      report: { status, as_of: null, refreshing: status === 'loading' },
      summary: null,
      histogram: [],
      store_statistics: []
    });

    render(<StoreItemUpdateMonitorPage />);

    expect(await screen.findByText(/Worker: healthy/)).toBeInTheDocument();
    expect(screen.getByText(/Beta paused until/)).toBeInTheDocument();
    expect(screen.getByText(/10 pending store slots.*Earliest pending cursor time/)).toBeInTheDocument();
    expect(screen.getByText('Due store cursors')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause automatic updates' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Initialize store schedule' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Catan' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(status === 'loading' ? 'Loading totals' : 'Totals are temporarily unavailable');
    expect(screen.queryByText('Eligible items')).not.toBeInTheDocument();
    expect(screen.queryByText('No stores with updates enabled')).not.toBeInTheDocument();
  });

  it('labels stale totals by their observation time and hides the old histogram during filter changes', async () => {
    const filtered = deferred<StoreItemUpdateMonitor>();
    const asOf = '2026-08-04T17:55:00Z';
    const staleMonitor = { ...monitor, report: { status: 'stale' as const, as_of: asOf, refreshing: true } };
    vi.spyOn(adminApi, 'getStoreItemUpdateMonitor').mockResolvedValueOnce(staleMonitor).mockReturnValue(filtered.promise);
    const user = userEvent.setup();

    render(<StoreItemUpdateMonitorPage />);

    expect(await screen.findByRole('status')).toHaveTextContent('Totals as of');
    expect(screen.getByRole('status').querySelector('time')).toHaveAttribute('datetime', asOf);
    expect(screen.getByRole('status')).toHaveTextContent('stale');
    expect(screen.getByText(/Live status as of/).querySelector('time')).toHaveAttribute('datetime', monitor.generated_at);
    expect(screen.getByLabelText('24h: 2 items')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Histogram' }));
    await user.click(screen.getByRole('option', { name: '72 hours' }));
    expect(screen.queryByRole('img', { name: 'Store item staleness histogram' })).not.toBeInTheDocument();
    expect(screen.getByText('Loading the selected histogram…')).toBeInTheDocument();
    await act(async () => filtered.resolve({ ...staleMonitor, range_hours: 72 }));
    expect(await screen.findByRole('img', { name: 'Store item staleness histogram' })).toBeInTheDocument();
  });

  it('describes pending per-store cursors and confirms daily initialization without resetting progress', async () => {
    const user = userEvent.setup();
    vi.spyOn(adminApi, 'getStoreItemUpdateMonitor').mockResolvedValue({ ...monitor, schedule_mode: 'per_store' });
    const runSchedule = vi.spyOn(adminApi, 'runStoreItemUpdateSchedule').mockResolvedValue(completedManualScheduleRun);

    render(<StoreItemUpdateMonitorPage />);

    expect(await screen.findByText('Due store cursors')).toBeInTheDocument();
    expect(screen.getByText('Pending store slots')).toBeInTheDocument();
    expect(screen.getByText(/earliest pending cursor time/i)).toBeInTheDocument();
    expect(screen.getByText(/elapsed slots awaiting processing and stores on cooldown/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Initialize store schedule' }));
    expect(within(screen.getByRole('dialog')).getByText(/existing schedule keeps its progress/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm initialization' }));
    expect(await screen.findByText(/daily schedule ready for 4 stores/i)).toBeInTheDocument();
    expect(runSchedule).toHaveBeenCalledOnce();
  });


  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips polling while a report is pending and resumes after a failure', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const firstReport = deferred<StoreItemUpdateMonitor>();
    const getMonitor = vi.spyOn(adminApi, 'getStoreItemUpdateMonitor')
      .mockReturnValueOnce(firstReport.promise)
      .mockResolvedValue(monitor);

    render(<StoreItemUpdateMonitorPage />);

    await act(async () => vi.advanceTimersByTime(45_000));
    expect(getMonitor).toHaveBeenCalledOnce();

    await act(async () => firstReport.reject(new Error('Report failed')));
    expect(screen.getByText('Report failed')).toBeInTheDocument();
    expect(getMonitor).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTime(15_000));
    expect(getMonitor).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Report failed')).not.toBeInTheDocument();
  });

  it('loads only the latest filters once the pending report settles', async () => {
    const pendingReport = deferred<StoreItemUpdateMonitor>();
    const getMonitor = vi.spyOn(adminApi, 'getStoreItemUpdateMonitor')
      .mockResolvedValueOnce(monitor)
      .mockReturnValueOnce(pendingReport.promise)
      .mockResolvedValue({ ...monitor, range_hours: 72, histogram_store_id: 12 });
    const user = userEvent.setup();

    render(<StoreItemUpdateMonitorPage />);
    await user.click(await screen.findByRole('button', { name: 'Refresh' }));
    await user.click(screen.getByRole('combobox', { name: 'Histogram' }));
    await user.click(screen.getByRole('option', { name: '72 hours' }));
    await user.click(screen.getByLabelText('Histogram store'));
    await user.click(screen.getByRole('option', { name: 'Alpha' }));
    expect(getMonitor).toHaveBeenCalledTimes(2);

    await act(async () => pendingReport.reject(new Error('Stale report failed')));

    expect(getMonitor).toHaveBeenCalledTimes(3);
    expect(getMonitor).toHaveBeenLastCalledWith(72, 12);
    expect(screen.queryByText('Stale report failed')).not.toBeInTheDocument();
  });

  it('drops a queued refresh when leaving the page', async () => {
    const pendingReport = deferred<StoreItemUpdateMonitor>();
    const getMonitor = vi.spyOn(adminApi, 'getStoreItemUpdateMonitor')
      .mockResolvedValueOnce(monitor)
      .mockReturnValueOnce(pendingReport.promise)
      .mockResolvedValue(monitor);
    const user = userEvent.setup();

    const { unmount } = render(<StoreItemUpdateMonitorPage />);
    await user.click(await screen.findByRole('button', { name: 'Refresh' }));
    await user.click(screen.getByRole('combobox', { name: 'Histogram' }));
    await user.click(screen.getByRole('option', { name: '72 hours' }));
    unmount();
    await act(async () => pendingReport.resolve(monitor));

    expect(getMonitor).toHaveBeenCalledTimes(2);
  });

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
    expect(screen.getByText('16,560')).toBeInTheDocument();
    expect(screen.getByText('3 HTTP 429 responses')).toBeInTheDocument();
    expect(screen.getByText('96')).toBeInTheDocument();
    expect(screen.getByText('Scheduled later')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText(/Applied schedule: MANUAL COMPLETED/)).toBeInTheDocument();
    expect(screen.getByText(/Latest schedule attempt: MANUAL COMPLETED/)).toBeInTheDocument();
    expect(screen.getByText(/Latest automatic schedule: AUTOMATIC COMPLETED/)).toBeInTheDocument();
    expect(screen.getByText(/Applied schedule:.*8\/5\/2026, 4:00:00 AM America\/Mexico_City/)).toBeInTheDocument();
    expect(screen.getByText(/23-hour scheduling window/)).toBeInTheDocument();
    expect(screen.getByText(/Schedule capacity is fully utilized or exceeded/)).toBeInTheDocument();
    expect(screen.getByText(/Beta paused until/)).toBeInTheDocument();
    expect(screen.queryByText(/WooCommerce paused until/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause automatic updates' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Store item staleness histogram' })).toBeInTheDocument();
    expect(screen.getByLabelText('24h: 2 items')).toBeInTheDocument();
    expect(screen.getByText('All stores')).toBeInTheDocument();
    expect(screen.getByText(/Showing all stores with updates enabled/)).toBeInTheDocument();
    expect(screen.getAllByText('Alpha')).toHaveLength(2);
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Store update statistics · last 24h' })).toBeInTheDocument();
    expect(screen.getByText(/All 3 stores with updates enabled/)).toBeInTheDocument();
    expect(screen.getByText('92.5%')).toBeInTheDocument();
    expect(screen.getAllByText('No data')).toHaveLength(2);
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Catan' })).toHaveAttribute('href', '#listings?id=501');
    expect(screen.getByText('unavailable')).toBeInTheDocument();
    expect(screen.queryByText('deactivated')).not.toBeInTheDocument();
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

  it('shows current stale inventory per store independently of attempts in the last 24 hours', async () => {
    vi.spyOn(adminApi, 'getStoreItemUpdateMonitor').mockResolvedValue(monitor);
    vi.spyOn(adminApi, 'getStoreItemUpdateFailureAttempts').mockResolvedValue([]);

    render(<StoreItemUpdateMonitorPage />);

    const staleHeader = await screen.findByRole('columnheader', { name: 'Stale items' });
    const table = staleHeader.closest('table')!;
    expect(within(table).getAllByRole('columnheader').slice(2, 5).map((cell) => cell.textContent)).toEqual([
      'Products', 'Stale items', 'Attempts'
    ]);
    const alphaCells = within(within(table).getByRole('row', { name: /^Alpha shopify/ })).getAllByRole('cell');
    const betaCells = within(within(table).getByRole('row', { name: /^Beta woocommerce/ })).getAllByRole('cell');
    const gammaCells = within(within(table).getByRole('row', { name: /^Gamma unknown/ })).getAllByRole('cell');
    expect(alphaCells.slice(2, 5).map((cell) => cell.textContent)).toEqual(['120', '7', '40']);
    expect(betaCells.slice(2, 5).map((cell) => cell.textContent)).toEqual(['45', '3', '0']);
    expect(gammaCells.slice(2, 5).map((cell) => cell.textContent)).toEqual(['0', '0', '0']);
  });

  it('spans every statistics column when no stores have updates enabled', async () => {
    vi.spyOn(adminApi, 'getStoreItemUpdateMonitor').mockResolvedValue({ ...monitor, store_statistics: [] });
    vi.spyOn(adminApi, 'getStoreItemUpdateFailureAttempts').mockResolvedValue([]);

    render(<StoreItemUpdateMonitorPage />);

    const emptyCell = await screen.findByRole('cell', { name: 'No stores with updates enabled' });
    expect(emptyCell).toHaveAttribute('colspan', '11');
    expect(within(emptyCell.closest('table')!).getAllByRole('columnheader')).toHaveLength(11);
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

  it('warns when schedule utilization reaches 90 percent', async () => {
    vi.spyOn(adminApi, 'getStoreItemUpdateMonitor').mockResolvedValue({
      ...monitor,
      summary: { ...monitor.summary!, schedule_utilization_percent: 90 }
    });
    vi.spyOn(adminApi, 'getStoreItemUpdateFailureAttempts').mockResolvedValue([]);

    render(<StoreItemUpdateMonitorPage />);

    expect(await screen.findByText(/Schedule utilization is at 90.0% of the 23-hour window/)).toBeInTheDocument();
  });

  it('confirms redistribution, refreshes the monitor, and reports scheduled volume', async () => {
    const getMonitor = vi.spyOn(adminApi, 'getStoreItemUpdateMonitor').mockResolvedValue(monitor);
    vi.spyOn(adminApi, 'getStoreItemUpdateFailureAttempts').mockResolvedValue([]);
    const runSchedule = vi.spyOn(adminApi, 'runStoreItemUpdateSchedule').mockResolvedValue(completedManualScheduleRun);
    const user = userEvent.setup();

    render(<StoreItemUpdateMonitorPage />);

    await user.click(await screen.findByRole('button', { name: 'Redistribute update schedule' }));
    expect(screen.getByText(/new 23-hour window/i)).toBeInTheDocument();
    expect(screen.getByText(/including products already updated today and failures in backoff/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm redistribution' }));

    await waitFor(() => expect(runSchedule).toHaveBeenCalledOnce());
    await waitFor(() => expect(getMonitor).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Scheduled 100 items across 4 stores.*Applied window.*America\/Mexico_City/i)).toBeInTheDocument();
  });

  it.each([
    ['FAILED', 'distribution failed after lock acquisition'],
    ['RUNNING', '']
  ] as const)(
    'keeps the completed manual window visible when the latest attempt is %s',
    async (status, errorDetail) => {
      vi.spyOn(adminApi, 'getStoreItemUpdateMonitor').mockResolvedValue({
        ...monitor,
        latest_schedule_attempt: {
          ...completedManualScheduleRun,
          completed_at: status === 'FAILED' ? '2026-08-05T11:00:01.000Z' : null,
          error_detail: errorDetail,
          id: 10,
          scheduled_item_count: 0,
          scheduled_store_count: 0,
          started_at: '2026-08-05T11:00:00.000Z',
          status,
          window_end: '2026-08-06T07:00:00.000Z',
          window_start: '2026-08-05T11:00:00.000Z'
        }
      });
      vi.spyOn(adminApi, 'getStoreItemUpdateFailureAttempts').mockResolvedValue([]);

      render(<StoreItemUpdateMonitorPage />);

      expect(await screen.findByText(/Applied schedule: MANUAL COMPLETED/)).toBeInTheDocument();
      expect(screen.getByText(new RegExp(`Latest schedule attempt: MANUAL ${status}`))).toBeInTheDocument();
      if (status === 'FAILED') {
        expect(screen.getByText(new RegExp(errorDetail))).toBeInTheDocument();
      } else {
        expect(screen.queryByText(errorDetail || 'distribution failed after lock acquisition')).not.toBeInTheDocument();
      }
    }
  );

  it('disables schedule confirmation while redistribution is pending', async () => {
    vi.spyOn(adminApi, 'getStoreItemUpdateMonitor').mockResolvedValue(monitor);
    vi.spyOn(adminApi, 'getStoreItemUpdateFailureAttempts').mockResolvedValue([]);
    let resolveSchedule: (value: typeof completedManualScheduleRun) => void;
    const runSchedule = vi.spyOn(adminApi, 'runStoreItemUpdateSchedule').mockReturnValue(
      new Promise((resolve) => { resolveSchedule = resolve; })
    );
    const user = userEvent.setup();

    render(<StoreItemUpdateMonitorPage />);

    await user.click(await screen.findByRole('button', { name: 'Redistribute update schedule' }));
    await user.click(screen.getByRole('button', { name: 'Confirm redistribution' }));

    await waitFor(() => expect(runSchedule).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Redistributing schedule' })).toBeDisabled();
    resolveSchedule!(completedManualScheduleRun);
    await screen.findByText(/Scheduled 100 items across 4 stores/i);
  });

  it('retains the monitor page when schedule redistribution conflicts', async () => {
    vi.spyOn(adminApi, 'getStoreItemUpdateMonitor').mockResolvedValue(monitor);
    vi.spyOn(adminApi, 'getStoreItemUpdateFailureAttempts').mockResolvedValue([]);
    vi.spyOn(adminApi, 'runStoreItemUpdateSchedule').mockRejectedValue(
      new Error('A store item update schedule run is already in progress')
    );
    const user = userEvent.setup();

    render(<StoreItemUpdateMonitorPage />);

    await user.click(await screen.findByRole('button', { name: 'Redistribute update schedule' }));
    await user.click(screen.getByRole('button', { name: 'Confirm redistribution' }));

    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A store item update schedule run is already in progress');
    expect(screen.getByText('Store Item Update Monitor', { selector: 'h4' })).toBeInTheDocument();
  });

  it('keeps a schedule conflict visible when an older monitor refresh completes', async () => {
    const oldRefresh = deferred<StoreItemUpdateMonitor>();
    vi.spyOn(adminApi, 'getStoreItemUpdateMonitor')
      .mockResolvedValueOnce(monitor)
      .mockReturnValueOnce(oldRefresh.promise);
    vi.spyOn(adminApi, 'getStoreItemUpdateFailureAttempts').mockResolvedValue([]);
    vi.spyOn(adminApi, 'runStoreItemUpdateSchedule').mockRejectedValue(
      new Error('A store item update schedule run is already in progress')
    );
    const user = userEvent.setup();

    render(<StoreItemUpdateMonitorPage />);

    await user.click(await screen.findByRole('button', { name: 'Refresh' }));
    await user.click(screen.getByRole('button', { name: 'Redistribute update schedule' }));
    await user.click(screen.getByRole('button', { name: 'Confirm redistribution' }));

    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A store item update schedule run is already in progress');
    oldRefresh.resolve(monitor);
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('A store item update schedule run is already in progress'));
  });

  it('queues the post-schedule refresh behind a pending report', async () => {
    const oldRefresh = deferred<StoreItemUpdateMonitor>();
    const freshMonitor: StoreItemUpdateMonitor = {
      ...monitor,
      store_statistics: [{ ...monitor.store_statistics[0], store_name: 'Fresh Store' }]
    };
    const getMonitor = vi.spyOn(adminApi, 'getStoreItemUpdateMonitor')
      .mockResolvedValueOnce(monitor)
      .mockReturnValueOnce(oldRefresh.promise)
      .mockResolvedValueOnce(freshMonitor);
    vi.spyOn(adminApi, 'getStoreItemUpdateFailureAttempts').mockResolvedValue([]);
    vi.spyOn(adminApi, 'runStoreItemUpdateSchedule').mockResolvedValue(completedManualScheduleRun);
    const user = userEvent.setup();

    render(<StoreItemUpdateMonitorPage />);

    await user.click(await screen.findByRole('button', { name: 'Refresh' }));
    await user.click(screen.getByRole('button', { name: 'Redistribute update schedule' }));
    await user.click(screen.getByRole('button', { name: 'Confirm redistribution' }));
    expect(await screen.findByText(/Scheduled 100 items across 4 stores/i)).toBeInTheDocument();
    expect(getMonitor).toHaveBeenCalledTimes(2);

    await act(async () => {
      oldRefresh.resolve(monitor);
      await oldRefresh.promise;
    });
    expect(await screen.findByText('Fresh Store')).toBeInTheDocument();
    expect(getMonitor).toHaveBeenCalledTimes(3);
  });
});
