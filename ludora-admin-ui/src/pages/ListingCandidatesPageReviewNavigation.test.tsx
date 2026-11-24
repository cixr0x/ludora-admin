import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListingCandidatesPage } from './ListingCandidatesPage';

const actions = [
  { button: 'Approve listing', status: 'LISTED', success: 'approved' },
  { button: 'Reject listing', status: 'REJECTED', success: 'rejected' },
  { button: 'Translate and approve', status: 'PROCESSING', success: 'translation' }
];
const sleepStorageKey = 'ludora.admin.offerReviewSleeps';

describe('ListingCandidatesPage review navigation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it.each(actions)('returns to the review list on exhaustion after $button', async ({ button, status }) => {
    const onClear = vi.fn();
    const onOpen = vi.fn();
    const requests = mockReviewRequests(status);
    render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} onClearSelectedCandidateId={onClear} />);
    await clickEnabled(button);
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
    expect(onOpen).not.toHaveBeenCalled();
    expect(requests.filter((url) => url.pathname === '/discovery/listings')).toHaveLength(0);
    expect(requests.find((url) => url.pathname.endsWith('/offer-reviews/next'))?.searchParams.get('exclude_ids')).toBe('920');
  });

  it.each(actions)('preserves successful action when the next review fails after $button', async ({ button, status, success }) => {
    const onClear = vi.fn();
    const onOpen = vi.fn();
    mockReviewRequests(status, 'next');
    render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} onClearSelectedCandidateId={onClear} />);
    await clickEnabled(button);
    const message = success === 'translation'
      ? 'Translation and approval started, but the next review could not be loaded.'
      : `Store item listing was ${success}, but the next review could not be loaded.`;
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Title')).toHaveValue('Cafe Barista');
  });

  it.each(actions)('does not advance when the action fails after $button', async ({ button, status, success }) => {
    const onOpen = vi.fn();
    const requests = mockReviewRequests(status, 'action');
    render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} />);
    await clickEnabled(button);
    expect(await screen.findByText(success === 'translation'
      ? 'Translation and approval job could not be started.'
      : 'Store item listing status could not be saved.')).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
    expect(requests.some((url) => url.pathname.endsWith('/offer-reviews/next'))).toBe(false);
  });

  it('advances a sleeping offer without saving a listing change', async () => {
    const onOpen = vi.fn();
    const requests = mockReviewRequests('LISTED', { next: () => '921' });
    render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} />);

    await clickEnabled('Sleep');

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('921'));
    expect(nextReviewExclusions(requests)).toEqual(['920']);
    expect(vi.mocked(globalThis.fetch).mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it.each([...actions, { button: 'Sleep', status: 'LISTED' }])(
    'preserves multiple sleeping offers across remounts when advancing after $button',
    async ({ button, status }) => {
      const onOpen = vi.fn();
      const nextIds = ['921', '922'];
      const requests = mockReviewRequests(status, { next: () => nextIds.shift() ?? null });

      for (const [id, nextId] of [['920', '921'], ['921', '922']]) {
        const review = render(<ListingCandidatesPage detailMode="review" selectedCandidateId={id} onOpenCandidate={onOpen} />);
        await clickEnabled('Sleep');
        await waitFor(() => expect(onOpen).toHaveBeenLastCalledWith(nextId));
        review.unmount();
      }

      const onClear = vi.fn();
      render(<ListingCandidatesPage detailMode="review" selectedCandidateId="922" onOpenCandidate={onOpen} onClearSelectedCandidateId={onClear} />);
      await clickEnabled(button);
      await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
      expect(nextReviewExclusions(requests)).toEqual(['920', '921,920', '922,920,921']);
    }
  );

  it('includes a sleeping offer until exactly one hour after the click', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const onOpen = vi.fn();
    const requests = mockReviewRequests('LISTED', { next: () => '921' });
    const firstReview = render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} />);
    await clickEnabled('Sleep');
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    firstReview.unmount();

    now.mockReturnValue(1_799_999_999_000);
    const reviewAfterClockChange = render(<ListingCandidatesPage detailMode="review" selectedCandidateId="922" onOpenCandidate={onOpen} />);
    await clickEnabled('Approve listing');
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2));
    reviewAfterClockChange.unmount();

    now.mockReturnValue(1_800_003_599_999);
    const laterReview = render(<ListingCandidatesPage detailMode="review" selectedCandidateId="922" onOpenCandidate={onOpen} />);
    await clickEnabled('Approve listing');
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(3));
    laterReview.unmount();

    now.mockReturnValue(1_800_003_600_000);
    render(<ListingCandidatesPage detailMode="review" selectedCandidateId="922" onOpenCandidate={onOpen} />);
    await clickEnabled('Approve listing');
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(4));
    expect(nextReviewExclusions(requests)).toEqual(['920', '922,920', '922,920', '922']);
    expect(window.sessionStorage.getItem(sleepStorageKey)).toBeNull();
  });

  it('keeps the current offer open on a next-review error and can retry', async () => {
    const onOpen = vi.fn();
    const onClear = vi.fn();
    const next = vi.fn<() => string | null>()
      .mockImplementationOnce(() => { throw new Error('Next review failed'); })
      .mockReturnValueOnce('921');
    const requests = mockReviewRequests('LISTED', { next });
    render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} onClearSelectedCandidateId={onClear} />);

    await clickEnabled('Sleep');

    expect(await screen.findByText(/next review could not be loaded/)).toHaveTextContent('Click Sleep to retry');
    expect(screen.getByLabelText('Title')).toHaveValue('Cafe Barista');
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();

    await clickEnabled('Sleep');
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('921'));
    expect(nextReviewExclusions(requests)).toEqual(['920', '920']);
  });

  it('returns to the review list when sleeping leaves no eligible offers', async () => {
    const onOpen = vi.fn();
    const onClear = vi.fn();
    const requests = mockReviewRequests('LISTED');
    render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} onClearSelectedCandidateId={onClear} />);

    await clickEnabled('Sleep');

    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
    expect(onOpen).not.toHaveBeenCalled();
    expect(nextReviewExclusions(requests)).toEqual(['920']);
  });

  it('blocks overlapping review actions and discards a Sleep response after going back', async () => {
    const next = deferred<string>();
    const onOpen = vi.fn();
    const onClear = vi.fn();
    const requests = mockReviewRequests('PROCESSING', { next: () => next.promise });
    render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} onClearSelectedCandidateId={onClear} />);

    await clickEnabled('Sleep');

    expect(screen.getByRole('button', { name: 'Sleep' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject listing' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Translate and approve' })).toBeDisabled();
    await clickEnabled('Back to Review');
    await act(async () => { next.resolve('921'); });
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(nextReviewExclusions(requests)).toEqual(['920']);
  });

  it('lets a new review start Sleep while an obsolete next request is still pending', async () => {
    const oldNext = deferred<string>();
    const newNext = deferred<string>();
    const onOpen = vi.fn();
    const next = vi.fn<() => Promise<string>>()
      .mockReturnValueOnce(oldNext.promise)
      .mockReturnValueOnce(newNext.promise);
    const requests = mockReviewRequests('LISTED', { next });
    const review = render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} />);
    await clickEnabled('Sleep');

    review.rerender(<ListingCandidatesPage detailMode="review" selectedCandidateId="921" onOpenCandidate={onOpen} />);
    await clickEnabled('Sleep');
    await act(async () => { oldNext.resolve('923'); });

    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sleep' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject listing' })).toBeDisabled();
    await act(async () => { newNext.resolve('922'); });
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('922');
    expect(nextReviewExclusions(requests)).toEqual(['920', '921,920']);
  });

  it('discards a Sleep response after opening standard details for the same offer', async () => {
    const next = deferred<string>();
    const onOpen = vi.fn();
    mockReviewRequests('LISTED', { next: () => next.promise });
    const review = render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} />);
    await clickEnabled('Sleep');

    review.rerender(<ListingCandidatesPage detailMode="standard" selectedCandidateId="920" />);
    await screen.findByRole('heading', { name: 'Store Item Details' });
    await act(async () => { next.resolve('921'); });

    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save Store Item' })).toBeEnabled();
  });

  it('prevents Save Store Item and Sleep from running at the same time', async () => {
    const save = deferred<void>();
    const next = deferred<string>();
    const onOpen = vi.fn();
    const requests = mockReviewRequests('LISTED', { next: () => next.promise, save: () => save.promise });
    render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} />);

    await clickEnabled('Save Store Item');
    expect(screen.getByRole('button', { name: 'Sleep' })).toBeDisabled();
    expect(nextReviewExclusions(requests)).toEqual([]);
    await act(async () => { save.resolve(); });

    await clickEnabled('Sleep');
    expect(screen.getByRole('button', { name: 'Save Store Item' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete Store Item' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create item from BGG ID' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create Item from Candidate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back to Review' })).toBeEnabled();
    await act(async () => { next.resolve('921'); });
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('921');
  });

  it('keeps the new review open when an earlier AI match finishes after Sleep', async () => {
    const match = deferred<void>();
    const onOpen = vi.fn();
    mockReviewRequests('LISTED', { next: () => '921', matchAi: () => match.promise });
    const review = render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} />);

    await clickEnabled('Match AI');
    await clickEnabled('Sleep');
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('921'));
    review.rerender(<ListingCandidatesPage detailMode="review" selectedCandidateId="921" onOpenCandidate={onOpen} />);
    expect(await screen.findByLabelText('Title')).toHaveValue('Cafe Barista');
    await act(async () => { match.resolve(); });

    expect(screen.getByLabelText('Title')).toHaveValue('Cafe Barista');
    expect(screen.queryByText('AI matched Obsolete match.')).not.toBeInTheDocument();
  });

  it('prevents cover preparation and Sleep from running concurrently', async () => {
    const cover = deferred<void>();
    const next = deferred<string>();
    const onOpen = vi.fn();
    let waitForCover = false;
    mockReviewRequests('LISTED', {
      next: () => next.promise,
      loadItem: () => waitForCover ? cover.promise : undefined
    });
    render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} />);
    await screen.findByRole('link', { name: 'Coffee Rush' });
    waitForCover = true;
    await clickEnabled('Flatten cover for Cafe Barista');
    expect(screen.getByRole('button', { name: 'Sleep' })).toBeDisabled();
    await act(async () => { cover.resolve(); });
    await screen.findByRole('dialog', { name: 'Flatten cover: Cafe Barista' });
    await clickEnabled('Cancel');

    await clickEnabled('Sleep');
    expect(screen.getByRole('button', { name: 'Flatten cover for Cafe Barista' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start cover workflow for Cafe Barista' })).toBeDisabled();
    await act(async () => { next.resolve('921'); });
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('921');
  });

  it('keeps the new review open when a linked-item association finishes after Sleep', async () => {
    const association = deferred<void>();
    const next = deferred<string>();
    const onOpen = vi.fn();
    mockReviewRequests('LISTED', { next: () => next.promise, associate: () => association.promise });
    const review = render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} />);

    await clickEnabled('Sleep');
    await clickEnabled('Change linked item');
    await clickEnabled('Associate with Replacement game');
    await act(async () => { next.resolve('921'); });
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('921');
    review.rerender(<ListingCandidatesPage detailMode="review" selectedCandidateId="921" onOpenCandidate={onOpen} />);
    expect(await screen.findByLabelText('Title')).toHaveValue('Cafe Barista');
    await act(async () => { association.resolve(); });

    expect(screen.getByLabelText('Title')).toHaveValue('Cafe Barista');
    expect(screen.queryByText('Store item associated with Replacement game.')).not.toBeInTheDocument();
  });

  it('ignores malformed stored exclusions without sending them to the API', async () => {
    const expiresAt = Date.now() + 60_000;
    window.sessionStorage.setItem(sleepStorageKey, JSON.stringify([
      ['919', expiresAt],
      ['bad-id', expiresAt],
      ['9223372036854775808', expiresAt],
      ['921', String(expiresAt)],
      null
    ]));
    const onOpen = vi.fn();
    const requests = mockReviewRequests('LISTED', { next: () => '922' });
    render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} />);

    await clickEnabled('Sleep');

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('922'));
    expect(nextReviewExclusions(requests)).toEqual(['920,919']);
  });

  it('keeps sleeping exclusions in memory when the browser blocks session storage', async () => {
    const storageError = new DOMException('Storage is unavailable', 'SecurityError');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw storageError; });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw storageError; });
    const onOpen = vi.fn();
    const nextIds = ['921', '922'];
    const requests = mockReviewRequests('LISTED', { next: () => nextIds.shift() ?? null });
    const review = render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" onOpenCandidate={onOpen} />);
    await clickEnabled('Sleep');
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('921'));

    review.rerender(<ListingCandidatesPage detailMode="review" selectedCandidateId="921" onOpenCandidate={onOpen} />);
    await clickEnabled('Approve listing');

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('922'));
    expect(nextReviewExclusions(requests)).toEqual(['920', '921,920']);
  });
});

