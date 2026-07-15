import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoverPoint } from '../api/client';
import { ManualCoverPointSelector } from './ManualCoverPointSelector';

describe('ManualCoverPointSelector', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses overflow-safe stacked controls at narrow widths', () => {
    useMobileViewport();
    render(
      <ManualCoverPointSelector
        imageTitle="Mobile box"
        imageUrl="blob:mobile"
        points={[]}
        onChange={() => undefined}
      />
    );

    selectPoint(110, 70);

    const controls = screen.getByRole('group', { name: 'Manual point controls' });
    expect(controls).toHaveStyle({ alignItems: 'stretch', flexDirection: 'column' });
    for (const name of ['Back to full image', 'Undo last point', 'Reset points']) {
      expect(screen.getByRole('button', { name })).toHaveStyle({ minHeight: '44px', width: '100%' });
    }
  });

  it('uses an 8x confirmation zoom for each corner and supports undo and reset', () => {
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
    expect(screen.getByText('Select corner 1 of 4: top-left. Click once to magnify its area.')).toBeInTheDocument();

    selectPoint(30, 40);
    expect(onPointsChange).not.toHaveBeenCalled();
    expect(screen.getByText('8× zoom')).toBeInTheDocument();
    confirmZoomAt(110, 70);

    selectPoint(190, 40);
    confirmZoomAt(110, 70);
    selectPoint(190, 100);
    confirmZoomAt(110, 70);
    selectPoint(30, 100);
    confirmZoomAt(110, 70);

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
    fireEvent.click(screen.getByTestId('manual-cover-point-surface'), { clientX: 110, clientY: 70 });
    expect(onPointsChange).toHaveBeenCalledTimes(callsAfterFourPoints);
    expect(screen.queryByTestId('manual-cover-zoom-surface')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Undo last point' }));
    expect(screen.queryByTestId('manual-cover-point-4')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset points' }));
    expect(screen.queryByTestId('manual-cover-point-1')).not.toBeInTheDocument();
    expect(screen.getByText('Select corner 1 of 4: top-left. Click once to magnify its area.')).toBeInTheDocument();
  });

  it('maps fine adjustments in the zoomed view back to the original image', () => {
    const onChange = vi.fn();
    render(
      <ManualCoverPointSelector
        imageTitle="Azul"
        imageUrl="blob:azul"
        points={[]}
        onChange={onChange}
      />
    );

    const overview = screen.getByTestId('manual-cover-point-surface');
    vi.spyOn(overview, 'getBoundingClientRect').mockReturnValue(rectangle(0, 0, 400, 200));
    fireEvent.click(overview, { clientX: 100, clientY: 80 });
    expect(onChange).not.toHaveBeenCalled();

    const zoom = screen.getByTestId('manual-cover-zoom-surface');
    vi.spyOn(zoom, 'getBoundingClientRect').mockReturnValue(rectangle(0, 0, 400, 200));
    fireEvent.click(zoom, { clientX: 360, clientY: 20 });

    const selectedPoint = onChange.mock.calls[0]?.[0]?.[0] as CoverPoint;
    expect(selectedPoint.x).toBeCloseTo(0.3);
    expect(selectedPoint.y).toBeCloseTo(0.35);
  });

  it('keeps an edge anchor centered and ignores clicks in the out-of-image zoom area', () => {
    const onChange = vi.fn();
    render(
      <ManualCoverPointSelector
        imageTitle="Edge box"
        imageUrl="blob:edge"
        points={[]}
        onChange={onChange}
      />
    );

    const overview = screen.getByTestId('manual-cover-point-surface');
    vi.spyOn(overview, 'getBoundingClientRect').mockReturnValue(rectangle(10, 20, 200, 100));
    fireEvent.click(overview, { clientX: 10, clientY: 20 });

    const zoom = screen.getByTestId('manual-cover-zoom-surface');
    vi.spyOn(zoom, 'getBoundingClientRect').mockReturnValue(rectangle(10, 20, 200, 100));
    fireEvent.click(zoom, { clientX: 10, clientY: 20 });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('manual-cover-zoom-surface')).toBeInTheDocument();

    fireEvent.click(zoom, { clientX: 110, clientY: 70 });
    expect(onChange).toHaveBeenCalledWith([{ x: 0, y: 0 }]);
  });

  it('backs out of a pending zoom with the button or Escape without adding a point', () => {
    const onChange = vi.fn();
    render(
      <ManualCoverPointSelector
        imageTitle="Back test"
        imageUrl="blob:back"
        points={[]}
        onChange={onChange}
      />
    );

    selectPoint(110, 70);
    fireEvent.click(screen.getByRole('button', { name: 'Back to full image' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('manual-cover-point-surface')).toBeInTheDocument();

    selectPoint(110, 70);
    fireEvent.keyDown(screen.getByTestId('manual-cover-zoom-surface'), { key: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('manual-cover-point-surface')).toBeInTheDocument();
  });
});

function selectPoint(clientX: number, clientY: number): void {
  const surface = screen.getByTestId('manual-cover-point-surface');
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rectangle(10, 20, 200, 100));
  fireEvent.click(surface, { clientX, clientY });
}

function confirmZoomAt(clientX: number, clientY: number): void {
  const surface = screen.getByTestId('manual-cover-zoom-surface');
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rectangle(10, 20, 200, 100));
  fireEvent.click(surface, { clientX, clientY });
}

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

function useMobileViewport() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query.includes('max-width:899.95px'),
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn()
    }))
  );
}
