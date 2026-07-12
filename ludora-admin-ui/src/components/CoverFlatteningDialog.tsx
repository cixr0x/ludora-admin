import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Typography
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import {
  adminApi,
  type AcceptedCoverFlattening,
  type CoverFlatteningWorkflow,
  type CoverImageField
} from '../api/client';

export type CoverFlatteningRequest =
  | {
      id: string;
      kind: 'store_item';
      title: string;
    }
  | {
      id: string;
      kind: 'item';
      sources: Array<{ field: CoverImageField; url: string }>;
      title: string;
    };

export function CoverFlatteningDialog({
  onAccepted,
  onClose,
  request
}: {
  onAccepted: (result: AcceptedCoverFlattening) => void;
  onClose: () => void;
  request: CoverFlatteningRequest | null;
}) {
  const [workflow, setWorkflow] = useState<CoverFlatteningWorkflow | null>(null);
  const [candidateUrls, setCandidateUrls] = useState<Record<number, string>>({});
  const [selectedCandidate, setSelectedCandidate] = useState<number | null>(null);
  const [sourceField, setSourceField] = useState<CoverImageField>('image_url');
  const [targetField, setTargetField] = useState<CoverImageField | ''>('');
  const [isStarting, setIsStarting] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState('');
  const requestKeyRef = useRef('');
  const cancelRequestedRef = useRef(false);

  const requestKey = request ? `${request.kind}:${request.id}` : '';
  const itemSources = request?.kind === 'item' ? request.sources : [];
  const needsSourceChoice = itemSources.length > 1 && !workflow;

  useEffect(() => {
    if (!request || requestKeyRef.current === requestKey) {
      return;
    }
    requestKeyRef.current = requestKey;
    cancelRequestedRef.current = false;
    setWorkflow(null);
    setCandidateUrls({});
    setSelectedCandidate(null);
    setTargetField('');
    setError('');
    const preferredSource = request.kind === 'item' && request.sources.some((source) => source.field === 'image_url')
      ? 'image_url'
      : request.kind === 'item'
        ? request.sources[0]?.field ?? 'image_url'
        : 'image_url';
    setSourceField(preferredSource);

    if (request.kind === 'store_item' || request.sources.length === 1) {
      void startWorkflow(request, request.kind === 'item' ? request.sources[0]?.field ?? 'image_url' : 'image_url');
    }
  }, [request, requestKey]);

  useEffect(() => {
    if (!workflow) {
      return;
    }
    let active = true;
    const createdUrls: string[] = [];
    void Promise.all(
      workflow.candidates.map(async (candidate) => {
        const blob = await adminApi.getCoverFlatteningCandidate(workflow.workflow_id, candidate.index);
        const url = URL.createObjectURL(blob);
        createdUrls.push(url);
        return [candidate.index, url] as const;
      })
    )
      .then((entries) => {
        if (active) {
          setCandidateUrls(Object.fromEntries(entries));
        }
      })
      .catch((candidateError) => {
        if (active) {
          setError(errorMessage(candidateError, 'Cover candidates could not be loaded.'));
        }
      });
    return () => {
      active = false;
      for (const url of createdUrls) {
        URL.revokeObjectURL(url);
      }
    };
  }, [workflow]);

  async function startWorkflow(activeRequest: CoverFlatteningRequest, selectedSource: CoverImageField) {
    const activeRequestKey = `${activeRequest.kind}:${activeRequest.id}`;
    setIsStarting(true);
    setError('');
    try {
      const started = activeRequest.kind === 'store_item'
        ? await adminApi.startStoreItemCoverFlattening(activeRequest.id)
        : await adminApi.startItemCoverFlattening(activeRequest.id, selectedSource);
      if (cancelRequestedRef.current || requestKeyRef.current !== activeRequestKey) {
        await adminApi.cancelCoverFlattening(started.workflow_id).catch(() => undefined);
        return;
      }
      setWorkflow(started);
      setSelectedCandidate(started.candidates.length === 1 ? started.candidates[0]?.index ?? null : null);
    } catch (startError) {
      if (!cancelRequestedRef.current) {
        setError(errorMessage(startError, 'Cover flattening could not be started.'));
      }
    } finally {
      if (requestKeyRef.current === activeRequestKey || cancelRequestedRef.current) {
        setIsStarting(false);
      }
    }
  }

  async function handleAccept() {
    if (!workflow || selectedCandidate === null || !targetField) {
      return;
    }
    setIsAccepting(true);
    setError('');
    try {
      const result = await adminApi.acceptCoverFlattening(workflow.workflow_id, selectedCandidate, targetField);
      setWorkflow(null);
      onAccepted(result);
    } catch (acceptError) {
      setError(errorMessage(acceptError, 'Flattened cover could not be saved.'));
    } finally {
      setIsAccepting(false);
    }
  }

  function handleClose() {
    cancelRequestedRef.current = true;
    if (workflow) {
      void adminApi.cancelCoverFlattening(workflow.workflow_id).catch(() => undefined);
    }
    setWorkflow(null);
    requestKeyRef.current = '';
    onClose();
  }

  return (
    <Dialog fullWidth maxWidth="lg" open={Boolean(request)} onClose={isAccepting ? undefined : handleClose}>
      <DialogTitle>Flatten cover{request?.title ? `: ${request.title}` : ''}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          {needsSourceChoice ? (
            <FormControl>
              <FormLabel>Source image</FormLabel>
              <RadioGroup value={sourceField} onChange={(event) => setSourceField(event.target.value as CoverImageField)}>
                {itemSources.map((source) => (
                  <FormControlLabel
                    control={<Radio />}
                    key={source.field}
                    label={source.field === 'image_url' ? 'Image' : 'Spanish image'}
                    value={source.field}
                  />
                ))}
              </RadioGroup>
              <Button
                disabled={isStarting}
                startIcon={isStarting ? <CircularProgress size={18} /> : <AutoFixHighIcon />}
                sx={{ alignSelf: 'flex-start', mt: 1 }}
                variant="contained"
                onClick={() => request && startWorkflow(request, sourceField)}
              >
                Generate candidates
              </Button>
            </FormControl>
          ) : null}

          {isStarting ? (
            <Stack alignItems="center" direction="row" spacing={1.5}>
              <CircularProgress size={20} />
              <Typography>Detecting the box perspective and flattening its cover…</Typography>
            </Stack>
          ) : null}

          {error ? <Alert severity="error">{error}</Alert> : null}

          {workflow ? (
            <>
              <Typography color="text.secondary" variant="body2">
                {workflow.perspective === 'two_faces'
                  ? 'Two-face perspective detected. One cover candidate was generated.'
                  : 'Three-face perspective detected. Select the correct cover candidate.'}
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gap: 2,
                  gridTemplateColumns: { md: `repeat(${workflow.candidates.length}, minmax(0, 1fr))`, xs: '1fr' }
                }}
              >
                {workflow.candidates.map((candidate) => (
                  <Paper
                    key={candidate.index}
                    sx={{
                      border: 2,
                      borderColor: selectedCandidate === candidate.index ? 'primary.main' : 'divider',
                      cursor: 'pointer',
                      overflow: 'hidden',
                      p: 1.5
                    }}
                    variant="outlined"
                    onClick={() => setSelectedCandidate(candidate.index)}
                  >
                    <Stack spacing={1}>
                      <FormControlLabel
                        control={<Radio checked={selectedCandidate === candidate.index} />}
                        label={`Candidate ${candidate.index}`}
                        value={candidate.index}
                      />
                      {candidateUrls[candidate.index] ? (
                        <Box
                          alt={`Flattened cover candidate ${candidate.index}`}
                          component="img"
                          src={candidateUrls[candidate.index]}
                          sx={{ bgcolor: 'grey.100', maxHeight: 560, objectFit: 'contain', width: '100%' }}
                        />
                      ) : (
                        <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 240 }}>
                          <CircularProgress size={24} />
                        </Stack>
                      )}
                      <Typography color="text.secondary" variant="caption">
                        {candidate.width} × {candidate.height} · ratio {candidate.aspect_ratio.toFixed(3)}
                        {candidate.square_snapped ? ' · square corrected' : ''}
                      </Typography>
                    </Stack>
                  </Paper>
                ))}
              </Box>

              <FormControl>
                <FormLabel>Save selected candidate as</FormLabel>
                <RadioGroup
                  row
                  value={targetField}
                  onChange={(event) => setTargetField(event.target.value as CoverImageField)}
                >
                  <FormControlLabel control={<Radio />} label="Image" value="image_url" />
                  <FormControlLabel control={<Radio />} label="Spanish image" value="image_url_es" />
                </RadioGroup>
              </FormControl>
            </>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={isAccepting} onClick={handleClose}>Cancel</Button>
        <Button
          disabled={
            !workflow ||
            selectedCandidate === null ||
            !candidateUrls[selectedCandidate] ||
            !targetField ||
            isAccepting
          }
          startIcon={isAccepting ? <CircularProgress size={18} /> : undefined}
          variant="contained"
          onClick={handleAccept}
        >
          {isAccepting ? 'Saving…' : 'Accept candidate'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
