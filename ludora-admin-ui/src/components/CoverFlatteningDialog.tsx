import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import AddIcon from '@mui/icons-material/Add';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import RemoveIcon from '@mui/icons-material/Remove';
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
  IconButton,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Typography,
  useMediaQuery,
  useTheme
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import {
  adminApi,
  type AcceptedCoverFlattening,
  type CoverFlatteningCandidate,
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
    }
  | {
      id: string;
      itemId: string;
      kind: 'review';
      sources: Array<{ field: CoverFlatteningSourceField; url: string }>;
      title: string;
    };

type CoverFlatteningSourceField = CoverImageField | 'store_item_image';

export function CoverFlatteningDialog({
  onAccepted,
  onClose,
  request
}: {
  onAccepted: (result: AcceptedCoverFlattening) => void;
  onClose: () => void;
  request: CoverFlatteningRequest | null;
}) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [workflow, setWorkflow] = useState<CoverFlatteningWorkflow | null>(null);
  const [mode, setMode] = useState<CoverFlatteningMode>('candidates');
  const [candidateUrls, setCandidateUrls] = useState<Record<number, string>>({});
  const [selectedCandidate, setSelectedCandidate] = useState<number | null>(null);
  const [manualPoints, setManualPoints] = useState<CoverPoint[]>([]);
  const [manualSourceUrl, setManualSourceUrl] = useState('');
  const [aspectRatioChoice, setAspectRatioChoice] = useState<AspectRatioChoice>('auto');
  const [customAspectRatio, setCustomAspectRatio] = useState('1');
  const [aspectRatioOrientation, setAspectRatioOrientation] = useState<AspectRatioOrientation>('vertical');
  const [trimSteps, setTrimSteps] = useState(0);
  const [sourceField, setSourceField] = useState<CoverFlatteningSourceField>('image_url');
  const [targetField, setTargetField] = useState<CoverImageField | ''>('');
  const [startingMode, setStartingMode] = useState<CoverGeneration | null>(null);
  const [isAccepting, setIsAccepting] = useState(false);
  const [isGeneratingAiCandidate, setIsGeneratingAiCandidate] = useState(false);
  const [isCreatingManualCandidate, setIsCreatingManualCandidate] = useState(false);
  const [isLoadingManualSource, setIsLoadingManualSource] = useState(false);
  const [error, setError] = useState('');
  const requestKeyRef = useRef('');
  const requestVersionRef = useRef(0);
  const activeWorkflowIdRef = useRef<string | null>(null);

  const requestKey = request
    ? `${request.kind}:${request.id}:${request.kind === 'review' ? request.itemId : ''}`
    : '';
  const selectableSources = request?.kind === 'item' || request?.kind === 'review' ? request.sources : [];
  const needsSourceChoice = selectableSources.length > 1 && !workflow;
  const isStarting = startingMode !== null;
  const hasAiCandidate = workflow?.candidates.some(isAiCandidate);
  const trimFraction = trimSteps / 1000;

  useEffect(() => {
    if (requestKeyRef.current === requestKey) {
      return;
    }
    requestKeyRef.current = requestKey;
    cancelActiveWorkflow();
    setWorkflow(null);
    setStartingMode(null);
    setIsGeneratingAiCandidate(false);
    if (!request) {
      return;
    }
    setMode('candidates');
    setCandidateUrls({});
    setSelectedCandidate(null);
    setManualPoints([]);
    setManualSourceUrl('');
    setAspectRatioChoice('auto');
    setCustomAspectRatio('1');
    setAspectRatioOrientation('vertical');
    setTrimSteps(0);
    setTargetField('');
    setError('');
    const preferredSource = request.kind === 'review'
      ? request.sources[0]?.field ?? 'store_item_image'
      : request.kind === 'item' && request.sources.some((source) => source.field === 'image_url')
        ? 'image_url'
        : request.kind === 'item'
          ? request.sources[0]?.field ?? 'image_url'
          : 'image_url';
    setSourceField(preferredSource);

    if (request.kind === 'store_item' || selectableSources.length === 1) {
      void startWorkflow(
        request,
        request.kind === 'store_item' ? 'store_item_image' : selectableSources[0]?.field ?? 'image_url'
      );
    }
  }, [request, requestKey]);

  useEffect(() => () => {
    requestKeyRef.current = '';
    cancelActiveWorkflow();
  }, []);

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

  async function startWorkflow(
    activeRequest: CoverFlatteningRequest,
    selectedSource: CoverFlatteningSourceField,
    initialGeneration: CoverGeneration = 'automatic'
  ) {
    const version = requestVersionRef.current;
    const skipAutomatic = initialGeneration === 'ai';
    setStartingMode(initialGeneration);
    setError('');
    let started: CoverFlatteningWorkflow;
    try {
      started = activeRequest.kind === 'store_item' || selectedSource === 'store_item_image'
        ? await adminApi.startStoreItemCoverFlattening(activeRequest.id, skipAutomatic)
        : await adminApi.startItemCoverFlattening(
            activeRequest.kind === 'review' ? activeRequest.itemId : activeRequest.id,
            selectedSource,
            skipAutomatic
          );
      if (requestVersionRef.current !== version) {
        await adminApi.cancelCoverFlattening(started.workflow_id).catch(() => undefined);
        return;
      }
      activeWorkflowIdRef.current = started.workflow_id;
      setWorkflow(started);
      const onlyCandidate = started.candidates.length === 1 ? started.candidates[0] : undefined;
      setSelectedCandidate(onlyCandidate?.index ?? null);
      if (onlyCandidate) {
        setAspectRatioOrientation(orientationForRatio(onlyCandidate.aspect_ratio));
      }
    } catch (startError) {
      if (requestVersionRef.current === version) {
        setError(errorMessage(startError, 'Cover flattening could not be started.'));
      }
      return;
    } finally {
      if (requestVersionRef.current === version) {
        setStartingMode(null);
      }
    }
    if (skipAutomatic) {
      await generateAiCandidate(started.workflow_id);
    }
  }

  async function generateAiCandidate(workflowId: string) {
    const version = requestVersionRef.current;
    setIsGeneratingAiCandidate(true);
    setError('');
    try {
      const updatedWorkflow = await adminApi.createAiCoverFlatteningCandidate(workflowId);
      if (requestVersionRef.current !== version) {
        return;
      }
      selectGeneratedCandidate(updatedWorkflow, updatedWorkflow.candidates.find(isAiCandidate), 'AI');
    } catch (aiError) {
      if (requestVersionRef.current === version) {
        setError(errorMessage(aiError, 'AI cover candidate could not be generated.'));
      }
    } finally {
      if (requestVersionRef.current === version) {
        setIsGeneratingAiCandidate(false);
      }
    }
  }

  function selectGeneratedCandidate(
    updatedWorkflow: CoverFlatteningWorkflow,
    candidate: CoverFlatteningCandidate | undefined,
    label: string
  ) {
    if (!candidate) {
      throw new Error(`${label} cover candidate was not returned by the server.`);
    }
    setCandidateUrls({});
    setWorkflow(updatedWorkflow);
    setSelectedCandidate(candidate.index);
    if (aspectRatioChoice === 'auto') {
      setAspectRatioOrientation(orientationForRatio(candidate.aspect_ratio));
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
      const aspectRatioOverride = aspectRatioChoice === 'auto' ? null : aspectRatio;
      const result = await adminApi.acceptCoverFlattening(
        workflow.workflow_id,
        selectedCandidate,
        targetField,
        aspectRatioOverride,
        trimFraction
      );
      activeWorkflowIdRef.current = null;
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
      selectGeneratedCandidate(
        updatedWorkflow,
        updatedWorkflow.candidates.find((candidate) => candidate.index === 3),
        'Manual'
      );
      setManualPoints([]);
      setMode('candidates');
    } catch (manualError) {
      setError(errorMessage(manualError, 'Manual cover candidate could not be generated.'));
    } finally {
      setIsCreatingManualCandidate(false);
    }
  }

  function cancelActiveWorkflow() {
    requestVersionRef.current++;
    if (activeWorkflowIdRef.current) {
      const workflowId = activeWorkflowIdRef.current;
      activeWorkflowIdRef.current = null;
      void adminApi.cancelCoverFlattening(workflowId).catch(() => undefined);
    }
  }

  function handleClose() {
    cancelActiveWorkflow();
    setWorkflow(null);
    setMode('candidates');
    setManualPoints([]);
    requestKeyRef.current = '';
    onClose();
  }

  return (
    <Dialog
      fullScreen={isMobile}
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
              <RadioGroup
                value={sourceField}
                onChange={(event) => setSourceField(event.target.value as CoverFlatteningSourceField)}
              >
                {selectableSources.map((source) => (
                  <FormControlLabel
                    control={<Radio disabled={isStarting} />}
                    key={source.field}
                    label={coverSourceLabel(request, source.field)}
                    value={source.field}
                  />
                ))}
              </RadioGroup>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1 }}>
                <Button
                  disabled={isStarting}
                  startIcon={<AutoFixHighIcon />}
                  variant="contained"
                  onClick={() => request && startWorkflow(request, sourceField)}
                >
                  Generate candidates
                </Button>
                <Button
                  disabled={isStarting}
                  startIcon={<AutoAwesomeIcon />}
                  variant="outlined"
                  onClick={() => request && startWorkflow(request, sourceField, 'ai')}
                >
                  Generate with AI
                </Button>
              </Stack>
            </FormControl>
          ) : null}

          {isStarting ? (
            <Stack alignItems="center" direction="row" role="status" spacing={1.5}>
              <CircularProgress size={20} />
              <Typography>
                {startingMode === 'ai'
                  ? 'Preparing the source image…'
                  : 'Detecting the box perspective and flattening its cover…'}
              </Typography>
            </Stack>
          ) : null}

          {isGeneratingAiCandidate ? (
            <Stack alignItems="center" direction="row" role="status" spacing={1.5}>
              <CircularProgress size={20} />
              <Typography>Detecting the front cover corners with AI…</Typography>
            </Stack>
          ) : null}

          {error ? <Alert severity="error">{error}</Alert> : null}

          {workflow && mode === 'candidates' ? (
            <>
              {workflow.candidates.length === 0 && workflow.automatic_error ? (
                <Alert severity="warning">
                  <Typography variant="body2">
                    Automatic point selection could not find a usable cover. Generate with AI or select the four cover
                    corners manually.
                  </Typography>
                  <Typography color="text.secondary" sx={{ display: 'block', mt: 0.5 }} variant="caption">
                    Detection detail: {workflow.automatic_error}
                  </Typography>
                </Alert>
              ) : workflow.candidates.length > 0 ? (
                <Typography color="text.secondary" variant="body2">
                  {hasAiCandidate
                    ? 'AI cover candidate generated. Select the candidate to save.'
                    : workflow.candidates.some((candidate) => candidate.index === 3)
                    ? 'Manual cover candidate generated. Select the candidate to save.'
                    : workflow.perspective === 'two_faces'
                    ? 'Two-face perspective detected. One cover candidate was generated.'
                    : 'Three-face perspective detected. Select the correct cover candidate.'}
                </Typography>
              ) : null}
              {workflow.candidates.length > 0 ? (
                <>
              <Box
                sx={{
                  display: 'grid',
                  gap: 2,
                  gridTemplateColumns: { md: `repeat(${Math.min(3, workflow.candidates.length)}, minmax(0, 1fr))`, xs: '1fr' }
                }}
              >
                {workflow.candidates.map((candidate) => {
                  const selectedRatio = selectedAspectRatio(
                    aspectRatioChoice,
                    customAspectRatio,
                    aspectRatioOrientation,
                    candidate.aspect_ratio
                  );
                  const ratioOverride = aspectRatioChoice === 'auto' || selectedRatio === undefined
                    ? null
                    : selectedRatio;
                  const trimmedWidth = trimmedDimension(candidate.width, trimFraction);
                  const previewHeight = trimmedDimension(candidate.height, trimFraction);
                  const previewRatio = ratioOverride ?? (trimmedWidth / previewHeight);
                  const previewWidth = ratioOverride === null
                    ? trimmedWidth
                    : Math.max(2, Math.round(previewHeight * ratioOverride));
                  const trimTransform = trimFraction === 0
                    ? 'scale(1)'
                    : `scale(${candidate.width / trimmedWidth}, ${candidate.height / previewHeight})`;
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
                          label={isAiCandidate(candidate) ? 'AI candidate' : `Candidate ${candidate.index}`}
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
                              alt={isAiCandidate(candidate)
                                ? 'AI-flattened cover candidate'
                                : `Flattened cover candidate ${candidate.index}`}
                              component="img"
                              data-testid={`trim-preview-image-${candidate.index}`}
                              src={candidateUrls[candidate.index]}
                              sx={{
                                display: 'block',
                                height: '100%',
                                objectFit: 'fill',
                                transform: trimTransform,
                                transformOrigin: 'center center',
                                transition: 'transform 120ms ease-out',
                                width: '100%'
                              }}
                            />
                          </Box>
                        ) : (
                          <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 240 }}>
                            <CircularProgress size={24} />
                          </Stack>
                        )}
                        <Typography color="text.secondary" variant="caption">
                          {previewWidth} × {previewHeight} · ratio {previewRatio.toFixed(3)} ·{' '}
                          {aspectRatioChoice === 'auto' ? automaticSizingLabel(candidate) : 'reviewer override'}
                        </Typography>
                      </Stack>
                    </Paper>
                  );
                })}
              </Box>

              <FormControl disabled={isGeneratingAiCandidate}>
                <FormLabel>Output aspect ratio</FormLabel>
                <RadioGroup
                  row={!isMobile}
                  value={aspectRatioChoice}
                  onChange={(event) => setAspectRatioChoice(event.target.value as AspectRatioChoice)}
                >
                  <FormControlLabel control={<Radio />} label="Automatic" value="auto" />
                  <FormControlLabel control={<Radio />} label="Square (1:1)" value="square" />
                  <FormControlLabel control={<Radio />} label="4:5" value="4:5" />
                  <FormControlLabel control={<Radio />} label="3:4" value="3:4" />
                  <FormControlLabel control={<Radio />} label="2:3" value="2:3" />
                  <FormControlLabel control={<Radio />} label="1:2 (0.5)" value="1:2" />
                  <FormControlLabel control={<Radio />} label="1:3 (0.33)" value="1:3" />
                  <FormControlLabel control={<Radio />} label="Custom" value="custom" />
                </RadioGroup>
                {aspectRatioChoice === 'custom' ? (
                  <Box
                    aria-label="Custom width to height ratio"
                    component="input"
                    disabled={isGeneratingAiCandidate}
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

              <FormControl disabled={isGeneratingAiCandidate}>
                <FormLabel>Rectangle orientation</FormLabel>
                <RadioGroup
                  row={!isMobile}
                  value={aspectRatioOrientation}
                  onChange={(event) => setAspectRatioOrientation(event.target.value as AspectRatioOrientation)}
                >
                  <FormControlLabel control={<Radio />} label="Vertical" value="vertical" />
                  <FormControlLabel control={<Radio />} label="Horizontal" value="horizontal" />
                </RadioGroup>
              </FormControl>

              <FormControl>
                <FormLabel>Trim all borders</FormLabel>
                <Stack alignItems="center" direction="row" spacing={1}>
                  <IconButton
                    aria-label="Decrease trim by 0.1%"
                    disabled={trimSteps === 0 || isAccepting}
                    onClick={() => setTrimSteps((current) => Math.max(0, current - 1))}
                  >
                    <RemoveIcon />
                  </IconButton>
                  <Typography aria-live="polite" sx={{ minWidth: 56, textAlign: 'center' }}>
                    {(trimSteps / 10).toFixed(1)}%
                  </Typography>
                  <IconButton
                    aria-label="Increase trim by 0.1%"
                    disabled={trimSteps >= MAX_TRIM_STEPS || isAccepting}
                    onClick={() => setTrimSteps((current) => Math.min(MAX_TRIM_STEPS, current + 1))}
                  >
                    <AddIcon />
                  </IconButton>
                </Stack>
              </FormControl>

              <FormControl>
                <FormLabel>Save selected candidate as</FormLabel>
                <RadioGroup
                  row={!isMobile}
                  value={targetField}
                  onChange={(event) => setTargetField(event.target.value as CoverImageField)}
                >
                  <FormControlLabel control={<Radio />} label="Image" value="image_url" />
                  <FormControlLabel control={<Radio />} label="Spanish image" value="image_url_es" />
                </RadioGroup>
              </FormControl>
                </>
              ) : null}
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
      <DialogActions
        sx={{
          alignItems: isMobile ? 'stretch' : 'center',
          flexDirection: isMobile ? 'column' : 'row',
          px: isMobile ? 2 : 1,
          py: isMobile ? 1.5 : 1,
          '& .MuiButton-root': {
            minHeight: isMobile ? 44 : undefined,
            width: isMobile ? '100%' : 'auto'
          },
          '& > :not(style) ~ :not(style)': {
            marginLeft: isMobile ? 0 : 1,
            marginTop: isMobile ? 1 : 0
          }
        }}
      >
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
            {workflow ? (
              <Button
                disabled={isAccepting || isGeneratingAiCandidate}
                startIcon={<AutoAwesomeIcon />}
                variant="outlined"
                onClick={() => generateAiCandidate(workflow.workflow_id)}
              >
                Generate with AI
              </Button>
            ) : null}
            <Button
              disabled={!workflow || isAccepting || isGeneratingAiCandidate}
              variant="outlined"
              onClick={handleStartManualSelection}
            >
              Select points manually
            </Button>
            {workflow && workflow.candidates.length > 0 ? (
              <Button
                disabled={
                  selectedCandidate === null ||
                  !candidateUrls[selectedCandidate] ||
                  !targetField ||
                  selectedAspectRatio(
                    aspectRatioChoice,
                    customAspectRatio,
                    aspectRatioOrientation,
                    workflow.candidates.find((candidate) => candidate.index === selectedCandidate)?.aspect_ratio ?? 1
                  ) === undefined ||
                  isAccepting ||
                  isGeneratingAiCandidate
                }
                startIcon={isAccepting ? <CircularProgress size={18} /> : undefined}
                variant="contained"
                onClick={handleAccept}
              >
                {isAccepting ? 'Saving…' : 'Accept candidate'}
              </Button>
            ) : null}
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

