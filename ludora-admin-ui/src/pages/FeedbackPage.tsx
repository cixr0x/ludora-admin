import {
  Alert,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Typography
} from '@mui/material';
import { useEffect, useState } from 'react';
import { adminApi, type FeedbackSubmission, type PagedRows } from '../api/client';

const PAGE_SIZE = 25;

type FeedbackState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: PagedRows<FeedbackSubmission> };

export function FeedbackPage() {
  const [page, setPage] = useState(0);
  const [feedback, setFeedback] = useState<FeedbackState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    adminApi.getFeedbackPage({ page, pageSize: PAGE_SIZE }).then((data) => {
      if (active) setFeedback({ status: 'ready', data });
    }).catch(() => {
      if (active) setFeedback({ status: 'error' });
    });
    return () => { active = false; };
  }, [page]);

  const data = feedback.status === 'ready' ? feedback.data : null;

  return (
    <Stack spacing={2}>
      <Typography component="h2" variant="h5" sx={{ fontWeight: 700 }}>Feedback</Typography>
      {feedback.status === 'loading' && <CircularProgress aria-label="Loading feedback" size={28} />}
      {feedback.status === 'error' && <Alert severity="error">Feedback could not be loaded.</Alert>}
      {data && (
        data.total === 0 ? <Alert severity="info">No feedback submissions yet.</Alert> : (
          <Paper variant="outlined">
            <TableContainer>
              <Table aria-label="Feedback submissions" size="small" sx={{ minWidth: 760, '& td': { verticalAlign: 'top' } }}>
                <TableHead>
                  <TableRow>
                    <TableCell>ID</TableCell>
                    <TableCell>Submitted at</TableCell>
                    <TableCell>Name</TableCell>
                    <TableCell>Email</TableCell>
                    <TableCell>Message</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.id}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        <time dateTime={row.created_at}>{new Date(row.created_at).toLocaleString()}</time>
                      </TableCell>
                      <TableCell sx={{ overflowWrap: 'anywhere' }}>{row.name}</TableCell>
                      <TableCell sx={{ overflowWrap: 'anywhere' }}>{row.email}</TableCell>
                      <TableCell sx={{ minWidth: 240, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{row.message}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <TablePagination
              component="div"
              count={data.total}
              onPageChange={(_event, nextPage) => {
                setFeedback({ status: 'loading' });
                setPage(nextPage);
              }}
              page={data.page}
              rowsPerPage={data.pageSize}
              rowsPerPageOptions={[PAGE_SIZE]}
            />
          </Paper>
        )
      )}
    </Stack>
  );
}
