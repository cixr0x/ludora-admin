import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewImageSimilarity as Component } from './ReviewImageSimilarity';

const sift = { score: 98.62, method: 'sift_homography_v1', matched_region: null,
  diagnostics: { reference_dimensions: { width: 400, height: 500 }, candidate_dimensions: { width: 1200, height: 900 },
    reference_keypoints: 100, candidate_keypoints: 200, tentative_matches: 80, inliers: 78, inlier_ratio: 0.975,
    reference_hull_coverage: 0.8, reference_grid_coverage: 0.8, median_reprojection_error: 0.1, projected_area_ratio: 0.1, homography_valid: true } };
const best = { status: 'ready', method: 'phash_dct256_v1', score: 85.9375, distance: 36, origin: 'box_silhouette',
  raw: { score: 50, distance: 128 }, variant_count: 2, normalization_status: 'completed' };
const props = { itemImageLabel: 'Spanish cover', itemImageUrl: 'https://catalog.test/current.webp',
  storeItemImageUrl: 'https://store.test/current.jpg', linkedItemLoaded: true, linkedItemPresent: true, reviewId: '920' };
function response(data: unknown, status = 200) { return new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } }); }

describe('review pair fingerprint display', () => {
  afterEach(() => vi.restoreAllMocks());

  it('waits for an explicit calculation on mount and unrelated rerenders', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...sift, hash_similarity: best }));
    const view = render(<Component {...props} />);
    expect(screen.getByRole('status', { name: 'Image similarity' })).toHaveTextContent('Image similarity: Not calculated');
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Hash similarity: Not calculated');
    expect(screen.getByRole('button', { name: 'Calculate similarities' })).toBeEnabled();
    view.rerender(<Component {...props} itemImageLabel="Updated cover label" />);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('opts in with current displayed URLs and shows best score, origin, bits and raw detail', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...sift, hash_similarity: best }));
    render(<Component {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Calculate similarities' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Hash similarity: 85.94 / 100'));
    expect(screen.getByRole('status', { name: 'Image similarity' })).toHaveTextContent('Image similarity: 98.62 / 100');
    expect(screen.getByText('36 of 256 bits differ · Flattened cover')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Hash comparison details'));
    expect(screen.getByText('Raw photo: 50.00 / 100 · 128 of 256 bits differ')).toBeVisible();
    expect(screen.getByText(/not an identity probability/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Calculate similarities' })).toBeEnabled();
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ reference_image_url: props.itemImageUrl, candidate_image_url: props.storeItemImageUrl, include_hash_similarity: true });
  });

  it('labels raw winners and displays a real zero score without treating it as missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...sift, hash_similarity: { ...best, origin: 'raw', score: 0, distance: 256, raw: { score: 0, distance: 256 }, variant_count: 1, normalization_status: 'no_faces' } }));
    render(<Component {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Calculate similarities' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Hash similarity: 0.00 / 100'));
    expect(screen.getByText('256 of 256 bits differ · Raw photo')).toBeInTheDocument();
  });

  it.each([undefined, { status: 'unavailable', method: 'phash_dct256_v1', error: 'Decode failed' }, { ...best, score: '85.94' }, { ...best, distance: -1 }, { ...best, raw: null }, { ...best, origin: 'raw' }, { ...best, variant_count: 1 }, { ...best, normalization_status: 'no_faces' }])('shows unavailable for legacy/error/malformed hash evidence while keeping SIFT', async (hash) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...sift, hash_similarity: hash }));
    render(<Component {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Calculate similarities' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Image similarity' })).toHaveTextContent('98.62 / 100'));
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Hash similarity: Unavailable');
    expect(screen.getByRole('status', { name: 'Hash similarity' })).not.toHaveTextContent('0.00');
  });

  it('disables duplicate requests while loading and allows explicit retries after errors or completion', async () => {
    let rejectFirst!: (reason: Error) => void;
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectFirst = reject; }))
      .mockImplementation(async () => response({ ...sift, hash_similarity: best }));
    render(<Component {...props} />);
    const button = screen.getByRole('button', { name: 'Calculate similarities' });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Image similarity' })).toHaveTextContent('Estimating image similarity');
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Calculating');
    fireEvent.click(button);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => rejectFirst(new Error('offline')));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Image similarity' })).toHaveTextContent('could not be estimated'));
    expect(screen.getByRole('status', { name: 'Image similarity' })).toHaveTextContent('offline');
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Unavailable');
    expect(button).toBeEnabled();
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('85.94'));
    expect(fetch).toHaveBeenCalledTimes(2);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    { values: { storeItemImageUrl: '' }, message: 'store item has no image' },
    { values: { itemImageUrl: '' }, message: 'linked item has no image' },
    { values: { itemImageUrl: '', linkedItemLoaded: false }, message: 'Waiting for the linked item image' },
    { values: { linkedItemLoaded: false }, message: 'Waiting for the linked item image' }
  ])('preserves unavailable or waiting messaging and disables calculation: $message', ({ values, message }) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    render(<Component {...props} {...values} />);
    expect(screen.getByRole('status', { name: 'Image similarity' })).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Calculate similarities' })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['itemImageUrl', 'storeItemImageUrl'] as const)('clears results on %s changes without calculating automatically', async (imageProp) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...sift, hash_similarity: best }));
    const view = render(<Component {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Calculate similarities' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('85.94'));
    view.rerender(<Component {...props} {...{ [imageProp]: 'https://images.test/new.jpg' }} />);
    expect(screen.getByRole('status', { name: 'Image similarity' })).toHaveTextContent('Not calculated');
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Not calculated');
    expect(fetch).toHaveBeenCalledTimes(1);
    view.rerender(<Component {...props} />);
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Not calculated');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ignores an earlier image-pair response even after returning to that pair', async () => {
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSecond = resolve; }));
    const view = render(<Component {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Calculate similarities' }));
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Calculating');
    view.rerender(<Component {...props} itemImageUrl="https://catalog.test/new.webp" />);
    view.rerender(<Component {...props} />);
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Not calculated');
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Calculate similarities' }));
    await act(async () => resolveFirst(response({ ...sift, hash_similarity: best })));
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Calculating');
    await act(async () => resolveSecond(response({ ...sift, hash_similarity: { ...best, score: 93.75, distance: 16 } })));
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('93.75');
    expect(screen.queryByText('36 of 256 bits differ · Flattened cover')).not.toBeInTheDocument();
  });

  it('clears results on review navigation even when both displayed image URLs are identical', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...sift, hash_similarity: best }));
    const view = render(<Component {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Calculate similarities' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('85.94'));
    view.rerender(<Component {...props} reviewId="921" />);
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Not calculated');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ignores pending errors from a previous review with identical image URLs', async () => {
    let rejectFirst!: (reason: Error) => void;
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce(response({ ...sift, hash_similarity: best }));
    const view = render(<Component {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Calculate similarities' }));
    view.rerender(<Component {...props} reviewId="921" />);
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Not calculated');
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Calculate similarities' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('85.94'));
    await act(async () => rejectFirst(new Error('old review offline')));
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('85.94');
    expect(screen.queryByText('old review offline')).not.toBeInTheDocument();
  });
});
