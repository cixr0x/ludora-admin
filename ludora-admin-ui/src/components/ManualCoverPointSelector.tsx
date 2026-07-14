import { Box, Button, Stack, Typography } from '@mui/material';
import { useId, type MouseEvent as ReactMouseEvent } from 'react';

import type { CoverPoint } from '../api/client';

const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;

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
  const instruction = points.length === 4
    ? 'All four corners are selected. Generate the manual candidate or adjust the points.'
    : `Select corner ${points.length + 1} of 4: ${CORNER_NAMES[points.length]}.`;
  const svgPoints = points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(' ');

  function handleImageClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (disabled || points.length >= 4) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }
    onChange([
      ...points,
      {
        x: clamp((event.clientX - bounds.left) / bounds.width),
        y: clamp((event.clientY - bounds.top) / bounds.height)
      }
    ]);
  }

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography id={instructionId} variant="body1">
          Click the four cover corners in order: top-left, top-right, bottom-right, bottom-left.
        </Typography>
        <Typography aria-live="polite" color="text.secondary" variant="body2">
          {instruction}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'center', maxWidth: '100%', overflow: 'auto' }}>
        <Box
          aria-describedby={instructionId}
          aria-label="Select cover corners on source image"
          data-testid="manual-cover-point-surface"
          role="group"
          sx={{
            cursor: disabled || points.length >= 4 ? 'default' : 'crosshair',
            display: 'inline-block',
            lineHeight: 0,
            maxWidth: '100%',
            position: 'relative'
          }}
          onClick={handleImageClick}
        >
          <Box
            alt={`Source box image for ${imageTitle}`}
            component="img"
            draggable={false}
            src={imageUrl}
            sx={{
              display: 'block',
              height: 'auto',
              maxHeight: '65vh',
              maxWidth: '100%',
              userSelect: 'none',
              width: 'auto'
            }}
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
      </Box>

      <Stack direction="row" spacing={1}>
        <Button disabled={disabled || points.length === 0} onClick={() => onChange(points.slice(0, -1))}>
          Undo last point
        </Button>
        <Button disabled={disabled || points.length === 0} onClick={() => onChange([])}>
          Reset points
        </Button>
      </Stack>
    </Stack>
  );
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
