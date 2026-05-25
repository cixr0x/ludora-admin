import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListingCandidatesPage } from './ListingCandidatesPage';

describe('ListingCandidatesPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders discovery listing candidate raw fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'listing-1',
              raw_title: 'Azul MX',
              raw_price: '899.00',
              parsed_availability: 'in_stock',
              confidence: '0.82',
              store_candidate_domain: 'example.mx',
              review_status: 'pending',
              last_seen_at: '2026-05-25T10:00:00.000Z'
            }
          ]
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        }
      )
    );

    render(<ListingCandidatesPage />);

    expect(await screen.findByText('Azul MX')).toBeInTheDocument();
    expect(screen.getByText('example.mx')).toBeInTheDocument();
    expect(screen.getByText('899.00')).toBeInTheDocument();
    expect(screen.getByText('in_stock')).toBeInTheDocument();
    expect(screen.getByText('0.82')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });
});
