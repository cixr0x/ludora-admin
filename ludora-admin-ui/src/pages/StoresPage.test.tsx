import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoresPage } from './StoresPage';

describe('StoresPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders clean store table columns and website links', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
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

    for (const heading of ['Name', 'Domain', 'Website', 'Platform', 'City', 'State', 'Country', 'Logo', 'Status', 'Updated']) {
      expect(await screen.findByRole('columnheader', { name: heading })).toBeInTheDocument();
    }
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
      if (url.endsWith('/stores/12') && init?.method === 'PATCH') {
        return jsonResponse({
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
    await user.click(screen.getByRole('button', { name: 'Save Store' }));

    expect(await screen.findByText('Example Updated')).toBeInTheDocument();
    const patchCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/stores/12') && init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      name: 'Example Updated',
      platform: 'shopify',
      website_url: 'https://example.mx/'
    });
  });

  it('detects website fields and creates a reviewed store', async () => {
    const user = userEvent.setup();
    const createdStore = {
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
          profile: Object.fromEntries(Object.entries(createdStore).filter(([key]) => !['id', 'status'].includes(key))),
          unresolved_fields: []
        });
      }
      if (pathOf(url) === '/stores' && init?.method === 'POST') {
        return jsonResponse(createdStore, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<StoresPage />);

    await user.click(await screen.findByRole('button', { name: 'Create Store' }));
    await user.type(screen.getByLabelText('Website URL'), 'newstore.mx');
    await user.click(screen.getByRole('button', { name: 'Detect Store Details' }));

    expect(await screen.findByText('All store details detected with AI enrichment. Review them before saving.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('New Store');
    expect(screen.getByLabelText('Canonical domain')).toHaveValue('newstore.mx');
    expect(screen.getByLabelText('Platform')).toHaveValue('woocommerce');

    await user.click(screen.getByRole('button', { name: 'Create Store' }));

    expect(await screen.findByText('New Store')).toBeInTheDocument();
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => pathOf(String(url)) === '/stores' && init?.method === 'POST'
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
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

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}

function pathOf(url: string) {
  return new URL(url).pathname;
}
