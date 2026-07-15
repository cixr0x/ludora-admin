import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import SaveIcon from '@mui/icons-material/Save';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Link,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material';
import { type FormEvent, useState } from 'react';
import { adminApi, type AdminRecord, type StoreCandidateInput, type StoreCandidateStatus } from '../api/client';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { useInfiniteServerRows, useServerTableState } from '../components/useServerTableState';

type FormMode = 'create' | 'edit' | 'table';
type StoreCandidateAction = 'approve' | 'reject';

type StoreCandidateFormState = {
  canonical_domain: string;
  city: string;
  confidence: string;
  country: string;
  evidence: string;
  facebook_url: string;
  instagram_url: string;
  state: string;
  store_logo: string;
  store_name: string;
  website_url: string;
};

const emptyFormState: StoreCandidateFormState = {
  canonical_domain: '',
  city: '',
  confidence: '',
  country: 'Mexico',
  evidence: '',
  facebook_url: '',
  instagram_url: '',
  state: '',
  store_logo: '',
  store_name: '',
  website_url: ''
};

function valueFor(record: AdminRecord, keys: string[], fallback = '-') {
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  return value === undefined ? fallback : String(value);
}

function optionalValueFor(record: AdminRecord, keys: string[]) {
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  return value === undefined ? '' : String(value);
}

function websiteHref(record: AdminRecord) {
  const url = optionalValueFor(record, ['website_url']);
  if (url) {
    return withProtocol(url);
  }

  const domain = optionalValueFor(record, ['canonical_domain']);
  return domain ? withProtocol(domain) : '';
}

function websiteLabel(record: AdminRecord) {
  return optionalValueFor(record, ['canonical_domain', 'website_url']);
}

function withProtocol(value: string) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function linkHref(record: AdminRecord, key: string) {
  const url = optionalValueFor(record, [key]);
  return url ? withProtocol(url) : '';
}

function confidenceNumber(record: AdminRecord) {
  const value = optionalValueFor(record, ['confidence']);
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function confidenceLabel(record: AdminRecord) {
  const numericValue = confidenceNumber(record);
  if (numericValue === null) {
    return optionalValueFor(record, ['confidence']) || '-';
  }

  const percentage = numericValue <= 1 ? numericValue * 100 : numericValue;
  return `${Math.round(percentage * 100) / 100}%`;
}

function statusFor(record: AdminRecord): StoreCandidateStatus {
  const status = optionalValueFor(record, ['status']).toUpperCase();
  return status === 'ACCEPTED' || status === 'REJECTED' || status === 'PENDING' ? status : 'PENDING';
}

function statusChipColor(status: StoreCandidateStatus) {
  if (status === 'ACCEPTED') {
    return 'success';
  }
  if (status === 'REJECTED') {
    return 'default';
  }
  return 'warning';
}

function listValues(record: AdminRecord, key: string) {
  const value = record[key];
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item)).filter(Boolean);
        }
      } catch {
        return [trimmed];
      }
    }

    return trimmed
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function formStateFromRecord(record: AdminRecord): StoreCandidateFormState {
  return {
    canonical_domain: optionalValueFor(record, ['canonical_domain']),
    city: optionalValueFor(record, ['city']),
    confidence: optionalValueFor(record, ['confidence']),
    country: optionalValueFor(record, ['country']) || 'Mexico',
    evidence: listValues(record, 'evidence').join(', '),
    facebook_url: optionalValueFor(record, ['facebook_url']),
    instagram_url: optionalValueFor(record, ['instagram_url']),
    state: optionalValueFor(record, ['state']),
    store_logo: optionalValueFor(record, ['store_logo']),
    store_name: optionalValueFor(record, ['store_name']),
    website_url: optionalValueFor(record, ['website_url'])
  };
}

