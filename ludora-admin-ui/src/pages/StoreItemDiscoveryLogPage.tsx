import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  Paper,
  Stack,
  Typography
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, type AdminRecord } from '../api/client';

const POLL_INTERVAL_MS = 2_000;
const TERMINAL_STATUSES = new Set(['cancelled', 'completed', 'failed']);

type LoadState = 'loading' | 'ready' | 'error';

export function StoreItemDiscoveryLogPage({ jobId, onBack }: { jobId: string; onBack: () => void }) {
  const [state, setState] = useState<LoadState>('loading');
  const [job, setJob] = useState<AdminRecord | null>(null);
  const [content, setContent] = useState('');
  const [isAvailable, setIsAvailable] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [isFollowing, setIsFollowing] = useState(true);
  const [error, setError] = useState('');
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef(0);
  const requestInFlightRef = useRef(false);

  const loadLog = useCallback(async () => {
    if (requestInFlightRef.current) {
      return;
    }
    requestInFlightRef.current = true;
    try {
      const result = await adminApi.getStoreItemDiscoveryJobLog(jobId, offsetRef.current);
      setJob(result.job);
      setIsAvailable(result.available);
      setHasMore(result.has_more);
      setContent((current) => (result.reset ? result.content : `${current}${result.content}`));
      offsetRef.current = result.next_offset;
      setError('');
      setState('ready');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Store item discovery log could not be loaded.');
      setState('error');
    } finally {
      requestInFlightRef.current = false;
    }
  }, [jobId]);

  useEffect(() => {
    setState('loading');
    setJob(null);
    setContent('');
    offsetRef.current = 0;
    void loadLog();
  }, [jobId, loadLog]);

  const status = recordText(job, 'status').toLowerCase();
  const shouldPoll = state !== 'error' && (!TERMINAL_STATUSES.has(status) || status === '' || hasMore);

  useEffect(() => {
    if (!shouldPoll) {
      return;
    }
    const timer = window.setInterval(() => void loadLog(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadLog, shouldPoll]);

  const formattedContent = useMemo(() => formatJsonlLog(content), [content]);

  useEffect(() => {
    if (isFollowing && consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [formattedContent, isFollowing]);

  return (
    <Stack spacing={2.5}>
      <Stack alignItems={{ sm: 'center' }} direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={2}>
        <Stack spacing={0.5}>
          <Typography component="h1" variant="h4">
            Store Item Discovery Log
          </Typography>
          <Typography color="text.secondary" variant="body2">
            Job #{jobId}{job ? ` · Run ${recordText(job, 'run_id', 'unknown')}` : ''}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button startIcon={<ArrowBackIcon />} variant="outlined" onClick={onBack}>
            Back to discovery jobs
          </Button>
          <Button startIcon={<RefreshIcon />} variant="contained" onClick={() => void loadLog()}>
            Refresh log
          </Button>
        </Stack>
      </Stack>

      {state === 'loading' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={20} />
          <Typography variant="body2">Loading discovery log</Typography>
        </Stack>
      ) : null}
      {state === 'error' ? <Alert severity="error">{error}</Alert> : null}

      {job ? (
        <Paper variant="outlined">
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={{ xs: 1, md: 3 }} sx={{ p: 2 }}>
            <LogDetail label="Status" value={<Chip label={recordText(job, 'status', 'unknown')} size="small" />} />
            <LogDetail label="Store ID" value={recordText(job, 'store_id', '-')} />
            <LogDetail label="Started" value={recordText(job, 'started_at', '-')} />
            <LogDetail label="Completed" value={recordText(job, 'completed_at', '-')} />
          </Stack>
        </Paper>
      ) : null}

      <Paper variant="outlined">
        <Stack
          alignItems="center"
          direction="row"
          justifyContent="space-between"
          sx={{ bgcolor: '#161b22', borderBottom: '1px solid #30363d', color: '#c9d1d9', px: 2, py: 1 }}
        >
          <Typography sx={{ fontFamily: 'monospace' }} variant="body2">
            Console output
          </Typography>
          <FormControlLabel
            control={
              <Checkbox
                checked={isFollowing}
                size="small"
                sx={{ color: '#8b949e', '&.Mui-checked': { color: '#58a6ff' } }}
                onChange={(event) => setIsFollowing(event.target.checked)}
              />
            }
            label="Follow log"
            sx={{ m: 0, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
          />
        </Stack>
        <Box
          ref={consoleRef}
          aria-label={`Console output for discovery job ${jobId}`}
          role="log"
          sx={{
            bgcolor: '#0d1117',
            color: '#c9d1d9',
            fontFamily: 'Consolas, Monaco, monospace',
            fontSize: 13,
            lineHeight: 1.6,
            maxHeight: '65vh',
            minHeight: 360,
            overflow: 'auto',
            p: 2,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {formattedContent || (state === 'ready' && !isAvailable ? 'Log output is not available for this job yet.' : 'Waiting for log output...')}
        </Box>
      </Paper>
      <Typography color="text.secondary" variant="caption">
        {TERMINAL_STATUSES.has(status) ? `Job ${status}.` : 'Auto-refreshing every 2 seconds.'}
      </Typography>
    </Stack>
  );
}

function LogDetail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Stack spacing={0.25} sx={{ minWidth: 150 }}>
      <Typography color="text.secondary" variant="caption">
        {label}
      </Typography>
      <Box>{value}</Box>
    </Stack>
  );
}

function recordText(record: AdminRecord | null, key: string, fallback = ''): string {
  const value = record?.[key];
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function formatJsonlLog(content: string): string {
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const timestamp = String(record.ts ?? '');
        const event = String(record.event ?? 'log');
        const elapsed = typeof record.elapsed_ms === 'number' ? ` +${record.elapsed_ms}ms` : '';
        const details = Object.fromEntries(
          Object.entries(record).filter(([key]) => !['elapsed_ms', 'event', 'run_id', 'ts'].includes(key))
        );
        const detailText = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
        return `${timestamp}${elapsed}  ${event}${detailText}`.trim();
      } catch {
        return line;
      }
    })
    .join('\n');
}
