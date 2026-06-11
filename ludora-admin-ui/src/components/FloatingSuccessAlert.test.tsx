import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FloatingSuccessAlert } from './FloatingSuccessAlert';

describe('FloatingSuccessAlert', () => {
  it('renders success feedback in a non-layout floating container', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<FloatingSuccessAlert message="Saved." onClose={onClose} />);

    expect(screen.getByTestId('floating-success-alert')).toHaveTextContent('Saved.');
    expect(screen.getByRole('alert')).toHaveTextContent('Saved.');

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalled();
  });
});