function inputFromForm(form: StoreCandidateFormState): StoreCandidateInput {
  const confidence = Number(form.confidence);
  return {
    canonical_domain: form.canonical_domain.trim(),
    city: form.city.trim(),
    confidence: Number.isFinite(confidence) ? confidence : 0,
    country: form.country.trim() || 'Mexico',
    evidence: evidenceValues(form.evidence),
    facebook_url: form.facebook_url.trim(),
    instagram_url: form.instagram_url.trim(),
    state: form.state.trim(),
    store_logo: form.store_logo.trim(),
    store_name: form.store_name.trim(),
    website_url: form.website_url.trim()
  };
}

function evidenceValues(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function ChipList({ values }: { values: string[] }) {
  if (values.length === 0) {
    return <Typography variant="body2">-</Typography>;
  }

  return (
    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5, maxWidth: 280 }}>
      {values.map((value) => (
        <Chip key={value} label={value} size="small" variant="outlined" />
      ))}
    </Stack>
  );
}

function storeCandidateColumns(
  onCandidateAction: (row: AdminRecord, action: StoreCandidateAction) => void,
  candidateActionId: string
): DataTableColumn<AdminRecord>[] {
  return [
  {
    filterValue: (row) => valueFor(row, ['store_name']),
    id: 'store_name',
    label: 'Store',
    minWidth: 180,
    render: (row) => valueFor(row, ['store_name']),
    sortValue: (row) => valueFor(row, ['store_name'])
  },
  {
    filterValue: (row) => valueFor(row, ['canonical_domain']),
    id: 'canonical_domain',
    label: 'Domain',
    minWidth: 150,
    render: (row) => valueFor(row, ['canonical_domain']),
    sortValue: (row) => valueFor(row, ['canonical_domain'])
  },
  {
    filterValue: (row) => valueFor(row, ['website_url']),
    id: 'website_url',
    label: 'Website',
    minWidth: 150,
    render: (row) => {
      const href = websiteHref(row);
      return href ? (
        <Link href={href} rel="noreferrer" target="_blank">
          {websiteLabel(row)}
        </Link>
      ) : (
        '-'
      );
    },
    sortValue: (row) => valueFor(row, ['website_url'])
  },
  {
    filterValue: (row) => valueFor(row, ['instagram_url']),
    id: 'instagram_url',
    label: 'Instagram',
    minWidth: 110,
    render: (row) => {
      const href = linkHref(row, 'instagram_url');
      return href ? (
        <Link href={href} rel="noreferrer" target="_blank">
          Instagram
        </Link>
      ) : (
        '-'
      );
    },
    sortValue: (row) => valueFor(row, ['instagram_url'])
  },
  {
    filterValue: (row) => valueFor(row, ['facebook_url']),
    id: 'facebook_url',
    label: 'Facebook',
    minWidth: 110,
    render: (row) => {
      const href = linkHref(row, 'facebook_url');
      return href ? (
        <Link href={href} rel="noreferrer" target="_blank">
          Facebook
        </Link>
      ) : (
        '-'
      );
    },
    sortValue: (row) => valueFor(row, ['facebook_url'])
  },
  {
    filterValue: (row) => valueFor(row, ['city']),
    id: 'city',
    label: 'City',
    minWidth: 150,
    render: (row) => valueFor(row, ['city']),
    sortValue: (row) => valueFor(row, ['city'])
  },
  {
    filterValue: (row) => valueFor(row, ['state']),
    id: 'state',
    label: 'State',
    minWidth: 110,
    render: (row) => valueFor(row, ['state']),
    sortValue: (row) => valueFor(row, ['state'])
  },
  {
    filterValue: (row) => valueFor(row, ['country']),
    id: 'country',
    label: 'Country',
    minWidth: 110,
    render: (row) => valueFor(row, ['country']),
    sortValue: (row) => valueFor(row, ['country'])
  },
  {
    filterValue: (row) => valueFor(row, ['store_logo']),
    id: 'store_logo',
    label: 'Logo',
    minWidth: 90,
    render: (row) => {
      const logoUrl = optionalValueFor(row, ['store_logo']);
      const storeName = valueFor(row, ['store_name']);
      return logoUrl ? (
        <Link href={logoUrl} rel="noreferrer" target="_blank">
          <Box
            alt={`${storeName} logo`}
            component="img"
            src={logoUrl}
            sx={{
              borderRadius: 1,
              display: 'block',
              height: 36,
              objectFit: 'contain',
              width: 36
            }}
          />
        </Link>
      ) : (
        '-'
      );
    },
    sortValue: (row) => valueFor(row, ['store_logo'])
  },
  {
    filterValue: (row) => statusFor(row),
    id: 'status',
    label: 'Status',
    mobilePreview: true,
    minWidth: 120,
    render: (row) => {
      const status = statusFor(row);
      return <Chip color={statusChipColor(status)} label={status} size="small" variant="outlined" />;
    },
    sortValue: (row) => statusFor(row)
  },
  {
    filterable: false,
    id: 'actions',
    label: 'Actions',
    mobilePreview: true,
    minWidth: 190,
    render: (row) => (
      <StoreCandidateActions
        actionId={candidateActionId}
        row={row}
        onCandidateAction={onCandidateAction}
      />
    ),
    sortable: false
  },
  {
    filterValue: (row) => confidenceLabel(row),
    id: 'confidence',
    label: 'Confidence',
    minWidth: 110,
    render: (row) => confidenceLabel(row),
    sortValue: (row) => confidenceNumber(row)
  },
  {
    filterValue: (row) => listValues(row, 'evidence').join(' '),
    id: 'evidence',
    label: 'Evidence',
    minWidth: 260,
    render: (row) => <ChipList values={listValues(row, 'evidence')} />,
    sortValue: (row) => listValues(row, 'evidence').join(' ')
  },
  {
    filterValue: (row) => valueFor(row, ['first_seen_at']),
    id: 'first_seen_at',
    label: 'First Seen',
    minWidth: 190,
    render: (row) => valueFor(row, ['first_seen_at']),
    sortValue: (row) => valueFor(row, ['first_seen_at'])
  },
  {
    filterValue: (row) => valueFor(row, ['last_seen_at']),
    id: 'last_seen_at',
    label: 'Last Seen',
    minWidth: 190,
    render: (row) => valueFor(row, ['last_seen_at']),
    sortValue: (row) => valueFor(row, ['last_seen_at'])
  }
  ];
}

