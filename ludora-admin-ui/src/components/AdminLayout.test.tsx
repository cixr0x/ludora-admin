import { ThemeProvider, createTheme } from '@mui/material';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { AdminLayout } from './AdminLayout';

function mockMobileBreakpoint(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches,
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn()
    }))
  );
}

function renderLayout() {
  const onLogout = vi.fn();
  const onNavigate = vi.fn();

  render(
    <ThemeProvider theme={createTheme()}>
      <AdminLayout activeSection="store-candidates" onLogout={onLogout} onNavigate={onNavigate}>
        <div>Page content</div>
      </AdminLayout>
    </ThemeProvider>
  );

  return { onLogout, onNavigate };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AdminLayout', () => {
  it('keeps the navigation visible and omits mobile menu controls at md and wider', () => {
    mockMobileBreakpoint(false);
    const { onLogout } = renderLayout();

    expect(screen.getAllByRole('navigation', { name: 'Admin navigation' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: /^Stores$/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open navigation menu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close navigation menu' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('opens and closes one temporary navigation drawer on mobile', async () => {
    mockMobileBreakpoint(true);
    renderLayout();

    const openButton = screen.getByRole('button', { name: 'Open navigation menu' });
    expect(openButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'Admin navigation' })).not.toBeInTheDocument();

    fireEvent.click(openButton);

    expect(await screen.findByRole('navigation', { name: 'Admin navigation' })).toBeVisible();
    expect(screen.getAllByRole('navigation', { name: 'Admin navigation' })).toHaveLength(1);
    expect(openButton).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Close navigation menu' }));

    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: 'Admin navigation' })).not.toBeInTheDocument();
    });
    expect(openButton).toHaveAttribute('aria-expanded', 'false');
  });

  it('navigates and closes the temporary drawer after a mobile menu selection', async () => {
    mockMobileBreakpoint(true);
    const { onNavigate } = renderLayout();

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    fireEvent.click(await screen.findByRole('link', { name: /^Stores$/ }));

    expect(onNavigate).toHaveBeenCalledWith('stores');
    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: 'Admin navigation' })).not.toBeInTheDocument();
    });
  });
});
