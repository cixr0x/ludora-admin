import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    cleanup();
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
    expect(screen.getByTestId('aspect-ratio-preview-1')).toHaveStyle({ aspectRatio: '0.75' });
    fireEvent.click(screen.getByLabelText('4:5', { selector: 'input' }));
    fireEvent.click(screen.getByLabelText('Horizontal', { selector: 'input' }));
    expect(screen.getByText(/625 × 500 · ratio 1.250 · reviewer override/)).toBeInTheDocument();
    expect(screen.getByTestId('aspect-ratio-preview-1')).toHaveStyle({
      aspectRatio: '1.25',
      width: 'min(100%, 700px)'
    });
    fireEvent.click(screen.getByLabelText('Square (1:1)', { selector: 'input' }));
    expect(screen.getByText(/500 × 500 · ratio 1.000 · reviewer override/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('4:5', { selector: 'input' }));
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
    expect(JSON.parse(String(acceptRequest?.[1]?.body))).toMatchObject({ aspect_ratio: 1.25 });
  });

  it('selects four source points, cancels back without deleting, and generates manual candidate 3', async () => {
    const automaticCandidate = {
      aspect_ratio: 0.75,
      aspect_ratio_method: 'edge_average',
      construction: 'two-face cover',
      height: 500,
      index: 1,
      square_snapped: false,
      vanishing_confidence: 0,
      width: 375
    };
    const manualCandidate = {
      aspect_ratio: 0.8,
      aspect_ratio_method: 'edge_average',
      construction: 'manual corner selection',
      height: 500,
      index: 3,
      square_snapped: false,
      vanishing_confidence: 0,
      width: 400
    };
    const workflow = {
      candidates: [automaticCandidate],
      created_at: '2026-07-11T12:00:00.000Z',
      expires_at: '2026-07-11T12:30:00.000Z',
      item_id: 77,
      perspective: 'two_faces',
      source_field: 'image_url',
      store_item_id: null,
      workflow_id: 'flatten-manual-77'
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/admin/cover-flattening-workflows/items')) {
        return jsonResponse({ data: workflow }, 201);
      }
      if (url.endsWith('/admin/cover-flattening-workflows/flatten-manual-77/source')) {
        return new Response(new Blob(['source'], { type: 'image/png' }), { status: 200 });
      }
      if (url.endsWith('/admin/cover-flattening-workflows/flatten-manual-77/manual-candidate')) {
        return jsonResponse({ data: { ...workflow, candidates: [automaticCandidate, manualCandidate] } });
      }
      if (url.includes('/admin/cover-flattening-workflows/flatten-manual-77/candidates/')) {
        return new Response(new Blob(['candidate'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });

    render(
      <CoverFlatteningDialog
        request={{
          id: '77',
          kind: 'item',
          sources: [{ field: 'image_url', url: 'https://example.com/box.jpg' }],
          title: 'Coffee Rush'
        }}
        onAccepted={() => undefined}
        onClose={() => undefined}
      />
    );

    expect(await screen.findByText('Two-face perspective detected. One cover candidate was generated.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select points manually' }));
    await selectManualCorner(30, 40);
    const escapedZoom = await beginManualZoom(190, 40);
    fireEvent.keyDown(escapedZoom, { key: 'Escape' });
    expect(screen.getByTestId('manual-cover-point-surface')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/flatten-manual-77') && init?.method === 'DELETE'
    )).toBe(false);
    await beginManualZoom(190, 40);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel manual selection' }));

    expect(screen.getByText('Two-face perspective detected. One cover candidate was generated.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/flatten-manual-77') && init?.method === 'DELETE'
    )).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Select points manually' }));
    const generateButton = screen.getByRole('button', { name: 'Generate manual candidate' });
    expect(generateButton).toBeDisabled();
    await selectManualCorner(30, 40);
    await selectManualCorner(190, 40);
    await selectManualCorner(190, 100);
    await selectManualCorner(30, 100);
    expect(generateButton).toBeEnabled();
    fireEvent.click(generateButton);

    expect(await screen.findByText('Manual cover candidate generated. Select the candidate to save.')).toBeInTheDocument();
    expect(await screen.findByAltText('Flattened cover candidate 3')).toBeInTheDocument();
    expect(screen.getByLabelText('Candidate 3', { selector: 'input' })).toBeChecked();
    const manualRequest = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/manual-candidate'));
    expect(manualRequest?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(manualRequest?.[1]?.body))).toEqual({
      points: [
        { x: 0.1, y: 0.2 },
        { x: 0.9, y: 0.2 },
        { x: 0.9, y: 0.8 },
        { x: 0.1, y: 0.8 }
      ]
    });
  });
});

async function manualPointSurface(): Promise<HTMLElement> {
  await screen.findByAltText('Source box image for Coffee Rush');
  const surface = screen.getByTestId('manual-cover-point-surface');
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(manualSurfaceRectangle());
  return surface;
}

async function beginManualZoom(clientX: number, clientY: number): Promise<HTMLElement> {
  const surface = await manualPointSurface();
  fireEvent.click(surface, { clientX, clientY });
  const zoomSurface = screen.getByTestId('manual-cover-zoom-surface');
  vi.spyOn(zoomSurface, 'getBoundingClientRect').mockReturnValue(manualSurfaceRectangle());
  return zoomSurface;
}

async function selectManualCorner(clientX: number, clientY: number): Promise<void> {
  const zoomSurface = await beginManualZoom(clientX, clientY);
  fireEvent.click(zoomSurface, { clientX: 110, clientY: 70 });
}

function manualSurfaceRectangle(): DOMRect {
  return {
    bottom: 120,
    height: 100,
    left: 10,
    right: 210,
    toJSON: () => ({}),
    top: 20,
    width: 200,
    x: 10,
    y: 20
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}
