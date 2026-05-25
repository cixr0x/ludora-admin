import { Alert, Box, CircularProgress, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { adminApi, type AdminRecord } from '../api/client';

type LoadState = 'loading' | 'ready' | 'error';

function valueFor(record: AdminRecord, keys: string[], fallback = '—') {
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  return value === undefined ? fallback : String(value);
}

export function StoreCandidatesPage() {
  const [rows, setRows] = useState<AdminRecord[]>([]);
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    let ignore = false;

    adminApi
      .getStoreCandidates()
      .then((data) => {
        if (!ignore) {
          setRows(data);
          setState('ready');
        }
      })
      .catch(() => {
        if (!ignore) {
          setState('error');
        }
      });

    return () => {
      ignore = true;
    };
  }, []);

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700 }}>
          Store Candidates
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Discovery stores awaiting admin review.
        </Typography>
      </Box>

      {state === 'loading' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading store candidates</Typography>
        </Stack>
      ) : null}

      {state === 'error' ? <Alert severity="error">Store candidates could not be loaded.</Alert> : null}

      {state === 'ready' && rows.length === 0 ? <Alert severity="info">No store candidates found.</Alert> : null}

      {state === 'ready' && rows.length > 0 ? (
        <Paper variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>City</TableCell>
                <TableCell>Source</TableCell>
                <TableCell>Last Seen</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={valueFor(row, ['id'], String(index))}>
                  <TableCell>{valueFor(row, ['name', 'store_name', 'title'])}</TableCell>
                  <TableCell>{valueFor(row, ['city', 'locality'])}</TableCell>
                  <TableCell>{valueFor(row, ['source', 'source_url'])}</TableCell>
                  <TableCell>{valueFor(row, ['last_seen_at', 'updated_at'])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      ) : null}
    </Stack>
  );
}
