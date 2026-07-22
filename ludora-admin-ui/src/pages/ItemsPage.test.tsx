import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
          rating: '7.37125',
          status: 'active',
          year_published: 2023
        }
      ])
    );

    render(<ItemsPage />);

    const itemsTable = await screen.findByRole('table', { name: 'Items' });
    const headers = within(itemsTable).getAllByRole('columnheader').map((header) => header.textContent);
    const firstRowCells = within(within(itemsTable).getAllByRole('row')[2]).getAllByRole('cell');

    expect(headers[0]).toContain('ID');
    expect(headers.join(' ')).toContain('Rating');
    expect(firstRowCells[0]).toHaveTextContent('1');
    expect(screen.getByRole('img', { name: 'Coffee Rush thumbnail' })).toHaveAttribute(
      'src',
      'https://cf.geekdo-images.com/coffee-thumb.jpg'
    );
    expect(screen.getByText('Coffee Rush')).toBeInTheDocument();
    expect(screen.getByText('base_game')).toBeInTheDocument();
    expect(screen.getByText('2023')).toBeInTheDocument();
    expect(screen.getByText('7.37125')).toBeInTheDocument();
  });

  it('opens a form view from the item table and saves changes', async () => {
    const user = userEvent.setup();
    const item = {
      bgg_alternate_names: ['Cafe Barista', 'Cafe Barista Actualizado'],
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
      rating: '7.37125',
      status: 'active',
      updated_at: '2026-05-29T09:53:38.466Z',
      year_published: 2023
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/items' && !init?.method) {
        return jsonResponse([item]);
      }
      if (pathOf(url) === '/items/1/store-items') {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/items/1/relationships') {
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
    expect(screen.getByLabelText('Rating')).toHaveValue('7.37125');
    expect(screen.getByRole('img', { name: 'Coffee Rush item image' })).toHaveAttribute(
      'src',
      'https://cf.geekdo-images.com/coffee.jpg'
    );
    expect(screen.getByRole('img', { name: 'Coffee Rush Spanish item image' })).toHaveAttribute(
      'src',
      'https://cf.geekdo-images.com/coffee-es.jpg'
    );
    expect(screen.getByRole('combobox', { name: 'Canonical Name ES' })).toHaveTextContent('Cafe Barista');
    const normalizedNameEs = screen.getByLabelText('Normalized Name ES');
    const generateDescription = screen.getByRole('button', { name: 'Generate Spanish item description' });
    const description = screen.getByLabelText('Description');
    const descriptionEs = screen.getByLabelText('Description ES');
    const itemType = screen.getByLabelText('Item Type');

    expect(normalizedNameEs.compareDocumentPosition(generateDescription)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(generateDescription.compareDocumentPosition(description)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(description.compareDocumentPosition(descriptionEs)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(descriptionEs.compareDocumentPosition(itemType)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.change(screen.getByLabelText('Canonical Name'), { target: { value: 'Coffee Rush Updated' } });
    await user.click(screen.getByRole('combobox', { name: 'Canonical Name ES' }));
    expect(await screen.findByRole('option', { name: 'Cafe Barista' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Cafe Barista Actualizado' }));
    await user.click(screen.getByRole('button', { name: 'Generate normalized Spanish name' }));
    expect(screen.getByLabelText('Normalized Name ES')).toHaveValue('cafe barista actualizado');
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

  it('generates the Spanish normalized name from the Spanish canonical name', async () => {
    const user = userEvent.setup();
    const item = {
      canonical_name: 'Coffee Rush',
      canonical_name_es: '',
      description: '',
      description_es: '',
      id: '77',
      image_url: 'https://cf.geekdo-images.com/coffee.jpg',
      item_type: 'base_game',
      normalized_name: 'coffee rush',
      normalized_name_es: '',
      status: 'active'
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (pathOf(url) === '/items/77') {
        return jsonResponse(item);
      }
      if (pathOf(url) === '/items/77/store-items') {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/items/77/relationships') {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/items/77/taxonomy') {
        return jsonResponse({
          categories: [],
          families: [],
          mechanics: []
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ItemsPage selectedItemId="77" />);

    const canonicalNameEs = await screen.findByLabelText('Canonical Name ES');
    fireEvent.change(canonicalNameEs, { target: { value: 'Las Ruínas Perdidas de Arnak: Expedición!' } });
    await user.click(screen.getByRole('button', { name: 'Generate normalized Spanish name' }));

    expect(screen.getByLabelText('Normalized Name ES')).toHaveValue('las ruinas perdidas de arnak expedicion');
  });

  it('regenerates and saves a Spanish description from item details', async () => {
    const user = userEvent.setup();
    const generatedDescription = 'Sirve pedidos de cafe antes de que se acabe el tiempo.';
    const item = {
      bgg_id: 377061,
      bgg_url: 'https://boardgamegeek.com/boardgame/377061/coffee-rush',
      canonical_name: 'Coffee Rush',
      canonical_name_es: 'Cafe Barista',
      description: 'Complete customer orders before time runs out.',
      description_es: 'Descripcion anterior.',
      id: '77',
      image_url: 'https://cf.geekdo-images.com/coffee.jpg',
      item_type: 'base_game',
      normalized_name: 'coffee rush',
      status: 'active'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/items/77' && !init?.method) {
        return jsonResponse(item);
      }
      if (pathOf(url) === '/items/77/store-items') {
        return jsonResponse([
          {
            description: 'Vive la emocion de una cafeteria llena de pedidos y aromas.',
            id: '3365',
            item_id: '77',
            source_url: 'https://store.mx/products/coffee-rush',
            title: 'Cafe Barista'
          }
        ]);
      }
      if (pathOf(url) === '/items/77/relationships') {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/items/77/taxonomy') {
        return jsonResponse({
          categories: [],
          families: [],
          mechanics: []
        });
      }
      if (pathOf(url) === '/admin/description-generations' && init?.method === 'POST') {
        return jsonResponse({
          description_es: generatedDescription,
          metadata: {},
          model: 'gpt-4.1-mini',
          prompt_version: 'description-generator-v1'
        });
      }
      if (pathOf(url) === '/items/77' && init?.method === 'PATCH') {
        return jsonResponse({
          ...item,
          description_es: generatedDescription
        });
      }
      if (pathOf(url) === '/items') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ItemsPage selectedItemId="77" />);

    const generateButton = await screen.findByRole('button', { name: 'Generate Spanish item description' });
    expect(generateButton).toBeEnabled();
    await user.click(generateButton);

    await waitFor(() => {
      const generationCall = fetchMock.mock.calls.find(([input]) => pathOf(String(input)) === '/admin/description-generations');
      expect(generationCall).toBeDefined();
      expect(JSON.parse(String(generationCall?.[1]?.body))).toEqual({
        boardgame_name: 'Cafe Barista',
        description_1: 'Complete customer orders before time runs out.',
        description_2: 'Vive la emocion de una cafeteria llena de pedidos y aromas.'
      });
    });

    const patchCall = fetchMock.mock.calls.find(([url, init]) => pathOf(String(url)) === '/items/77' && init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      canonical_name: 'Coffee Rush',
      description: 'Complete customer orders before time runs out.',
      description_es: generatedDescription
    });
    expect(await screen.findByText('Spanish item description saved.')).toBeInTheDocument();
    expect(screen.getByLabelText('Description ES')).toHaveValue(generatedDescription);
  });

  it('generates a Spanish description from item details when only the item description exists', async () => {
    const user = userEvent.setup();
    const generatedDescription = 'Explora una galaxia de decisiones tacticas con cartas y personajes memorables.';
    const item = {
      bgg_id: 419398,
      bgg_url: 'https://boardgamegeek.com/boardgame/419398/star-wars-unlimited-shadows-galaxy',
      canonical_name: 'Star Wars: Unlimited - Shadows of the Galaxy',
      canonical_name_es: '',
      description: 'A tactical card game set in the Star Wars galaxy.',
      description_es: '',
      id: '2247',
      item_type: 'expansion',
      normalized_name: 'star wars unlimited shadows of the galaxy',
      status: 'active'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/items/2247' && !init?.method) {
        return jsonResponse(item);
      }
      if (pathOf(url) === '/items/2247/store-items') {
        return jsonResponse([
          {
            description: '',
            id: '4656',
            item_id: '2247',
            source_url: 'https://store.mx/products/star-wars-unlimited',
            title: 'Star Wars Unlimited Shadows of the Galaxy'
          }
        ]);
      }
      if (pathOf(url) === '/items/2247/relationships') {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/items/2247/taxonomy') {
        return jsonResponse({
          categories: [],
          families: [],
          mechanics: []
        });
      }
      if (pathOf(url) === '/admin/description-generations' && init?.method === 'POST') {
        return jsonResponse({
          description_es: generatedDescription,
          metadata: {},
          model: 'gpt-5.4-mini',
          prompt_version: 'description-generator-v1'
        });
      }
      if (pathOf(url) === '/items/2247' && init?.method === 'PATCH') {
        return jsonResponse({
          ...item,
          description_es: generatedDescription
        });
      }
      if (pathOf(url) === '/items') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ItemsPage selectedItemId="2247" />);

    const generateButton = await screen.findByRole('button', { name: 'Generate Spanish item description' });
    expect(generateButton).toBeEnabled();
    await user.click(generateButton);

    await waitFor(() => {
      const generationCall = fetchMock.mock.calls.find(([input]) => pathOf(String(input)) === '/admin/description-generations');
      expect(generationCall).toBeDefined();
      expect(JSON.parse(String(generationCall?.[1]?.body))).toEqual({
        boardgame_name: 'Star Wars: Unlimited - Shadows of the Galaxy',
        description_1: 'A tactical card game set in the Star Wars galaxy.',
        description_2: ''
      });
    });

    expect(await screen.findByText('Spanish item description saved.')).toBeInTheDocument();
  });

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
      if (pathOf(url) === '/items/77/relationships') {
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

    render(<ItemsPage selectedItemId="77" />);

    expect(await screen.findByRole('heading', { name: 'Item Details' })).toBeInTheDocument();

    const storeItemsTable = await screen.findByRole('table', { name: 'Linked store items' });
    expect(within(storeItemsTable).getByRole('link', { name: 'Coffee Rush' })).toHaveAttribute('href', '#listings?id=3365');
    expect(within(storeItemsTable).getByText('Caravana Game Shop')).toBeInTheDocument();
    expect(within(storeItemsTable).getByText('LISTED')).toBeInTheDocument();
    expect(within(storeItemsTable).getByText('799.00')).toBeInTheDocument();
  });

  it('starts a local cover workflow from a linked store item image', async () => {
    const user = userEvent.setup();
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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/items/77') {
        return jsonResponse(item);
      }
      if (pathOf(url) === '/items/77/store-items') {
        return jsonResponse([
          {
            availability: 'in_stock',
            id: '3365',
            image_url: 'https://store.mx/products/coffee-rush-box.jpg',
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
      if (pathOf(url) === '/items/77/relationships') {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/items/77/taxonomy') {
        return jsonResponse({
          categories: [],
          families: [],
          mechanics: []
        });
      }
      if (pathOf(url) === '/admin/local-cover-workflows' && init?.method === 'POST') {
        return jsonResponse(
          {
            error: null,
            expected_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.es.webp',
            expected_paths: [
              'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.en.webp',
              'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.es.webp'
            ],
            filename: 'coffeerush.es.webp',
            item_id: 77,
            public_url: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/coffeerush.es.webp',
            source_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.source.jpg',
            status: 'waiting_for_edit',
            store_item_id: 3365,
            target_field: null,
            workflow_id: 'cover-3365-77'
          },
          202
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ItemsPage selectedItemId="77" />);

    const storeItemsTable = await screen.findByRole('table', { name: 'Linked store items' });
    expect(within(storeItemsTable).getByRole('button', { name: 'Flatten cover for Coffee Rush' })).toBeEnabled();
    await user.click(within(storeItemsTable).getByRole('button', { name: 'Start cover workflow for Coffee Rush' }));

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/local-cover-workflows', {
      body: JSON.stringify({ store_item_id: '3365' }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(await screen.findByText('Cover workflow started for coffeerush.es.webp.')).toBeInTheDocument();
    expect(screen.getByText('Save the edited cover to one of:')).toBeInTheDocument();
    expect(screen.getByText('C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.en.webp')).toBeInTheDocument();
    expect(screen.getByText('C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.es.webp')).toBeInTheDocument();
  });

  it('starts a local cover workflow from the item image', async () => {
    const user = userEvent.setup();
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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/items/77') {
        return jsonResponse(item);
      }
      if (pathOf(url) === '/items/77/store-items') {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/items/77/relationships') {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/items/77/taxonomy') {
        return jsonResponse({
          categories: [],
          families: [],
          mechanics: []
        });
      }
      if (pathOf(url) === '/admin/local-cover-workflows/items' && init?.method === 'POST') {
        return jsonResponse(
          {
            error: null,
            expected_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.es.webp',
            expected_paths: [
              'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.en.webp',
              'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.es.webp'
            ],
            filename: 'coffeerush.es.webp',
            item_id: 77,
            public_url: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/coffeerush.es.webp',
            source_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.source.jpg',
            status: 'waiting_for_edit',
            store_item_id: null,
            target_field: null,
            workflow_id: 'cover-item-77'
          },
          202
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ItemsPage selectedItemId="77" />);

    await screen.findByRole('heading', { name: 'Item Details' });
    expect(screen.getByRole('button', { name: 'Flatten cover for Coffee Rush' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Start cover workflow from item image for Coffee Rush' }));

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/local-cover-workflows/items', {
      body: JSON.stringify({ item_id: '77' }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(await screen.findByText('Cover workflow started for coffeerush.es.webp.')).toBeInTheDocument();
    expect(screen.getByText('C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.en.webp')).toBeInTheDocument();
    expect(screen.getByText('C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.es.webp')).toBeInTheDocument();
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
      if (pathOf(url) === '/items/77/relationships') {
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
    expect(screen.getByText('Economico')).toBeInTheDocument();
    expect(screen.getByText('Mechanics')).toBeInTheDocument();
    expect(screen.getByText('Contratos')).toBeInTheDocument();
    expect(screen.getByText('Families')).toBeInTheDocument();
    expect(screen.getByText('Cafe')).toBeInTheDocument();
  });

  it('renders item relationships and adds a new relationship', async () => {
    const user = userEvent.setup();
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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/items/77') {
        return jsonResponse(item);
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
      if (pathOf(url) === '/items/77/relationships' && !init?.method) {
        return jsonResponse([
          {
            direction: 'incoming',
            id: '100',
            item_a_id: '12',
            item_b_id: '77',
            link_type: 'extension',
            related_item_id: '12',
            related_item_name: 'Coffee Rush Deluxe',
            related_item_name_es: '',
            source: 'bgg',
            source_ref: '377061'
          }
        ]);
      }
      if (pathOf(url) === '/items/77/relationships' && init?.method === 'POST') {
        return jsonResponse(
          {
            direction: 'incoming',
            id: '101',
            item_a_id: '88',
            item_b_id: '77',
            link_type: 'implementation',
            related_item_id: '88',
            related_item_name: 'Coffee Rush Original',
            related_item_name_es: '',
            source: 'admin',
            source_ref: ''
          },
          201
        );
      }
      if (pathOf(url) === '/items/77/relationships/100' && init?.method === 'DELETE') {
        return jsonResponse({
          direction: 'incoming',
          id: '100',
          item_a_id: '12',
          item_b_id: '77',
          link_type: 'extension',
          related_item_id: '12',
          related_item_name: 'Coffee Rush Deluxe',
          related_item_name_es: '',
          source: 'bgg',
          source_ref: '377061'
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ItemsPage selectedItemId="77" />);

    const relationshipsTable = await screen.findByRole('table', { name: 'Item relationships' });
    expect(within(relationshipsTable).getByText('Coffee Rush Deluxe')).toBeInTheDocument();
    expect(within(relationshipsTable).getByText('Extended by')).toBeInTheDocument();

    const addRelationshipForm = screen.getByRole('form', { name: 'Add item relationship' });
    expect(within(addRelationshipForm).queryByLabelText('Direction')).not.toBeInTheDocument();
    expect(within(addRelationshipForm).queryByLabelText('Source')).not.toBeInTheDocument();
    expect(within(addRelationshipForm).queryByLabelText('Source Ref')).not.toBeInTheDocument();

    await user.click(within(addRelationshipForm).getByRole('combobox', { name: /relationship type/i }));
    await user.click(screen.getByRole('option', { name: 'Implemented by' }));
    await user.type(within(addRelationshipForm).getByRole('spinbutton', { name: /related item id/i }), '88');
    await user.click(within(addRelationshipForm).getByRole('button', { name: 'Add Relationship' }));

    expect(await screen.findByText('Relationship added.')).toBeInTheDocument();
    expect(within(relationshipsTable).getByText('Coffee Rush Original')).toBeInTheDocument();
    expect(within(relationshipsTable).getByText('Implemented by')).toBeInTheDocument();

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => pathOf(String(url)) === '/items/77/relationships' && init?.method === 'POST'
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      direction: 'incoming',
      link_type: 'implementation',
      related_item_id: '88',
      source: 'admin',
      source_ref: ''
    });

    await user.click(within(relationshipsTable).getByRole('button', { name: 'Delete relationship Coffee Rush Deluxe' }));

    expect(await screen.findByText('Relationship deleted.')).toBeInTheDocument();
    await waitFor(() => expect(within(relationshipsTable).queryByText('Coffee Rush Deluxe')).not.toBeInTheDocument());

    const deleteCall = fetchMock.mock.calls.find(
      ([url, init]) => pathOf(String(url)) === '/items/77/relationships/100' && init?.method === 'DELETE'
    );
    expect(deleteCall?.[1]).toEqual({ credentials: 'include', method: 'DELETE' });
  });

  it('refreshes taxonomy after adding an implementation relationship', async () => {
    const user = userEvent.setup();
    let taxonomyRequests = 0;
    const item = {
      bgg_id: 377061,
      bgg_url: 'https://boardgamegeek.com/boardgame/377061/coffee-rush-dice',
      canonical_name: 'Coffee Rush Dice',
      id: '77',
      image_url: 'https://cf.geekdo-images.com/coffee-dice.jpg',
      item_type: 'base_game',
      normalized_name: 'coffee rush dice',
      status: 'active'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/items/77') {
        return jsonResponse(item);
      }
      if (pathOf(url) === '/items/77/store-items') {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/items/77/relationships' && !init?.method) {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/items/77/taxonomy') {
        taxonomyRequests += 1;
        return jsonResponse(
          taxonomyRequests === 1
            ? {
                categories: [],
                families: [],
                mechanics: []
              }
            : {
                categories: [{ id: '1', value: 'Economic', value_es: 'Economico' }],
                families: [{ id: '2', value: 'Food & Drink: Coffee', value_es: 'Cafe' }],
                mechanics: [{ id: '3', value: 'Contracts', value_es: 'Contratos' }]
              }
        );
      }
      if (pathOf(url) === '/items/77/relationships' && init?.method === 'POST') {
        return jsonResponse(
          {
            direction: 'outgoing',
            id: '101',
            item_a_id: '77',
            item_b_id: '88',
            link_type: 'implementation',
            related_item_id: '88',
            related_item_name: 'Coffee Rush Original',
            related_item_name_es: '',
            source: 'admin',
            source_ref: ''
          },
          201
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ItemsPage selectedItemId="77" />);

    expect(await screen.findByRole('heading', { name: 'Item Details' })).toBeInTheDocument();
    expect(screen.getByText('No linked categories.')).toBeInTheDocument();

    const addRelationshipForm = screen.getByRole('form', { name: 'Add item relationship' });
    await user.click(within(addRelationshipForm).getByRole('combobox', { name: /relationship type/i }));
    await user.click(screen.getByRole('option', { name: 'Implements' }));
    await user.type(within(addRelationshipForm).getByRole('spinbutton', { name: /related item id/i }), '88');
    await user.click(within(addRelationshipForm).getByRole('button', { name: 'Add Relationship' }));

    expect(await screen.findByText('Relationship added.')).toBeInTheDocument();
    expect(await screen.findByText('Economico')).toBeInTheDocument();
    expect(screen.getByText('Contratos')).toBeInTheDocument();
    expect(screen.getByText('Cafe')).toBeInTheDocument();
    expect(taxonomyRequests).toBe(2);

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => pathOf(String(url)) === '/items/77/relationships' && init?.method === 'POST'
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      direction: 'outgoing',
      link_type: 'implementation',
      related_item_id: '88',
      source: 'admin',
      source_ref: ''
    });
  });

  it('replaces reciprocal implementation relationships after adding an implementation relationship', async () => {
    const user = userEvent.setup();
    const item = {
      bgg_id: 377061,
      bgg_url: 'https://boardgamegeek.com/boardgame/377061/coffee-rush-dice',
      canonical_name: 'Coffee Rush Dice',
      id: '77',
      image_url: 'https://cf.geekdo-images.com/coffee-dice.jpg',
      item_type: 'base_game',
      normalized_name: 'coffee rush dice',
      status: 'active'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/items/77') {
        return jsonResponse(item);
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
      if (pathOf(url) === '/items/77/relationships' && !init?.method) {
        return jsonResponse([
          {
            direction: 'incoming',
            id: '100',
            item_a_id: '88',
            item_b_id: '77',
            link_type: 'implementation',
            related_item_id: '88',
            related_item_name: 'Coffee Rush Original',
            related_item_name_es: '',
            source: 'admin',
            source_ref: ''
          }
        ]);
      }
      if (pathOf(url) === '/items/77/relationships' && init?.method === 'POST') {
        return jsonResponse(
          {
            direction: 'outgoing',
            id: '101',
            item_a_id: '77',
            item_b_id: '88',
            link_type: 'implementation',
            related_item_id: '88',
            related_item_name: 'Coffee Rush Original',
            related_item_name_es: '',
            source: 'admin',
            source_ref: ''
          },
          201
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ItemsPage selectedItemId="77" />);

    const relationshipsTable = await screen.findByRole('table', { name: 'Item relationships' });
    expect(within(relationshipsTable).getByText('Implemented by')).toBeInTheDocument();

    const addRelationshipForm = screen.getByRole('form', { name: 'Add item relationship' });
    await user.click(within(addRelationshipForm).getByRole('combobox', { name: /relationship type/i }));
    await user.click(screen.getByRole('option', { name: 'Implements' }));
    await user.type(within(addRelationshipForm).getByRole('spinbutton', { name: /related item id/i }), '88');
    await user.click(within(addRelationshipForm).getByRole('button', { name: 'Add Relationship' }));

    expect(await screen.findByText('Relationship added.')).toBeInTheDocument();
    await waitFor(() => expect(within(relationshipsTable).queryByText('Implemented by')).not.toBeInTheDocument());
    expect(within(relationshipsTable).getByText('Implements')).toBeInTheDocument();
    expect(within(relationshipsTable).getAllByText('Coffee Rush Original')).toHaveLength(1);

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => pathOf(String(url)) === '/items/77/relationships' && init?.method === 'POST'
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      direction: 'outgoing',
      link_type: 'implementation',
      related_item_id: '88',
      source: 'admin',
      source_ref: ''
    });
  });

  it('replaces reciprocal extension relationships after adding an extension relationship', async () => {
    const user = userEvent.setup();
    const item = {
      bgg_id: 377061,
      bgg_url: 'https://boardgamegeek.com/boardgame/377061/coffee-rush-expansion',
      canonical_name: 'Coffee Rush Expansion',
      id: '77',
      image_url: 'https://cf.geekdo-images.com/coffee-expansion.jpg',
      item_type: 'expansion',
      normalized_name: 'coffee rush expansion',
      status: 'active'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/items/77') {
        return jsonResponse(item);
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
      if (pathOf(url) === '/items/77/relationships' && !init?.method) {
        return jsonResponse([
          {
            direction: 'incoming',
            id: '100',
            item_a_id: '88',
            item_b_id: '77',
            link_type: 'extension',
            related_item_id: '88',
            related_item_name: 'Coffee Rush',
            related_item_name_es: '',
            source: 'admin',
            source_ref: ''
          }
        ]);
      }
      if (pathOf(url) === '/items/77/relationships' && init?.method === 'POST') {
        return jsonResponse(
          {
            direction: 'outgoing',
            id: '101',
            item_a_id: '77',
            item_b_id: '88',
            link_type: 'extension',
            related_item_id: '88',
            related_item_name: 'Coffee Rush',
            related_item_name_es: '',
            source: 'admin',
            source_ref: ''
          },
          201
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ItemsPage selectedItemId="77" />);

    const relationshipsTable = await screen.findByRole('table', { name: 'Item relationships' });
    expect(within(relationshipsTable).getByText('Extended by')).toBeInTheDocument();

    const addRelationshipForm = screen.getByRole('form', { name: 'Add item relationship' });
    await user.type(within(addRelationshipForm).getByRole('spinbutton', { name: /related item id/i }), '88');
    await user.click(within(addRelationshipForm).getByRole('button', { name: 'Add Relationship' }));

    expect(await screen.findByText('Relationship added.')).toBeInTheDocument();
    await waitFor(() => expect(within(relationshipsTable).queryByText('Extended by')).not.toBeInTheDocument());
    expect(within(relationshipsTable).getByText('Extends')).toBeInTheDocument();
    expect(within(relationshipsTable).getAllByText('Coffee Rush')).toHaveLength(1);

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => pathOf(String(url)) === '/items/77/relationships' && init?.method === 'POST'
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      direction: 'outgoing',
      link_type: 'extension',
      related_item_id: '88',
      source: 'admin',
      source_ref: ''
    });
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
      if (pathOf(url) === '/items/77/relationships') {
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