function StoreCandidateActions({
  actionId,
  row,
  onCandidateAction
}: {
  actionId: string;
  row: AdminRecord;
  onCandidateAction: (row: AdminRecord, action: StoreCandidateAction) => void;
}) {
  if (statusFor(row) !== 'PENDING') {
    return <Typography variant="body2">-</Typography>;
  }

  const rowId = valueFor(row, ['id'], '');
  const approveActionId = `${rowId}:approve`;
  const rejectActionId = `${rowId}:reject`;
  const isApprovePending = actionId === approveActionId;
  const isRejectPending = actionId === rejectActionId;
  const isAnyActionPending = Boolean(actionId);

  return (
    <Stack direction="row" spacing={1} sx={{ minWidth: 172 }}>
      <Button
        color="success"
        disabled={isAnyActionPending}
        size="small"
        startIcon={
          isApprovePending ? <CircularProgress color="inherit" size={14} /> : <CheckCircleIcon fontSize="small" />
        }
        variant="contained"
        onClick={(event) => {
          event.stopPropagation();
          onCandidateAction(row, 'approve');
        }}
      >
        Approve
      </Button>
      <Button
        color="error"
        disabled={isAnyActionPending}
        size="small"
        startIcon={isRejectPending ? <CircularProgress color="inherit" size={14} /> : <CancelIcon fontSize="small" />}
        variant="outlined"
        onClick={(event) => {
          event.stopPropagation();
          onCandidateAction(row, 'reject');
        }}
      >
        Reject
      </Button>
    </Stack>
  );
}

