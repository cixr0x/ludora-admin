import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { adminApi, type HashSimilarityResult, type ImageSimilarityResult } from '../api/client';

type State = { requestKey: string; status: 'idle' | 'loading' }
  | { requestKey: string; result: ImageSimilarityResult; status: 'ready' }
  | { requestKey: string; message: string; status: 'error' };

export function ReviewImageSimilarity({ itemImageLabel, itemImageUrl, linkedItemLoaded, linkedItemPresent, storeItemImageUrl }: {
  itemImageLabel: string; itemImageUrl: string; linkedItemLoaded: boolean; linkedItemPresent: boolean; storeItemImageUrl: string;
}) {
  const requestKey = `${itemImageUrl}\u001f${storeItemImageUrl}`;
  const [state, setState] = useState<State>({ requestKey: '', status: 'idle' });
  useEffect(() => {
    if (!itemImageUrl || !storeItemImageUrl) { setState({ requestKey, status: 'idle' }); return; }
    let ignore = false;
    setState({ requestKey, status: 'loading' });
    adminApi.estimateImageSimilarity(itemImageUrl, storeItemImageUrl, { includeHashSimilarity: true })
      .then((result) => { if (!ignore) setState({ requestKey, result, status: 'ready' }); })
      .catch((error: unknown) => { if (!ignore) setState({ requestKey, status: 'error', message: error instanceof Error ? error.message : 'Unknown error' }); });
    return () => { ignore = true; };
  }, [itemImageUrl, requestKey, storeItemImageUrl]);

  const current = state.requestKey === requestKey ? state : { requestKey, status: 'loading' as const };
  const imagesPresent = Boolean(itemImageUrl && storeItemImageUrl);
  const loading = imagesPresent && (current.status === 'idle' || current.status === 'loading');
  const hash = imagesPresent && current.status === 'ready' ? current.result.hash_similarity : undefined;
  let visual;
  if (!storeItemImageUrl) {
    visual = <Typography variant="body2">Similarity unavailable: the store item has no image.</Typography>;
  } else if (!itemImageUrl) {
    visual = <Typography variant="body2">{linkedItemPresent && !linkedItemLoaded ? 'Waiting for the linked item image...' : 'Similarity unavailable: the linked item has no image.'}</Typography>;
  } else if (current.status === 'ready') {
    visual = <>
      <Typography sx={{ fontWeight: 700 }} variant="body2">Image similarity: {current.result.score.toFixed(2)} / 100</Typography>
      <Typography color="text.secondary" variant="caption">Compared with {itemImageLabel} · {current.result.diagnostics.inliers} geometric inliers</Typography>
    </>;
  } else if (current.status === 'error') {
    visual = <>
      <Typography color="warning.main" sx={{ fontWeight: 600 }} variant="body2">Image similarity could not be estimated.</Typography>
      <Typography color="text.secondary" variant="caption">{current.message}</Typography>
    </>;
  } else {
    visual = <Stack alignItems="center" direction="row" spacing={1}><CircularProgress size={16} /><Typography variant="body2">Estimating image similarity...</Typography></Stack>;
  }

  return <Stack alignItems="center" spacing={1} sx={{ bgcolor: 'grey.50', border: 1, borderColor: 'divider', borderRadius: 1, gridColumn: '1 / -1', px: 1.5, py: 1, textAlign: 'center', overflowWrap: 'anywhere' }}>
    <Stack alignItems="center" aria-label="Image similarity" aria-live="polite" role="status" spacing={0.25}>{visual}</Stack>
    <Stack alignItems="center" aria-label="Hash similarity" aria-live="polite" role="status" spacing={0.25}>
      {loading ? <Typography variant="body2">Hash similarity: Calculating...</Typography> : validHash(hash) ? <>
        <Typography sx={{ fontWeight: 700 }} variant="body2">Hash similarity: {hash.score.toFixed(2)} / 100</Typography>
        <Typography color="text.secondary" variant="caption">{hash.distance} of 256 bits differ · {hash.origin === 'raw' ? 'Raw photo' : 'Flattened cover'}</Typography>
        <Box component="details" sx={{ maxWidth: '100%' }}>
          <Box component="summary" sx={{ cursor: 'pointer', fontSize: '0.75rem' }}>Hash comparison details</Box>
          <Typography variant="caption" component="p">Raw photo: {hash.raw.score.toFixed(2)} / 100 · {hash.raw.distance} of 256 bits differ</Typography>
          <Typography variant="caption" component="p">{hash.variant_count} query {hash.variant_count === 1 ? 'variant' : 'variants'} · {hash.normalization_status === 'completed' ? 'Cover normalization completed' : hash.normalization_status === 'no_faces' ? 'No flattened cover found' : 'Cover normalization unavailable'}</Typography>
          <Typography variant="caption" component="p">Fingerprint similarity is not an identity probability.</Typography>
        </Box>
      </> : <Typography variant="body2">Hash similarity: Unavailable</Typography>}
    </Stack>
  </Stack>;
}

function validHash(value: unknown): value is Extract<HashSimilarityResult, { status: 'ready' }> {
  if (!isRecord(value) || value.status !== 'ready' || value.method !== 'phash_dct256_v1'
    || !['raw', 'box_silhouette'].includes(String(value.origin)) || !isRecord(value.raw)
    || !validPair(value) || !validPair(value.raw) || Number(value.distance) > Number(value.raw.distance)
    || !Number.isInteger(value.variant_count) || Number(value.variant_count) < 1 || Number(value.variant_count) > 3
    || !['completed', 'no_faces', 'error'].includes(String(value.normalization_status))) return false;
  if (value.origin === 'raw' && (value.distance !== value.raw.distance || value.score !== value.raw.score)) return false;
  if (value.origin === 'box_silhouette' && (Number(value.variant_count) < 2 || value.normalization_status !== 'completed')) return false;
  return true;
}
function validPair(value: Record<string, unknown>): boolean {
  return typeof value.distance === 'number' && Number.isInteger(value.distance) && value.distance >= 0 && value.distance <= 256
    && typeof value.score === 'number' && Number.isFinite(value.score) && value.score >= 0 && value.score <= 100
    && Math.abs(value.score - 100 * (256 - value.distance) / 256) < 0.000001;
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
