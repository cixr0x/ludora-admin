import { Alert, Box, CircularProgress, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { adminApi, type AdminRecord } from '../api/client';

type LoadState = 'loading' | 'ready' | 'error';

function field(record: AdminRecord, keys: string[], fallback = '-') {
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  return value === undefined ? fallback : String(value);
}

export function ListingCandidatesPage() {
  const [rows, setRows] = useState<AdminRecord[]>([]);
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    let ignore = false;

    adminApi
      .getListingCandidates()
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
          Listing Candidates
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Product and event listings captured from discovery feeds.
        </Typography>
      </Box>

      {state === 'loading' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading listing candidates</Typography>
        </Stack>
      ) : null}

      {state === 'error' ? <Alert severity="error">Listing candidates could not be loaded.</Alert> : null}

      {state === 'ready' && rows.length === 0 ? <Alert severity="info">No listing candidates found.</Alert> : null}

      {state === 'ready' && rows.length > 0 ? (
        <Paper variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Title</TableCell>
                <TableCell>Store</TableCell>
                <TableCell>Price</TableCell>
                <TableCell>Availability</TableCell>
                <TableCell>Confidence</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Last Seen</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={field(row, ['id'], String(index))}>
                  <TableCell>{field(row, ['raw_title', 'title', 'name'])}</TableCell>
                  <TableCell>{field(row, ['store_candidate_domain', 'store_name', 'store_id'])}</TableCell>
                  <TableCell>{field(row, ['raw_price', 'parsed_price_mxn', 'price'])}</TableCell>
                  <TableCell>{field(row, ['parsed_availability', 'raw_availability', 'availability'])}</TableCell>
                  <TableCell>{field(row, ['confidence'])}</TableCell>
                  <TableCell>{field(row, ['status', 'review_status'])}</TableCell>
                  <TableCell>{field(row, ['last_seen_at', 'updated_at'])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      ) : null}
    </Stack>
  );
}
