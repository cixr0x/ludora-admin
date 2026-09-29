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
  storeItemImageUrl: 'https://store.test/current.jpg', linkedItemLoaded: true, linkedItemPresent: true };
function response(data: unknown, status = 200) { return new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } }); }

describe('review pair fingerprint display', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opts in with current displayed URLs and shows best score, origin, bits and raw detail', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...sift, hash_similarity: best }));
    render(<Component {...props} />);
    expect(await screen.findByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Hash similarity: 85.94 / 100');
    expect(screen.getByRole('status', { name: 'Image similarity' })).toHaveTextContent('Image similarity: 98.62 / 100');
    expect(screen.getByText('36 of 256 bits differ · Flattened cover')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Hash comparison details'));
    expect(screen.getByText('Raw photo: 50.00 / 100 · 128 of 256 bits differ')).toBeVisible();
    expect(screen.getByText(/not an identity probability/i)).toBeInTheDocument();
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ reference_image_url: props.itemImageUrl, candidate_image_url: props.storeItemImageUrl, include_hash_similarity: true });
  });

  it('labels raw winners and displays a real zero score without treating it as missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...sift, hash_similarity: { ...best, origin: 'raw', score: 0, distance: 256, raw: { score: 0, distance: 256 }, variant_count: 1, normalization_status: 'no_faces' } }));
    render(<Component {...props} />);
    expect(await screen.findByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Hash similarity: 0.00 / 100');
    expect(screen.getByText('256 of 256 bits differ · Raw photo')).toBeInTheDocument();
  });

  it.each([undefined, { status: 'unavailable', method: 'phash_dct256_v1', error: 'Decode failed' }, { ...best, score: '85.94' }, { ...best, distance: -1 }, { ...best, raw: null }, { ...best, origin: 'raw' }, { ...best, variant_count: 1 }, { ...best, normalization_status: 'no_faces' }])('shows unavailable for legacy/error/malformed hash evidence while keeping SIFT', async (hash) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...sift, hash_similarity: hash }));
    render(<Component {...props} />);
    await waitFor(() => expect(screen.getByRole('status', { name: 'Image similarity' })).toHaveTextContent('98.62 / 100'));
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Hash similarity: Unavailable');
    expect(screen.getByRole('status', { name: 'Hash similarity' })).not.toHaveTextContent('0.00');
  });

  it('reports request errors and missing images honestly', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const view = render(<Component {...props} />);
    await waitFor(() => expect(screen.getByRole('status', { name: 'Image similarity' })).toHaveTextContent('could not be estimated'));
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Unavailable');
    view.rerender(<Component {...props} storeItemImageUrl="" />);
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Unavailable');
    expect(screen.getByRole('status', { name: 'Image similarity' })).toHaveTextContent('store item has no image');
  });

  it('clears old scores on a current-cover switch and ignores the stale asynchronous result', async () => {
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const body = JSON.parse(String(init?.body));
      return new Promise<Response>((resolve) => { if (body.reference_image_url === props.itemImageUrl) resolveFirst = resolve; else resolveSecond = resolve; });
    });
    const view = render(<Component {...props} />);
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('Calculating');
    view.rerender(<Component {...props} itemImageUrl="https://catalog.test/new.webp" />);
    await act(async () => resolveSecond(response({ ...sift, hash_similarity: { ...best, score: 93.75, distance: 16 } })));
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('93.75');
    await act(async () => resolveFirst(response({ ...sift, hash_similarity: best })));
    expect(screen.getByRole('status', { name: 'Hash similarity' })).toHaveTextContent('93.75');
    expect(screen.queryByText('36 of 256 bits differ · Flattened cover')).not.toBeInTheDocument();
  });
});
