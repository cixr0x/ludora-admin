import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoresPage } from './StoresPage';

describe('StoresPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows all eight numeric columns after Domain using only the paginated list request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (pathOf(String(input)) === '/stores') return jsonResponse([{ ...exampleStore, ...exampleStatistics }]);
      throw new Error(`Unexpected request: ${input}`);
    });
    render(<StoresPage />);

    const table = await screen.findByRole('table', { name: 'Stores' });
    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers.slice(0, 12)).toEqual(['Active', 'Name', 'Domain', ...statisticsLabels, 'Website']);
    const row = screen.getByText('Example Juegos').closest('tr')!;
    const cells = within(row).getAllByRole('cell');
    expect(cells.slice(3, 11).map((cell) => cell.textContent)).toEqual(['31', '17', '7', '2', '5', '11', '3', '2']);
    for (const cell of cells.slice(3, 11)) expect(cell).toHaveStyle({ textAlign: 'right' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('page')).toBe('0');
  });

  it('requests server-side statistics sorting and text filtering from the Stores table', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse([{ ...exampleStore, ...exampleStatistics }]));
    render(<StoresPage />);
    await screen.findByText('Example Juegos');

    await user.click(screen.getByRole('button', { name: 'Total items' }));
    await waitFor(() => expect(new URL(String(fetchMock.mock.lastCall?.[0])).searchParams.get('sort')).toBe('total_items'));
    await user.type(screen.getByLabelText('Filter Confirmed boardgames: Listed'), '11');

    await waitFor(() => expect(new URL(String(fetchMock.mock.lastCall?.[0])).searchParams.get('filter_confirmed_boardgame_listed')).toBe('11'));
    expect(new URL(String(fetchMock.mock.lastCall?.[0])).searchParams.get('sort_direction')).toBe('asc');
  });

  it('keeps the original mobile preview and reveals all statistics when expanded', async () => {
    const user = userEvent.setup();
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(), addListener: vi.fn(), dispatchEvent: vi.fn(),
        matches: query.includes('max-width'), media: query, onchange: null,
        removeEventListener: vi.fn(), removeListener: vi.fn()
      }))
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (pathOf(String(input)) === '/stores') return jsonResponse([{ ...exampleStore, ...exampleStatistics }]);
      if (pathOf(String(input)) === '/stores/12/item-statistics') return jsonResponse(exampleStatistics);
      throw new Error(`Unexpected request: ${input}`);
    });
    try {
      render(<StoresPage />);
      const cards = await screen.findByRole('list', { name: 'Stores cards' });
      expect(within(cards).getByText('Website')).toBeVisible();
      expect(within(cards).getByText('Total items')).not.toBeVisible();
      await user.click(within(cards).getByRole('button', { name: /Show .* more fields/ }));
      for (const label of statisticsLabels) expect(within(cards).getByText(label)).toBeVisible();
      expect(within(cards).getByText('31')).toBeVisible();
      await user.click(within(cards).getByRole('button', { name: 'Edit Example Juegos' }));
      expect(screen.getByRole('heading', { name: 'Edit Store' })).toBeInTheDocument();
      expect(await screen.findByRole('region', { name: 'Store item statistics' })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
    }
  });

  it('loads all item counts in store details while preserving the store fields', async () => {
    const user = userEvent.setup();
    const pending = deferredResponse();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (pathOf(String(input)) === '/stores') return jsonResponse([exampleStore]);
      if (pathOf(String(input)) === '/stores/12/item-statistics') return pending.response;
      throw new Error(`Unexpected request: ${input}`);
    });
    render(<StoresPage />);
    expect(screen.queryByRole('region', { name: 'Store item statistics' })).not.toBeInTheDocument();

    await user.dblClick(await screen.findByText('Example Juegos'));

    const statistics = screen.getByRole('region', { name: 'Store item statistics' });
    expect(within(statistics).getByRole('status')).toHaveTextContent('Loading store item statistics');
    expect(within(statistics).queryByText('31')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Example Juegos');
    await act(async () => { pending.resolve(jsonResponse(exampleStatistics)); });

    expect(await within(statistics).findByText('31')).toBeInTheDocument();
    expect(within(statistics).getByText('Total store items')).toBeInTheDocument();
    const classification = within(statistics).getByRole('table', { name: 'Store items by boardgame classification' });
    expect(within(classification).getAllByRole('row').map((row) =>
      within(row).queryAllByRole('cell').map((cell) => cell.textContent)
    )).toEqual([[], ['True', 'True', '17'], ['True', 'False', '7'], ['False', 'True', '2'], ['False', 'False', '5']]);
    const statuses = within(statistics).getByRole('group', { name: 'Confirmed boardgame listing status' });
    expect(within(statuses).getByText('LISTED').nextElementSibling).toHaveTextContent('11');
    expect(within(statuses).getByText('PENDING').nextElementSibling).toHaveTextContent('3');
    expect(within(statuses).getByText('REJECTED').nextElementSibling).toHaveTextContent('2');
    expect(within(statistics).queryByText('UNLISTED')).not.toBeInTheDocument();
  });

  it('displays zero counts when the existing store has no items', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (pathOf(String(input)) === '/stores') return jsonResponse([exampleStore]);
      if (pathOf(String(input)) === '/stores/12/item-statistics') return jsonResponse(emptyStatistics);
      throw new Error(`Unexpected request: ${input}`);
    });
    render(<StoresPage />);

    await user.dblClick(await screen.findByText('Example Juegos'));

    const statistics = screen.getByRole('region', { name: 'Store item statistics' });
    expect(await within(statistics).findAllByText('0')).toHaveLength(8);
    expect(within(statistics).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a statistics error without replacing a failed request with zero counts', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (pathOf(String(input)) === '/stores') return jsonResponse([exampleStore]);
      if (pathOf(String(input)) === '/stores/12/item-statistics') {
        return new Response(JSON.stringify({ error: { message: 'Unavailable' } }), { status: 500 });
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    render(<StoresPage />);

    await user.dblClick(await screen.findByText('Example Juegos'));

    const statistics = screen.getByRole('region', { name: 'Store item statistics' });
    expect(await within(statistics).findByRole('alert')).toHaveTextContent('Store item statistics could not be loaded.');
    expect(within(statistics).queryByText('0')).not.toBeInTheDocument();
    expect(within(statistics).queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Store' })).toBeEnabled();
  });

  it('discards another store’s late statistics after changing stores', async () => {
    const user = userEvent.setup();
    const firstStore = deferredResponse();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (pathOf(String(input)) === '/stores') {
        return jsonResponse([exampleStore, { ...exampleStore, id: 13, name: 'Other Store', canonical_domain: 'other.mx' }]);
      }
      if (pathOf(String(input)) === '/stores/12/item-statistics') return firstStore.response;
      if (pathOf(String(input)) === '/stores/13/item-statistics') return jsonResponse({ ...emptyStatistics, total_items: 99 });
      throw new Error(`Unexpected request: ${input}`);
    });
    render(<StoresPage />);
    await user.dblClick(await screen.findByText('Example Juegos'));
    const firstSignal = fetchMock.mock.calls.find(([input]) => pathOf(String(input)) === '/stores/12/item-statistics')?.[1]?.signal;

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(firstSignal?.aborted).toBe(true);
    await user.dblClick(await screen.findByText('Other Store'));
    const statistics = screen.getByRole('region', { name: 'Store item statistics' });
    expect(await within(statistics).findByText('99')).toBeInTheDocument();
    await act(async () => { firstStore.resolve(jsonResponse(exampleStatistics)); });

    expect(within(statistics).getByText('99')).toBeInTheDocument();
    expect(within(statistics).queryByText('31')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Other Store');
  });

  it('renders clean store table columns and website links', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              active: false,
              canonical_domain: 'example.mx',
              city: 'Ciudad de Mexico',
              country: 'Mexico',
              id: 12,
              logo_url: 'https://example.mx/logo.png',
              name: 'Example Juegos',
              platform: 'shopify',
              state: 'CDMX',
              status: 'active',
              updated_at: '2026-05-25T20:00:00Z',
              website_url: 'https://example.mx/'
            }
          ]
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        }
      )
    );

    render(<StoresPage />);

    for (const heading of ['Active', 'Name', 'Domain', 'Website', 'Platform', 'City', 'State', 'Country', 'Logo', 'Status', 'Updated']) {
      expect(await screen.findByRole('columnheader', { name: heading })).toBeInTheDocument();
    }
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(await screen.findByText('Example Juegos')).toBeInTheDocument();
    expect(screen.getByText('shopify')).toBeInTheDocument();
    expect(screen.getByText('CDMX')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'example.mx' });
    expect(link).toHaveAttribute('href', 'https://example.mx/');
    expect(screen.getByRole('img', { name: 'Example Juegos logo' })).toHaveAttribute(
      'src',
      'https://example.mx/logo.png'
    );
  });

  it('opens a clean store form and saves changes', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/stores' && !init?.method) {
        return jsonResponse([
          {
            active: true,
            ...exampleStatistics,
            canonical_domain: 'example.mx',
            city: 'Ciudad de Mexico',
            country: 'Mexico',
            id: 12,
            name: 'Example Juegos',
            platform: 'amazon',
            state: 'CDMX',
            status: 'active',
            website_url: 'https://example.mx/'
          }
        ]);
      }
      if (url.endsWith('/stores/12/item-statistics')) return jsonResponse(emptyStatistics);
      if (url.endsWith('/stores/12') && init?.method === 'PATCH') {
        return jsonResponse({
          active: false,
          canonical_domain: 'example.mx',
          city: 'Ciudad de Mexico',
            country: 'Mexico',
            id: 12,
            name: 'Example Updated',
            platform: 'shopify',
            state: 'CDMX',
            status: 'active',
            website_url: 'https://example.mx/'
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<StoresPage />);

    await user.dblClick(await screen.findByText('Example Juegos'));
    expect(screen.getByRole('heading', { name: 'Edit Store' })).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Example Updated');
    expect(screen.getByLabelText('Platform')).toHaveValue('amazon');
    await user.clear(screen.getByLabelText('Platform'));
    await user.type(screen.getByLabelText('Platform'), 'shopify');
    await user.click(screen.getByRole('checkbox', { name: 'Active' }));
    await user.click(screen.getByRole('button', { name: 'Save Store' }));

    expect(await screen.findByText('Example Updated')).toBeInTheDocument();
    const updatedRow = screen.getByText('Example Updated').closest('tr')!;
    expect(within(updatedRow).getAllByRole('cell').slice(3, 11).map((cell) => cell.textContent)).toEqual(['31', '17', '7', '2', '5', '11', '3', '2']);
    const patchCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/stores/12') && init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      active: false,
      name: 'Example Updated',
      platform: 'shopify',
      website_url: 'https://example.mx/'
    });
  });

  it('detects website fields and creates a reviewed store', async () => {
    const user = userEvent.setup();
    const createdStore = {
      active: true,
      canonical_domain: 'newstore.mx',
      city: 'Mérida',
      country: 'Mexico',
      facebook_url: 'https://facebook.com/newstore',
      id: 91,
      instagram_url: 'https://instagram.com/newstore',
      logo_url: 'https://newstore.mx/logo.png',
      name: 'New Store',
      platform: 'woocommerce',
      state: 'Yucatán',
      status: 'active',
      website_url: 'https://newstore.mx/'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/stores' && !init?.method) {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/admin/store-profile-detections' && init?.method === 'POST') {
        return jsonResponse({
          ai_used: true,
          profile: Object.fromEntries(Object.entries(createdStore).filter(([key]) => !['active', 'id', 'status'].includes(key))),
          unresolved_fields: []
        });
      }
      if (pathOf(url) === '/stores' && init?.method === 'POST') {
        return jsonResponse(createdStore, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<StoresPage />);

    await user.click(await screen.findByRole('button', { name: 'Create from Website' }));
    expect(screen.queryByRole('region', { name: 'Store item statistics' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Website URL'), 'newstore.mx');
    await user.click(screen.getByRole('button', { name: 'Detect Store Details' }));

    expect(await screen.findByText('All store details detected with AI enrichment. Review them before saving.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('New Store');
    expect(screen.getByLabelText('Canonical domain')).toHaveValue('newstore.mx');
    expect(screen.getByLabelText('Platform')).toHaveValue('woocommerce');

    await user.click(screen.getByRole('button', { name: 'Create Store' }));

    expect(await screen.findByText('New Store')).toBeInTheDocument();
    const createdRow = screen.getByText('New Store').closest('tr')!;
    expect(within(createdRow).getAllByRole('cell').slice(3, 11).map((cell) => cell.textContent)).toEqual(['0', '0', '0', '0', '0', '0', '0', '0']);
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => pathOf(String(url)) === '/stores' && init?.method === 'POST'
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      active: true,
      canonical_domain: 'newstore.mx',
      name: 'New Store',
      platform: 'woocommerce',
      website_url: 'https://newstore.mx/'
    });
  });

  it('starts item discovery from the clean store form', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/stores' && !init?.method) {
        return jsonResponse([
          {
            canonical_domain: 'example.mx',
            country: 'Mexico',
            id: 12,
            name: 'Example Juegos',
            status: 'active',
            website_url: 'https://example.mx/'
          }
        ]);
      }
      if (url.endsWith('/admin/operations/stores/12/item-discovery-runs') && init?.method === 'POST') {
        return jsonResponse({
          completed_at: null,
          error: null,
          id: 'run-2',
          result: null,
          started_at: '2026-05-25T20:00:00Z',
          status: 'running',
          type: 'item_discovery'
        }, 202);
      }
      if (url.endsWith('/stores/12/item-statistics')) return jsonResponse(emptyStatistics);
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<StoresPage />);

    await user.dblClick(await screen.findByText('Example Juegos'));
    await user.click(screen.getByRole('button', { name: 'Run Item Discovery' }));

    expect(await screen.findByText('Item discovery started.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/operations/stores/12/item-discovery-runs', {
      credentials: 'include',
      method: 'POST'
    });
  });

  it('starts item update from the clean store form', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/stores' && !init?.method) {
        return jsonResponse([
          {
            canonical_domain: 'example.mx',
            country: 'Mexico',
            id: 12,
            name: 'Example Juegos',
            status: 'active',
            website_url: 'https://example.mx/'
          }
        ]);
      }
      if (url.endsWith('/admin/operations/item-update-runs') && init?.method === 'POST') {
        return jsonResponse({
          completed_at: null,
          error: null,
          id: 'run-3',
          result: null,
          started_at: '2026-06-08T20:00:00Z',
          status: 'running',
          type: 'item_update'
        }, 202);
      }
      if (url.endsWith('/stores/12/item-statistics')) return jsonResponse(emptyStatistics);
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<StoresPage />);

    await user.dblClick(await screen.findByText('Example Juegos'));
    await user.click(screen.getByRole('button', { name: 'Run Item Update' }));

    expect(await screen.findByText('Item update started.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/operations/item-update-runs', {
      credentials: 'include',
      method: 'POST'
    });
  });
});

