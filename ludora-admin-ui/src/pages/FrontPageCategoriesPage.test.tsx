import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrontPageCategoriesPage } from './FrontPageCategoriesPage';

describe('FrontPageCategoriesPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders front page category rows with taxonomy names', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([
        {
          category_id: 5,
          category_name: 'Party Game',
          category_name_es: 'Juego de fiesta',
          category_type: 'category',
          id: 1,
          order: 10,
          title: 'Need a laugh?',
          updated_at: '2026-06-08T10:00:00Z'
        }
      ])
    );

    render(<FrontPageCategoriesPage />);

    for (const heading of ['Order', 'Title', 'Type', 'Category ID', 'Linked Category', 'Updated']) {
      expect(await screen.findByRole('columnheader', { name: heading })).toBeInTheDocument();
    }
    expect(await screen.findByText('10')).toBeInTheDocument();
    expect(await screen.findByText('Need a laugh?')).toBeInTheDocument();
    expect(screen.getByText('category')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Juego de fiesta (Party Game)')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4001/front-page-categories?page=0&page_size=100&sort=order&sort_direction=asc'
    );
  });

  it('creates a front page category from the form', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/front-page-categories' && !init) {
        return jsonResponse([]);
      }
      if (pathOf(url) === '/front-page-categories' && init?.method === 'POST') {
        return jsonResponse({
          category_id: 5,
          category_name: 'Party Game',
          category_name_es: 'Juego de fiesta',
          category_type: 'category',
          id: 1,
          order: 10,
          title: 'Need a laugh?'
        }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<FrontPageCategoriesPage />);

    await user.click(await screen.findByRole('button', { name: 'New Category' }));
    expect(screen.getByRole('heading', { name: 'New Front Page Category' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Order'), '10');
    await user.type(screen.getByLabelText('Title'), 'Need a laugh?');
    await user.type(screen.getByLabelText('Category ID'), '5');
    await user.click(screen.getByRole('button', { name: 'Save Category' }));

    expect(await screen.findByText('Need a laugh?')).toBeInTheDocument();
    const postCall = fetchMock.mock.calls.find(([url, init]) => pathOf(String(url)) === '/front-page-categories' && init?.method === 'POST');
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      category_id: 5,
      category_type: 'category',
      order: 10,
      title: 'Need a laugh?'
    });
  });

  it('opens an edit form on double click and saves changes', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/front-page-categories' && !init) {
        return jsonResponse([
          {
            category_id: 5,
            category_name: 'Party Game',
            category_type: 'category',
            id: 1,
            order: 10,
            title: 'Need a laugh?'
          }
        ]);
      }
      if (pathOf(url) === '/front-page-categories/1' && init?.method === 'PATCH') {
        return jsonResponse({
          category_id: 8,
          category_name: 'Hand Management',
          category_type: 'mechanic',
          id: 1,
          order: 20,
          title: 'Smart choices'
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<FrontPageCategoriesPage />);

    await user.dblClick(await screen.findByText('Need a laugh?'));
    expect(screen.getByRole('heading', { name: 'Edit Front Page Category' })).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Order'));
    await user.type(screen.getByLabelText('Order'), '20');
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Smart choices');
    await user.clear(screen.getByLabelText('Category ID'));
    await user.type(screen.getByLabelText('Category ID'), '8');
    await user.selectOptions(screen.getByLabelText('Type'), 'mechanic');
    await user.click(screen.getByRole('button', { name: 'Save Category' }));

    expect(await screen.findByText('Smart choices')).toBeInTheDocument();
    const patchCall = fetchMock.mock.calls.find(([url, init]) => pathOf(String(url)) === '/front-page-categories/1' && init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      category_id: 8,
      category_type: 'mechanic',
      order: 20,
      title: 'Smart choices'
    });
  });

  it('deletes a front page category from the edit form', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/front-page-categories' && !init) {
        return jsonResponse([
          {
            category_id: 5,
            category_name: 'Party Game',
            category_type: 'category',
            id: 1,
            order: 10,
            title: 'Need a laugh?'
          }
        ]);
      }
      if (pathOf(url) === '/front-page-categories/1' && init?.method === 'DELETE') {
        return jsonResponse({
          category_id: 5,
          category_name: 'Party Game',
          category_type: 'category',
          id: 1,
          order: 10,
          title: 'Need a laugh?'
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<FrontPageCategoriesPage />);

    await user.dblClick(await screen.findByText('Need a laugh?'));
    expect(screen.getByRole('heading', { name: 'Edit Front Page Category' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete Category' }));

    expect(await screen.findByText('Front page category deleted.')).toBeInTheDocument();
    expect(screen.getByText('No matching records.')).toBeInTheDocument();
    const deleteCall = fetchMock.mock.calls.find(([url, init]) => pathOf(String(url)) === '/front-page-categories/1' && init?.method === 'DELETE');
    expect(deleteCall?.[1]).toEqual({ method: 'DELETE' });
  });

  it('starts random item assignment from the table screen', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (pathOf(url) === '/front-page-categories' && !init) {
        return jsonResponse([
          {
            category_id: 5,
            category_name: 'Party Game',
            category_type: 'category',
            id: 1,
            order: 10,
            title: 'Need a laugh?'
          }
        ]);
      }
      if (pathOf(url) === '/front-page-categories/random-item-assignments' && init?.method === 'POST') {
        return jsonResponse({ assigned_count: 2, skipped_count: 1 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<FrontPageCategoriesPage />);

    await user.click(await screen.findByRole('button', { name: 'Assign Random Games' }));

    expect(await screen.findByText('Random assignments complete: 2 assigned, 1 skipped.')).toBeInTheDocument();
    const assignmentCall = fetchMock.mock.calls.find(
      ([url, init]) => pathOf(String(url)) === '/front-page-categories/random-item-assignments' && init?.method === 'POST'
    );
    expect(assignmentCall?.[1]).toEqual({ method: 'POST' });
  });
});

function jsonResponse(data: unknown, status = 200) {
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
      status
    }
  );
}

function pathOf(url: string) {
  return new URL(url).pathname;
}
