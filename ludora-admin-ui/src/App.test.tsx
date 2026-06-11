import { render, screen } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import App from './App';

describe('App', () => {
  afterEach(() => {
    window.location.hash = '';
    vi.restoreAllMocks();
  });

  it('renders the admin shell navigation', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: /Ludora Admin/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Store Candidates/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Stores$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Store Items/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Review Tasks/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Operations/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Items$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Add Front Page Category/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Front Page Preview/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Offers$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Store Item Review/i })).toBeInTheDocument();
  });

  it('opens an item form from a hash route', async () => {
    window.location.hash = '#items?id=77';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (new URL(url).pathname === '/items/77') {
        return jsonResponse({
          canonical_name: 'Coffee Rush',
          id: '77',
          item_type: 'base_game',
          normalized_name: 'coffee rush',
          status: 'active'
        });
      }
      if (new URL(url).pathname === '/items/77/store-items') {
        return jsonResponse([]);
      }
      if (new URL(url).pathname === '/items/77/taxonomy') {
        return jsonResponse({ categories: [], families: [], mechanics: [] });
      }
      if (new URL(url).pathname === '/items') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Item Details' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Coffee Rush')).toBeInTheDocument();
  });

  it('opens the front page category source screen from a hash route', async () => {
    window.location.hash = '#front-page-category-options';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Add Front Page Category' })).toBeInTheDocument();
  });

  it('opens front page category products from a hash route', async () => {
    window.location.hash = '#front-page-category-products?category_type=category&category_id=5&name=Party%20Game';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (new URL(url).pathname === '/front-page-category-options/category/5/products') {
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
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Party Game Products' })).toBeInTheDocument();
    expect(screen.getByText('Cafeteria')).toBeInTheDocument();
  });

  it('opens the front page preview from a hash route', async () => {
    window.location.hash = '#front-page-preview';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([
        {
          category_id: 5,
          category_name: 'Party Game',
          category_type: 'category',
          id: 1,
          order: 10,
          products: [],
          title: 'Party Game'
        }
      ])
    );

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Front Page Preview' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Party Game' })).toBeInTheDocument();
  });

  it('opens the front page preview from the front page review hash alias', async () => {
    window.location.hash = '#front-page-review';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([
        {
          category_id: 5,
          category_name: 'Party Game',
          category_type: 'category',
          id: 1,
          order: 10,
          products: [],
          title: 'Party Game'
        }
      ])
    );

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
