import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SaveIcon from '@mui/icons-material/Save';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import UpdateIcon from '@mui/icons-material/Update';
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
import { adminApi, type AdminRecord, type StoreInput } from '../api/client';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { FloatingSuccessAlert } from '../components/FloatingSuccessAlert';
import { useInfiniteServerRows, useServerTableState } from '../components/useServerTableState';

type FormMode = 'edit' | 'table';

type StoreFormState = {
  canonical_domain: string;
  city: string;
  country: string;
  facebook_url: string;
  instagram_url: string;
  logo_url: string;
  name: string;
  state: string;
  status: string;
  website_url: string;
};

const emptyFormState: StoreFormState = {
  canonical_domain: '',
  city: '',
  country: 'Mexico',
  facebook_url: '',
  instagram_url: '',
  logo_url: '',
  name: '',
  state: '',
  status: 'active',
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

function withProtocol(value: string) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function websiteHref(record: AdminRecord) {
  const url = optionalValueFor(record, ['website_url']);
  return url ? withProtocol(url) : '';
}

function websiteLabel(record: AdminRecord) {
  return optionalValueFor(record, ['canonical_domain', 'website_url']);
}

function linkHref(record: AdminRecord, key: string) {
  const url = optionalValueFor(record, [key]);
  return url ? withProtocol(url) : '';
}

function formStateFromRecord(record: AdminRecord): StoreFormState {
  return {
    canonical_domain: optionalValueFor(record, ['canonical_domain']),
    city: optionalValueFor(record, ['city']),
    country: optionalValueFor(record, ['country']) || 'Mexico',
    facebook_url: optionalValueFor(record, ['facebook_url']),
    instagram_url: optionalValueFor(record, ['instagram_url']),
    logo_url: optionalValueFor(record, ['logo_url']),
    name: optionalValueFor(record, ['name']),
    state: optionalValueFor(record, ['state']),
    status: optionalValueFor(record, ['status']) || 'active',
    website_url: optionalValueFor(record, ['website_url'])
  };
}

function inputFromForm(form: StoreFormState): StoreInput {
  return {
    canonical_domain: form.canonical_domain.trim(),
    city: form.city.trim(),
    country: form.country.trim() || 'Mexico',
    facebook_url: form.facebook_url.trim(),
    instagram_url: form.instagram_url.trim(),
    logo_url: form.logo_url.trim(),
    name: form.name.trim(),
    state: form.state.trim(),
    status: form.status.trim() || 'active',
    website_url: form.website_url.trim()
  };
}

function storeColumns(): DataTableColumn<AdminRecord>[] {
  return [
    {
      filterValue: (row) => valueFor(row, ['name']),
      id: 'name',
      label: 'Name',
      minWidth: 180,
      render: (row) => valueFor(row, ['name']),
      sortValue: (row) => valueFor(row, ['name'])
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
      filterValue: (row) => valueFor(row, ['logo_url']),
      id: 'logo_url',
      label: 'Logo',
      minWidth: 90,
      render: (row) => {
        const logoUrl = optionalValueFor(row, ['logo_url']);
        const storeName = valueFor(row, ['name']);
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
      sortValue: (row) => valueFor(row, ['logo_url'])
    },
    {
      filterValue: (row) => valueFor(row, ['status']),
      id: 'status',
      label: 'Status',
      minWidth: 100,
      render: (row) => <Chip label={valueFor(row, ['status'])} size="small" variant="outlined" />,
      sortValue: (row) => valueFor(row, ['status'])
    },
    {
      filterValue: (row) => valueFor(row, ['updated_at']),
      id: 'updated_at',
      label: 'Updated',
      minWidth: 190,
      render: (row) => valueFor(row, ['updated_at']),
      sortValue: (row) => valueFor(row, ['updated_at'])
    }
  ];
}

export function StoresPage() {
  const [formMode, setFormMode] = useState<FormMode>('table');
  const [editingId, setEditingId] = useState('');
  const [formState, setFormState] = useState<StoreFormState>(emptyFormState);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunningDiscovery, setIsRunningDiscovery] = useState(false);
  const [isRunningItemUpdate, setIsRunningItemUpdate] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [operationMessage, setOperationMessage] = useState('');
  const table = useServerTableState('canonical_domain');
  const { hasMore, isLoadingMore, loadMore, rows, setRows, state, totalRows } = useInfiniteServerRows(
    table,
    adminApi.getStoresPage
  );

  function handleEditStore(row: AdminRecord) {
    setFormState(formStateFromRecord(row));
    setEditingId(valueFor(row, ['id'], ''));
    setSaveError('');
    setOperationError('');
    setOperationMessage('');
    setFormMode('edit');
  }

  function handleFieldChange(field: keyof StoreFormState, value: string) {
    setFormState((current) => ({ ...current, [field]: value }));
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setSaveError('');
    setOperationError('');
    setOperationMessage('');

    try {
      const saved = await adminApi.updateStore(editingId, inputFromForm(formState));
      setRows((currentRows) =>
        currentRows.map((row, index) => (valueFor(row, ['id'], String(index)) === editingId ? saved : row))
      );
      setFormMode('table');
    } catch {
      setSaveError('Store could not be saved.');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRunItemDiscovery() {
    if (!editingId) {
      return;
    }

    setIsRunningDiscovery(true);
    setOperationError('');
    setOperationMessage('');

    try {
      await adminApi.startStoreItemDiscoveryRun(editingId);
      setOperationMessage('Item discovery started.');
    } catch {
      setOperationError('Item discovery could not be started.');
    } finally {
      setIsRunningDiscovery(false);
    }
  }

  async function handleRunItemUpdate() {
    setIsRunningItemUpdate(true);
    setOperationError('');
    setOperationMessage('');

    try {
      await adminApi.startItemUpdateRun();
      setOperationMessage('Item update started.');
    } catch {
      setOperationError('Item update could not be started.');
    } finally {
      setIsRunningItemUpdate(false);
    }
  }

  const isFormMode = formMode !== 'table';

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700 }}>
          Stores
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Approved stores served by the platform.
        </Typography>
      </Box>

      {state === 'loading' && !isFormMode ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading stores</Typography>
        </Stack>
      ) : null}

      {state === 'error' && !isFormMode ? <Alert severity="error">Stores could not be loaded.</Alert> : null}
      <FloatingSuccessAlert message={operationMessage} onClose={() => setOperationMessage('')} />

      {isFormMode ? (
        <Paper component="section" variant="outlined" sx={{ maxWidth: 980, p: 2 }}>
          <Box component="form" onSubmit={handleSave}>
            <Stack spacing={2}>
              <Typography variant="h6">Edit Store</Typography>

              {saveError ? <Alert severity="error">{saveError}</Alert> : null}
              {operationError ? <Alert severity="error">{operationError}</Alert> : null}

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
                  label="Name"
                  value={formState.name}
                  onChange={(event) => handleFieldChange('name', event.target.value)}
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
                  label="Logo URL"
                  value={formState.logo_url}
                  onChange={(event) => handleFieldChange('logo_url', event.target.value)}
                />
                <TextField
                  fullWidth
                  label="Status"
                  value={formState.status}
                  onChange={(event) => handleFieldChange('status', event.target.value)}
                />
              </Box>

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Button disabled={isSaving} startIcon={<SaveIcon />} type="submit" variant="contained">
                  Save Store
                </Button>
                <Button
                  disabled={isRunningDiscovery || isRunningItemUpdate}
                  startIcon={isRunningDiscovery ? <CircularProgress color="inherit" size={16} /> : <TravelExploreIcon />}
                  type="button"
                  variant="outlined"
                  onClick={handleRunItemDiscovery}
                >
                  Run Item Discovery
                </Button>
                <Button
                  disabled={isRunningDiscovery || isRunningItemUpdate}
                  startIcon={isRunningItemUpdate ? <CircularProgress color="inherit" size={16} /> : <UpdateIcon />}
                  type="button"
                  variant="outlined"
                  onClick={handleRunItemUpdate}
                >
                  Run Item Update
                </Button>
                <Button
                  disabled={isSaving || isRunningDiscovery || isRunningItemUpdate}
                  startIcon={<ArrowBackIcon />}
                  type="button"
                  variant="outlined"
                  onClick={() => {
                    setFormMode('table');
                    setSaveError('');
                    setOperationError('');
                    setOperationMessage('');
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
          ariaLabel="Stores"
          columns={storeColumns()}
          defaultSortColumnId="canonical_domain"
          getRowKey={(row, index) => valueFor(row, ['id'], String(index))}
          minWidth={1470}
          onRowDoubleClick={handleEditStore}
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