export function StoreCandidatesPage() {
  const [formMode, setFormMode] = useState<FormMode>('table');
  const [editingId, setEditingId] = useState('');
  const [formState, setFormState] = useState<StoreCandidateFormState>(emptyFormState);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [actionError, setActionError] = useState('');
  const [candidateActionId, setCandidateActionId] = useState('');
  const table = useServerTableState('canonical_domain');
  const { hasMore, isLoadingMore, loadMore, rows, setRows, setTotalRows, state, totalRows } = useInfiniteServerRows(
    table,
    adminApi.getStoreCandidatesPage
  );

  function handleNewCandidate() {
    setFormState(emptyFormState);
    setEditingId('');
    setSaveError('');
    setActionError('');
    setFormMode('create');
  }

  function handleEditCandidate(row: AdminRecord) {
    setFormState(formStateFromRecord(row));
    setEditingId(valueFor(row, ['id'], ''));
    setSaveError('');
    setActionError('');
    setFormMode('edit');
  }

  function handleFieldChange(field: keyof StoreCandidateFormState, value: string) {
    setFormState((current) => ({ ...current, [field]: value }));
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setSaveError('');
    setActionError('');

    try {
      const input = inputFromForm(formState);
      const saved =
        formMode === 'edit'
          ? await adminApi.updateStoreCandidate(editingId, input)
          : await adminApi.createStoreCandidate(input);

      setRows((currentRows) => {
        if (formMode === 'edit') {
          return currentRows.map((row, index) =>
            valueFor(row, ['id'], String(index)) === editingId ? saved : row
          );
        }

        return [saved, ...currentRows];
      });
      if (formMode === 'create') {
        setTotalRows((currentTotalRows) => currentTotalRows + 1);
      }
      setFormMode('table');
    } catch {
      setSaveError('Store candidate could not be saved.');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCandidateAction(row: AdminRecord, action: StoreCandidateAction) {
    const candidateId = valueFor(row, ['id'], '');
    if (!candidateId) {
      return false;
    }

    setCandidateActionId(`${candidateId}:${action}`);
    setActionError('');

    try {
      const saved =
        action === 'approve'
          ? await adminApi.approveStoreCandidate(candidateId)
          : await adminApi.rejectStoreCandidate(candidateId);

      setRows((currentRows) =>
        currentRows.map((currentRow, index) =>
          valueFor(currentRow, ['id'], String(index)) === candidateId ? saved : currentRow
        )
      );
      return true;
    } catch {
      setActionError(
        action === 'approve' ? 'Store candidate could not be approved.' : 'Store candidate could not be rejected.'
      );
      return false;
    } finally {
      setCandidateActionId('');
    }
  }

  const isFormMode = formMode !== 'table';
  const editingRow = formMode === 'edit' ? rows.find((row, index) => valueFor(row, ['id'], String(index)) === editingId) : undefined;
  const columns = storeCandidateColumns((row, action) => {
    void handleCandidateAction(row, action);
  }, candidateActionId);

  return (
    <Stack spacing={2}>
      <Stack alignItems="flex-start" direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700 }}>
            Store Candidates
          </Typography>
          <Typography color="text.secondary" variant="body2">
            Discovery stores awaiting admin review.
          </Typography>
        </Box>
        <Button startIcon={<AddIcon />} variant="contained" onClick={handleNewCandidate}>
          New Store Candidate
        </Button>
      </Stack>

      {state === 'loading' && !isFormMode ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading store candidates</Typography>
        </Stack>
      ) : null}

      {state === 'error' && !isFormMode ? <Alert severity="error">Store candidates could not be loaded.</Alert> : null}

      {actionError && !isFormMode ? <Alert severity="error">{actionError}</Alert> : null}

      {isFormMode ? (
        <Paper component="section" variant="outlined" sx={{ maxWidth: 980, p: 2 }}>
          <Box component="form" onSubmit={handleSave}>
            <Stack spacing={2}>
              <Typography variant="h6">{formMode === 'edit' ? 'Edit Store Candidate' : 'New Store Candidate'}</Typography>

              {saveError ? <Alert severity="error">{saveError}</Alert> : null}
              {actionError ? <Alert severity="error">{actionError}</Alert> : null}

              <Box
                sx={{
                  display: 'grid',
                  gap: 2,
                  gridTemplateColumns: {
                    md: 'repeat(2, minmax(0, 1fr))',
                    xs: '1fr'
                  }
                }}
              >
                <TextField
                  fullWidth
                  label="Store name"
                  value={formState.store_name}
                  onChange={(event) => handleFieldChange('store_name', event.target.value)}
                />
                <TextField
                  fullWidth
                  label="Canonical domain"
                  value={formState.canonical_domain}
                  onChange={(event) => handleFieldChange('canonical_domain', event.target.value)}
                />
                <TextField
                  fullWidth
                  label="Website URL"
                  value={formState.website_url}
                  onChange={(event) => handleFieldChange('website_url', event.target.value)}
                />
                <TextField
                  fullWidth
                  label="Instagram URL"
                  value={formState.instagram_url}
                  onChange={(event) => handleFieldChange('instagram_url', event.target.value)}
                />
                <TextField
                  fullWidth
                  label="Facebook URL"
                  value={formState.facebook_url}
                  onChange={(event) => handleFieldChange('facebook_url', event.target.value)}
                />
                <TextField
                  fullWidth
                  label="City"
                  value={formState.city}
                  onChange={(event) => handleFieldChange('city', event.target.value)}
                />
                <TextField
                  fullWidth
                  label="State"
                  value={formState.state}
                  onChange={(event) => handleFieldChange('state', event.target.value)}
                />
                <TextField
                  fullWidth
                  label="Country"
                  value={formState.country}
                  onChange={(event) => handleFieldChange('country', event.target.value)}
                />
                <TextField
                  fullWidth
                  label="Store logo"
                  value={formState.store_logo}
                  onChange={(event) => handleFieldChange('store_logo', event.target.value)}
                />
                <TextField
                  fullWidth
                  inputProps={{ step: '0.01' }}
                  label="Confidence"
                  type="number"
                  value={formState.confidence}
                  onChange={(event) => handleFieldChange('confidence', event.target.value)}
                />
                <TextField
                  fullWidth
                  multiline
                  label="Evidence"
                  minRows={3}
                  sx={{ gridColumn: { md: '1 / -1' } }}
                  value={formState.evidence}
                  onChange={(event) => handleFieldChange('evidence', event.target.value)}
                />
              </Box>

              {editingRow && statusFor(editingRow) === 'PENDING' ? (
                <StoreCandidateActions
                  actionId={candidateActionId}
                  row={editingRow}
                  onCandidateAction={(row, action) => {
                    void handleCandidateAction(row, action).then((saved) => {
                      if (saved) {
                        setFormMode('table');
                      }
                    });
                  }}
                />
              ) : null}

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Button disabled={isSaving} startIcon={<SaveIcon />} type="submit" variant="contained">
                  Save Store Candidate
                </Button>
                <Button
                  disabled={isSaving}
                  startIcon={<ArrowBackIcon />}
                  variant="outlined"
                  onClick={() => {
                    setFormMode('table');
                    setSaveError('');
                  }}
                >
                  Cancel
                </Button>
              </Stack>
            </Stack>
          </Box>
        </Paper>
      ) : null}

      {state === 'ready' && !isFormMode ? (
        <DataTable
          ariaLabel="Store candidates"
          columns={columns}
          defaultSortColumnId="canonical_domain"
          getRowKey={(row, index) => valueFor(row, ['id'], String(index))}
          mobileActionLabel={(row) => `Edit ${valueFor(row, ['store_name', 'name'], 'store candidate')}`}
          minWidth={1770}
          onRowDoubleClick={handleEditCandidate}
          serverSide
          tableState={table.tableState}
          onTableStateChange={table.handleTableStateChange}
          infiniteScroll={{
            hasMore,
            isLoading: isLoadingMore,
            loadedCount: rows.length,
            onLoadMore: loadMore,
            totalCount: totalRows
          }}
          rows={rows}
        />
      ) : null}
    </Stack>
  );
}
