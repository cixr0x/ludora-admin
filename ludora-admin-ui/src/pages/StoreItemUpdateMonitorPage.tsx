import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
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
  const [monitor, setMonitor] = useState<StoreItemUpdateMonitor | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const loadMonitor = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setLoading(true);
    }
    try {
      setMonitor(await adminApi.getStoreItemUpdateMonitor(hours));
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    void loadMonitor(true);
    const timer = window.setInterval(() => void loadMonitor(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadMonitor]);

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
  const shopifyBlockedUntil = worker ? optionalRecordText(worker, 'shopify_blocked_until') : '';
  const shopifyIsBlocked = worker?.shopify_is_blocked === true;
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
          {!worker ? (
            <Chip color="default" label="Shopify claim state unavailable" size="small" variant="outlined" />
          ) : shopifyIsBlocked && shopifyBlockedUntil ? (
            <Chip color="warning" label={`Shopify paused until ${formatDate(shopifyBlockedUntil)}`} size="small" />
          ) : (
            <Chip color="success" label="Shopify claims enabled" size="small" variant="outlined" />
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
              Time since each eligible store item was last successfully refreshed. Items at 24 hours or more are highlighted.
            </Typography>
          </Box>
          <Typography color="text.secondary" variant="caption">
            Updated {monitor ? formatDate(monitor.generated_at) : '-'}
          </Typography>
        </Stack>
        <StalenessHistogram buckets={monitor?.histogram ?? []} />
      </Paper>

      <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { lg: 'minmax(0, 1fr) minmax(0, 1.5fr)' } }}>
        <Paper sx={{ overflow: 'hidden' }} variant="outlined">
          <Box sx={{ p: 2 }}>
            <Typography variant="h6">Failures by store · last 24h</Typography>
          </Box>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow><TableCell>Store</TableCell><TableCell>Platform</TableCell><TableCell align="right">Failures</TableCell><TableCell align="right">429</TableCell></TableRow>
              </TableHead>
              <TableBody>
                {(monitor?.failures_by_store ?? []).map((row, index) => (
                  <TableRow key={`${recordText(row, 'store_id')}-${recordText(row, 'platform')}-${index}`}>
                    <TableCell title={optionalRecordText(row, 'last_error')}>{recordText(row, 'store_name')}</TableCell>
                    <TableCell>{recordText(row, 'platform')}</TableCell>
                    <TableCell align="right">{recordText(row, 'failures', '0')}</TableCell>
                    <TableCell align="right">{recordText(row, 'rate_limited', '0')}</TableCell>
                  </TableRow>
                ))}
                {!monitor?.failures_by_store.length ? <EmptyRow columns={4} label="No failures in the last 24 hours" /> : null}
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
      </Box>
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
