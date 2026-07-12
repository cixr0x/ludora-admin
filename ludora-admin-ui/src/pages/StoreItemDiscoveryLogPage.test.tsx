import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreItemDiscoveryLogPage } from './StoreItemDiscoveryLogPage';

describe('StoreItemDiscoveryLogPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders and formats the discovery trace as console output', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            entries: [
              {
                created_at: '2026-07-11T12:00:00Z',
                event: 'item_discovery.run.start',
                id: 219,
                payload: { store_id: 12 },
                run_id: 'run-19',
                source: 'discovery'
              },
              {
                created_at: '2026-07-11T12:01:00Z',
                event: 'item_discovery.run.completed',
                id: 220,
                payload: { new_items: 7 },
                run_id: 'run-19',
                source: 'discovery'
              }
            ],
            has_more: false,
            job: {
              completed_at: '2026-07-11T12:01:00Z',
              id: 19,
              run_id: 'run-19',
              started_at: '2026-07-11T12:00:00Z',
              status: 'completed',
              store_id: 12,
              store_name: 'Alpha Games'
            },
            next_cursor: 220
          }
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      )
    );

    render(<StoreItemDiscoveryLogPage jobId="19" onBack={() => undefined} />);

    expect(await screen.findByText('completed')).toBeInTheDocument();
    const consoleOutput = screen.getByRole('log', { name: 'Console output for discovery job 19' });
    expect(consoleOutput).toHaveTextContent('[discovery] item_discovery.run.start {"store_id":12}');
    expect(consoleOutput).toHaveTextContent('[discovery] item_discovery.run.completed {"new_items":7}');
    expect(screen.getByText('Alpha Games')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Follow log' })).toBeChecked();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4001/admin/operations/store-item-discovery-jobs/19/log?after_id=0',
      { credentials: 'include' }
    );
  });
});
