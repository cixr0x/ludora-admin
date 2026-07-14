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
  type CoverPoint,
  type CoverFlatteningWorkflow,
  type CoverImageField
} from '../api/client';
import { ManualCoverPointSelector } from './ManualCoverPointSelector';

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
  const [mode, setMode] = useState<CoverFlatteningMode>('candidates');
  const [candidateUrls, setCandidateUrls] = useState<Record<number, string>>({});
  const [selectedCandidate, setSelectedCandidate] = useState<number | null>(null);
  const [manualPoints, setManualPoints] = useState<CoverPoint[]>([]);
  const [manualSourceUrl, setManualSourceUrl] = useState('');
  const [aspectRatioChoice, setAspectRatioChoice] = useState<AspectRatioChoice>('auto');
  const [customAspectRatio, setCustomAspectRatio] = useState('1');
  const [aspectRatioOrientation, setAspectRatioOrientation] = useState<AspectRatioOrientation>('vertical');
  const [sourceField, setSourceField] = useState<CoverImageField>('image_url');
  const [targetField, setTargetField] = useState<CoverImageField | ''>('');
  const [isStarting, setIsStarting] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);
  const [isCreatingManualCandidate, setIsCreatingManualCandidate] = useState(false);
  const [isLoadingManualSource, setIsLoadingManualSource] = useState(false);
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
    setMode('candidates');
    setCandidateUrls({});
    setSelectedCandidate(null);
    setManualPoints([]);
    setManualSourceUrl('');
    setAspectRatioChoice('auto');
    setCustomAspectRatio('1');
    setAspectRatioOrientation('vertical');
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

  useEffect(() => {
    if (!workflow || mode !== 'manual') {
      return;
    }
    let active = true;
    let createdUrl = '';
    setManualSourceUrl('');
    setIsLoadingManualSource(true);
    void adminApi.getCoverFlatteningSource(workflow.workflow_id)
      .then((blob) => {
        createdUrl = URL.createObjectURL(blob);
        if (active) {
          setManualSourceUrl(createdUrl);
        }
      })
      .catch((sourceError) => {
        if (active) {
          setError(errorMessage(sourceError, 'The source image could not be loaded.'));
        }
      })
      .finally(() => {
        if (active) {
          setIsLoadingManualSource(false);
        }
      });
    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [mode, workflow]);

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
      const onlyCandidate = started.candidates.length === 1 ? started.candidates[0] : undefined;
      setSelectedCandidate(onlyCandidate?.index ?? null);
      if (onlyCandidate) {
        setAspectRatioOrientation(orientationForRatio(onlyCandidate.aspect_ratio));
      }
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
      const candidate = workflow.candidates.find((entry) => entry.index === selectedCandidate);
      if (!candidate) {
        setError('Selected cover candidate is no longer available.');
        return;
      }
      const aspectRatio = selectedAspectRatio(
        aspectRatioChoice,
        customAspectRatio,
        aspectRatioOrientation,
        candidate.aspect_ratio
      );
      if (aspectRatio === undefined) {
        setError('Custom aspect ratio must be between 0.2 and 5.');
        return;
      }
      const aspectRatioOverride = Math.abs(aspectRatio - candidate.aspect_ratio) < 0.0005
        ? null
        : aspectRatio;
      const result = await adminApi.acceptCoverFlattening(
        workflow.workflow_id,
        selectedCandidate,
        targetField,
        aspectRatioOverride
      );
      setWorkflow(null);
      onAccepted(result);
    } catch (acceptError) {
      setError(errorMessage(acceptError, 'Flattened cover could not be saved.'));
    } finally {
      setIsAccepting(false);
    }
  }

  function handleStartManualSelection() {
    setManualPoints([]);
    setManualSourceUrl('');
    setError('');
    setMode('manual');
  }

  function handleCancelManualSelection() {
    setManualPoints([]);
    setManualSourceUrl('');
    setError('');
    setMode('candidates');
  }

  async function handleGenerateManualCandidate() {
    if (!workflow || manualPoints.length !== 4) {
      return;
    }
    setIsCreatingManualCandidate(true);
    setError('');
    try {
      const updatedWorkflow = await adminApi.createManualCoverFlatteningCandidate(
        workflow.workflow_id,
        manualPoints
      );
      const manualCandidate = updatedWorkflow.candidates.find((candidate) => candidate.index === 3);
      if (!manualCandidate) {
        setError('Manual cover candidate was not returned by the server.');
        return;
      }
      setWorkflow(updatedWorkflow);
      setSelectedCandidate(manualCandidate.index);
      if (aspectRatioChoice === 'auto') {
        setAspectRatioOrientation(orientationForRatio(manualCandidate.aspect_ratio));
      }
      setManualPoints([]);
      setMode('candidates');
    } catch (manualError) {
      setError(errorMessage(manualError, 'Manual cover candidate could not be generated.'));
    } finally {
      setIsCreatingManualCandidate(false);
    }
  }

  function handleClose() {
    cancelRequestedRef.current = true;
    if (workflow) {
      void adminApi.cancelCoverFlattening(workflow.workflow_id).catch(() => undefined);
    }
    setWorkflow(null);
    setMode('candidates');
    setManualPoints([]);
    requestKeyRef.current = '';
    onClose();
  }

  return (
    <Dialog
      fullWidth
      maxWidth="lg"
      open={Boolean(request)}
      onClose={isAccepting || isCreatingManualCandidate ? undefined : handleClose}
    >
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

          {workflow && mode === 'candidates' ? (
            <>
              <Typography color="text.secondary" variant="body2">
                {workflow.candidates.some((candidate) => candidate.index === 3)
                  ? 'Manual cover candidate generated. Select the candidate to save.'
                  : workflow.perspective === 'two_faces'
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
                {workflow.candidates.map((candidate) => {
                  const previewRatio = selectedAspectRatio(
                    aspectRatioChoice,
                    customAspectRatio,
                    aspectRatioOrientation,
                    candidate.aspect_ratio
                  ) ?? candidate.aspect_ratio;
                  const previewWidth = Math.max(2, Math.round(candidate.height * previewRatio));
                  return (
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
                      onClick={() => {
                        setSelectedCandidate(candidate.index);
                        if (aspectRatioChoice === 'auto') {
                          setAspectRatioOrientation(orientationForRatio(candidate.aspect_ratio));
                        }
                      }}
                    >
                      <Stack spacing={1}>
                        <FormControlLabel
                          control={<Radio checked={selectedCandidate === candidate.index} />}
                          label={`Candidate ${candidate.index}`}
                          value={candidate.index}
                        />
                        {candidateUrls[candidate.index] ? (
                          <Box
                            data-testid={`aspect-ratio-preview-${candidate.index}`}
                            sx={{
                              aspectRatio: previewRatio,
                              bgcolor: 'grey.100',
                              maxWidth: '100%',
                              maxHeight: 560,
                              mx: 'auto',
                              overflow: 'hidden',
                              width: `min(100%, ${560 * previewRatio}px)`
                            }}
                          >
                            <Box
                              alt={`Flattened cover candidate ${candidate.index}`}
                              component="img"
                              src={candidateUrls[candidate.index]}
                              sx={{ display: 'block', height: '100%', objectFit: 'fill', width: '100%' }}
                            />
                          </Box>
                        ) : (
                          <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 240 }}>
                            <CircularProgress size={24} />
                          </Stack>
                        )}
                        <Typography color="text.secondary" variant="caption">
                          {previewWidth} × {candidate.height} · ratio {previewRatio.toFixed(3)} ·{' '}
                          {aspectRatioChoice === 'auto' ? automaticSizingLabel(candidate) : 'reviewer override'}
                        </Typography>
                      </Stack>
                    </Paper>
                  );
                })}
              </Box>

              <FormControl>
                <FormLabel>Output aspect ratio</FormLabel>
                <RadioGroup
                  row
                  value={aspectRatioChoice}
                  onChange={(event) => setAspectRatioChoice(event.target.value as AspectRatioChoice)}
                >
                  <FormControlLabel control={<Radio />} label="Automatic" value="auto" />
                  <FormControlLabel control={<Radio />} label="Square (1:1)" value="square" />
                  <FormControlLabel control={<Radio />} label="4:5" value="4:5" />
                  <FormControlLabel control={<Radio />} label="3:4" value="3:4" />
                  <FormControlLabel control={<Radio />} label="2:3" value="2:3" />
                  <FormControlLabel control={<Radio />} label="Custom" value="custom" />
                </RadioGroup>
                {aspectRatioChoice === 'custom' ? (
                  <Box
                    aria-label="Custom width to height ratio"
                    component="input"
                    max="5"
                    min="0.2"
                    step="0.01"
                    type="number"
                    value={customAspectRatio}
                    sx={{ maxWidth: 180, px: 1.5, py: 1 }}
                    onChange={(event) => setCustomAspectRatio(event.currentTarget.value)}
                  />
                ) : null}
              </FormControl>

              <FormControl>
                <FormLabel>Rectangle orientation</FormLabel>
                <RadioGroup
                  row
                  value={aspectRatioOrientation}
                  onChange={(event) => setAspectRatioOrientation(event.target.value as AspectRatioOrientation)}
                >
                  <FormControlLabel control={<Radio />} label="Vertical" value="vertical" />
                  <FormControlLabel control={<Radio />} label="Horizontal" value="horizontal" />
                </RadioGroup>
              </FormControl>

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
          {workflow && mode === 'manual' ? (
            <>
              <Typography variant="h6">Select cover corners manually</Typography>
              {isLoadingManualSource ? (
                <Stack alignItems="center" direction="row" spacing={1.5}>
                  <CircularProgress size={20} />
                  <Typography>Loading the source image…</Typography>
                </Stack>
              ) : null}
              {manualSourceUrl ? (
                <ManualCoverPointSelector
                  disabled={isCreatingManualCandidate}
                  imageTitle={request?.title ?? 'board game'}
                  imageUrl={manualSourceUrl}
                  points={manualPoints}
                  onChange={setManualPoints}
                />
              ) : null}
            </>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={isAccepting || isCreatingManualCandidate} onClick={handleClose}>Cancel</Button>
        {workflow && mode === 'manual' ? (
          <>
            <Button disabled={isCreatingManualCandidate} onClick={handleCancelManualSelection}>
              Cancel manual selection
            </Button>
            <Button
              disabled={manualPoints.length !== 4 || isCreatingManualCandidate}
              startIcon={isCreatingManualCandidate ? <CircularProgress size={18} /> : undefined}
              variant="contained"
              onClick={handleGenerateManualCandidate}
            >
              {isCreatingManualCandidate ? 'Generating…' : 'Generate manual candidate'}
            </Button>
          </>
        ) : (
          <>
            <Button disabled={!workflow || isAccepting} variant="outlined" onClick={handleStartManualSelection}>
              Select points manually
            </Button>
            <Button
              disabled={
                !workflow ||
                selectedCandidate === null ||
                !candidateUrls[selectedCandidate] ||
                !targetField ||
                selectedAspectRatio(
                  aspectRatioChoice,
                  customAspectRatio,
                  aspectRatioOrientation,
                  workflow?.candidates.find((candidate) => candidate.index === selectedCandidate)?.aspect_ratio ?? 1
                ) === undefined ||
                isAccepting
              }
              startIcon={isAccepting ? <CircularProgress size={18} /> : undefined}
              variant="contained"
              onClick={handleAccept}
            >
              {isAccepting ? 'Saving…' : 'Accept candidate'}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

type AspectRatioChoice = 'auto' | 'square' | '4:5' | '3:4' | '2:3' | 'custom';
type AspectRatioOrientation = 'vertical' | 'horizontal';
type CoverFlatteningMode = 'candidates' | 'manual';

function selectedAspectRatio(
  choice: AspectRatioChoice,
  customValue: string,
  orientation: AspectRatioOrientation,
  automaticRatio: number
): number | undefined {
  const presets: Record<Exclude<AspectRatioChoice, 'auto' | 'custom'>, number> = {
    '2:3': 2 / 3,
    '3:4': 3 / 4,
    '4:5': 4 / 5,
    square: 1
  };
  const ratio = choice === 'auto'
    ? automaticRatio
    : choice === 'custom'
      ? Number(customValue)
      : presets[choice];
  if (!Number.isFinite(ratio) || ratio < 0.2 || ratio > 5) {
    return undefined;
  }
  if (Math.abs(ratio - 1) < 0.0005) {
    return 1;
  }
  return orientation === 'vertical' ? Math.min(ratio, 1 / ratio) : Math.max(ratio, 1 / ratio);
}

function orientationForRatio(ratio: number): AspectRatioOrientation {
  return ratio > 1 ? 'horizontal' : 'vertical';
}

function automaticSizingLabel(candidate: CoverFlatteningWorkflow['candidates'][number]): string {
  if (candidate.aspect_ratio_method === 'vanishing_points') {
    return `vanishing points ${(candidate.vanishing_confidence * 100).toFixed(0)}%`;
  }
  if (candidate.aspect_ratio_method === 'near_square') {
    return 'near-square correction';
  }
  return 'edge estimate';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
