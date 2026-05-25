import { Alert, Box, CircularProgress, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { adminApi, type AdminRecord } from '../api/client';

type LoadState = 'loading' | 'ready' | 'error';

function read(record: AdminRecord, keys: string[], fallback = '—') {
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  return value === undefined ? fallback : String(value);
}

export function ReviewTasksPage() {
  const [rows, setRows] = useState<AdminRecord[]>([]);
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    let ignore = false;

    adminApi
      .getReviewTasks()
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
          Review Tasks
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Admin review queue ordered by latest activity.
        </Typography>
      </Box>

      {state === 'loading' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading review tasks</Typography>
        </Stack>
      ) : null}

      {state === 'error' ? <Alert severity="error">Review tasks could not be loaded.</Alert> : null}

      {state === 'ready' && rows.length === 0 ? <Alert severity="info">No review tasks found.</Alert> : null}

      {state === 'ready' && rows.length > 0 ? (
        <Paper variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Task</TableCell>
                <TableCell>Entity</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Updated</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={read(row, ['id'], String(index))}>
                  <TableCell>{read(row, ['task_type', 'type', 'title'])}</TableCell>
                  <TableCell>{read(row, ['entity_type', 'entity_id'])}</TableCell>
                  <TableCell>{read(row, ['status', 'state'])}</TableCell>
                  <TableCell>{read(row, ['updated_at', 'created_at'])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      ) : null}
    </Stack>
  );
}
