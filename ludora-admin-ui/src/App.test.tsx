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
      if (new URL(url).pathname === '/items') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Item Details' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Coffee Rush')).toBeInTheDocument();
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
