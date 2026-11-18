import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListingCandidatesPage } from './ListingCandidatesPage';

const primaryItem = { canonical_name: 'Linked primary item', id: 77 };
const additionalItem = { canonical_name: 'Linked additional item', id: 88 };
const firstPage = Array.from({ length: 50 }, (_, index) => ({
  canonical_name: `Catalog item ${String(index + 1).padStart(2, '0')}`,
  id: 100 + index
}));
const lastItem = { canonical_name: 'Later catalog item', id: 150 };

describe('Store Item Review catalog search', () => {
  beforeEach(() => {
    // Provide layout for the scroll container because jsdom does not calculate it.
    function listHeight(this: HTMLElement) {
      return this.querySelectorAll('[role="button"]').length * 56;
    }
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return Math.min(480, listHeight.call(this));
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(listHeight);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      buttonName: 'Link item',
      dialogName: 'Link Catalog Item',
      listName: 'Catalog item matches',
      resultAction: 'Associate with',
      selectionPath: '/discovery/listings/920/associate-item'
    },
    {
      buttonName: 'Add additional item',
      dialogName: 'Add Additional Item',
      listName: 'Additional catalog item matches',
      resultAction: 'Add',
      selectionPath: '/discovery/listings/920/additional-items'
    }
  ])('appends results and selects an item from page two through $buttonName', async ({
    buttonName, dialogName, listName, resultAction, selectionPath
  }) => {
    const laterPage = deferredResponse();
    const selected = vi.fn();
    const { searchRequests, user } = renderReview((params) =>
      params.get('page') === '0' ? itemPage(firstPage, 0, 51) : laterPage.promise,
    {
      primary: buttonName === 'Link item' ? null : primaryItem,
      onSelect: selected
    });
    await user.click(await screen.findByRole('button', { name: buttonName }));
    const dialog = within(await screen.findByRole('dialog', { name: dialogName }));
    const firstButton = await dialog.findByRole('button', { name: `${resultAction} Catalog item 01` });
    const list = dialog.getByRole('list', { name: listName });

    fireEvent.scroll(list, { target: { scrollTop: 400 } });
    expect(searchRequests.map((params) => params.get('page'))).toEqual(['0']);

    scrollToBottom(list);
    scrollToBottom(list);
    await waitFor(() => expect(searchRequests.map((params) => params.get('page'))).toEqual(['0', '1']));
    expect(firstButton).toBeEnabled();
    await act(async () => laterPage.resolve(itemPage([firstPage[0], lastItem], 1, 52)));

    const laterButton = await dialog.findByRole('button', { name: `${resultAction} Later catalog item` });
    expect(dialog.getAllByRole('button', { name: `${resultAction} Catalog item 01` })).toEqual([firstButton]);
    scrollToBottom(list);
    expect(searchRequests.map((params) => Object.fromEntries(params))).toEqual([
      { filter_name: 'Example listing', page: '0', page_size: '50', sort: 'canonical_name', sort_direction: 'asc' },
      { filter_name: 'Example listing', page: '1', page_size: '50', sort: 'canonical_name', sort_direction: 'asc' }
    ]);

    await user.click(laterButton);
    expect(selected).toHaveBeenCalledExactlyOnceWith(selectionPath, { item_id: '150' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: dialogName })).not.toBeInTheDocument());
  });

  it('continues past pages with too few selectable results to scroll', async () => {
    const extraLinkedItem = { canonical_name: 'Another linked item', id: 89 };
    const pages = [[primaryItem, additionalItem], [extraLinkedItem, firstPage[0]], [lastItem]];
    const { searchRequests, user } = renderReview((params) => {
      const page = Number(params.get('page'));
      return itemPage(pages[page], page, 5, 2);
    }, { additional: [additionalItem, extraLinkedItem] });
    await user.click(await screen.findByRole('button', { name: 'Add additional item' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add Additional Item' }));

    expect(await dialog.findByRole('button', { name: 'Add Later catalog item' })).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Add Catalog item 01' })).toBeInTheDocument();
    for (const item of [primaryItem, additionalItem, extraLinkedItem]) {
      expect(dialog.queryByRole('button', { name: `Add ${item.canonical_name}` })).not.toBeInTheDocument();
    }
    expect(searchRequests.map((params) => params.get('page'))).toEqual(['0', '1', '2']);
  });

  it('keeps already loaded results and retries the failed page', async () => {
    let laterAttempts = 0;
    const { searchRequests, user } = renderReview((params) => {
      if (params.get('page') === '0') {
        return itemPage(firstPage, 0, 51);
      }
      laterAttempts += 1;
      return laterAttempts === 1 ? jsonResponse(null, 503) : itemPage([lastItem], 1, 51);
    });
    await user.click(await screen.findByRole('button', { name: 'Add additional item' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add Additional Item' }));
    const firstButton = await dialog.findByRole('button', { name: 'Add Catalog item 01' });
    const list = dialog.getByRole('list', { name: 'Additional catalog item matches' });

    scrollToBottom(list);
    const retry = await dialog.findByRole('button', { name: 'Retry' });
    expect(dialog.getByRole('alert')).toBeInTheDocument();
    expect(firstButton).toBeEnabled();
    scrollToBottom(list);
    expect(laterAttempts).toBe(1);

    await user.click(retry);
    expect(await dialog.findByRole('button', { name: 'Add Later catalog item' })).toBeInTheDocument();
    expect(firstButton).toBeInTheDocument();
    expect(searchRequests.map((params) => params.get('page'))).toEqual(['0', '1', '1']);
  });

  it.each(['changing the query', 'closing and reopening the same query'])(
    'discards a pending page after %s', async (scenario) => {
      const laterPage = deferredResponse();
      const replacement = { canonical_name: 'Replacement match', id: 151 };
      let initialRequest = true;
      const { searchRequests, user } = renderReview((params) => {
        if (params.get('page') === '1') {
          return laterPage.promise;
        }
        if (initialRequest) {
          initialRequest = false;
          return itemPage(firstPage, 0, 51);
        }
        return itemPage([replacement], 0, 1);
      });
      const openButton = () => screen.findByRole('button', { name: 'Add additional item' });
      const findDialog = () => screen.findByRole('dialog', { name: 'Add Additional Item' });
      await user.click(await openButton());
      let dialog = within(await findDialog());
      await dialog.findByRole('button', { name: 'Add Catalog item 01' });
      scrollToBottom(dialog.getByRole('list', { name: 'Additional catalog item matches' }));
      await waitFor(() => expect(searchRequests.map((params) => params.get('page'))).toEqual(['0', '1']));

      if (scenario === 'changing the query') {
        fireEvent.change(dialog.getByRole('textbox', { name: 'Search catalog items' }), {
          target: { value: 'Different search' }
        });
      } else {
        await user.click(dialog.getByRole('button', { name: 'Close' }));
        await user.click(await openButton());
        dialog = within(await findDialog());
      }

      await dialog.findByRole('button', { name: 'Add Replacement match' });
      await act(async () => laterPage.resolve(itemPage([lastItem], 1, 51)));
      expect(dialog.queryByRole('button', { name: 'Add Later catalog item' })).not.toBeInTheDocument();
      expect(dialog.queryByRole('button', { name: 'Add Catalog item 01' })).not.toBeInTheDocument();
      expect(dialog.getByRole('button', { name: 'Add Replacement match' })).toBeInTheDocument();
      expect(searchRequests.map((params) => [params.get('filter_name'), params.get('page')])).toEqual([
        ['Example listing', '0'],
        ['Example listing', '1'],
        [scenario === 'changing the query' ? 'Different search' : 'Example listing', '0']
      ]);
    }
  );
});

function renderReview(
  search: (params: URLSearchParams) => Response | Promise<Response>,
  {
    primary = primaryItem,
    additional = [additionalItem],
    onSelect
  }: {
    primary?: typeof primaryItem | null;
    additional?: Array<typeof additionalItem>;
    onSelect?: (path: string, payload: unknown) => void;
  } = {}
) {
  const selectedCandidate = {
    id: '920',
    item_id: primary?.id ?? null,
    listing_status: 'PENDING',
    title: 'Example listing'
  };
  const searchRequests: URLSearchParams[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === '/items') {
      searchRequests.push(url.searchParams);
      return search(url.searchParams);
    }
    if (init?.method === 'POST') {
      onSelect?.(path, JSON.parse(String(init.body)));
      if (path === '/discovery/listings/920/associate-item') {
        return jsonResponse({ ...selectedCandidate, item_id: lastItem.id });
      }
      if (path === '/discovery/listings/920/additional-items') {
        return jsonResponse(lastItem, 201);
      }
    }
    if (path === '/discovery/listings/920') {
      return jsonResponse(selectedCandidate);
    }
    if (path === '/items/77') {
      return jsonResponse(primaryItem);
    }
    if (path === '/items/150') {
      return jsonResponse(lastItem);
    }
    if (path.endsWith('/taxonomy')) {
      return jsonResponse({ categories: [], families: [], mechanics: [] });
    }
    if (path === '/discovery/listings/920/additional-items') {
      return jsonResponse(additional);
    }
    if (path === '/discovery/listings' || path.endsWith('/relationships') || path.endsWith('/store-items')) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const user = userEvent.setup();
  render(<ListingCandidatesPage detailMode="review" selectedCandidateId="920" />);
  return { searchRequests, user };
}

function scrollToBottom(list: HTMLElement) {
  fireEvent.scroll(list, { target: { scrollTop: list.scrollHeight - list.clientHeight } });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolveResponse) => {
    resolve = resolveResponse;
  });
  return { promise, resolve };
}

function itemPage(rows: Array<typeof lastItem>, page: number, total: number, pageSize = 50) {
  return jsonResponse(rows, 200, { page, page_size: pageSize, total });
}

function jsonResponse(data: unknown, status = 200, meta?: unknown) {
  return new Response(JSON.stringify({ data, meta }), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}
