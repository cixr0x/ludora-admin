import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography
} from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi, type AdminRecord, type StoreItemUpdateMonitor } from '../api/client';

const REFRESH_INTERVAL_MS = 15_000;
const RANGE_OPTIONS = [24, 48, 72, 168];

export function StoreItemUpdateMonitorPage() {
  const [hours, setHours] = useState(48);
  const [histogramStoreId, setHistogramStoreId] = useState<number | ''>('');
  const [monitor, setMonitor] = useState<StoreItemUpdateMonitor | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [failureGroup, setFailureGroup] = useState<AdminRecord | null>(null);
  const [failureAttempts, setFailureAttempts] = useState<AdminRecord[]>([]);
  const [failureDetailsError, setFailureDetailsError] = useState('');
  const [failureDetailsLoading, setFailureDetailsLoading] = useState(false);
  const [controlLoading, setControlLoading] = useState(false);

  const loadMonitor = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setLoading(true);
    }
    try {
      setMonitor(await adminApi.getStoreItemUpdateMonitor(hours, histogramStoreId || undefined));
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [histogramStoreId, hours]);

  const updateWorkerControl = useCallback(async (action: 'pause' | 'resume') => {
    setControlLoading(true);
    try {
      if (action === 'pause') {
        await adminApi.pauseContinuousStoreItemUpdates();
      } else {
        await adminApi.resumeContinuousStoreItemUpdates();
      }
      await loadMonitor();
    } catch (controlError) {
      setError(controlError instanceof Error ? controlError.message : String(controlError));
    } finally {
      setControlLoading(false);
    }
  }, [loadMonitor]);

  useEffect(() => {
    void loadMonitor(true);
    const timer = window.setInterval(() => void loadMonitor(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadMonitor]);

  useEffect(() => {
    if (!failureGroup) {
      return;
    }

    let active = true;
    setFailureAttempts([]);
    setFailureDetailsError('');
    setFailureDetailsLoading(true);
    void adminApi.getStoreItemUpdateFailureAttempts(
      recordText(failureGroup, 'store_id'),
      24
    ).then((attempts) => {
      if (active) {
        setFailureAttempts(attempts);
      }
    }).catch((loadError) => {
      if (active) {
        setFailureDetailsError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }).finally(() => {
      if (active) {
        setFailureDetailsLoading(false);
      }
    });

    return () => {
      active = false;
    };
  }, [failureGroup]);

  if (loading && !monitor) {
    return (
      <Box sx={{ display: 'grid', minHeight: 320, placeItems: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }

  const summary = monitor?.summary;
  const worker = monitor?.worker;
  const workerHealth = worker ? recordText(worker, 'health') : 'not started';
  const controlStatus = monitor?.control_status ?? 'unavailable';
  const activePlatformCooldowns = (monitor?.platform_cooldowns ?? []).filter(
    (cooldown) => cooldown.active && cooldown.blocked_until
  );
  const histogramStores = [...(monitor?.store_statistics ?? [])].sort((left, right) =>
    recordText(left, 'store_name').localeCompare(recordText(right, 'store_name'))
  );
  const selectedHistogramStore = histogramStores.find(
    (store) => numberRecordField(store, 'store_id') === histogramStoreId
  );
  const metrics = summary
    ? [
        { label: 'Eligible items', value: formatInteger(summary.eligible_items), note: 'Active stores and listed confirmed items' },
        { label: 'Due now', value: formatInteger(summary.due_items), note: `${formatInteger(summary.leased_items)} currently leased` },
        { label: 'Fresh under 24h', value: `${summary.fresh_percent.toFixed(1)}%`, note: `${formatInteger(summary.stale_items)} stale items` },
        { label: 'Oldest staleness', value: formatHours(summary.oldest_staleness_hours), note: `Oldest overdue: ${formatHours(summary.oldest_due_hours)}` },
        { label: 'Successful / 24h', value: formatInteger(summary.successes_24h), note: `${summary.success_rate_percent.toFixed(1)}% success rate` },
        { label: 'Failed / 24h', value: formatInteger(summary.failures_24h), note: `${formatInteger(summary.rate_limited_24h)} HTTP 429 responses` },
        { label: 'Projected demand', value: formatInteger(summary.projected_daily_demand), note: 'Attempts/day at a 22h mean interval' },
        { label: 'Cadence capacity', value: formatInteger(summary.daily_capacity), note: `${summary.projected_utilization_percent.toFixed(1)}% projected utilization` }
      ]
    : [];

  return (
    <Stack spacing={3}>
      <Stack alignItems={{ sm: 'center' }} direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={2}>
        <Box>
          <Typography variant="h4">Store Item Update Monitor</Typography>
          <Typography color="text.secondary" sx={{ mt: 0.5 }}>
            Continuous single-item refresh health, scheduling, failures, and staleness.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          {controlStatus === 'paused' ? (
            <Button
              disabled={controlLoading}
              onClick={() => void updateWorkerControl('resume')}
              variant="contained"
            >
              Resume automatic updates
            </Button>
          ) : controlStatus === 'stopping' ? (
            <Button disabled variant="contained">Stopping automatic updates</Button>
          ) : controlStatus === 'running' ? (
            <Button
              color="warning"
              disabled={controlLoading}
              onClick={() => void updateWorkerControl('pause')}
              variant="contained"
            >
              Pause automatic updates
            </Button>
          ) : null}
          <FormControl size="small" sx={{ minWidth: 130 }}>
            <InputLabel id="staleness-range-label">Histogram</InputLabel>
            <Select
              label="Histogram"
              labelId="staleness-range-label"
              onChange={(event) => setHours(Number(event.target.value))}
              value={hours}
            >
              {RANGE_OPTIONS.map((range) => (
                <MenuItem key={range} value={range}>{range === 168 ? '7 days' : `${range} hours`}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button disabled={loading} onClick={() => void loadMonitor(true)} startIcon={<RefreshIcon />} variant="outlined">
            Refresh
          </Button>
        </Stack>
      </Stack>

      {error ? <Alert severity="error">{error}</Alert> : null}
      <Alert severity={workerHealth === 'healthy' ? 'success' : workerHealth === 'stale' ? 'error' : 'warning'}>
        <Stack alignItems={{ sm: 'center' }} direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Typography variant="body2">
            Worker: {workerHealth}. {worker ? `Last heartbeat ${formatDate(worker.heartbeat_at)}.` : 'No heartbeat has been recorded.'}
          </Typography>
          {!monitor ? (
            <Chip color="default" label="Platform cooldown state unavailable" size="small" variant="outlined" />
          ) : activePlatformCooldowns.length ? (
            activePlatformCooldowns.map((cooldown) => (
              <Chip
                color="warning"
                key={cooldown.platform}
                label={`${formatPlatform(cooldown.platform)} paused until ${formatDate(cooldown.blocked_until)}`}
                size="small"
              />
            ))
          ) : (
            <Chip color="success" label="Platform claims enabled" size="small" variant="outlined" />
          )}
        </Stack>
      </Alert>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        {metrics.map((metric) => (
          <Paper key={metric.label} sx={{ p: 2 }} variant="outlined">
            <Typography color="text.secondary" variant="body2">{metric.label}</Typography>
            <Typography sx={{ my: 0.5 }} variant="h5">{metric.value}</Typography>
            <Typography color="text.secondary" variant="caption">{metric.note}</Typography>
          </Paper>
        ))}
      </Box>

      <Paper sx={{ p: { xs: 2, sm: 3 } }} variant="outlined">
        <Stack alignItems={{ sm: 'center' }} direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1}>
          <Box>
            <Typography variant="h6">Product staleness by hour</Typography>
            <Typography color="text.secondary" variant="body2">
              Time since each eligible store item was last successfully refreshed. Items at 24 hours or more are highlighted.{' '}
              {selectedHistogramStore
                ? `Showing ${recordText(selectedHistogramStore, 'store_name')}.`
                : 'Showing all active stores.'}
            </Typography>
          </Box>
          <Stack alignItems={{ sm: 'flex-end' }} spacing={0.75}>
            <FormControl size="small" sx={{ minWidth: 220 }}>
              <InputLabel id="histogram-store-label" shrink>Histogram store</InputLabel>
              <Select
                displayEmpty
                label="Histogram store"
                labelId="histogram-store-label"
                onChange={(event) => setHistogramStoreId(event.target.value ? Number(event.target.value) : '')}
                value={histogramStoreId}
              >
                <MenuItem value="">All stores</MenuItem>
                {histogramStores.map((store) => {
                  const storeId = numberRecordField(store, 'store_id');
                  return <MenuItem key={storeId} value={storeId}>{recordText(store, 'store_name')}</MenuItem>;
                })}
              </Select>
            </FormControl>
            <Typography color="text.secondary" variant="caption">
              Updated {monitor ? formatDate(monitor.generated_at) : '-'}
            </Typography>
          </Stack>
        </Stack>
        <StalenessHistogram buckets={monitor?.histogram ?? []} />
      </Paper>

      <Stack spacing={3}>
        <Paper sx={{ overflow: 'hidden' }} variant="outlined">
          <Box sx={{ p: 2 }}>
            <Typography variant="h6">Store update statistics · last 24h</Typography>
            <Typography color="text.secondary" variant="body2">
              All {monitor?.store_statistics.length ?? 0} active stores, including stores with no attempts or no failures during the period.
            </Typography>
          </Box>
          <TableContainer sx={{ maxHeight: 520 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Store</TableCell>
                  <TableCell>Platform</TableCell>
                  <TableCell align="right">Products</TableCell>
                  <TableCell align="right">Attempts</TableCell>
                  <TableCell align="right">Successes</TableCell>
                  <TableCell align="right">Failures</TableCell>
                  <TableCell>Success rate</TableCell>
                  <TableCell align="right">429</TableCell>
                  <TableCell>Latest attempt</TableCell>
                  <TableCell align="right">Details</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(monitor?.store_statistics ?? []).map((row) => (
                  <TableRow key={recordText(row, 'store_id')}>
                    <TableCell>{recordText(row, 'store_name')}</TableCell>
                    <TableCell>{recordText(row, 'platform')}</TableCell>
                    <TableCell align="right">{recordText(row, 'eligible_items', '0')}</TableCell>
                    <TableCell align="right">{recordText(row, 'attempts', '0')}</TableCell>
                    <TableCell align="right">{recordText(row, 'successes', '0')}</TableCell>
                    <TableCell align="right">{recordText(row, 'failures', '0')}</TableCell>
                    <TableCell><StoreSuccessRate row={row} /></TableCell>
                    <TableCell align="right">{recordText(row, 'rate_limited', '0')}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(row.last_attempt_at)}</TableCell>
                    <TableCell align="right">
                      {numberRecordField(row, 'failures') > 0 ? (
                        <Button
                          aria-label={`View failed attempts for ${recordText(row, 'store_name')} (${recordText(row, 'platform')})`}
                          onClick={() => setFailureGroup(row)}
                          size="small"
                        >
                          View
                        </Button>
                      ) : <Typography color="text.secondary">—</Typography>}
                    </TableCell>
                  </TableRow>
                ))}
                {!monitor?.store_statistics.length ? <EmptyRow columns={10} label="No active stores" /> : null}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>

        <Paper sx={{ overflow: 'hidden' }} variant="outlined">
          <Box sx={{ p: 2 }}>
            <Typography variant="h6">Recent attempts</Typography>
          </Box>
          <TableContainer sx={{ maxHeight: 440 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow><TableCell>Started</TableCell><TableCell>Item</TableCell><TableCell>Store</TableCell><TableCell>Status</TableCell><TableCell align="right">ms</TableCell></TableRow>
              </TableHead>
              <TableBody>
                {(monitor?.recent_attempts ?? []).map((row) => <AttemptRow key={recordText(row, 'id')} row={row} />)}
                {!monitor?.recent_attempts.length ? <EmptyRow columns={5} label="No continuous update attempts yet" /> : null}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      </Stack>

      <Dialog
        fullWidth
        maxWidth="lg"
        onClose={() => setFailureGroup(null)}
        open={Boolean(failureGroup)}
      >
        <DialogTitle>
          Failed attempts · {failureGroup ? recordText(failureGroup, 'store_name') : ''}
        </DialogTitle>
        <DialogContent dividers>
          <Typography color="text.secondary" sx={{ mb: 2 }} variant="body2">
            {failureGroup ? recordText(failureGroup, 'platform') : ''} · latest failures in the last 24 hours, up to 100 attempts.
          </Typography>
          {failureDetailsLoading ? (
            <Box sx={{ display: 'grid', minHeight: 180, placeItems: 'center' }}><CircularProgress /></Box>
          ) : failureDetailsError ? (
            <Alert severity="error">{failureDetailsError}</Alert>
          ) : (
            <TableContainer sx={{ maxHeight: 520 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Started</TableCell>
                    <TableCell>Item</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">HTTP</TableCell>
                    <TableCell align="right">ms</TableCell>
                    <TableCell>Error</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {failureAttempts.map((attempt) => <FailureAttemptRow key={recordText(attempt, 'id')} row={attempt} />)}
                  {!failureAttempts.length ? <EmptyRow columns={6} label="No failed attempts found in the last 24 hours" /> : null}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </DialogContent>
        <DialogActions><Button onClick={() => setFailureGroup(null)}>Close</Button></DialogActions>
      </Dialog>
    </Stack>
  );
}

function StalenessHistogram({ buckets }: { buckets: StoreItemUpdateMonitor['histogram'] }) {
  const maxCount = useMemo(() => Math.max(1, ...buckets.map((bucket) => bucket.item_count)), [buckets]);
  return (
    <Box sx={{ mt: 3, overflowX: 'auto', pb: 1 }}>
      <Box
        aria-label="Store item staleness histogram"
        role="img"
        sx={{ alignItems: 'end', display: 'flex', gap: 0.5, height: 230, minWidth: Math.max(720, buckets.length * 24), px: 1 }}
      >
        {buckets.map((bucket) => {
          const height = bucket.item_count > 0 ? Math.max(4, (bucket.item_count / maxCount) * 180) : 2;
          const stale = bucket.staleness_hour >= 24;
          return (
            <Box key={`${bucket.staleness_hour}-${bucket.overflow}`} sx={{ alignItems: 'center', display: 'flex', flex: '1 0 18px', flexDirection: 'column', height: '100%', justifyContent: 'flex-end' }}>
              <Typography color="text.secondary" sx={{ fontSize: 10, mb: 0.5 }}>{bucket.item_count || ''}</Typography>
              <Box
                aria-label={`${bucket.label}: ${bucket.item_count} items`}
                title={`${bucket.label}: ${bucket.item_count.toLocaleString()} items`}
                sx={{ bgcolor: bucket.overflow ? 'error.main' : stale ? 'warning.main' : 'primary.main', borderRadius: '3px 3px 0 0', height, width: '100%' }}
              />
              <Typography color="text.secondary" sx={{ fontSize: 9, mt: 0.75, transform: 'rotate(-45deg)', transformOrigin: 'top center', whiteSpace: 'nowrap' }}>
                {bucket.staleness_hour % 4 === 0 || bucket.overflow ? bucket.label : ''}
              </Typography>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function AttemptRow({ row }: { row: AdminRecord }) {
  const status = recordText(row, 'status');
  const color = status === 'succeeded' || status === 'deactivated' ? 'success' : status === 'running' ? 'info' : 'error';
  const itemId = recordText(row, 'store_item_id');
  return (
    <TableRow hover title={optionalRecordText(row, 'error')}>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(row.started_at)}</TableCell>
      <TableCell>
        <Link href={`#listings?id=${encodeURIComponent(itemId)}`}>{recordText(row, 'store_item_title', `#${itemId}`)}</Link>
      </TableCell>
      <TableCell>{recordText(row, 'store_name')}</TableCell>
      <TableCell><Chip color={color} label={status} size="small" variant="outlined" /></TableCell>
      <TableCell align="right">{recordText(row, 'duration_ms')}</TableCell>
    </TableRow>
  );
}

function StoreSuccessRate({ row }: { row: AdminRecord }) {
  const completed = numberRecordField(row, 'successes') + numberRecordField(row, 'failures');
  if (completed === 0) {
    return <Chip label="No data" size="small" variant="outlined" />;
  }
  const rate = numberRecordField(row, 'success_rate_percent');
  const color = rate >= 95 ? 'success' : rate >= 80 ? 'warning' : 'error';
  return <Chip color={color} label={`${rate.toFixed(1)}%`} size="small" variant="outlined" />;
}

function FailureAttemptRow({ row }: { row: AdminRecord }) {
  const itemId = recordText(row, 'store_item_id');
  const sourceUrl = optionalRecordText(row, 'source_url');
  return (
    <TableRow hover>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(row.started_at)}</TableCell>
      <TableCell>
        <Stack spacing={0.25}>
          <Link href={`#listings?id=${encodeURIComponent(itemId)}`}>{recordText(row, 'store_item_title', `#${itemId}`)}</Link>
          {sourceUrl ? <Link href={sourceUrl} rel="noreferrer" target="_blank" variant="caption">Source page</Link> : null}
        </Stack>
      </TableCell>
      <TableCell><Chip color="error" label={recordText(row, 'status')} size="small" variant="outlined" /></TableCell>
      <TableCell align="right">{recordText(row, 'http_status')}</TableCell>
      <TableCell align="right">{recordText(row, 'duration_ms')}</TableCell>
      <TableCell sx={{ minWidth: 280, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        <Typography color="error" variant="body2">{recordText(row, 'error')}</Typography>
      </TableCell>
    </TableRow>
  );
}

function EmptyRow({ columns, label }: { columns: number; label: string }) {
  return <TableRow><TableCell align="center" colSpan={columns} sx={{ color: 'text.secondary', py: 4 }}>{label}</TableCell></TableRow>;
}

function optionalRecordText(record: AdminRecord, key: string): string {
  const value = record[key];
  return value === null || value === undefined ? '' : String(value);
}

function recordText(record: AdminRecord, key: string, fallback = '-') {
  return optionalRecordText(record, key) || fallback;
}

function numberRecordField(record: AdminRecord, key: string): number {
  const value = Number(record[key]);
  return Number.isFinite(value) ? value : 0;
}

function formatDate(value: unknown): string {
  if (!value) {
    return '-';
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatHours(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}h`;
}

function formatPlatform(platform: string): string {
  if (platform === 'woocommerce') {
    return 'WooCommerce';
  }
  return platform ? `${platform[0].toUpperCase()}${platform.slice(1)}` : 'Unknown platform';
}
