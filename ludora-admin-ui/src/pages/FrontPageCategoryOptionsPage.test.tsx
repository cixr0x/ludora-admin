import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrontPageCategoryOptionsPage } from './FrontPageCategoryOptionsPage';

describe('FrontPageCategoryOptionsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists taxonomy options and adds a front page category from a row', async () => {
    const user = userEvent.setup();
    const handleOpenProducts = vi.fn();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/front-page-category-options' && !init) {
        return jsonResponse([
          {
            bgg_id: 1021,
            category_id: 5,
            category_type: 'category',
            front_page_category_id: null,
            game_count: 42,
            name: 'Party Game',
            name_es: 'Juego de fiesta'
          },
          {
            bgg_id: 2040,
            category_id: 8,
            category_type: 'mechanic',
            front_page_category_id: 99,
            game_count: 17,
            name: 'Hand Management',
            name_es: 'Gestión de mano'
          }
        ]);
      }
      if (pathOf(url) === '/front-page-categories' && init?.method === 'POST') {
        return jsonResponse(
          {
            category_id: 5,
            category_type: 'category',
            id: 100,
            order: 0,
            title: 'Juego de fiesta'
          },
          201
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<FrontPageCategoryOptionsPage onOpenProducts={handleOpenProducts} />);

    expect(await screen.findByText('Juego de fiesta')).toBeInTheDocument();
    expect(screen.getByText('Gestión de mano')).toBeInTheDocument();
    expect(screen.getByText('Games')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.queryByText('BGG ID')).not.toBeInTheDocument();
    expect(screen.queryByText('Category ID')).not.toBeInTheDocument();
    expect(screen.getByText('Added')).toBeInTheDocument();

    await user.click(screen.getByText('Juego de fiesta'));

    expect(handleOpenProducts).toHaveBeenCalledWith(
      expect.objectContaining({
        category_id: 5,
        category_type: 'category',
        name: 'Party Game'
      })
    );

    await user.click(screen.getByRole('button', { name: 'Add Juego de fiesta' }));

    const postCall = fetchMock.mock.calls.find(([url, init]) => pathOf(String(url)) === '/front-page-categories' && init?.method === 'POST');
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      category_id: 5,
      category_type: 'category',
      order: 0,
      title: 'Juego de fiesta'
    });
    expect(handleOpenProducts).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Front page category added.')).toBeInTheDocument();
  });

  it('reloads counts for games not already covered by front page categories', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathAndSearchOf(url) === '/front-page-category-options' && !init) {
        return jsonResponse([
          {
            bgg_id: 1021,
            category_id: 5,
            category_type: 'category',
            front_page_category_id: null,
            game_count: 42,
            name: 'Party Game',
            name_es: 'Juego de fiesta'
          }
        ]);
      }
      if (pathAndSearchOf(url) === '/front-page-category-options?only_unlinked_games=true' && !init) {
        return jsonResponse([
          {
            bgg_id: 1021,
            category_id: 5,
            category_type: 'category',
            front_page_category_id: null,
            game_count: 7,
            name: 'Party Game',
            name_es: 'Juego de fiesta'
          }
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<FrontPageCategoryOptionsPage />);

    expect(await screen.findByText('42')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Only count uncovered games' }));

    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/front-page-category-options?only_unlinked_games=true');
  });
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}

function pathOf(url: string) {
  return new URL(url).pathname;
}

function pathAndSearchOf(url: string) {
  const parsedUrl = new URL(url);
  return `${parsedUrl.pathname}${parsedUrl.search}`;
}
