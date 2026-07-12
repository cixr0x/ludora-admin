import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoverFlatteningDialog } from './CoverFlatteningDialog';

describe('CoverFlatteningDialog', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:cover-candidate'),
      revokeObjectURL: vi.fn()
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('chooses an item source, displays candidates, and accepts one for image_url_es', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/admin/cover-flattening-workflows/items')) {
        return jsonResponse({
          data: {
            candidates: [
              {
                aspect_ratio: 0.75,
                aspect_ratio_method: 'edge_average',
                construction: 'two-face cover',
                height: 500,
                index: 1,
                square_snapped: false,
                vanishing_confidence: 0,
                width: 375
              }
            ],
            created_at: '2026-07-11T12:00:00.000Z',
            expires_at: '2026-07-11T12:30:00.000Z',
            item_id: 77,
            perspective: 'two_faces',
            source_field: 'image_url_es',
            store_item_id: null,
            workflow_id: 'flatten-77'
          }
        }, 201);
      }
      if (url.endsWith('/admin/cover-flattening-workflows/flatten-77/candidates/1')) {
        return new Response(new Blob(['candidate'], { type: 'image/png' }), { status: 200 });
      }
      if (url.endsWith('/admin/cover-flattening-workflows/flatten-77/accept')) {
        return jsonResponse({
          data: {
            item_id: 77,
            optimized_size_bytes: 88_000,
            public_url: 'https://cdn.example/boardgame/cover.es.hash.webp',
            s3_key: 'boardgame/cover.es.hash.webp',
            target_field: 'image_url_es'
          }
        });
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });
    const onAccepted = vi.fn();

    render(
      <CoverFlatteningDialog
        request={{
          id: '77',
          kind: 'item',
          sources: [
            { field: 'image_url', url: 'https://example.com/en.jpg' },
            { field: 'image_url_es', url: 'https://example.com/es.jpg' }
          ],
          title: 'Coffee Rush'
        }}
        onAccepted={onAccepted}
        onClose={() => undefined}
      />
    );

    fireEvent.click(screen.getByLabelText('Spanish image', { selector: 'input' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate candidates' }));

    expect(await screen.findByText('Two-face perspective detected. One cover candidate was generated.')).toBeInTheDocument();
    expect(await screen.findByAltText('Flattened cover candidate 1')).toHaveAttribute('src', 'blob:cover-candidate');
    expect(screen.getByText(/375 × 500 · ratio 0.750 · edge estimate/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Square (1:1)', { selector: 'input' }));
    expect(screen.getByText(/500 × 500 · ratio 1.000 · reviewer override/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Spanish image', { selector: 'input' }));
    fireEvent.click(screen.getByRole('button', { name: 'Accept candidate' }));

    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(onAccepted.mock.calls[0]?.[0]).toMatchObject({
      public_url: 'https://cdn.example/boardgame/cover.es.hash.webp',
      target_field: 'image_url_es'
    });
    const startRequest = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/admin/cover-flattening-workflows/items'));
    expect(JSON.parse(String(startRequest?.[1]?.body))).toEqual({ item_id: '77', source_field: 'image_url_es' });
    const acceptRequest = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/flatten-77/accept'));
    expect(JSON.parse(String(acceptRequest?.[1]?.body))).toMatchObject({ aspect_ratio: 1 });
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}
