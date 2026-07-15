import { act, render, screen } from '@testing-library/react';
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

  it('automatically closes success feedback after three seconds by default', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { unmount } = render(<FloatingSuccessAlert message="Saved." onClose={onClose} />);

    try {
      act(() => vi.advanceTimersByTime(2999));
      expect(onClose).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(1));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it('restarts the timer when a new confirmation message appears', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { rerender, unmount } = render(<FloatingSuccessAlert message="Saved." onClose={onClose} />);

    try {
      act(() => vi.advanceTimersByTime(2000));
      rerender(<FloatingSuccessAlert message="Updated." onClose={onClose} />);
      act(() => vi.advanceTimersByTime(1000));
      expect(onClose).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(2000));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });
});
