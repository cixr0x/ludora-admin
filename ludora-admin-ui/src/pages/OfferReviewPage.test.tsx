import { render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByRole('img', { name: 'Store item image for Cafe Barista' })).toHaveAttribute(
      'src',
      'https://store.mx/cafe-barista.jpg'
    );
    expect(screen.getByRole('img', { name: 'Item image for Coffee Rush' })).toHaveAttribute(
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

  it('sets the item Spanish name from the candidate name', async () => {
    const user = userEvent.setup();
    const item = {
      bgg_id: 377061,
      bgg_url: 'https://boardgamegeek.com/boardgame/377061/coffee-rush',
      canonical_name: 'Coffee Rush',
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
      normalized_name: 'coffee rush',
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
                candidate_name: 'Cafe Barista',
                candidate_url: 'https://store.mx/products/cafe-barista',
                item_bgg_id: 377061,
                item_id: 77,
                item_image_url: 'https://bgg.example/coffee-rush.jpg',
                item_name: 'Coffee Rush',
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
              canonical_name_es: 'Cafe Barista',
              normalized_name_es: 'cafe barista'
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
        canonical_name_es: 'Cafe Barista',
        normalized_name_es: ''
      });
    });
    expect(screen.getByRole('link', { name: 'Coffee Rush (Cafe Barista)' })).toHaveAttribute('href', '#items?id=77');
    expect(screen.getByText('Spanish item name saved.')).toBeInTheDocument();
  });

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
});
