import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrontPageCategoryProductsPage } from './FrontPageCategoryProductsPage';

describe('FrontPageCategoryProductsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows linked products in a mosaic view', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (pathOf(url) === '/front-page-category-options/category/5/products') {
        return jsonResponse([
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
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<FrontPageCategoryProductsPage categoryId="5" categoryType="category" name="Party Game" />);

    expect(await screen.findByRole('heading', { name: 'Party Game Products' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Cafeteria' })).toHaveAttribute('src', 'https://cdn.example/cafe.jpg');
    expect(screen.getByText('Cafeteria')).toBeInTheDocument();
    expect(screen.getByText('Kitchen Rush')).toBeInTheDocument();
    expect(screen.getByText('No image')).toBeInTheDocument();
  });

  it('returns to the front page category options screen', async () => {
    const user = userEvent.setup();
    const handleBack = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));

    render(<FrontPageCategoryProductsPage categoryId="5" categoryType="category" name="Party Game" onBack={handleBack} />);

    await user.click(screen.getByRole('button', { name: 'Back to Add Front Page Category' }));

    expect(handleBack).toHaveBeenCalled();
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
