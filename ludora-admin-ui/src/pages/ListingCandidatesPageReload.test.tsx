import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/CoverFlatteningDialog', () => ({
  CoverFlatteningDialog: ({
    onAccepted,
    request
  }: {
    onAccepted: (result: Record<string, unknown>) => void;
    request: unknown;
  }) =>
    request ? (
      <button
        type="button"
        onClick={() =>
          onAccepted({
            item_id: 77,
            optimized_size_bytes: 80_000,
            output_aspect_ratio: 0.75,
            public_url: 'https://cdn.example/cafe-barista.flattened.webp',
            s3_key: 'boardgame/cafe-barista.flattened.webp',
            target_field: 'image_url_es',
            trim_fraction: 0
          })
        }
      >
        Complete flattening
      </button>
    ) : null
}));

import { ListingCandidatesPage } from './ListingCandidatesPage';

describe('ListingCandidatesPage review reload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reloads the review page after an accepted flattened cover', async () => {
    const reloadPage = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/discovery/listings/920') {
        return jsonResponse({
          id: '920',
          image_url: 'https://store.example/cafe-barista.jpg',
          item_id: 77,
          listing_status: 'PENDING',
          source_url: 'https://store.example/cafe-barista',
          title: 'Cafe Barista'
        });
      }
      if (path === '/discovery/listings') {
        return jsonResponse([], { page: 0, page_size: 100, total: 0 });
      }
      if (path === '/discovery/listings/920/additional-items') {
        return jsonResponse([]);
      }
      if (path === '/items/77') {
        return jsonResponse({
          canonical_name: 'Coffee Rush',
          id: 77,
          image_url: 'https://catalog.example/coffee-rush.jpg',
          image_url_es: ''
        });
      }
      if (path === '/items/77/relationships' || path === '/items/77/store-items') {
        return jsonResponse([]);
      }
      if (path === '/items/77/taxonomy') {
        return jsonResponse({ categories: [], families: [], mechanics: [] });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(
      <ListingCandidatesPage
        detailMode="review"
        reloadPage={reloadPage}
        selectedCandidateId="920"
      />
    );

    const coverComparison = await screen.findByRole('group', {
      name: 'Store item and linked item cover comparison'
    });
    expect(await within(coverComparison).findByRole('img', { name: 'Coffee Rush item cover' })).toHaveAttribute(
      'src',
      'https://catalog.example/coffee-rush.jpg'
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Flatten cover for Cafe Barista' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Complete flattening' }));

    await waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
  });

  it('generates a missing translation from the cover comparison', async () => {
    let item: Record<string, unknown> = {
      canonical_name: 'Coffee Rush',
      description: 'Complete customer orders in a busy coffee shop.',
      description_es: '',
      id: 77,
      image_url: 'https://catalog.example/coffee-rush.jpg',
      image_url_es: ''
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/discovery/listings/920') {
        return jsonResponse({
          description: 'Run a coffee shop before the customers lose patience.',
          id: '920',
          image_url: 'https://store.example/cafe-barista.jpg',
          item_id: 77,
          listing_status: 'PENDING',
          source_url: 'https://store.example/cafe-barista',
          title: 'Cafe Barista'
        });
      }
      if (path === '/discovery/listings') {
        return jsonResponse([], { page: 0, page_size: 100, total: 0 });
      }
      if (path === '/discovery/listings/920/additional-items') {
        return jsonResponse([]);
      }
      if (path === '/admin/description-generations' && init?.method === 'POST') {
        return jsonResponse({
          description_es: 'Completa los pedidos de los clientes en una cafeteria concurrida.',
          metadata: {},
          model: 'test-model',
          prompt_version: 'test'
        });
      }
      if (path === '/items/77' && init?.method === 'PATCH') {
        item = { ...item, ...JSON.parse(String(init.body)) };
        return jsonResponse(item);
      }
      if (path === '/items/77') {
        return jsonResponse(item);
      }
      if (path === '/items/77/relationships' || path === '/items/77/store-items') {
        return jsonResponse([]);
      }
      if (path === '/items/77/taxonomy') {
        return jsonResponse({ categories: [], families: [], mechanics: [] });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Generate translation' }));

    expect(await screen.findByRole('status', { name: 'Translation generated' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate translation' })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/description-generations', {
      body: JSON.stringify({
        boardgame_name: 'Coffee Rush',
        description_1: 'Complete customer orders in a busy coffee shop.',
        description_2: 'Run a coffee shop before the customers lose patience.'
      }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    const itemUpdate = fetchMock.mock.calls.find(
      ([input, init]) => new URL(String(input)).pathname === '/items/77' && init?.method === 'PATCH'
    );
    expect(JSON.parse(String(itemUpdate?.[1]?.body)).description_es).toBe(
      'Completa los pedidos de los clientes en una cafeteria concurrida.'
    );
  });
});

function jsonResponse(data: unknown, meta?: unknown) {
  return new Response(JSON.stringify({ data, meta }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200
  });
}