const exampleStore = {
  active: true,
  canonical_domain: 'example.mx',
  country: 'Mexico',
  id: 12,
  name: 'Example Juegos',
  status: 'active',
  website_url: 'https://example.mx/'
};

const statisticsLabels = [
  'Total items',
  'Boardgame: True / Confirmed: True',
  'Boardgame: True / Confirmed: False',
  'Boardgame: False / Confirmed: True',
  'Boardgame: False / Confirmed: False',
  'Confirmed boardgames: Listed',
  'Confirmed boardgames: Pending',
  'Confirmed boardgames: Rejected'
];

const exampleStatistics = {
  total_items: 31,
  boardgame_true_confirmed_true: 17,
  boardgame_true_confirmed_false: 7,
  boardgame_false_confirmed_true: 2,
  boardgame_false_confirmed_false: 5,
  confirmed_boardgame_listed: 11,
  confirmed_boardgame_pending: 3,
  confirmed_boardgame_rejected: 2
};

const emptyStatistics = {
  total_items: 0,
  boardgame_true_confirmed_true: 0,
  boardgame_true_confirmed_false: 0,
  boardgame_false_confirmed_true: 0,
  boardgame_false_confirmed_false: 0,
  confirmed_boardgame_listed: 0,
  confirmed_boardgame_pending: 0,
  confirmed_boardgame_rejected: 0
};

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const response = new Promise<Response>((resolveResponse) => { resolve = resolveResponse; });
  return { resolve, response };
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}

function pathOf(url: string) {
  return new URL(url).pathname;
}
