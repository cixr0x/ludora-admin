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

  it('loads store items by last updated descending by default', async () => {
    const listingRequests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (pathOf(url) === '/discovery/listings') {
        listingRequests.push(url);
        return jsonResponse([{ id: 'item-candidate-1', title: 'Azul MX' }], 200, { page: 0, page_size: 100, total: 1 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ListingCandidatesPage />);

    expect(await screen.findByText('Azul MX')).toBeInTheDocument();
    expect(listingRequests[0]).toContain('sort=last_updated');
    expect(listingRequests[0]).toContain('sort_direction=desc');
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
    expect(screen.getByRole('button', { name: 'Mark as boardgame' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark as not boardgame' })).not.toBeDisabled();
  });

  it('batch confirms selected store items sequentially', async () => {
    const user = userEvent.setup();
    const originalCandidates = [
      {
        availability: 'available',
        id: '101',
        is_boardgame: false,
        is_boardgame_confirmed: false,
        listing_status: 'PENDING',
        source_url: 'https://store.mx/products/first-game',
        store_id: 42,
        title: 'First Game'
      },
      {
        availability: 'available',
        id: '102',
        is_boardgame: false,
        is_boardgame_confirmed: false,
        listing_status: 'PENDING',
        source_url: 'https://store.mx/products/second-game',
        store_id: 42,
        title: 'Second Game'
      }
    ];
    let currentCandidates = originalCandidates;
    const confirmationCalls: string[] = [];
    let resolveFirstConfirmation: (() => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const path = pathOf(url);
      if (path === '/discovery/listings' && !init) {
        return jsonResponse(currentCandidates, 200, { page: 0, page_size: 100, total: currentCandidates.length });
      }
      if (path === '/discovery/listings/101/confirm-boardgame' && init?.method === 'POST') {
        confirmationCalls.push('101');
        return new Promise<Response>((resolve) => {
          resolveFirstConfirmation = () => {
            const confirmed = { ...originalCandidates[0], is_boardgame: true, is_boardgame_confirmed: true };
            currentCandidates = [confirmed, currentCandidates[1]];
            resolve(jsonResponse(confirmed));
          };
        });
      }
      if (path === '/discovery/listings/102/confirm-boardgame' && init?.method === 'POST') {
        confirmationCalls.push('102');
        const confirmed = { ...originalCandidates[1], is_boardgame: true, is_boardgame_confirmed: true };
        currentCandidates = [currentCandidates[0], confirmed];
        return jsonResponse(confirmed);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ListingCandidatesPage />);

    expect(await screen.findByText('First Game')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Batch confirmation' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select First Game' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Second Game' }));
    await user.click(screen.getByRole('button', { name: 'Confirm selected boardgames' }));

    await waitFor(() => expect(confirmationCalls).toEqual(['101']));
    expect(screen.getByText('Confirming 1 / 2')).toBeInTheDocument();

    resolveFirstConfirmation?.();

    await waitFor(() => expect(confirmationCalls).toEqual(['101', '102']));
    expect(await screen.findByText('Confirmed 2 store items as boardgames.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select First Game' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Second Game' })).not.toBeChecked();
  });

  it('batch marks selected store items as not boardgames sequentially', async () => {
    const user = userEvent.setup();
    const originalCandidates = [
      {
        availability: 'available',
        id: '201',
        is_boardgame: false,
        is_boardgame_confirmed: false,
        listing_status: 'PENDING',
        source_url: 'https://store.mx/products/sleeves',
        store_id: 42,
        title: 'Card Sleeves'
      },
      {
        availability: 'available',
        id: '202',
        is_boardgame: false,
        is_boardgame_confirmed: false,
        listing_status: 'PENDING',
        source_url: 'https://store.mx/products/paint',
        store_id: 42,
        title: 'Miniature Paint'
      }
    ];
    let currentCandidates = originalCandidates;
    const patchCalls: Array<{ id: string; body: Record<string, unknown> }> = [];
    let resolveFirstUpdate: (() => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const path = pathOf(url);
      if (path === '/discovery/listings' && !init) {
        return jsonResponse(currentCandidates, 200, { page: 0, page_size: 100, total: currentCandidates.length });
      }
      if (path === '/discovery/listings/201' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        patchCalls.push({ body, id: '201' });
        return new Promise<Response>((resolve) => {
          resolveFirstUpdate = () => {
            const updated = { ...originalCandidates[0], ...body };
            currentCandidates = [updated, currentCandidates[1]];
            resolve(jsonResponse(updated));
          };
        });
      }
      if (path === '/discovery/listings/202' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        patchCalls.push({ body, id: '202' });
        const updated = { ...originalCandidates[1], ...body };
        currentCandidates = [currentCandidates[0], updated];
        return jsonResponse(updated);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ListingCandidatesPage />);

    expect(await screen.findByText('Card Sleeves')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Batch confirmation' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Card Sleeves' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Miniature Paint' }));
    await user.click(screen.getByRole('button', { name: 'Mark selected not boardgames' }));

    await waitFor(() => expect(patchCalls.map((call) => call.id)).toEqual(['201']));
    expect(screen.getByText('Confirming 1 / 2')).toBeInTheDocument();

    resolveFirstUpdate?.();

    await waitFor(() => expect(patchCalls.map((call) => call.id)).toEqual(['201', '202']));
    expect(patchCalls.map((call) => call.body)).toEqual([
      expect.objectContaining({ is_boardgame: false, is_boardgame_confirmed: true }),
      expect.objectContaining({ is_boardgame: false, is_boardgame_confirmed: true })
    ]);
    expect(await screen.findByText('Confirmed 2 store items as not boardgames.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Card Sleeves' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Miniature Paint' })).not.toBeChecked();
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
    expect(screen.getByRole('button', { name: 'Mark as boardgame' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark as not boardgame' })).not.toBeDisabled();
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
    expect(listingRequests.at(-1)).toContain('sort=last_updated');
    expect(listingRequests.at(-1)).toContain('sort_direction=desc');
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

  it('starts a local cover workflow from the store item form', async () => {
    const user = userEvent.setup();
    const originalCandidate = {
      availability: 'available',
      id: '3365',
      image_url: 'https://store.mx/kitchen-rush.jpg',
      is_boardgame: true,
      is_boardgame_confirmed: true,
      item_id: 77,
      listing_status: 'LISTED',
      source_url: 'https://store.mx/products/kitchen-rush',
      store_id: 42,
      title: 'Kitchen Rush'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/discovery/listings' && !init) {
        return jsonResponse([originalCandidate], 200, { page: 0, page_size: 100, total: 1 });
      }
      if (pathOf(url) === '/admin/local-cover-workflows' && init?.method === 'POST') {
        return jsonResponse({
          expected_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\kitchenrush.es.webp',
          expected_paths: [
            'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\kitchenrush.en.webp',
            'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\kitchenrush.es.webp'
          ],
          filename: 'kitchenrush.es.webp',
          item_id: 77,
          public_url: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/kitchenrush.es.webp',
          source_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\kitchenrush.source.jpg',
          status: 'waiting_for_edit',
          target_field: null,
          store_item_id: 3365
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ListingCandidatesPage />);

    const titleCells = await screen.findAllByText('Kitchen Rush');
    await user.dblClick(titleCells[0]);
    await user.click(screen.getByRole('button', { name: 'Start cover workflow for Kitchen Rush' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => pathOf(String(url)) === '/admin/local-cover-workflows' && init?.method === 'POST'
        )
      ).toBe(true)
    );
    const workflowCall = fetchMock.mock.calls.find(
      ([url, init]) => pathOf(String(url)) === '/admin/local-cover-workflows' && init?.method === 'POST'
    );
    expect(JSON.parse(String(workflowCall?.[1]?.body))).toEqual({ store_item_id: '3365' });
    expect(await screen.findByText('Cover workflow started for kitchenrush.es.webp.')).toBeInTheDocument();
    expect(screen.getByText('C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\kitchenrush.en.webp')).toBeInTheDocument();
    expect(screen.getByText('C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\kitchenrush.es.webp')).toBeInTheDocument();
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
    const onOpenItem = vi.fn();

    render(<ListingCandidatesPage onOpenItem={onOpenItem} />);

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
    expect(onOpenItem).toHaveBeenCalledWith('77');
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

  it('creates a curated item from the candidate form with an extension relationship', async () => {
    const user = userEvent.setup();
    const originalCandidate = {
      availability: 'available',
      description: 'An expansion for Kitchen Rush.',
      id: '3366',
      image_url: 'https://store.mx/kitchen-rush-expansion.jpg',
      item_id: null,
      item_type: 'expansion',
      language: 'en',
      matched_bgg_id: '',
      source_url: 'https://store.mx/products/kitchen-rush-expansion',
      listing_status: 'PENDING',
      store_id: 42,
      title: 'Kitchen Rush Expansion'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/discovery/listings' && !init) {
        return jsonResponse([originalCandidate], 200, { page: 0, page_size: 100, total: 1 });
      }
      if (pathOf(url) === '/discovery/listings/3366/create-item' && init?.method === 'POST') {
        return jsonResponse({
          ...originalCandidate,
          item_id: 78,
          match_source: 'MANUAL',
          listing_status: 'PENDING'
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<ListingCandidatesPage />);

    const titleCells = await screen.findAllByText('Kitchen Rush Expansion');
    await user.dblClick(titleCells[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Create Item from Candidate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create Item from Candidate' });
    expect(within(dialog).getByLabelText('Extends')).not.toBeChecked();

    fireEvent.click(within(dialog).getByLabelText('Extends'));
    await user.type(within(dialog).getByLabelText('Extends Item ID'), '77');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Item' }));

    expect(await screen.findByText('Item created from candidate.')).toBeInTheDocument();
    expect(screen.getByLabelText('Item ID')).toHaveValue('78');
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/listings/3366/create-item', {
      body: JSON.stringify({ bgg_id: '', implements: false, extends: true, extends_item_id: '77' }),
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
    const onOpenItem = vi.fn();

    render(<ListingCandidatesPage onOpenItem={onOpenItem} />);

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
    expect(onOpenItem).toHaveBeenCalledWith('77');
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
      'http://localhost:4001/discovery/listings?page=1&page_size=100&sort=last_updated&sort_direction=desc'
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
