import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListingCandidatesPage } from './ListingCandidatesPage';

const actions = [
  { button: 'Approve listing', status: 'LISTED', success: 'approved' },
  { button: 'Reject listing', status: 'REJECTED', success: 'rejected' },
  { button: 'Translate and approve', status: 'PROCESSING', success: 'translation' }
];

describe('ListingCandidatesPage review navigation', () => {
  afterEach(() => vi.restoreAllMocks());

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
});

async function clickEnabled(button: string) {
  const action = await screen.findByRole('button', { name: button });
  await waitFor(() => expect(action).toBeEnabled());
  fireEvent.click(action);
}

function mockReviewRequests(status: string, failure?: 'next' | 'action') {
  const requests: URL[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    const candidate = { id: '920', item_id: 77, listing_status: 'PENDING', title: 'Cafe Barista' };
    if (url.pathname === '/discovery/listings/920') return jsonResponse(candidate);
    if (url.pathname.endsWith('/listing-status') || url.pathname.endsWith('/translate-and-approve')) {
      if (failure === 'action') return jsonResponse({ error: { message: 'Action failed' } }, 500);
      return jsonResponse({ ...candidate, listing_status: status });
    }
    if (url.pathname.endsWith('/offer-reviews/next')) {
      if (failure === 'next') return jsonResponse({ error: { message: 'Next review failed' } }, 500);
      return jsonResponse({ candidate_id: null });
    }
    if (url.pathname === '/items/77') return jsonResponse({
      canonical_name: 'Coffee Rush', description: 'Serve coffee before the customers leave.', id: 77,
      description_es: status === 'PROCESSING' ? '' : 'Completa los pedidos.'
    });
    if (url.pathname.endsWith('/taxonomy')) return jsonResponse({ categories: [], families: [], mechanics: [] });
    if (url.pathname === '/discovery/listings' || url.pathname.endsWith('/additional-items') || url.pathname.endsWith('/relationships') || url.pathname.endsWith('/store-items')) return jsonResponse([]);
    throw new Error(`Unexpected request: ${url.toString()} ${init?.method ?? 'GET'}`);
  });
  return requests;
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' }, status });
}
