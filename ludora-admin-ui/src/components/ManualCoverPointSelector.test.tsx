import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { CoverPoint } from '../api/client';
import { ManualCoverPointSelector } from './ManualCoverPointSelector';

describe('ManualCoverPointSelector', () => {
  it('maps four image-bound clicks to normalized points and supports undo and reset', () => {
    const onPointsChange = vi.fn();

    function Harness() {
      const [points, setPoints] = useState<CoverPoint[]>([]);
      return (
        <ManualCoverPointSelector
          imageTitle="Coffee Rush"
          imageUrl="blob:source-cover"
          points={points}
          onChange={(nextPoints) => {
            onPointsChange(nextPoints);
            setPoints(nextPoints);
          }}
        />
      );
    }

    render(<Harness />);

    expect(screen.getByAltText('Source box image for Coffee Rush')).toHaveAttribute('src', 'blob:source-cover');
    expect(screen.getByText('Select corner 1 of 4: top-left.')).toBeInTheDocument();

    const surface = screen.getByTestId('manual-cover-point-surface');
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rectangle(10, 20, 200, 100));
    fireEvent.click(surface, { clientX: 30, clientY: 40 });
    fireEvent.click(surface, { clientX: 190, clientY: 40 });
    fireEvent.click(surface, { clientX: 190, clientY: 100 });
    fireEvent.click(surface, { clientX: 30, clientY: 100 });

    expect(onPointsChange).toHaveBeenLastCalledWith([
      { x: 0.1, y: 0.2 },
      { x: 0.9, y: 0.2 },
      { x: 0.9, y: 0.8 },
      { x: 0.1, y: 0.8 }
    ]);
    expect(screen.getByText('All four corners are selected. Generate the manual candidate or adjust the points.')).toBeInTheDocument();
    expect(screen.getByTestId('manual-cover-point-1')).toHaveTextContent('1');
    expect(screen.getByTestId('manual-cover-point-4')).toHaveTextContent('4');
    expect(screen.getByTestId('manual-cover-polygon').querySelector('polygon')).toHaveAttribute(
      'points',
      '100,200 900,200 900,800 100,800'
    );

    const callsAfterFourPoints = onPointsChange.mock.calls.length;
    fireEvent.click(surface, { clientX: 110, clientY: 70 });
    expect(onPointsChange).toHaveBeenCalledTimes(callsAfterFourPoints);

    fireEvent.click(screen.getByRole('button', { name: 'Undo last point' }));
    expect(screen.queryByTestId('manual-cover-point-4')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset points' }));
    expect(screen.queryByTestId('manual-cover-point-1')).not.toBeInTheDocument();
    expect(screen.getByText('Select corner 1 of 4: top-left.')).toBeInTheDocument();
  });

  it('clamps pointer positions to the image bounds', () => {
    const onChange = vi.fn();
    render(
      <ManualCoverPointSelector
        imageTitle="Azul"
        imageUrl="blob:azul"
        points={[]}
        onChange={onChange}
      />
    );
    const surface = screen.getByTestId('manual-cover-point-surface');
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rectangle(10, 20, 200, 100));

    fireEvent.click(surface, { clientX: 0, clientY: 200 });

    expect(onChange).toHaveBeenCalledWith([{ x: 0, y: 1 }]);
  });
});

function rectangle(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    toJSON: () => ({}),
    top,
    width,
    x: left,
    y: top
  };
}
