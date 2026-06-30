import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrontPagePreviewPage } from './FrontPagePreviewPage';

describe('FrontPagePreviewPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows front page categories as streaming-style product rows', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([
        {
          category_id: 5,
          category_name: 'Party Game',
          category_name_es: 'Juego de fiesta',
          category_type: 'category',
          id: 1,
          order: 10,
          products: [
            {
              canonical_name: 'Coffee Rush',
              canonical_name_es: 'Cafeteria',
              id: 77,
              image_url: 'https://cdn.example/coffee.jpg',
              image_url_es: 'https://cdn.example/cafe.jpg',
              item_type: 'base_game',
              year_published: 2023
            },
            {
              canonical_name: 'Kitchen Rush',
              canonical_name_es: '',
              id: 78,
              image_url: '',
              image_url_es: '',
              item_type: 'base_game',
              year_published: 2017
            }
          ],
          title_display: '',
          title: 'Party Game'
        },
        {
          category_id: 22,
          category_name: 'Solo / Solitaire Game',
          category_name_es: '',
          category_type: 'mechanic',
          id: 2,
          order: 20,
          products: [],
          title_display: 'En solitario',
          title: 'Solo Picks'
        }
      ])
    );

    render(<FrontPagePreviewPage />);

    expect(await screen.findByRole('heading', { name: 'Front Page Preview' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Juego de fiesta' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'En solitario' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Solo Picks' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Juego de fiesta products')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Cafeteria' })).toHaveAttribute('src', 'https://cdn.example/cafe.jpg');
    expect(screen.getByText('Cafeteria')).toBeInTheDocument();
    expect(screen.getByText('Kitchen Rush')).toBeInTheDocument();
    expect(screen.getByText('No assigned products.')).toBeInTheDocument();
  });
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}
