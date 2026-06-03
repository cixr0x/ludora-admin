import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, type DataTableColumn } from './DataTable';

type Row = {
  city: string;
  confidence: number;
  id: string;
  store: string;
};

const rows: Row[] = [
  { city: 'Monterrey', confidence: 0.71, id: 'beta', store: 'Beta Juegos' },
  { city: 'Ciudad de Mexico', confidence: 0.91, id: 'alpha', store: 'Alpha Mesa' },
  { city: 'Guadalajara', confidence: 0.84, id: 'gamma', store: 'Gamma Ludica' }
];

const columns: DataTableColumn<Row>[] = [
  {
    id: 'store',
    label: 'Store',
    render: (row) => <span data-testid="store-name">{row.store}</span>,
    sortValue: (row) => row.store
  },
  {
    id: 'city',
    label: 'City',
    render: (row) => row.city,
    sortValue: (row) => row.city
  },
  {
    id: 'confidence',
    label: 'Confidence',
    render: (row) => `${Math.round(row.confidence * 100)}%`,
    sortValue: (row) => row.confidence
  }
];

describe('DataTable', () => {
  it('sorts rows by column headers', async () => {
    const user = userEvent.setup();
    render(<DataTable ariaLabel="Stores" columns={columns} getRowKey={(row) => row.id} rows={rows} />);

    await user.click(screen.getByRole('button', { name: 'Store' }));

    expect(screen.getAllByTestId('store-name').map((cell) => cell.textContent)).toEqual([
      'Alpha Mesa',
      'Beta Juegos',
      'Gamma Ludica'
    ]);

    await user.click(screen.getByRole('button', { name: 'Store' }));

    expect(screen.getAllByTestId('store-name').map((cell) => cell.textContent)).toEqual([
      'Gamma Ludica',
      'Beta Juegos',
      'Alpha Mesa'
    ]);
  });

  it('sorts rows by the default sort column on first render', () => {
    render(
      <DataTable
        ariaLabel="Stores"
        columns={columns}
        defaultSortColumnId="city"
        getRowKey={(row) => row.id}
        rows={rows}
      />
    );

    expect(screen.getAllByTestId('store-name').map((cell) => cell.textContent)).toEqual([
      'Alpha Mesa',
      'Gamma Ludica',
      'Beta Juegos'
    ]);
  });

  it('filters rows by column values', async () => {
    const user = userEvent.setup();
    render(<DataTable ariaLabel="Stores" columns={columns} getRowKey={(row) => row.id} rows={rows} />);

    await user.type(screen.getByLabelText('Filter City'), 'mexico');

    const table = screen.getByRole('table', { name: 'Stores' });
    expect(within(table).getByText('Alpha Mesa')).toBeInTheDocument();
    expect(within(table).queryByText('Beta Juegos')).not.toBeInTheDocument();
    expect(within(table).queryByText('Gamma Ludica')).not.toBeInTheDocument();
  });

  it('emits server-side filter and sort state without filtering the current page locally', async () => {
    const user = userEvent.setup();
    const handleTableStateChange = vi.fn();
    render(
      <DataTable
        ariaLabel="Stores"
        columns={columns}
        getRowKey={(row) => row.id}
        rows={rows}
        serverSide
        tableState={{ filters: {}, sortColumnId: 'store', sortDirection: 'asc' }}
        onTableStateChange={handleTableStateChange}
      />
    );

    await user.type(screen.getByLabelText('Filter City'), 'mexico');
    await user.click(screen.getByRole('button', { name: 'Store' }));

    const table = screen.getByRole('table', { name: 'Stores' });
    expect(within(table).getByText('Beta Juegos')).toBeInTheDocument();
    expect(within(table).getByText('Gamma Ludica')).toBeInTheDocument();
    expect(handleTableStateChange).toHaveBeenCalledWith({
      filters: { city: 'mexico' },
      sortColumnId: 'store',
      sortDirection: 'asc'
    });
    expect(handleTableStateChange).toHaveBeenCalledWith({
      filters: { city: 'mexico' },
      sortColumnId: 'store',
      sortDirection: 'desc'
    });
  });

  it('notifies when a row is double clicked', async () => {
    const user = userEvent.setup();
    const handleDoubleClick = vi.fn();
    render(
      <DataTable
        ariaLabel="Stores"
        columns={columns}
        getRowKey={(row) => row.id}
        rows={rows}
        onRowDoubleClick={handleDoubleClick}
      />
    );

    await user.dblClick(screen.getByText('Beta Juegos'));

    expect(handleDoubleClick).toHaveBeenCalledWith(rows[0]);
  });

  it('loads more server rows when scrolled near the bottom', () => {
    const handleLoadMore = vi.fn();
    render(
      <DataTable
        ariaLabel="Stores"
        columns={columns}
        getRowKey={(row) => row.id}
        infiniteScroll={{
          hasMore: true,
          isLoading: false,
          loadedCount: 3,
          onLoadMore: handleLoadMore,
          totalCount: 4
        }}
        rows={rows}
      />
    );

    const scrollArea = screen.getByLabelText('Stores scroll area');
    Object.defineProperty(scrollArea, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scrollArea, 'scrollTop', { configurable: true, value: 620 });

    fireEvent.scroll(scrollArea);

    expect(handleLoadMore).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Go to next page' })).not.toBeInTheDocument();
  });

  it('keeps label and filter header rows in separate sticky positions', () => {
    render(
      <DataTable
        ariaLabel="Stores"
        columns={columns}
        getRowKey={(row) => row.id}
        infiniteScroll={{
          hasMore: false,
          isLoading: false,
          loadedCount: 3,
          onLoadMore: vi.fn(),
          totalCount: 3
        }}
        rows={rows}
      />
    );

    const labelHeader = screen.getByRole('button', { name: 'Store' }).closest('th');
    const filterHeader = screen.getByLabelText('Filter Store').closest('th');

    expect(labelHeader).toHaveStyle({ position: 'sticky', top: '0px' });
    expect(filterHeader).toHaveStyle({ position: 'sticky', top: '42px' });
  });
});
