import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfferReviewPage } from './OfferReviewPage';

describe('OfferReviewPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders offer-created candidate and linked item comparison fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              candidate_availability: 'available',
              candidate_id: 920,
              candidate_image_url: 'https://store.mx/cafe-barista.jpg',
              candidate_language: 'es',
              candidate_name: 'Cafe Barista',
              candidate_price: '899.00',
              candidate_publisher: 'Korea Boardgames',
              candidate_url: 'https://store.mx/products/cafe-barista',
              item_bgg_id: 377061,
              item_id: 77,
              item_image_url: 'https://bgg.example/coffee-rush.jpg',
              item_image_url_es: 'https://bgg.example/cafe-barista.jpg',
              item_name: 'Coffee Rush',
              item_name_es: 'Cafe Barista',
              item_type: 'base_game',
              match_score: '0.9400',
              match_source: 'BGG',
              store_domain: 'store.mx',
              store_item_listing_status: 'PENDING',
              store_name: 'Store MX'
            }
          ]
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        }
      )
    );

    render(<OfferReviewPage />);

    expect(await screen.findByRole('link', { name: 'Cafe Barista' })).toHaveAttribute('href', '#listings?id=920');
    expect(screen.getByRole('link', { name: 'Coffee Rush (Cafe Barista)' })).toHaveAttribute('href', '#items?id=77');
    expect(screen.getByText('Store MX')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Listing status' })).toBeInTheDocument();
    expect(screen.getByText('PENDING')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Admin links' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Candidate form' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Item form' })).not.toBeInTheDocument();
    expect(screen.getByText('0.9400')).toBeInTheDocument();
    expect(screen.getAllByText('BGG').length).toBeGreaterThan(0);
    const imageComparison = screen.getByRole('group', {
      name: 'Image comparison for Cafe Barista and Coffee Rush'
    });
    expect(imageComparison).toHaveStyle({ flexDirection: 'row' });
    expect(within(imageComparison).getByRole('img', { name: 'Store item image for Cafe Barista' })).toHaveAttribute(
      'src',
      'https://store.mx/cafe-barista.jpg'
    );
    expect(within(imageComparison).getByRole('img', { name: 'Item image for Coffee Rush' })).toHaveAttribute(
      'src',
      'https://bgg.example/cafe-barista.jpg'
    );
    expect(screen.getByRole('link', { name: 'Store item image for Cafe Barista' })).toHaveAttribute(
      'href',
      'https://store.mx/products/cafe-barista'
    );
    expect(screen.getByRole('link', { name: 'Item image for Coffee Rush' })).toHaveAttribute(
      'href',
      'https://boardgamegeek.com/boardgame/377061'
    );
    expect(screen.getByRole('link', { name: 'Store item page' })).toHaveAttribute(
      'href',
      'https://store.mx/products/cafe-barista'
    );
  });

  it('searches and associates an existing item from the store item review table', async () => {
    const user = userEvent.setup();
    const catalogItem = {
      bgg_id: 377061,
      canonical_name: 'Eternal',
      canonical_name_es: 'Aeterna: Edicion en Espanol',
      id: 77,
      image_url: 'https://images.example/eternal.jpg',
      image_url_es: 'https://images.example/aeterna-es.jpg',
      item_type: 'base_game'
    };
    let currentReview: Record<string, unknown> = {
      candidate_id: 3365,
      candidate_image_url: 'https://www.amigocalavera.mx/aeterna.jpg',
      candidate_name: 'Aeterna',
      candidate_url: 'https://www.amigocalavera.mx/productos/aeterna/',
      item_id: 11,
      item_name: 'Incorrect Item',
      store_item_listing_status: 'PENDING'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/admin/discovery/offer-reviews') && !init?.method) {
        return new Response(
          JSON.stringify({ data: [currentReview], meta: { page: 0, page_size: 100, total: 1 } }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 }
        );
      }
      if (url.pathname.endsWith('/items') && !init?.method) {
        return new Response(JSON.stringify({ data: [catalogItem], meta: { page: 0, page_size: 8, total: 1 } }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }
      if (url.pathname.endsWith('/discovery/listings/3365/associate-item') && init?.method === 'POST') {
        currentReview = {
          ...currentReview,
          item_bgg_id: catalogItem.bgg_id,
          item_id: catalogItem.id,
          item_image_url: catalogItem.image_url,
          item_image_url_es: catalogItem.image_url_es,
          item_name: catalogItem.canonical_name,
          item_name_es: catalogItem.canonical_name_es,
          item_type: catalogItem.item_type,
          match_score: 1,
          match_source: 'MANUAL'
        };
        return new Response(JSON.stringify({ data: { id: 3365, item_id: catalogItem.id, match_source: 'MANUAL' } }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(<OfferReviewPage />);

    const reviewTable = await screen.findByRole('table', { name: 'Store item review' });
    await user.click(within(reviewTable).getByRole('button', { name: 'Associate Aeterna with an existing item' }));

    const dialog = await screen.findByRole('dialog', { name: 'Associate Store Item' });
    expect(within(dialog).getByLabelText('Search catalog items')).toHaveValue('Aeterna');
    expect(within(dialog).getByText('Currently associated with item 11')).toBeInTheDocument();
    expect(await within(dialog).findByText('Aeterna: Edicion en Espanol')).toBeInTheDocument();
    expect(within(dialog).getByText('Eternal · Item 77')).toBeInTheDocument();
    expect(within(dialog).getByRole('img', { name: 'Aeterna: Edicion en Espanol cover' })).toHaveAttribute(
      'src',
      'https://images.example/aeterna-es.jpg'
    );

    const itemSearchRequest = fetchMock.mock.calls.find(([input]) => new URL(String(input)).pathname.endsWith('/items'));
    expect(String(itemSearchRequest?.[0])).toContain('filter_name=Aeterna');
    expect(String(itemSearchRequest?.[0])).toContain('page_size=8');

    await user.click(within(dialog).getByRole('button', { name: 'Associate with Aeterna: Edicion en Espanol' }));

    expect(await screen.findByText('Store item associated with Aeterna: Edicion en Espanol.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/discovery/listings/3365/associate-item', {
      body: JSON.stringify({ item_id: '77' }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(await screen.findByRole('link', { name: 'Eternal (Aeterna: Edicion en Espanol)' })).toHaveAttribute(
      'href',
      '#items?id=77'
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Associate Store Item' })).not.toBeInTheDocument());
  });

  it('shows both review images side by side in the default mobile card', async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query.includes('max-width'),
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn()
      })),
      writable: true
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              candidate_id: 920,
              candidate_image_url: 'https://store.mx/cafe-barista.jpg',
              candidate_name: 'Cafe Barista',
              candidate_url: 'https://store.mx/products/cafe-barista',
              item_bgg_id: 377061,
              item_id: 77,
              item_image_url_es: 'https://bgg.example/cafe-barista.jpg',
              item_name: 'Coffee Rush',
              store_item_listing_status: 'PENDING'
            }
          ]
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      )
    );

    try {
      render(<OfferReviewPage />);

      const cards = await screen.findByRole('list', { name: 'Store item review cards' });
      const imageComparison = within(cards).getByRole('group', {
        name: 'Image comparison for Cafe Barista and Coffee Rush'
      });
      expect(imageComparison).toHaveStyle({ flexDirection: 'row' });
      expect(within(imageComparison).getByRole('img', { name: 'Store item image for Cafe Barista' })).toBeVisible();
      expect(within(imageComparison).getByRole('img', { name: 'Item image for Coffee Rush' })).toBeVisible();
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
        writable: true
      });
    }
  });

  it('falls back to the original item image when no Spanish image exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              candidate_id: 3278,
              candidate_name: 'Azul Mini',
              item_id: 78,
              item_image_url: 'https://bgg.example/azul-mini.jpg',
              item_image_url_es: '',
              item_name: 'Azul Mini'
            }
          ]
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        }
      )
    );

    render(<OfferReviewPage />);

    expect(await screen.findByRole('img', { name: 'Item image for Azul Mini' })).toHaveAttribute(
      'src',
      'https://bgg.example/azul-mini.jpg'
    );
  });

  it('filters pending listing status by default', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              candidate_id: 920,
              candidate_name: 'Cafe Barista',
              item_id: 77,
              item_name: 'Coffee Rush',
              store_item_listing_status: 'PENDING'
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

    render(<OfferReviewPage />);

    expect(await screen.findByRole('table', { name: 'Store item review' })).toBeInTheDocument();
    await waitFor(() => {
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('filter_store_item_listing_status=PENDING');
    });
    expect(screen.getByLabelText('Filter Listing status')).toHaveValue('PENDING');
  });

  it('approves and rejects listing status from the review table', async () => {
    const user = userEvent.setup();
    let listingStatus = 'PENDING';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith('/discovery/offer-reviews')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                candidate_id: 920,
                candidate_name: 'Cafe Barista',
                item_id: 77,
                item_name: 'Coffee Rush',
                store_item_listing_status: listingStatus,
                store_name: 'Store MX'
              }
            ],
            meta: { page: 0, page_size: 100, total: 1 }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }

      if (url.pathname.endsWith('/discovery/listings/920/listing-status') && init?.method === 'PATCH') {
        listingStatus = JSON.parse(String(init.body)).listing_status;
        return new Response(
          JSON.stringify({
            data: {
              id: 920,
              listing_status: listingStatus,
              title: 'Cafe Barista'
            }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }

      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(<OfferReviewPage />);

    expect(await screen.findByText('PENDING')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve listing' }));

    await waitFor(() => {
      expect(screen.getByText('LISTED')).toBeInTheDocument();
    });
    expect(screen.getByText('Store item listing approved.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reject listing' }));

    await waitFor(() => {
      expect(screen.getByText('REJECTED')).toBeInTheDocument();
    });
    expect(screen.getByText('Store item listing rejected.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(2);
    expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body))).toEqual({
      listing_status: 'LISTED'
    });
  });

  it('filters offer reviews by item name', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const rows = url.includes('filter_item_name=')
        ? [{ candidate_id: 3278, candidate_name: 'Azul Mini', item_name: 'Azul' }]
        : [
            { candidate_id: 920, candidate_name: 'Cafe Barista', item_name: 'Coffee Rush' },
            { candidate_id: 3278, candidate_name: 'Azul Mini', item_name: 'Azul' }
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

    render(<OfferReviewPage />);

    expect(await screen.findByText('Coffee Rush')).toBeInTheDocument();
    expect(screen.getByText('Azul')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Filter Item name'), 'azul');

    await waitFor(() => {
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('filter_item_name=azul');
    });
    expect(screen.queryByText('Coffee Rush')).not.toBeInTheDocument();
    expect(screen.getByText('Azul')).toBeInTheDocument();
  });

  it.each(['Los Gatos de Schröndinger (Español)', 'Los Gatos de Schröndinger en español'])(
    'sets the item Spanish name from the candidate name without a trailing language suffix: %s',
    async (candidateName) => {
      const user = userEvent.setup();
      const item = {
        bgg_id: 377061,
        bgg_url: 'https://boardgamegeek.com/boardgame/377061/los-gatos-de-schrodinger',
        canonical_name: "Schrodinger's Cats",
        canonical_name_es: '',
        complexity: '1.75',
        description: 'Serve coffee fast.',
        description_es: '',
        id: 77,
        image_url: 'https://cf.geekdo-images.com/coffee.jpg',
        image_url_es: '',
        item_type: 'base_game',
        max_minutes: 45,
        max_players: 4,
        min_age: 8,
        min_minutes: 30,
        min_players: 2,
        normalized_name: 'schrodingers cats',
        normalized_name_es: '',
        parent_item_id: null,
        status: 'active',
        year_published: 2023
      };
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(String(input));

        if (url.pathname.endsWith('/discovery/offer-reviews')) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  candidate_id: 920,
                  candidate_name: candidateName,
                  candidate_url: 'https://store.mx/products/los-gatos-de-schrodinger',
                  item_bgg_id: 377061,
                  item_id: 77,
                  item_image_url: 'https://bgg.example/los-gatos-de-schrodinger.jpg',
                  item_name: "Schrodinger's Cats",
                  item_name_es: ''
                }
              ],
              meta: { page: 0, page_size: 100, total: 1 }
            }),
            {
              headers: { 'Content-Type': 'application/json' },
              status: 200
            }
          );
        }

        if (url.pathname.endsWith('/items/77') && (!init?.method || init.method === 'GET')) {
          return new Response(JSON.stringify({ data: item }), {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          });
        }

        if (url.pathname.endsWith('/items/77') && init?.method === 'PATCH') {
          return new Response(
            JSON.stringify({
              data: {
                ...item,
                canonical_name_es: 'Los Gatos de Schröndinger',
                normalized_name_es: 'los gatos de schrodinger'
              }
            }),
            {
              headers: { 'Content-Type': 'application/json' },
              status: 200
            }
          );
        }

        throw new Error(`Unexpected request: ${String(input)}`);
      });

      render(<OfferReviewPage />);

      expect(await screen.findByRole('columnheader', { name: 'ES' })).toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: 'Spanish name' })).not.toBeInTheDocument();
      expect(screen.getByText('->')).toBeInTheDocument();

      await user.click(await screen.findByRole('button', { name: 'Use candidate name as Spanish item name' }));

      await waitFor(() => {
        const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
        expect(patchCall).toBeDefined();
        expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
          canonical_name_es: 'Los Gatos de Schröndinger',
          normalized_name_es: ''
        });
      });
      expect(screen.getByRole('link', { name: "Schrodinger's Cats (Los Gatos de Schröndinger)" })).toHaveAttribute(
        'href',
        '#items?id=77'
      );
      expect(screen.getByText('Spanish item name saved.')).toBeInTheDocument();
    }
  );

  it('generates and saves a Spanish item description from review row source descriptions', async () => {
    const user = userEvent.setup();
    const item = {
      bgg_id: 377061,
      bgg_url: 'https://boardgamegeek.com/boardgame/377061/coffee-rush',
      canonical_name: 'Coffee Rush',
      canonical_name_es: 'Cafe Barista',
      complexity: '1.75',
      description: 'Complete customer orders to increase your ratings.',
      description_es: '',
      id: 77,
      image_url: 'https://cf.geekdo-images.com/coffee.jpg',
      image_url_es: '',
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
      year_published: 2023
    };
    const generatedDescription =
      'En Cafe Barista, cada pedido convierte la cafeteria en una carrera por ingredientes, reputacion y buen servicio.';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith('/discovery/offer-reviews')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                candidate_description: 'Vive la emocion de una cafeteria llena de pedidos y aromas.',
                candidate_id: 920,
                candidate_name: 'Cafe Barista',
                item_bgg_id: 377061,
                item_description: 'Complete customer orders to increase your ratings.',
                item_description_es: '',
                item_id: 77,
                item_image_url: 'https://bgg.example/coffee-rush.jpg',
                item_name: 'Coffee Rush',
                item_name_es: 'Cafe Barista'
              },
              {
                candidate_description: 'Already translated store source.',
                candidate_id: 921,
                candidate_name: 'Azul',
                item_description: 'Draft tiles.',
                item_description_es: 'Ya existe una descripcion.',
                item_id: 78,
                item_name: 'Azul',
                item_name_es: ''
              }
            ],
            meta: { page: 0, page_size: 100, total: 2 }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }

      if (url.pathname.endsWith('/description-generations') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              description_es: generatedDescription,
              metadata: { sourceBalance: 'mixed', warnings: [] },
              model: 'gpt-5.4-nano',
              prompt_version: 'description-generator-v1'
            }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 201
          }
        );
      }

      if (url.pathname.endsWith('/items/77') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ data: item }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }

      if (url.pathname.endsWith('/items/77') && init?.method === 'PATCH') {
        return new Response(
          JSON.stringify({
            data: {
              ...item,
              description_es: generatedDescription
            }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }

      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(<OfferReviewPage />);

    const generateButtons = await screen.findAllByRole('button', { name: /Generate Spanish item description/ });
    expect(generateButtons[0]).toBeEnabled();
    expect(generateButtons[1]).toBeDisabled();

    await user.click(generateButtons[0]);

    await waitFor(() => {
      const generationCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/admin/description-generations'));
      expect(generationCall).toBeDefined();
      expect(JSON.parse(String(generationCall?.[1]?.body))).toEqual({
        boardgame_name: 'Cafe Barista',
        description_1: 'Complete customer orders to increase your ratings.',
        description_2: 'Vive la emocion de una cafeteria llena de pedidos y aromas.'
      });
    });
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([input, init]) => String(input).endsWith('/items/77') && init?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
      expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
        description_es: generatedDescription
      });
    });
    expect(screen.getByText('Spanish item description saved.')).toBeInTheDocument();
    expect(generateButtons[0]).toBeDisabled();
  });

  it('generates a Spanish item description from a review row with one source description', async () => {
    const user = userEvent.setup();
    const item = {
      bgg_id: 419398,
      canonical_name: 'Star Wars: Unlimited - Shadows of the Galaxy',
      canonical_name_es: '',
      description: 'A tactical card game set in the Star Wars galaxy.',
      description_es: '',
      id: 2247,
      image_url: '',
      image_url_es: '',
      item_type: 'expansion',
      normalized_name: 'star wars unlimited shadows of the galaxy',
      normalized_name_es: '',
      parent_item_id: null,
      status: 'active'
    };
    const generatedDescription = 'Explora una galaxia de decisiones tacticas con cartas y personajes memorables.';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith('/discovery/offer-reviews')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                candidate_description: '',
                candidate_id: 4656,
                candidate_name: 'Star Wars Unlimited Shadows of the Galaxy',
                item_description: 'A tactical card game set in the Star Wars galaxy.',
                item_description_es: '',
                item_id: 2247,
                item_name: 'Star Wars: Unlimited - Shadows of the Galaxy',
                item_name_es: ''
              }
            ],
            meta: { page: 0, page_size: 100, total: 1 }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }

      if (url.pathname.endsWith('/description-generations') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              description_es: generatedDescription,
              metadata: { sourceBalance: 'single_source', warnings: [] },
              model: 'gpt-5.4-mini',
              prompt_version: 'description-generator-v1'
            }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 201
          }
        );
      }

      if (url.pathname.endsWith('/items/2247') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ data: item }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }

      if (url.pathname.endsWith('/items/2247') && init?.method === 'PATCH') {
        return new Response(
          JSON.stringify({
            data: {
              ...item,
              description_es: generatedDescription
            }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }

      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(<OfferReviewPage />);

    const generateButton = await screen.findByRole('button', { name: /Generate Spanish item description/ });
    expect(generateButton).toBeEnabled();

    await user.click(generateButton);

    await waitFor(() => {
      const generationCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/admin/description-generations'));
      expect(generationCall).toBeDefined();
      expect(JSON.parse(String(generationCall?.[1]?.body))).toEqual({
        boardgame_name: 'Star Wars: Unlimited - Shadows of the Galaxy',
        description_1: 'A tactical card game set in the Star Wars galaxy.',
        description_2: ''
      });
    });
    expect(await screen.findByText('Spanish item description saved.')).toBeInTheDocument();
  });
});
