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

  it('uses a fullscreen, stacked workflow layout below the md breakpoint', async () => {
    useMobileViewport();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/admin/cover-flattening-workflows/items')) {
        return jsonResponse({
          data: {
            automatic_error: null,
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
            source_field: 'image_url',
            store_item_id: null,
            workflow_id: 'flatten-mobile-77'
          }
        }, 201);
      }
      if (url.endsWith('/admin/cover-flattening-workflows/flatten-mobile-77/candidates/1')) {
        return new Response(new Blob(['candidate'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(
      <CoverFlatteningDialog
        request={{
          id: '77',
          kind: 'item',
          sources: [{ field: 'image_url', url: 'https://example.com/box.jpg' }],
          title: 'Mobile Box'
        }}
        onAccepted={() => undefined}
        onClose={() => undefined}
      />
    );

    expect(await screen.findByAltText('Flattened cover candidate 1')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('MuiDialog-paperFullScreen');

    const ratioGroup = screen.getByLabelText('Square (1:1)', { selector: 'input' }).closest('[role="radiogroup"]');
    const orientationGroup = screen.getByLabelText('Horizontal', { selector: 'input' }).closest('[role="radiogroup"]');
    const targetGroup = screen.getByLabelText('Spanish image', { selector: 'input' }).closest('[role="radiogroup"]');
    expect(ratioGroup).not.toHaveClass('MuiFormGroup-row');
    expect(orientationGroup).not.toHaveClass('MuiFormGroup-row');
    expect(targetGroup).not.toHaveClass('MuiFormGroup-row');

    const actions = dialog.querySelector('.MuiDialogActions-root');
    expect(actions).toHaveStyle({ alignItems: 'stretch', flexDirection: 'column' });
    expect(screen.getByRole('button', { name: 'Accept candidate' })).toHaveStyle({ minHeight: '44px', width: '100%' });
  });

  it('resets manual trim when the same cover workflow is reopened', async () => {
    let workflowNumber = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/admin/cover-flattening-workflows/items')) {
        workflowNumber += 1;
        return jsonResponse({
          data: {
            automatic_error: null,
            candidates: [
              {
                aspect_ratio: 1,
                aspect_ratio_method: 'edge_average',
                construction: 'two-face cover',
                height: 500,
                index: 1,
                square_snapped: true,
                vanishing_confidence: 0,
                width: 500
              }
            ],
            created_at: '2026-07-11T12:00:00.000Z',
            expires_at: '2026-07-11T12:30:00.000Z',
            item_id: 77,
            perspective: 'two_faces',
            source_field: 'image_url',
            store_item_id: null,
            workflow_id: `flatten-reset-${workflowNumber}`
          }
        }, 201);
      }
      if (url.includes('/admin/cover-flattening-workflows/flatten-reset-') && url.endsWith('/candidates/1')) {
        return new Response(new Blob(['candidate'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const request = {
      id: '77',
      kind: 'item' as const,
      sources: [{ field: 'image_url' as const, url: 'https://example.com/box.jpg' }],
      title: 'Reset Box'
    };
    const { rerender } = render(
      <CoverFlatteningDialog request={request} onAccepted={() => undefined} onClose={() => undefined} />
    );

    expect(await screen.findByText('0.0%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Increase trim by 0.1%' }));
    expect(screen.getByText('0.1%')).toBeInTheDocument();

    rerender(<CoverFlatteningDialog request={null} onAccepted={() => undefined} onClose={() => undefined} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    rerender(<CoverFlatteningDialog request={request} onAccepted={() => undefined} onClose={() => undefined} />);

    await waitFor(() => {
      const starts = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/admin/cover-flattening-workflows/items'));
      expect(starts).toHaveLength(2);
    });
    expect(await screen.findByText('0.0%')).toBeInTheDocument();
  });

  it('chooses an item source, displays candidates, and accepts one for image_url_es', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/admin/cover-flattening-workflows/items')) {
        return jsonResponse({
          data: {
            automatic_error: null,
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
    expect(screen.getByText('0.0%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decrease trim by 0.1%' })).toBeDisabled();
    expect(screen.getByTestId('trim-preview-image-1')).toHaveStyle({ transform: 'scale(1)' });
    fireEvent.click(screen.getByRole('button', { name: 'Increase trim by 0.1%' }));
    expect(screen.getByText('0.1%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decrease trim by 0.1%' })).toBeEnabled();
    expect(screen.getByTestId('trim-preview-image-1')).toHaveStyle({
      transform: `scale(${375 / 373}, ${500 / 498})`
    });
    fireEvent.click(screen.getByLabelText('4:5', { selector: 'input' }));
    fireEvent.click(screen.getByLabelText('Horizontal', { selector: 'input' }));
    expect(screen.getByText(/623 × 498 · ratio 1.250 · reviewer override/)).toBeInTheDocument();
    expect(screen.getByTestId('aspect-ratio-preview-1')).toHaveStyle({
      aspectRatio: '1.25',
      width: 'min(100%, 700px)'
    });
    fireEvent.click(screen.getByLabelText('Square (1:1)', { selector: 'input' }));
    expect(screen.getByText(/498 × 498 · ratio 1.000 · reviewer override/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('3:4', { selector: 'input' }));
    fireEvent.click(screen.getByLabelText('Vertical', { selector: 'input' }));
    expect(screen.getByText(/374 × 498 · ratio 0.750 · reviewer override/)).toBeInTheDocument();
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
    expect(JSON.parse(String(acceptRequest?.[1]?.body))).toMatchObject({
      aspect_ratio: 0.75,
      trim_fraction: 0.001
    });
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
      automatic_error: null,
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

  it('offers manual point selection when automatic detection returns no candidates', async () => {
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
    const failedWorkflow = {
      automatic_error: 'Flattening must return one or two cover candidates.',
      candidates: [],
      created_at: '2026-07-11T12:00:00.000Z',
      expires_at: '2026-07-11T12:30:00.000Z',
      item_id: 77,
      perspective: null,
      source_field: 'image_url',
      store_item_id: null,
      workflow_id: 'flatten-fallback-77'
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/admin/cover-flattening-workflows/items')) {
        return jsonResponse({ data: failedWorkflow }, 201);
      }
      if (url.endsWith('/admin/cover-flattening-workflows/flatten-fallback-77/source')) {
        return new Response(new Blob(['source'], { type: 'image/png' }), { status: 200 });
      }
      if (url.endsWith('/admin/cover-flattening-workflows/flatten-fallback-77/manual-candidate')) {
        return jsonResponse({ data: { ...failedWorkflow, candidates: [manualCandidate] } });
      }
      if (url.endsWith('/admin/cover-flattening-workflows/flatten-fallback-77/candidates/3')) {
        return new Response(new Blob(['candidate'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(
      <CoverFlatteningDialog
        request={{
          id: '77',
          kind: 'item',
          sources: [{ field: 'image_url', url: 'https://example.com/box.jpg' }],
          title: 'Fallback Box'
        }}
        onAccepted={() => undefined}
        onClose={() => undefined}
      />
    );

    expect(await screen.findByText(/Automatic point selection could not find a usable cover/)).toBeInTheDocument();
    expect(screen.getByText(/Flattening must return one or two cover candidates/)).toBeInTheDocument();
    expect(screen.queryByText('Output aspect ratio')).not.toBeInTheDocument();
    expect(screen.queryByText('Save selected candidate as')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept candidate' })).not.toBeInTheDocument();

    const selectManuallyButton = screen.getByRole('button', { name: 'Select points manually' });
    expect(selectManuallyButton).toBeEnabled();
    fireEvent.click(selectManuallyButton);
    await selectManualCorner(30, 40, 'Fallback Box');
    await selectManualCorner(190, 40, 'Fallback Box');
    await selectManualCorner(190, 100, 'Fallback Box');
    await selectManualCorner(30, 100, 'Fallback Box');
    fireEvent.click(screen.getByRole('button', { name: 'Generate manual candidate' }));

    expect(await screen.findByText('Manual cover candidate generated. Select the candidate to save.')).toBeInTheDocument();
    expect(await screen.findByAltText('Flattened cover candidate 3')).toBeInTheDocument();
    expect(screen.getByText('Output aspect ratio')).toBeInTheDocument();
    expect(screen.getByText('Save selected candidate as')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept candidate' })).toBeInTheDocument();
  });
});

async function manualPointSurface(imageTitle = 'Coffee Rush'): Promise<HTMLElement> {
  await screen.findByAltText(`Source box image for ${imageTitle}`);
  const surface = screen.getByTestId('manual-cover-point-surface');
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(manualSurfaceRectangle());
  return surface;
}

async function beginManualZoom(clientX: number, clientY: number, imageTitle = 'Coffee Rush'): Promise<HTMLElement> {
  const surface = await manualPointSurface(imageTitle);
  fireEvent.click(surface, { clientX, clientY });
  const zoomSurface = screen.getByTestId('manual-cover-zoom-surface');
  vi.spyOn(zoomSurface, 'getBoundingClientRect').mockReturnValue(manualSurfaceRectangle());
  return zoomSurface;
}

async function selectManualCorner(clientX: number, clientY: number, imageTitle = 'Coffee Rush'): Promise<void> {
  const zoomSurface = await beginManualZoom(clientX, clientY, imageTitle);
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

function useMobileViewport() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query.includes('max-width:899.95px'),
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn()
    }))
  );
}