async function clickEnabled(button: string) {
  const action = await screen.findByRole('button', { name: button });
  await waitFor(() => expect(action).toBeEnabled());
  fireEvent.click(action);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function nextReviewExclusions(requests: URL[]) {
  return requests.filter((url) => url.pathname.endsWith('/offer-reviews/next'))
    .map((url) => url.searchParams.get('exclude_ids'));
}

function mockReviewRequests(
  status: string,
  options?: 'next' | 'action' | {
    associate?: () => Promise<void>;
    loadItem?: () => Promise<void> | undefined;
    matchAi?: () => Promise<void>;
    next: () => string | null | Promise<string | null>;
    save?: () => Promise<void>;
  }
) {
  const requests: URL[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    const id = url.pathname.match(/^\/discovery\/listings\/(\d+)(?:\/|$)/)?.[1];
    const candidate = { id, item_id: 77, listing_status: 'PENDING', title: 'Cafe Barista' };
    const coverCandidate = typeof options === 'object' && options.loadItem
      ? { ...candidate, image_url: 'https://example.com/cover.jpg' }
      : candidate;
    if (url.pathname === `/discovery/listings/${id}`) {
      if (init?.method === 'PATCH' && typeof options === 'object') await options.save?.();
      return jsonResponse(coverCandidate);
    }
    if (url.pathname.endsWith('/listing-status') || url.pathname.endsWith('/translate-and-approve')) {
      if (options === 'action') return jsonResponse({ error: { message: 'Action failed' } }, 500);
      return jsonResponse({ ...candidate, listing_status: status });
    }
    if (url.pathname.endsWith('/match-ai') && typeof options === 'object' && options.matchAi) {
      await options.matchAi();
      return jsonResponse({
        candidate: { ...candidate, title: 'Old Cafe offer' },
        result: { status: 'matched', item_id: 77, bgg_id: 35, matched_name: 'Obsolete match' }
      });
    }
    if (url.pathname.endsWith('/associate-item') && typeof options === 'object' && options.associate) {
      await options.associate();
      return jsonResponse({ ...candidate, item_id: 99, title: 'Old Cafe offer' });
    }
    if (url.pathname === '/items' && typeof options === 'object' && options.associate) {
      return jsonResponse([{ canonical_name: 'Replacement game', id: 99 }], 200, { page: 0, page_size: 50, total: 1 });
    }
    if (url.pathname.endsWith('/offer-reviews/next')) {
      if (options === 'next') return jsonResponse({ error: { message: 'Next review failed' } }, 500);
      const next = typeof options === 'object' ? await options.next() : null;
      return jsonResponse({ candidate_id: next });
    }
    if (url.pathname === '/items/77') {
      if (typeof options === 'object') await options.loadItem?.();
      return jsonResponse({
        canonical_name: 'Coffee Rush', description: 'Serve coffee before the customers leave.', id: 77,
        description_es: status === 'PROCESSING' ? '' : 'Completa los pedidos.',
        image_url: typeof options === 'object' && options.loadItem ? 'https://example.com/item-cover.jpg' : undefined
      });
    }
    if (url.pathname.endsWith('/taxonomy')) return jsonResponse({ categories: [], families: [], mechanics: [] });
    if (url.pathname === '/discovery/listings' || url.pathname.endsWith('/additional-items') || url.pathname.endsWith('/relationships') || url.pathname.endsWith('/store-items')) return jsonResponse([]);
    throw new Error(`Unexpected request: ${url.toString()} ${init?.method ?? 'GET'}`);
  });
  return requests;
}

function jsonResponse(data: unknown, status = 200, meta?: Record<string, unknown>) {
  return new Response(JSON.stringify({ data, meta }), { headers: { 'Content-Type': 'application/json' }, status });
}
