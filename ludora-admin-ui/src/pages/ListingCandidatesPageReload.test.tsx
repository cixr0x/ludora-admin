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

    expect(await screen.findByRole('button', { name: 'Approve listing' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Generate translation' }));

    await waitFor(
      () => expect(screen.getByRole('status', { name: 'Translation generated' })).toBeInTheDocument(),
      { timeout: 5_000 }
    );
    expect(screen.getByRole('button', { name: 'Approve listing' })).toBeEnabled();
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

  it('skips prior translate-and-approve submissions while advancing through pending reviews', async () => {
    const onOpenCandidate = vi.fn();
    const candidates: Record<string, Record<string, unknown>> = {
      '920': {
        description: 'Run a coffee shop before the customers lose patience.',
        id: '920',
        image_url: 'https://store.example/cafe-barista.jpg',
        item_id: 77,
        listing_status: 'PENDING',
        source_url: 'https://store.example/cafe-barista',
        title: 'Cafe Barista'
      },
      '921': {
        description: 'Serve desserts before the cafe closes.',
        id: '921',
        image_url: 'https://store.example/cafe-barista-deluxe.jpg',
        item_id: 78,
        listing_status: 'PENDING',
        source_url: 'https://store.example/cafe-barista-deluxe',
        title: 'Cafe Barista Deluxe'
      }
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const candidateMatch = path.match(/^\/discovery\/listings\/(\d+)$/);
      if (candidateMatch && candidates[candidateMatch[1]]) {
        return jsonResponse(candidates[candidateMatch[1]]);
      }
      if (path === '/discovery/listings') {
        return jsonResponse([], { page: 0, page_size: 100, total: 0 });
      }
      if (/^\/discovery\/listings\/(?:920|921)\/additional-items$/.test(path)) {
        return jsonResponse([]);
      }
      const translateAndApproveMatch = path.match(
        /^\/discovery\/listings\/(920|921)\/translate-and-approve$/
      );
      if (translateAndApproveMatch && init?.method === 'POST') {
        return jsonResponse(
          { candidate_id: Number(translateAndApproveMatch[1]), status: 'PROCESSING' },
          undefined,
          202
        );
      }
      if (path === '/admin/discovery/offer-reviews') {
        return jsonResponse(
          [
            { candidate_id: '920', candidate_name: 'Cafe Barista' },
            { candidate_id: '921', candidate_name: 'Cafe Barista Deluxe' },
            { candidate_id: '922', candidate_name: 'Coffee Break' }
          ],
          { page: 0, page_size: 4, total: 3 }
        );
      }
      const itemMatch = path.match(/^\/items\/(77|78)$/);
      if (itemMatch) {
        return jsonResponse({
          canonical_name: itemMatch[1] === '77' ? 'Coffee Rush' : 'Coffee Rush Deluxe',
          description: 'Complete customer orders in a busy coffee shop.',
          description_es: '',
          id: Number(itemMatch[1]),
          image_url: 'https://catalog.example/coffee-rush.jpg',
          image_url_es: ''
        });
      }
      if (/^\/items\/(?:77|78)\/(?:relationships|store-items)$/.test(path)) {
        return jsonResponse([]);
      }
      if (/^\/items\/(?:77|78)\/taxonomy$/.test(path)) {
        return jsonResponse({ categories: [], families: [], mechanics: [] });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    const { rerender } = render(
      <ListingCandidatesPage
        detailMode="review"
        onOpenCandidate={onOpenCandidate}
        selectedCandidateId="920"
      />
    );

    expect(await screen.findByRole('button', { name: 'Approve listing' })).toBeDisabled();
    const translateAndApprove = await screen.findByRole('button', { name: 'Translate and approve' });
    expect(translateAndApprove).toBeEnabled();
    fireEvent.click(translateAndApprove);

    await waitFor(() => expect(onOpenCandidate).toHaveBeenCalledWith('921'));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4001/discovery/listings/920/translate-and-approve',
      {
        credentials: 'include',
        method: 'POST'
      }
    );

    onOpenCandidate.mockClear();
    rerender(
      <ListingCandidatesPage
        detailMode="review"
        onOpenCandidate={onOpenCandidate}
        selectedCandidateId="921"
      />
    );
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Cafe Barista Deluxe'));
    fireEvent.click(await screen.findByRole('button', { name: 'Translate and approve' }));

    await waitFor(() => expect(onOpenCandidate).toHaveBeenCalledWith('922'));
    const offerReviewPageSizes = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname === '/admin/discovery/offer-reviews')
      .map((url) => url.searchParams.get('page_size'));
    expect(offerReviewPageSizes).toEqual(['3', '4']);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          new URL(String(input)).pathname === '/discovery/listings/920/listing-status' &&
          init?.method === 'PATCH'
      )
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([input]) => new URL(String(input)).pathname === '/admin/description-generations'
      )
    ).toBe(false);
  });

  it('reloads the review page after the linked item is saved', async () => {
    const reloadPage = vi.fn();
    let item: Record<string, unknown> = {
      canonical_name: 'Coffee Rush',
      canonical_name_es: 'Cafe Barista',
      description: 'Complete customer orders in a busy coffee shop.',
      description_es: 'Completa pedidos en una cafeteria.',
      id: 77,
      image_url: 'https://catalog.example/coffee-rush.jpg',
      image_url_es: 'https://catalog.example/cafe-barista.jpg',
      normalized_name: 'coffee rush',
      normalized_name_es: 'cafe barista'
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

    render(
      <ListingCandidatesPage
        detailMode="review"
        reloadPage={reloadPage}
        selectedCandidateId="920"
      />
    );

    fireEvent.change(await screen.findByLabelText('Canonical Name ES'), {
      target: { value: 'Cafe Barista Actualizado' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Item' }));

    await waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
    const itemUpdate = fetchMock.mock.calls.find(
      ([input, init]) => new URL(String(input)).pathname === '/items/77' && init?.method === 'PATCH'
    );
    expect(JSON.parse(String(itemUpdate?.[1]?.body)).canonical_name_es).toBe('Cafe Barista Actualizado');
  });
});

function jsonResponse(data: unknown, meta?: unknown, status = 200) {
  return new Response(JSON.stringify({ data, meta }), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}
