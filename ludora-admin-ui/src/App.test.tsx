import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import App from './App';

describe('App', () => {
  afterEach(() => {
    window.location.hash = '';
    vi.restoreAllMocks();
  });

  it('renders the admin shell navigation', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/discovery/stores') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: /Ludora Admin/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Store Candidates/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Stores$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Store Items/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Review Tasks/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Operations/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Store Discovery/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Store Item Discovery/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Store Item Update/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Item Embeddings/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Image Optimization/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Items$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Add Front Page Category/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Front Page Preview/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Offers$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Store Item Review/i })).toBeInTheDocument();
  });

  it('renders login when the admin session is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Authentication required' } }), {
        headers: { 'Content-Type': 'application/json' },
        status: 401
      })
    );

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Ludora Admin' })).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Store Candidates/i })).not.toBeInTheDocument();
  });

  it('logs in and renders the admin shell', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return new Response(JSON.stringify({ error: { message: 'Authentication required' } }), {
          headers: { 'Content-Type': 'application/json' },
          status: 401
        });
      }
      if (url.pathname === '/admin/auth/login' && init?.method === 'POST') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/discovery/stores') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('link', { name: /Store Candidates/i })).toBeInTheDocument();
  });

  it('logs out and returns to login', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/discovery/stores') {
        return jsonResponse([]);
      }
      if (url.pathname === '/admin/auth/logout' && init?.method === 'POST') {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
  });

  it('opens an item form from a hash route', async () => {
    window.location.hash = '#items?id=77';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/items/77') {
        return jsonResponse({
          canonical_name: 'Coffee Rush',
          id: '77',
          item_type: 'base_game',
          normalized_name: 'coffee rush',
          status: 'active'
        });
      }
      if (url.pathname === '/items/77/store-items') {
        return jsonResponse([]);
      }
      if (url.pathname === '/items/77/relationships') {
        return jsonResponse([]);
      }
      if (url.pathname === '/items/77/taxonomy') {
        return jsonResponse({ categories: [], families: [], mechanics: [] });
      }
      if (url.pathname === '/items') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Item Details' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Coffee Rush')).toBeInTheDocument();
  });

  it('opens a store item review and advances to the next pending review after approval', async () => {
    window.location.hash = '#offer-reviews?id=920';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/discovery/listings/920/listing-status' && init?.method === 'PATCH') {
        return jsonResponse({ id: '920', item_id: 77, listing_status: 'LISTED', title: 'Cafe Barista' });
      }
      if (url.pathname === '/discovery/listings/920') {
        return jsonResponse({
          description: 'Run a coffee shop before customers lose patience.',
          id: '920',
          image_url: 'https://store.mx/cafe-barista.jpg',
          item_id: 77,
          listing_status: 'PENDING',
          publisher: 'Korea Boardgames',
          source_url: 'https://store.mx/products/cafe-barista',
          title: 'Cafe Barista'
        });
      }
      if (url.pathname === '/discovery/listings/921') {
        return jsonResponse({
          description: 'Guide alpacas across the mountains.',
          id: '921',
          image_url: 'https://store.mx/alpaca-trails.jpg',
          item_id: 78,
          listing_status: 'PENDING',
          source_url: 'https://store.mx/products/alpaca-trails',
          title: 'Alpaca Trails'
        });
      }
      if (url.pathname === '/discovery/listings') {
        return jsonResponse([]);
      }
      if (
        url.pathname === '/discovery/listings/920/additional-items' ||
        url.pathname === '/discovery/listings/921/additional-items'
      ) {
        return jsonResponse([]);
      }
      if (url.pathname === '/admin/discovery/offer-reviews') {
        return jsonResponse([{ candidate_id: 921, candidate_name: 'Alpaca Trails' }]);
      }
      if (url.pathname === '/items/77') {
        return jsonResponse({
          bgg_id: 377061,
          canonical_name: 'Coffee Rush',
          canonical_name_es: 'Cafe Barista',
          description: 'Complete customer orders in a busy coffee shop.',
          description_es: 'Completa pedidos en una cafeteria.',
          id: '77',
          image_url: 'https://images.example/coffee-rush.jpg',
          image_url_es: 'https://images.example/cafe-barista.jpg',
          normalized_name: 'coffee rush',
          normalized_name_es: 'cafe barista'
        });
      }
      if (url.pathname === '/items/78') {
        return jsonResponse({
          canonical_name: 'Alpaca Trails',
          description: 'Guide alpacas across the mountains.',
          description_es: '',
          id: '78',
          image_url: 'https://images.example/alpaca-trails.jpg',
          image_url_es: '',
          normalized_name: 'alpaca trails',
          normalized_name_es: ''
        });
      }
      if (url.pathname === '/items/77/store-items' || url.pathname === '/items/77/relationships') {
        return jsonResponse([]);
      }
      if (url.pathname === '/items/78/store-items' || url.pathname === '/items/78/relationships') {
        return jsonResponse([]);
      }
      if (url.pathname === '/items/77/taxonomy' || url.pathname === '/items/78/taxonomy') {
        return jsonResponse({ categories: [], families: [], mechanics: [] });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Store Item Review Details' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Linked Item Details' })).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Cafe Barista');
    expect(screen.queryByLabelText('Publisher')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to Review' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve listing' }));

    await waitFor(() => expect(window.location.hash).toBe('#offer-reviews?id=921'));
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Alpaca Trails'));
    const nextReviewRequest = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((url) => url.pathname === '/admin/discovery/offer-reviews');
    expect(nextReviewRequest?.searchParams.get('filter_store_item_listing_status')).toBe('PENDING');
    expect(nextReviewRequest?.searchParams.get('sort')).toBe('candidate_name');
    expect(nextReviewRequest?.searchParams.get('sort_direction')).toBe('asc');
  });

  it('opens the newly created item after creating from a store item candidate', async () => {
    window.location.hash = '#listings?id=3365';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/discovery/listings/3365' && init?.method !== 'POST') {
        return jsonResponse({
          id: '3365',
          item_id: null,
          matched_bgg_id: '',
          source_url: 'https://store.mx/products/kitchen-rush',
          store_id: 42,
          title: 'Kitchen Rush'
        });
      }
      if (url.pathname === '/discovery/listings' && init?.method !== 'POST') {
        return jsonResponse([]);
      }
      if (url.pathname === '/discovery/listings/3365/create-item' && init?.method === 'POST') {
        return jsonResponse({
          id: '3365',
          item_id: 77,
          matched_bgg_id: '',
          source_url: 'https://store.mx/products/kitchen-rush',
          store_id: 42,
          title: 'Kitchen Rush'
        });
      }
      if (url.pathname === '/items/77') {
        return jsonResponse({
          canonical_name: 'Kitchen Rush',
          id: '77',
          item_type: 'base_game',
          normalized_name: 'kitchen rush',
          status: 'active'
        });
      }
      if (url.pathname === '/items/77/store-items') {
        return jsonResponse([]);
      }
      if (url.pathname === '/items/77/relationships') {
        return jsonResponse([]);
      }
      if (url.pathname === '/items/77/taxonomy') {
        return jsonResponse({ categories: [], families: [], mechanics: [] });
      }
      if (url.pathname === '/items') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Store Item Details' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create Item from Candidate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create Item from Candidate' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Item' }));

    await waitFor(() => expect(window.location.hash).toBe('#items?id=77'));
    expect(await screen.findByRole('heading', { name: 'Item Details' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Kitchen Rush')).toBeInTheDocument();
  });

  it('opens the front page category source screen from a hash route', async () => {
    window.location.hash = '#front-page-category-options';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/front-page-category-options') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Add Front Page Category' })).toBeInTheDocument();
  });

  it('opens front page category products from a hash route', async () => {
    window.location.hash = '#front-page-category-products?category_type=category&category_id=5&name=Party%20Game';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/front-page-category-options/category/5/products') {
        return jsonResponse([
          {
            canonical_name: 'Coffee Rush',
            canonical_name_es: 'Cafeteria',
            id: 77,
            image_url: 'https://cdn.example/coffee.jpg',
            image_url_es: '',
            item_type: 'base_game',
            year_published: 2023
          }
        ]);
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Party Game Products' })).toBeInTheDocument();
    expect(screen.getByText('Cafeteria')).toBeInTheDocument();
  });

  it('opens the front page preview from a hash route', async () => {
    window.location.hash = '#front-page-preview';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/front-page-preview') {
        return jsonResponse([
          {
            category_id: 5,
            category_name: 'Party Game',
            category_type: 'category',
            id: 1,
            order: 10,
            products: [],
            title: 'Party Game'
          }
        ]);
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Front Page Preview' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Party Game' })).toBeInTheDocument();
  });

  it('opens an operation sub page from a hash route', async () => {
    window.location.hash = '#operations-store-item-update';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/admin/operations/store-discovery-runs/latest') {
        return jsonResponse(null);
      }
      if (url.pathname === '/stores') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Store Item Update' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run for selected stores/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run for all/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run Store Discovery/i })).not.toBeInTheDocument();
  });

  it('opens store item update history from a run hash route', async () => {
    window.location.hash = '#operations-store-item-update?run_id=run-update-27';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/admin/operations/store-item-update-jobs/run-update-27/changes') {
        return jsonResponse({
          changes: [],
          job: { id: 27, run_id: 'run-update-27', store_id: 12, store_name: 'Alpha Games' }
        });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Store Item Update History' })).toBeInTheDocument();
    expect(screen.getByText('Alpha Games · Run run-update-27')).toBeInTheDocument();
  });

  it('opens a store item discovery job log from its hash route', async () => {
    window.location.hash = '#operations-store-item-discovery?job_id=19';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/admin/operations/store-item-discovery-jobs/19/log') {
        return jsonResponse({
          entries: [
            {
              created_at: '2026-07-11T12:00:00Z',
              event: 'item_discovery.run.completed',
              id: 80,
              payload: {},
              run_id: 'run-19',
              source: 'discovery'
            }
          ],
          has_more: false,
          job: { id: 19, run_id: 'run-19', status: 'completed', store_id: 12 },
          next_cursor: 80
        });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Store Item Discovery Log' })).toBeInTheDocument();
    expect(screen.getByRole('log', { name: 'Console output for discovery job 19' })).toHaveTextContent(
      'item_discovery.run.completed'
    );
  });

  it('opens the image optimization operation sub page from a hash route', async () => {
    window.location.hash = '#operations-image-optimization';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/admin/operations/external-cover-image-optimizations/latest') {
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Image Optimization' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Optimize Cover Images/i })).toBeInTheDocument();
  });

  it('opens the front page preview from the front page review hash alias', async () => {
    window.location.hash = '#front-page-review';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/front-page-preview') {
        return jsonResponse([
          {
            category_id: 5,
            category_name: 'Party Game',
            category_type: 'category',
            id: 1,
            order: 10,
            products: [],
            title: 'Party Game'
          }
        ]);
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Front Page Preview' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Party Game' })).toBeInTheDocument();
  });

});

function jsonResponse(data: unknown) {
  return new Response(
    JSON.stringify({
      data,
      meta: {
        page: 0,
        page_size: 100,
        total: Array.isArray(data) ? data.length : 1
      }
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      status: 200
    }
  );
}
