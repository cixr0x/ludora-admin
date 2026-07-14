import { Box, Button, Stack, Typography } from '@mui/material';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react';

import type { CoverPoint } from '../api/client';

const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;
const ZOOM_SCALE = 8;

export function ManualCoverPointSelector({
  disabled = false,
  imageTitle,
  imageUrl,
  onChange,
  points
}: {
  disabled?: boolean;
  imageTitle: string;
  imageUrl: string;
  onChange: (points: CoverPoint[]) => void;
  points: CoverPoint[];
}) {
  const instructionId = useId();
  const zoomSurfaceRef = useRef<HTMLDivElement | null>(null);
  const [zoomAnchor, setZoomAnchor] = useState<CoverPoint | null>(null);
  const cornerName = CORNER_NAMES[points.length];
  const instruction = points.length === 4
    ? 'All four corners are selected. Generate the manual candidate or adjust the points.'
    : zoomAnchor
      ? `Magnified ${ZOOM_SCALE}× view for the ${cornerName} corner. Click the exact corner to place it.`
      : `Select corner ${points.length + 1} of 4: ${cornerName}. Click once to magnify its area.`;
  const svgPoints = points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(' ');

  useEffect(() => {
    if (disabled || points.length >= 4) {
      setZoomAnchor(null);
    }
  }, [disabled, points.length]);

  useEffect(() => {
    if (zoomAnchor) {
      zoomSurfaceRef.current?.focus();
    }
  }, [zoomAnchor]);

  function handleOverviewClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (disabled || points.length >= 4) {
      return;
    }
    const point = normalizedClick(event);
    if (point) {
      setZoomAnchor(point);
    }
  }

  function handleZoomClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (disabled || !zoomAnchor || points.length >= 4) {
      return;
    }
    const zoomPoint = normalizedClick(event);
    if (!zoomPoint) {
      return;
    }
    const selectedPoint = {
      x: zoomAnchor.x + (zoomPoint.x - 0.5) / ZOOM_SCALE,
      y: zoomAnchor.y + (zoomPoint.y - 0.5) / ZOOM_SCALE
    };
    if (!isNormalizedPoint(selectedPoint)) {
      return;
    }
    onChange([...points, selectedPoint]);
    setZoomAnchor(null);
  }

  function handleZoomKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setZoomAnchor(null);
    }
  }

  function handleUndo() {
    setZoomAnchor(null);
    onChange(points.slice(0, -1));
  }

  function handleReset() {
    setZoomAnchor(null);
    onChange([]);
  }

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography id={instructionId} variant="body1">
          Select the four cover corners in order: top-left, top-right, bottom-right, bottom-left.
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Click or tap once near a corner to open a strong zoom, then click the exact corner in the magnified view.
        </Typography>
        <Typography aria-live="polite" color="text.secondary" variant="body2">
          {instruction}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'center', maxWidth: '100%', overflow: 'auto' }}>
        {zoomAnchor ? (
          <Box
            aria-describedby={instructionId}
            aria-label={`Magnified ${ZOOM_SCALE} times view for the ${cornerName} cover corner`}
            data-testid="manual-cover-zoom-surface"
            ref={zoomSurfaceRef}
            role="group"
            tabIndex={0}
            sx={{
              bgcolor: 'grey.300',
              cursor: disabled ? 'default' : 'crosshair',
              display: 'inline-block',
              lineHeight: 0,
              maxWidth: '100%',
              overflow: 'hidden',
              position: 'relative',
              touchAction: 'manipulation'
            }}
            onClick={handleZoomClick}
            onKeyDown={handleZoomKeyDown}
          >
            <SizingImage imageTitle={imageTitle} imageUrl={imageUrl} />
            <Box
              aria-hidden="true"
              component="img"
              draggable={false}
              src={imageUrl}
              sx={{
                height: `${ZOOM_SCALE * 100}%`,
                left: `${(0.5 - zoomAnchor.x * ZOOM_SCALE) * 100}%`,
                maxWidth: 'none',
                pointerEvents: 'none',
                position: 'absolute',
                top: `${(0.5 - zoomAnchor.y * ZOOM_SCALE) * 100}%`,
                userSelect: 'none',
                width: `${ZOOM_SCALE * 100}%`
              }}
            />
            <Box
              aria-hidden="true"
              data-testid="manual-cover-zoom-crosshair"
              sx={{ inset: 0, pointerEvents: 'none', position: 'absolute' }}
            >
              <Box
                sx={{
                  borderLeft: '1px dashed rgba(255,255,255,0.9)',
                  borderRight: '1px dashed rgba(0,0,0,0.7)',
                  height: '100%',
                  left: '50%',
                  position: 'absolute',
                  top: 0
                }}
              />
              <Box
                sx={{
                  borderBottom: '1px dashed rgba(0,0,0,0.7)',
                  borderTop: '1px dashed rgba(255,255,255,0.9)',
                  left: 0,
                  position: 'absolute',
                  top: '50%',
                  width: '100%'
                }}
              />
            </Box>
            <Typography
              aria-hidden="true"
              sx={{
                bgcolor: 'rgba(0,0,0,0.72)',
                borderRadius: 1,
                color: 'common.white',
                left: 8,
                lineHeight: 1.3,
                px: 1,
                py: 0.5,
                pointerEvents: 'none',
                position: 'absolute',
                top: 8
              }}
              variant="caption"
            >
              {ZOOM_SCALE}× zoom
            </Typography>
          </Box>
        ) : (
          <Box
            aria-describedby={instructionId}
            aria-label="Choose an area to magnify for the next cover corner"
            data-testid="manual-cover-point-surface"
            role="group"
            sx={{
              cursor: disabled || points.length >= 4 ? 'default' : 'zoom-in',
              display: 'inline-block',
              lineHeight: 0,
              maxWidth: '100%',
              position: 'relative',
              touchAction: 'manipulation'
            }}
            onClick={handleOverviewClick}
          >
            <Box
              alt={`Source box image for ${imageTitle}`}
              component="img"
              draggable={false}
              src={imageUrl}
              sx={imageSizingStyles}
            />

            {points.length >= 2 ? (
              <Box
                aria-hidden="true"
                component="svg"
                data-testid="manual-cover-polygon"
                preserveAspectRatio="none"
                sx={{ height: '100%', inset: 0, pointerEvents: 'none', position: 'absolute', width: '100%' }}
                viewBox="0 0 1000 1000"
              >
                {points.length === 4 ? (
                  <polygon
                    fill="rgba(25, 118, 210, 0.16)"
                    points={svgPoints}
                    stroke="#1976d2"
                    strokeWidth="3"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : (
                  <polyline
                    fill="none"
                    points={svgPoints}
                    stroke="#1976d2"
                    strokeWidth="3"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </Box>
            ) : null}

            {points.map((point, index) => (
              <Box
                aria-hidden="true"
                data-testid={`manual-cover-point-${index + 1}`}
                key={`${index}:${point.x}:${point.y}`}
                sx={{
                  alignItems: 'center',
                  bgcolor: 'primary.main',
                  border: '2px solid white',
                  borderRadius: '50%',
                  boxShadow: 2,
                  color: 'primary.contrastText',
                  display: 'flex',
                  fontSize: 13,
                  fontWeight: 700,
                  height: 28,
                  justifyContent: 'center',
                  left: `${point.x * 100}%`,
                  lineHeight: 1,
                  pointerEvents: 'none',
                  position: 'absolute',
                  top: `${point.y * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  width: 28
                }}
              >
                {index + 1}
              </Box>
            ))}
          </Box>
        )}
      </Box>

      <Stack direction="row" spacing={1}>
        {zoomAnchor ? (
          <Button disabled={disabled} onClick={() => setZoomAnchor(null)}>
            Back to full image
          </Button>
        ) : null}
        <Button disabled={disabled || points.length === 0} onClick={handleUndo}>
          Undo last point
        </Button>
        <Button disabled={disabled || points.length === 0} onClick={handleReset}>
          Reset points
        </Button>
      </Stack>
    </Stack>
  );
}

function SizingImage({ imageTitle, imageUrl }: { imageTitle: string; imageUrl: string }) {
  return (
    <Box
      alt={`Magnified source box image for ${imageTitle}`}
      aria-hidden="true"
      component="img"
      draggable={false}
      src={imageUrl}
      sx={{ ...imageSizingStyles, visibility: 'hidden' }}
    />
  );
}

const imageSizingStyles = {
  display: 'block',
  height: 'auto',
  maxHeight: '65vh',
  maxWidth: '100%',
  userSelect: 'none',
  width: 'auto'
} as const;

function normalizedClick(event: ReactMouseEvent<HTMLDivElement>): CoverPoint | null {
  const bounds = event.currentTarget.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) {
    return null;
  }
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width),
    y: clamp((event.clientY - bounds.top) / bounds.height)
  };
}

function isNormalizedPoint(point: CoverPoint): boolean {
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
