import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreCandidatesPage } from './StoreCandidatesPage';

describe('StoreCandidatesPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the store website as an external link', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              canonical_domain: 'example.mx',
              id: 'store-1',
              store_name: 'Example Juegos',
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

    render(<StoreCandidatesPage />);

    const link = await screen.findByRole('link', { name: 'example.mx' });
    expect(link).toHaveAttribute('href', 'https://example.mx/');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders the store candidate database columns', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              canonical_domain: 'example.mx',
              city: 'Ciudad de Mexico',
              confidence: '0.9100',
              country: 'Mexico',
              evidence: ['boardgame', 'online_store', 'mexico'],
              facebook_url: 'https://facebook.com/example',
              first_seen_at: '2026-05-24T20:00:00Z',
              id: 'store-1',
              instagram_url: 'https://instagram.com/example',
              last_seen_at: '2026-05-25T20:00:00Z',
              source_queries: ['juegos de mesa mexico', 'tiendas juegos de mesa cdmx'],
              state: 'CDMX',
              status: 'PENDING',
              store_logo: 'https://example.mx/logo.png',
              store_name: 'Example Juegos',
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

    render(<StoreCandidatesPage />);

    for (const heading of [
      'Store',
      'Domain',
      'Website',
      'Instagram',
      'Facebook',
      'City',
      'State',
      'Country',
      'Logo',
      'Status',
      'Actions',
      'Confidence',
      'Evidence',
      'First Seen',
      'Last Seen'
    ]) {
      expect(await screen.findByRole('columnheader', { name: heading })).toBeInTheDocument();
    }
    expect(screen.queryByRole('columnheader', { name: 'Source Queries' })).not.toBeInTheDocument();

    expect(await screen.findByText('Example Juegos')).toBeInTheDocument();
    expect(screen.getByText('Ciudad de Mexico')).toBeInTheDocument();
    expect(screen.getByText('CDMX')).toBeInTheDocument();
    expect(screen.getByText('Mexico')).toBeInTheDocument();
    expect(screen.getByText('PENDING')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.getByText('91%')).toBeInTheDocument();
    expect(screen.queryByText('juegos de mesa mexico')).not.toBeInTheDocument();
    expect(screen.queryByText('tiendas juegos de mesa cdmx')).not.toBeInTheDocument();
    expect(screen.getByText('boardgame')).toBeInTheDocument();
    expect(screen.getByText('online_store')).toBeInTheDocument();
    expect(screen.getByText('mexico')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Example Juegos logo' })).toHaveAttribute(
      'src',
      'https://example.mx/logo.png'
    );
  });

  it('requests store candidates sorted by domain by default', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              canonical_domain: 'zeta.mx',
              id: 'store-1',
              status: 'PENDING',
              store_name: 'First Returned',
              website_url: 'https://zeta.mx/'
            },
            {
              canonical_domain: 'alpha.mx',
              id: 'store-2',
              status: 'PENDING',
              store_name: 'Second Returned',
              website_url: 'https://alpha.mx/'
            }
          ]
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        }
      )
    );

    render(<StoreCandidatesPage />);

    expect(await screen.findByText('First Returned')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4001/discovery/stores?page=0&page_size=100&sort=canonical_domain&sort_direction=asc'
    );
  });

  it('opens an edit form on row double click and saves changes', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/discovery/stores' && !init) {
        return new Response(
          JSON.stringify({
            data: [
              {
                canonical_domain: 'example.mx',
                city: 'Ciudad de Mexico',
                confidence: '0.91',
                country: 'Mexico',
                evidence: ['boardgame'],
                id: 'store-1',
                state: 'CDMX',
                status: 'PENDING',
                store_name: 'Example Juegos',
                website_url: 'https://example.mx/'
              }
            ]
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }
      if (url.endsWith('/discovery/stores/store-1') && init?.method === 'PATCH') {
        return new Response(
          JSON.stringify({
            data: {
              canonical_domain: 'example.mx',
              city: 'Ciudad de Mexico',
              confidence: '0.91',
              country: 'Mexico',
              evidence: ['boardgame', 'manual'],
              id: 'store-1',
              state: 'CDMX',
              status: 'PENDING',
              store_name: 'Example Updated',
              website_url: 'https://example.mx/'
            }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<StoreCandidatesPage />);

    await user.dblClick(await screen.findByText('Example Juegos'));
    expect(screen.getByRole('heading', { name: 'Edit Store Candidate' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Store name'));
    await user.type(screen.getByLabelText('Store name'), 'Example Updated');
    await user.clear(screen.getByLabelText('Evidence'));
    await user.type(screen.getByLabelText('Evidence'), 'boardgame, manual');
    await user.click(screen.getByRole('button', { name: 'Save Store Candidate' }));

    expect(await screen.findByText('Example Updated')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4001/discovery/stores/store-1',
      expect.objectContaining({
        method: 'PATCH'
      })
    );
    const patchCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/discovery/stores/store-1') && init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      evidence: ['boardgame', 'manual'],
      store_name: 'Example Updated'
    });
    expect(JSON.parse(String(patchCall?.[1]?.body))).not.toHaveProperty('status');
  });

  it('opens an empty create form and saves a new store candidate', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/discovery/stores' && !init) {
        return new Response(JSON.stringify({ data: [] }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }
      if (pathOf(url) === '/discovery/stores' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              canonical_domain: 'newstore.mx',
              city: 'Monterrey',
              confidence: 0.7,
              country: 'Mexico',
              evidence: ['manual'],
              id: 'store-2',
              state: 'Nuevo Leon',
              status: 'PENDING',
              store_name: 'New Store',
              website_url: 'https://newstore.mx/'
            }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 201
          }
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<StoreCandidatesPage />);

    await screen.findByText('No matching records.');
    await user.click(screen.getByRole('button', { name: 'New Store Candidate' }));

    expect(screen.getByRole('heading', { name: 'New Store Candidate' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Store name'), 'New Store');
    await user.type(screen.getByLabelText('Canonical domain'), 'newstore.mx');
    await user.type(screen.getByLabelText('Website URL'), 'https://newstore.mx/');
    await user.type(screen.getByLabelText('City'), 'Monterrey');
    await user.type(screen.getByLabelText('State'), 'Nuevo Leon');
    await user.type(screen.getByLabelText('Confidence'), '0.7');
    await user.type(screen.getByLabelText('Evidence'), 'manual');
    await user.click(screen.getByRole('button', { name: 'Save Store Candidate' }));

    expect(await screen.findByText('New Store')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4001/discovery/stores',
      expect.objectContaining({
        method: 'POST'
      })
    );
    const postCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/discovery/stores') && init?.method === 'POST');
    expect(JSON.parse(String(postCall?.[1]?.body))).not.toHaveProperty('status');
  }, 10000);

  it('approves pending store candidates from the table', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/discovery/stores' && !init) {
        return new Response(
          JSON.stringify({
            data: [
              {
                canonical_domain: 'example.mx',
                id: 'store-1',
                status: 'PENDING',
                store_name: 'Example Juegos',
                website_url: 'https://example.mx/'
              }
            ]
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }
      if (url.endsWith('/discovery/stores/store-1/approve') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              canonical_domain: 'example.mx',
              id: 'store-1',
              status: 'ACCEPTED',
              store_name: 'Example Juegos',
              website_url: 'https://example.mx/'
            }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<StoreCandidatesPage />);

    await user.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('ACCEPTED')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/stores/store-1/approve', {
      method: 'POST'
    });
  });

  it('rejects pending store candidates from the table', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/discovery/stores' && !init) {
        return new Response(
          JSON.stringify({
            data: [
              {
                canonical_domain: 'example.mx',
                id: 'store-1',
                status: 'PENDING',
                store_name: 'Example Juegos',
                website_url: 'https://example.mx/'
              }
            ]
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }
      if (url.endsWith('/discovery/stores/store-1/reject') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              canonical_domain: 'example.mx',
              id: 'store-1',
              status: 'REJECTED',
              store_name: 'Example Juegos',
              website_url: 'https://example.mx/'
            }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<StoreCandidatesPage />);

    await user.click(await screen.findByRole('button', { name: 'Reject' }));

    expect(await screen.findByText('REJECTED')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/stores/store-1/reject', {
      method: 'POST'
    });
  });
});

function pathOf(url: string) {
  return new URL(url).pathname;
}
