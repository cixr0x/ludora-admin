import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItemsPage } from './ItemsPage';

describe('ItemsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders catalog items in a server-side table', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([
        {
          bgg_id: 377061,
          canonical_name: 'Coffee Rush',
          id: '1',
          image_url: 'https://cf.geekdo-images.com/coffee-thumb.jpg',
          item_type: 'base_game',
          max_players: 4,
          min_players: 2,
          status: 'active',
          year_published: 2023
        }
      ])
    );

    render(<ItemsPage />);

    expect(await screen.findByRole('table', { name: 'Items' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Coffee Rush thumbnail' })).toHaveAttribute(
      'src',
      'https://cf.geekdo-images.com/coffee-thumb.jpg'
    );
    expect(screen.getByText('Coffee Rush')).toBeInTheDocument();
    expect(screen.getByText('base_game')).toBeInTheDocument();
    expect(screen.getByText('2023')).toBeInTheDocument();
  });

  it('opens a form view from the item table and saves changes', async () => {
    const user = userEvent.setup();
    const item = {
      bgg_id: 377061,
      bgg_last_sync_at: '2026-05-29T09:53:38.466Z',
      bgg_url: 'https://boardgamegeek.com/boardgame/377061/coffee-rush',
      canonical_name: 'Coffee Rush',
      canonical_name_es: 'Cafe Barista',
      complexity: '1.75',
      created_at: '2026-05-29T09:53:38.466Z',
      description: 'Serve coffee fast.',
      description_es: 'Sirve cafe rapido.',
      id: '1',
      image_url: 'https://cf.geekdo-images.com/coffee.jpg',
      image_url_es: 'https://cf.geekdo-images.com/coffee-es.jpg',
      item_type: 'base_game',
      max_minutes: 45,
      max_players: 4,
      min_age: 8,
      min_minutes: 30,
      min_players: 2,
      normalized_name: 'coffee rush',
      normalized_name_es: 'cafe barista',
      parent_item_id: null,
      status: 'active',
      updated_at: '2026-05-29T09:53:38.466Z',
      year_published: 2023
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/items' && !init) {
        return jsonResponse([item]);
      }
      if (pathOf(url) === '/items/1/store-items') {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/items/1/taxonomy') {
        return jsonResponse({
          categories: [],
          families: [],
          mechanics: []
        });
      }
      if (pathOf(url) === '/items/1' && init?.method === 'PATCH') {
        return jsonResponse({
          ...item,
          canonical_name: 'Coffee Rush Updated',
          canonical_name_es: 'Cafe Barista Actualizado',
          description: 'Updated description',
          description_es: 'Descripcion actualizada',
          image_url_es: 'https://cf.geekdo-images.com/coffee-es-updated.jpg',
          normalized_name_es: 'cafe barista actualizado'
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ItemsPage />);

    const titleCells = await screen.findAllByText('Coffee Rush');
    await user.dblClick(titleCells[0]);

    expect(screen.getByRole('heading', { name: 'Item Details' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://boardgamegeek.com/boardgame/377061/coffee-rush')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Coffee Rush item image' })).toHaveAttribute(
      'src',
      'https://cf.geekdo-images.com/coffee.jpg'
    );

    fireEvent.change(screen.getByLabelText('Canonical Name'), { target: { value: 'Coffee Rush Updated' } });
    fireEvent.change(screen.getByLabelText('Canonical Name ES'), { target: { value: 'Cafe Barista Actualizado' } });
    fireEvent.change(screen.getByLabelText('Normalized Name ES'), { target: { value: 'cafe barista actualizado' } });
    fireEvent.change(screen.getByLabelText('Image URL ES'), {
      target: { value: 'https://cf.geekdo-images.com/coffee-es-updated.jpg' }
    });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Updated description' } });
    fireEvent.change(screen.getByLabelText('Description ES'), { target: { value: 'Descripcion actualizada' } });
    await user.click(screen.getByRole('button', { name: 'Save Item' }));

    expect(await screen.findByText('Item saved.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Coffee Rush Updated')).toBeInTheDocument();

    const patchCall = fetchMock.mock.calls.find(([url, init]) => pathOf(String(url)) === '/items/1' && init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      canonical_name: 'Coffee Rush Updated',
      canonical_name_es: 'Cafe Barista Actualizado',
      description: 'Updated description',
      description_es: 'Descripcion actualizada',
      image_url_es: 'https://cf.geekdo-images.com/coffee-es-updated.jpg',
      normalized_name_es: 'cafe barista actualizado'
    });

    await user.click(screen.getByRole('button', { name: 'Back to Items' }));

    expect(await screen.findByText('Coffee Rush Updated')).toBeInTheDocument();
  }, 10000);

  it('renders store items linked to the selected item', async () => {
    const item = {
      bgg_id: 377061,
      bgg_url: 'https://boardgamegeek.com/boardgame/377061/coffee-rush',
      canonical_name: 'Coffee Rush',
      id: '77',
      image_url: 'https://cf.geekdo-images.com/coffee.jpg',
      item_type: 'base_game',
      normalized_name: 'coffee rush',
      status: 'active'
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (pathOf(url) === '/items/77') {
        return jsonResponse(item);
      }
      if (pathOf(url) === '/items/77/store-items') {
        return jsonResponse([
          {
            availability: 'in_stock',
            id: '3365',
            item_id: '77',
            language: 'es',
            last_updated: '2026-05-29T09:53:38.466Z',
            price: '799.00',
            source_url: 'https://store.mx/products/coffee-rush',
            status: 'LISTED',
            store_domain: 'caravanagameshop.com',
            store_name: 'Caravana Game Shop',
            title: 'Coffee Rush'
          }
        ]);
      }
      if (pathOf(url) === '/items/77/taxonomy') {
        return jsonResponse({
          categories: [],
          families: [],
          mechanics: []
        });
      }
      if (pathOf(url) === '/items') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ItemsPage selectedItemId="77" />);

    expect(await screen.findByRole('heading', { name: 'Item Details' })).toBeInTheDocument();

    const storeItemsTable = await screen.findByRole('table', { name: 'Linked store items' });
    expect(within(storeItemsTable).getByRole('link', { name: 'Coffee Rush' })).toHaveAttribute('href', '#listings?id=3365');
    expect(within(storeItemsTable).getByText('Caravana Game Shop')).toBeInTheDocument();
    expect(within(storeItemsTable).getByText('LISTED')).toBeInTheDocument();
    expect(within(storeItemsTable).getByText('799.00')).toBeInTheDocument();
  });

  it('renders categories mechanics and families linked to the selected item', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (pathOf(url) === '/items/77') {
        return jsonResponse({
          bgg_id: 377061,
          bgg_url: 'https://boardgamegeek.com/boardgame/377061/coffee-rush',
          canonical_name: 'Coffee Rush',
          id: '77',
          image_url: 'https://cf.geekdo-images.com/coffee.jpg',
          item_type: 'base_game',
          normalized_name: 'coffee rush',
          status: 'active'
        });
      }
      if (pathOf(url) === '/items/77/store-items') {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/items/77/taxonomy') {
        return jsonResponse({
          categories: [{ id: '1', value: 'Economic', value_es: 'Economico' }],
          families: [{ id: '2', value: 'Food & Drink: Coffee', value_es: 'Cafe' }],
          mechanics: [{ id: '3', value: 'Contracts', value_es: 'Contratos' }]
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ItemsPage selectedItemId="77" />);

    expect(await screen.findByRole('heading', { name: 'Item Details' })).toBeInTheDocument();
    expect(screen.getByText('Categories')).toBeInTheDocument();
    expect(screen.getByText('Economico (Economic)')).toBeInTheDocument();
    expect(screen.getByText('Mechanics')).toBeInTheDocument();
    expect(screen.getByText('Contratos (Contracts)')).toBeInTheDocument();
    expect(screen.getByText('Families')).toBeInTheDocument();
    expect(screen.getByText('Cafe (Food & Drink: Coffee)')).toBeInTheDocument();
  });

  it('opens the item form directly from a selected item id', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (pathOf(url) === '/items/77') {
        return jsonResponse({
          bgg_id: 377061,
          bgg_url: 'https://boardgamegeek.com/boardgame/377061/coffee-rush',
          canonical_name: 'Coffee Rush',
          id: '77',
          image_url: 'https://cf.geekdo-images.com/coffee.jpg',
          item_type: 'base_game',
          normalized_name: 'coffee rush',
          status: 'active'
        });
      }
      if (pathOf(url) === '/items/77/store-items') {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/items/77/taxonomy') {
        return jsonResponse({
          categories: [],
          families: [],
          mechanics: []
        });
      }
      if (pathOf(url) === '/items') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { rerender } = render(<ItemsPage selectedItemId="77" />);

    expect(await screen.findByRole('heading', { name: 'Item Details' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Coffee Rush')).toBeInTheDocument();

    rerender(<ItemsPage />);

    expect(await screen.findByRole('table', { name: 'Items' })).toBeInTheDocument();
  });
});

function pathOf(url: string) {
  return new URL(url).pathname;
}

function jsonResponse(data: unknown, status = 200) {
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
      status
    }
  );
}
