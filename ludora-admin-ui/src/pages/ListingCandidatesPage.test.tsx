import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListingCandidatesPage } from './ListingCandidatesPage';

describe('ListingCandidatesPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders discovery item candidate fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              availability: 'in_stock',
              id: 'item-candidate-1',
              image_url: 'https://store.mx/azul.jpg',
              is_boardgame: true,
              is_boardgame_confirmed: true,
              last_updated: '2026-05-25T10:00:00.000Z',
              language: 'es',
              language_evidence: 'Highlights: 10+ 2-4 jugadores 45 min Español',
              language_source: 'product_highlights',
              match_score: '0.9400',
              match_source: 'LOCAL',
              matched_name: 'Azul',
              max_players: 4,
              min_players: 2,
              price: '899.00',
              price_source: 'json_ld_offer',
              processing_error: '',
              publisher: 'Plan B Games',
              raw_price: '899.00',
              source_url: 'https://store.mx/products/azul-mx',
              listing_status: 'LISTED',
              store_id: 42,
              title: 'Azul MX',
              availability_source: 'json_ld_offer'
            },
            {
              availability: 'unknown',
              id: 'item-candidate-2',
              is_boardgame: false,
              is_boardgame_confirmed: false,
              last_updated: '2026-05-25T11:00:00.000Z',
              language: 'en',
              match_source: 'NONE',
              price: null,
              processing_error: 'BGG client is not configured',
              publisher: '',
              raw_price: '',
              listing_status: 'PENDING',
              store_id: 43,
              title: 'Catan Ingles'
            }
          ]
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        }
      )
    );

    render(<ListingCandidatesPage />);

    const headers = await screen.findAllByRole('columnheader');
    expect(headers[0]).toHaveTextContent('Image');
    expect(await screen.findByText('Azul MX')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Azul MX product image' })).toHaveAttribute('src', 'https://store.mx/azul.jpg');
    const itemLink = screen.getByRole('link', { name: 'https://store.mx/products/azul-mx' });
    expect(itemLink).toHaveAttribute('href', 'https://store.mx/products/azul-mx');
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Plan B Games')).toBeInTheDocument();
    expect(screen.queryByText('LIKELY_BOARDGAME')).not.toBeInTheDocument();
    expect(screen.getAllByText('true').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('false').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('899.00')).toBeInTheDocument();
    expect(screen.getByText('in_stock')).toBeInTheDocument();
    expect(screen.getAllByText('json_ld_offer').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('es')).toBeInTheDocument();
    expect(screen.getByText('product_highlights')).toBeInTheDocument();
    expect(screen.getByText('Highlights: 10+ 2-4 jugadores 45 min Español')).toBeInTheDocument();
    expect(screen.getByText('2-4')).toBeInTheDocument();
    expect(screen.getByText('LISTED')).toBeInTheDocument();
    expect(screen.getByText('LOCAL')).toBeInTheDocument();
    expect(screen.getByText('Azul')).toBeInTheDocument();
    expect(screen.getByText('0.9400')).toBeInTheDocument();
    expect(screen.getByText('BGG client is not configured')).toBeInTheDocument();
  });

  it('filters store items by column value', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const rows = url.includes('filter_title=')
        ? [
            {
              id: 'item-candidate-2',
              store_id: 43,
              title: 'Catan Ingles'
            }
          ]
        : [
            {
              id: 'item-candidate-1',
              store_id: 42,
              title: 'Azul MX'
            },
            {
              id: 'item-candidate-2',
              store_id: 43,
              title: 'Catan Ingles'
            }
          ];

      return new Response(
        JSON.stringify({
          data: rows,
          meta: { page: 0, page_size: 100, total: rows.length }
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        }
      );
    });

    render(<ListingCandidatesPage />);

    expect(await screen.findByText('Azul MX')).toBeInTheDocument();
    expect(screen.getByText('Catan Ingles')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Filter Title'), 'catan');

    await waitFor(() => {
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('filter_title=catan');
    });
    expect(screen.queryByText('Azul MX')).not.toBeInTheDocument();
    expect(screen.getByText('Catan Ingles')).toBeInTheDocument();
  });

  it('updates boardgame confirmation from table actions', async () => {
    const user = userEvent.setup();
    const originalCandidate = {
      availability: 'available',
      id: '3365',
      image_url: 'https://store.mx/kitchen-rush.jpg',
      is_boardgame: false,
      is_boardgame_confirmed: false,
      price: '899.00',
      source_url: 'https://store.mx/products/kitchen-rush',
      listing_status: 'PENDING',
      store_id: 42,
      title: 'Kitchen Rush'
    };
    const confirmedCandidate = {
      ...originalCandidate,
      is_boardgame: true,
      is_boardgame_confirmed: true,
      item_id: 77,
      match_source: 'LOCAL',
      listing_status: 'PENDING'
    };
    let currentCandidate = originalCandidate;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/discovery/listings' && !init) {
        return jsonResponse([currentCandidate], 200, { page: 0, page_size: 100, total: 1 });
      }
      if (pathOf(url) === '/discovery/listings/3365/confirm-boardgame' && init?.method === 'POST') {
        currentCandidate = confirmedCandidate;
        return jsonResponse(confirmedCandidate);
      }
      if (pathOf(url) === '/discovery/listings/3365' && init?.method === 'PATCH') {
        currentCandidate = {
          ...currentCandidate,
          ...JSON.parse(String(init.body))
        };
        return jsonResponse({
          ...currentCandidate
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ListingCandidatesPage />);

    expect(await screen.findByText('Kitchen Rush')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark as boardgame' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => pathOf(String(url)) === '/discovery/listings/3365/confirm-boardgame' && init?.method === 'POST'
        )
      ).toBe(true)
    );
    expect(currentCandidate).toMatchObject({
      is_boardgame: true,
      is_boardgame_confirmed: true,
      item_id: 77,
      match_source: 'LOCAL'
    });
    expect(await screen.findByText('Store item marked as boardgame.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark as boardgame' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark as not boardgame' })).toBeDisabled();
  });

  it('marks unconfirmed store items as not boardgame from table actions', async () => {
    const user = userEvent.setup();
    const originalCandidate = {
      availability: 'available',
      id: '3365',
      image_url: 'https://store.mx/kitchen-rush.jpg',
      is_boardgame: false,
      is_boardgame_confirmed: false,
      price: '899.00',
      source_url: 'https://store.mx/products/kitchen-rush',
      listing_status: 'PENDING',
      store_id: 42,
      title: 'Kitchen Rush'
    };
    let currentCandidate = originalCandidate;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/discovery/listings' && !init) {
        return jsonResponse([currentCandidate], 200, { page: 0, page_size: 100, total: 1 });
      }
      if (pathOf(url) === '/discovery/listings/3365' && init?.method === 'PATCH') {
        currentCandidate = {
          ...currentCandidate,
          ...JSON.parse(String(init.body))
        };
        return jsonResponse({
          ...currentCandidate
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ListingCandidatesPage />);

    expect(await screen.findByText('Kitchen Rush')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark as not boardgame' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => JSON.parse(String(init?.body ?? '{}')).is_boardgame === false)).toBe(true)
    );
    const notBoardgamePatchCalls = fetchMock.mock.calls.filter(
      ([url, init]) => pathOf(String(url)) === '/discovery/listings/3365' && init?.method === 'PATCH'
    );
    expect(JSON.parse(String(notBoardgamePatchCalls.at(-1)?.[1]?.body))).toMatchObject({
      is_boardgame: false,
      is_boardgame_confirmed: true
    });
    expect(await screen.findByText('Store item marked as not boardgame.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark as boardgame' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark as not boardgame' })).toBeDisabled();
  });

  it('refreshes store items with active filters after boardgame table actions', async () => {
    const user = userEvent.setup();
    const originalCandidate = {
      availability: 'available',
      id: '3365',
      image_url: 'https://store.mx/kitchen-rush.jpg',
      is_boardgame: false,
      is_boardgame_confirmed: false,
      price: '899.00',
      source_url: 'https://store.mx/products/kitchen-rush',
      listing_status: 'PENDING',
      store_id: 42,
      title: 'Kitchen Rush'
    };
    const refreshedCandidate = {
      ...originalCandidate,
      is_boardgame: true,
      is_boardgame_confirmed: true,
      item_id: 77,
      match_source: 'LOCAL',
      listing_status: 'PENDING',
      title: 'Kitchen Rush Refreshed'
    };
    const listingRequests: string[] = [];
    let matchCompleted = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/discovery/listings' && !init) {
        listingRequests.push(url);
        return jsonResponse([matchCompleted ? refreshedCandidate : originalCandidate], 200, {
          page: 0,
          page_size: 100,
          total: 1
        });
      }
      if (pathOf(url) === '/discovery/listings/3365/confirm-boardgame' && init?.method === 'POST') {
        matchCompleted = true;
        return jsonResponse(refreshedCandidate);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ListingCandidatesPage />);

    expect(await screen.findByText('Kitchen Rush')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Filter Title'), 'kitchen');
    await waitFor(() => expect(listingRequests.at(-1)).toContain('filter_title=kitchen'));

    await user.click(screen.getByRole('button', { name: 'Mark as boardgame' }));

    expect(await screen.findByText('Kitchen Rush Refreshed')).toBeInTheDocument();
    expect(listingRequests.at(-1)).toContain('filter_title=kitchen');
    expect(listingRequests.at(-1)).toContain('sort=title');
    expect(listingRequests.at(-1)).toContain('sort_direction=asc');
  }, 10000);

  it('opens a form view with all item candidate fields on row double click', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              availability: 'available',
              availability_source: 'woocommerce_stock',
              category_confidence: '0.96',
              classification_reasons: ['product detail has boardgame player count'],
              currency: 'MXN',
              description: 'A cooperative real-time kitchen game.',
              id: '3365',
              image_url: 'https://store.mx/kitchen-rush.jpg',
              is_boardgame: true,
              is_boardgame_confirmed: true,
              item_id: 77,
              item_type: 'base_game',
              language: 'en',
              language_evidence: 'Highlights: English',
              language_source: 'product_highlights',
              last_seen_at: '2026-05-29T09:53:38.466Z',
              last_updated: '2026-05-29T09:53:38.466Z',
              match_payload: { source: 'local' },
              match_reasons: ['exact title match'],
              match_score: '0.9400',
              match_source: 'LOCAL',
              matched_at: '2026-05-29T09:53:38.466Z',
              matched_bgg_id: 223953,
              matched_name: 'Kitchen Rush',
              max_minutes: 45,
              max_players: 4,
              min_age: 8,
              min_minutes: 30,
              min_players: 2,
              price: '899.00',
              price_source: 'woocommerce_product_price',
              processed_at: '2026-05-29T09:53:38.466Z',
              processing_error: '',
              publisher: 'Artipia Games',
              raw_payload: { sku: 'KR-EN' },
              raw_price: '$899.00',
              source_listing_url: 'https://store.mx/collections/boardgames',
              source_url: 'https://store.mx/products/kitchen-rush',
              listing_status: 'LISTED',
              store_id: 42,
              store_sku: 'KR-EN',
              title: 'Kitchen Rush'
            }
          ],
          meta: { page: 0, page_size: 100, total: 1 }
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        }
      )
    );

    render(<ListingCandidatesPage />);

    const titleCells = await screen.findAllByText('Kitchen Rush');
    await user.dblClick(titleCells[0]);

    expect(screen.getByRole('heading', { name: 'Store Item Details' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('3365')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://store.mx/products/kitchen-rush')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://store.mx/collections/boardgames')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://store.mx/kitchen-rush.jpg')).toBeInTheDocument();
    expect(screen.getByDisplayValue('A cooperative real-time kitchen game.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('KR-EN')).toBeInTheDocument();
    expect(screen.queryByLabelText('Match Item ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Candidate Category')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Is Boardgame' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Is Boardgame Confirmed' })).toBeChecked();
    expect(screen.getByDisplayValue('["product detail has boardgame player count"]')).toBeInTheDocument();
    expect(screen.getByDisplayValue('{"sku":"KR-EN"}')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Kitchen Rush candidate image' })).toHaveAttribute(
      'src',
      'https://store.mx/kitchen-rush.jpg'
    );
    expect(screen.getByRole('link', { name: 'Open product page' })).toHaveAttribute(
      'href',
      'https://store.mx/products/kitchen-rush'
    );

    await user.click(screen.getByRole('button', { name: 'Back to Store Items' }));

    expect(screen.getByRole('table', { name: 'Store items' })).toBeInTheDocument();
  });

  it('edits and saves store items from the form view', async () => {
    const user = userEvent.setup();
    const originalCandidate = {
      availability: 'available',
      availability_source: 'woocommerce_stock',
      category_confidence: '0.96',
      classification_reasons: ['product detail has boardgame player count'],
      currency: 'MXN',
      description: 'A cooperative real-time kitchen game.',
      id: '3365',
      image_url: 'https://store.mx/kitchen-rush.jpg',
      is_boardgame: true,
      is_boardgame_confirmed: false,
      item_id: 55,
      item_type: 'base_game',
      language: 'en',
      language_evidence: 'Highlights: English',
      language_source: 'product_highlights',
      last_seen_at: '2026-05-29T09:53:38.466Z',
      last_updated: '2026-05-29T09:53:38.466Z',
      match_payload: {},
      match_reasons: [],
      match_score: null,
      match_source: '',
      matched_at: null,
      matched_bgg_id: null,
      matched_name: '',
      max_minutes: 45,
      max_players: 4,
      min_age: 8,
      min_minutes: 30,
      min_players: 2,
      price: '899.00',
      price_source: 'woocommerce_product_price',
      processed_at: null,
      processing_error: '',
      publisher: 'Artipia Games',
      raw_payload: { sku: 'KR-EN' },
      raw_price: '$899.00',
      source_listing_url: 'https://store.mx/collections/boardgames',
      source_url: 'https://store.mx/products/kitchen-rush',
      listing_status: 'PENDING',
      store_id: 42,
      store_sku: 'KR-EN',
      title: 'Kitchen Rush'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/discovery/listings' && !init) {
        return jsonResponse([originalCandidate], 200, { page: 0, page_size: 100, total: 1 });
      }
      if (pathOf(url) === '/discovery/listings/3365' && init?.method === 'PATCH') {
        return jsonResponse({
          ...originalCandidate,
          description: 'Updated description',
          listing_status: 'UNLISTED',
          title: 'Kitchen Rush Updated'
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ListingCandidatesPage />);

    const titleCells = await screen.findAllByText('Kitchen Rush');
    await user.dblClick(titleCells[0]);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Kitchen Rush Updated' } });
    fireEvent.change(screen.getByLabelText('Listing Status'), { target: { value: 'UNLISTED' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Updated description' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Store Item' }));

    expect(await screen.findByText('Store item saved.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Kitchen Rush Updated')).toBeInTheDocument();
    expect(screen.getByDisplayValue('UNLISTED')).toBeInTheDocument();

    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) => pathOf(String(url)) === '/discovery/listings/3365' && init?.method === 'PATCH'
    );
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      description: 'Updated description',
      listing_status: 'UNLISTED',
      title: 'Kitchen Rush Updated'
    });

    await user.click(screen.getByRole('button', { name: 'Back to Store Items' }));

    expect(await screen.findByText('Kitchen Rush Updated')).toBeInTheDocument();
  }, 10000);

  it('creates a curated item from the item candidate form', async () => {
    const user = userEvent.setup();
    const originalCandidate = {
      availability: 'available',
      description: 'A cooperative real-time kitchen game.',
      id: '3365',
      image_url: 'https://store.mx/kitchen-rush.jpg',
      item_id: null,
      item_type: 'base_game',
      language: 'en',
      max_players: 4,
      min_players: 2,
      price: '899.00',
      publisher: 'Artipia Games',
      matched_bgg_id: 223953,
      source_url: 'https://store.mx/products/kitchen-rush',
      listing_status: 'PENDING',
      store_id: 42,
      title: 'Kitchen Rush'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/discovery/listings' && !init) {
        return jsonResponse([originalCandidate], 200, { page: 0, page_size: 100, total: 1 });
      }
      if (pathOf(url) === '/discovery/listings/3365/create-item' && init?.method === 'POST') {
        return jsonResponse({
          ...originalCandidate,
          item_id: 77,
          match_source: 'MANUAL',
          listing_status: 'PENDING'
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ListingCandidatesPage />);

    const titleCells = await screen.findAllByText('Kitchen Rush');
    await user.dblClick(titleCells[0]);
    expect(screen.queryByLabelText('BGG ID')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create Item from Candidate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create Item from Candidate' });
    expect(within(dialog).getByLabelText('Implements')).not.toBeChecked();
    expect(within(dialog).getByLabelText('BGG ID')).toHaveValue('223953');
    fireEvent.click(within(dialog).getByLabelText('Implements'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Item' }));

    expect(await screen.findByText('Item created from candidate.')).toBeInTheDocument();
    expect(screen.getByLabelText('Item ID')).toHaveValue('77');
    expect(screen.getByDisplayValue('PENDING')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create Item from Candidate' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Create Item from Candidate' })).toBeEnabled();

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/listings/3365/create-item', {
      body: JSON.stringify({ bgg_id: '223953', implements: true }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  }, 10000);

  it('creates a BGG item from the item candidate form and links the candidate', async () => {
    const user = userEvent.setup();
    const originalCandidate = {
      availability: 'available',
      description: 'A coffee shop game.',
      id: '3365',
      image_url: 'https://store.mx/cafe-barista.jpg',
      item_id: 55,
      item_type: 'base_game',
      language: 'es',
      max_players: 4,
      min_players: 2,
      price: '899.00',
      publisher: 'Korea Boardgames',
      matched_bgg_id: 123456,
      source_url: 'https://store.mx/products/cafe-barista',
      listing_status: 'PENDING',
      store_id: 42,
      title: 'Cafe Barista'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/discovery/listings' && !init) {
        return jsonResponse([originalCandidate], 200, { page: 0, page_size: 100, total: 1 });
      }
      if (pathOf(url) === '/discovery/listings/3365/create-item-from-bgg' && init?.method === 'POST') {
        return jsonResponse(
          {
            ...originalCandidate,
            item_id: 77,
            match_source: 'BGG_MANUAL',
            matched_bgg_id: 377061,
            matched_name: 'Coffee Rush',
            listing_status: 'PENDING'
          },
          201
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ListingCandidatesPage />);

    const titleCells = await screen.findAllByText('Cafe Barista');
    await user.dblClick(titleCells[0]);
    expect(screen.getByRole('button', { name: 'Create Item from Candidate' })).toBeEnabled();
    expect(screen.queryByLabelText('BGG ID')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create item from BGG ID' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create Item from BGG' });
    expect(within(dialog).getByLabelText('BGG ID')).toHaveValue('123456');
    fireEvent.change(within(dialog).getByLabelText('BGG ID'), { target: { value: '377061' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create BGG Item' }));

    expect(await screen.findByText('Item created from BGG ID.')).toBeInTheDocument();
    expect(screen.getByLabelText('Item ID')).toHaveValue('77');
    expect(screen.getByLabelText('Matched BGG ID')).toHaveValue('377061');
    expect(screen.getByDisplayValue('PENDING')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create Item from BGG' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Create Item from Candidate' })).toBeEnabled();

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => pathOf(String(url)) === '/discovery/listings/3365/create-item-from-bgg' && init?.method === 'POST'
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({ bgg_id: '377061' });
  }, 10000);

  it('appends the next page when scrolled near the bottom', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('page=1')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'item-candidate-2', store_id: 43, title: 'Second Page Item' }],
            meta: { page: 1, page_size: 100, total: 101 }
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 }
        );
      }

      return new Response(
        JSON.stringify({
          data: [{ id: 'item-candidate-1', store_id: 42, title: 'First Page Item' }],
          meta: { page: 0, page_size: 100, total: 101 }
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      );
    });

    render(<ListingCandidatesPage />);

    expect(await screen.findByText('First Page Item')).toBeInTheDocument();

    const scrollArea = screen.getByLabelText('Store items scroll area');
    Object.defineProperty(scrollArea, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scrollArea, 'scrollTop', { configurable: true, value: 620 });

    fireEvent.scroll(scrollArea);

    expect(await screen.findByText('Second Page Item')).toBeInTheDocument();
    expect(screen.getByText('First Page Item')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://localhost:4001/discovery/listings?page=1&page_size=100&sort=title&sort_direction=asc'
    );
  });

  it('opens the item candidate form directly from a selected candidate id', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (pathOf(url) === '/discovery/listings/920') {
        return jsonResponse({
          id: '920',
          image_url: 'https://store.mx/cafe-barista.jpg',
          source_url: 'https://store.mx/products/cafe-barista',
          listing_status: 'LISTED',
          title: 'Cafe Barista'
        });
      }
      if (pathOf(url) === '/discovery/listings') {
        return jsonResponse([], 200, { page: 0, page_size: 100, total: 0 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { rerender } = render(<ListingCandidatesPage selectedCandidateId="920" />);

    expect(await screen.findByRole('heading', { name: 'Store Item Details' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Cafe Barista')).toBeInTheDocument();

    rerender(<ListingCandidatesPage />);

    expect(await screen.findByRole('table', { name: 'Store items' })).toBeInTheDocument();
  });
});

function jsonResponse(data: unknown, status = 200, meta?: unknown) {
  return new Response(JSON.stringify({ data, meta }), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}

function pathOf(url: string) {
  return new URL(url).pathname;
}