type AspectRatioChoice = 'auto' | 'square' | '4:5' | '3:4' | '2:3' | '1:2' | '1:3' | 'custom';
type AspectRatioOrientation = 'vertical' | 'horizontal';
type CoverFlatteningMode = 'candidates' | 'manual';
type CoverGeneration = 'automatic' | 'ai';
const FIRST_AI_CANDIDATE_INDEX = 4;
const MAX_TRIM_STEPS = 100;

function isAiCandidate(candidate: CoverFlatteningCandidate): boolean {
  return candidate.index >= FIRST_AI_CANDIDATE_INDEX;
}

function selectedAspectRatio(
  choice: AspectRatioChoice,
  customValue: string,
  orientation: AspectRatioOrientation,
  automaticRatio: number
): number | undefined {
  const presets: Record<Exclude<AspectRatioChoice, 'auto' | 'custom'>, number> = {
    '1:2': 1 / 2,
    '1:3': 1 / 3,
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

function trimmedDimension(dimension: number, trimFraction: number): number {
  if (trimFraction === 0) {
    return dimension;
  }
  const trim = Math.min(
    Math.max(1, Math.round(dimension * trimFraction)),
    Math.max(0, Math.floor((dimension - 2) / 2))
  );
  return dimension - (2 * trim);
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

function coverSourceLabel(request: CoverFlatteningRequest | null, sourceField: CoverFlatteningSourceField): string {
  if (request?.kind === 'review') {
    if (sourceField === 'store_item_image') {
      return 'Store item cover';
    }
    return sourceField === 'image_url' ? 'Item image' : 'Item Spanish image';
  }
  return sourceField === 'image_url' ? 'Image' : 'Spanish image';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
