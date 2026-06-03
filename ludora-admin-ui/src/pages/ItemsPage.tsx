import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SaveIcon from '@mui/icons-material/Save';
import { Alert, Box, Button, Chip, CircularProgress, Link, Paper, Stack, TextField, Typography } from '@mui/material';
import { type FormEvent, useEffect, useState } from 'react';
import { adminApi, type AdminRecord } from '../api/client';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { useInfiniteServerRows, useServerTableState } from '../components/useServerTableState';

type LoadState = 'loading' | 'ready' | 'error';
type ViewMode = 'form' | 'table';

type ItemDetailField = {
  gridColumn?: { md?: string; xs?: string };
  key: string;
  label: string;
  multiline?: boolean;
  readOnly?: boolean;
};

function field(record: AdminRecord, keys: string[], fallback = '-') {
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  return value === undefined ? fallback : String(value);
}

function detailValue(record: AdminRecord, key: string) {
  const value = record[key];
  if (value === undefined || value === null) {
    return '';
  }
  if (Array.isArray(value) || typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function numericField(record: AdminRecord, keys: string[]) {
  const value = field(record, keys, '');
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function playersLabel(record: AdminRecord) {
  const minPlayers = field(record, ['min_players'], '');
  const maxPlayers = field(record, ['max_players'], '');
  if (minPlayers && maxPlayers) {
    return minPlayers === maxPlayers ? minPlayers : `${minPlayers}-${maxPlayers}`;
  }
  return minPlayers || maxPlayers || '-';
}

function minutesLabel(record: AdminRecord) {
  const minMinutes = field(record, ['min_minutes'], '');
  const maxMinutes = field(record, ['max_minutes'], '');
  if (minMinutes && maxMinutes) {
    return minMinutes === maxMinutes ? minMinutes : `${minMinutes}-${maxMinutes}`;
  }
  return minMinutes || maxMinutes || '-';
}

function bggLink(record: AdminRecord) {
  const bggUrl = field(record, ['bgg_url'], '');
  const bggId = field(record, ['bgg_id'], '');
  if (!bggUrl && !bggId) {
    return '-';
  }

  return (
    <Link href={bggUrl || `https://boardgamegeek.com/boardgame/${bggId}`} rel="noreferrer" target="_blank">
      {bggId || 'BGG'}
    </Link>
  );
}

function itemThumbnail(record: AdminRecord) {
  const imageUrl = field(record, ['image_url'], '');
  const itemName = field(record, ['canonical_name'], 'Item');
  if (!imageUrl) {
    return '-';
  }

  return (
    <Box
      alt={`${itemName} thumbnail`}
      component="img"
      src={imageUrl}
      sx={{
        bgcolor: 'grey.100',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        display: 'block',
        height: 44,
        objectFit: 'contain',
        width: 44
      }}
    />
  );
}

function storeLabel(record: AdminRecord) {
  return field(record, ['store_name', 'store_domain', 'store_id']);
}

function candidateFormLink(record: AdminRecord) {
  const id = field(record, ['id'], '');
  const title = field(record, ['title'], 'Candidate');
  if (!id) {
    return title;
  }

  return <Link href={`#listings?id=${encodeURIComponent(id)}`}>{title}</Link>;
}

const itemDetailFields: ItemDetailField[] = [
  { key: 'id', label: 'ID', readOnly: true },
  { gridColumn: { md: 'span 2' }, key: 'canonical_name', label: 'Canonical Name' },
  { gridColumn: { md: 'span 2' }, key: 'normalized_name', label: 'Normalized Name' },
  { gridColumn: { md: 'span 2' }, key: 'canonical_name_es', label: 'Canonical Name ES' },
  { gridColumn: { md: 'span 2' }, key: 'normalized_name_es', label: 'Normalized Name ES' },
  { key: 'item_type', label: 'Item Type' },
  { key: 'parent_item_id', label: 'Parent Item ID' },
  { key: 'bgg_id', label: 'BGG ID' },
  { gridColumn: { md: 'span 2' }, key: 'bgg_url', label: 'BGG URL' },
  { key: 'bgg_last_sync_at', label: 'BGG Last Sync At', readOnly: true },
  { key: 'year_published', label: 'Year Published' },
  { key: 'min_players', label: 'Min Players' },
  { key: 'max_players', label: 'Max Players' },
  { key: 'min_minutes', label: 'Min Minutes' },
  { key: 'max_minutes', label: 'Max Minutes' },
  { key: 'complexity', label: 'Complexity' },
  { key: 'min_age', label: 'Min Age' },
  { gridColumn: { md: 'span 2' }, key: 'image_url', label: 'Image URL' },
  { gridColumn: { md: 'span 2' }, key: 'image_url_es', label: 'Image URL ES' },
  { key: 'status', label: 'Status' },
  { key: 'created_at', label: 'Created At', readOnly: true },
  { key: 'updated_at', label: 'Updated At', readOnly: true },
  { gridColumn: { md: '1 / -1' }, key: 'description', label: 'Description', multiline: true },
  { gridColumn: { md: '1 / -1' }, key: 'description_es', label: 'Description ES', multiline: true }
];

const itemColumns: DataTableColumn<AdminRecord>[] = [
  {
    filterable: false,
    id: 'image_url',
    label: 'Image',
    minWidth: 72,
    render: (row) => itemThumbnail(row),
    sortable: false
  },
  {
    filterValue: (row) => field(row, ['canonical_name']),
    id: 'canonical_name',
    label: 'Name',
    minWidth: 220,
    render: (row) => field(row, ['canonical_name']),
    sortValue: (row) => field(row, ['canonical_name'])
  },
  {
    filterValue: (row) => field(row, ['canonical_name_es']),
    id: 'canonical_name_es',
    label: 'Name ES',
    minWidth: 220,
    render: (row) => field(row, ['canonical_name_es']),
    sortValue: (row) => field(row, ['canonical_name_es'])
  },
  {
    filterValue: (row) => field(row, ['item_type']),
    id: 'item_type',
    label: 'Type',
    minWidth: 130,
    render: (row) => field(row, ['item_type']),
    sortValue: (row) => field(row, ['item_type'])
  },
  {
    filterValue: (row) => field(row, ['bgg_id']),
    id: 'bgg_id',
    label: 'BGG',
    minWidth: 100,
    render: (row) => bggLink(row),
    sortValue: (row) => numericField(row, ['bgg_id']) ?? field(row, ['bgg_id'])
  },
  {
    filterValue: (row) => field(row, ['year_published']),
    id: 'year_published',
    label: 'Year',
    minWidth: 90,
    render: (row) => field(row, ['year_published']),
    sortValue: (row) => numericField(row, ['year_published']) ?? field(row, ['year_published'])
  },
  {
    filterValue: (row) => playersLabel(row),
    id: 'players',
    label: 'Players',
    minWidth: 100,
    render: (row) => playersLabel(row),
    sortValue: (row) => numericField(row, ['min_players']) ?? playersLabel(row)
  },
  {
    filterValue: (row) => minutesLabel(row),
    id: 'min_minutes',
    label: 'Minutes',
    minWidth: 110,
    render: (row) => minutesLabel(row),
    sortValue: (row) => numericField(row, ['min_minutes']) ?? minutesLabel(row)
  },
  {
    filterValue: (row) => field(row, ['min_age']),
    id: 'min_age',
    label: 'Age',
    minWidth: 80,
    render: (row) => field(row, ['min_age']),
    sortValue: (row) => numericField(row, ['min_age']) ?? field(row, ['min_age'])
  },
  {
    filterValue: (row) => field(row, ['complexity']),
    id: 'complexity',
    label: 'Complexity',
    minWidth: 120,
    render: (row) => field(row, ['complexity']),
    sortValue: (row) => numericField(row, ['complexity']) ?? field(row, ['complexity'])
  },
  {
    filterValue: (row) => field(row, ['status']),
    id: 'status',
    label: 'Status',
    minWidth: 110,
    render: (row) => <Chip label={field(row, ['status'])} size="small" variant="outlined" />,
    sortValue: (row) => field(row, ['status'])
  },
  {
    filterValue: (row) => field(row, ['updated_at']),
    id: 'updated_at',
    label: 'Updated',
    minWidth: 190,
    render: (row) => field(row, ['updated_at']),
    sortValue: (row) => field(row, ['updated_at'])
  }
];

const linkedCandidateColumns: DataTableColumn<AdminRecord>[] = [
  {
    filterValue: (row) => field(row, ['title']),
    id: 'title',
    label: 'Candidate',
    minWidth: 220,
    render: (row) => candidateFormLink(row),
    sortValue: (row) => field(row, ['title'])
  },
  {
    filterValue: (row) => storeLabel(row),
    id: 'store',
    label: 'Store',
    minWidth: 190,
    render: (row) => storeLabel(row),
    sortValue: (row) => storeLabel(row)
  },
  {
    filterValue: (row) => field(row, ['status']),
    id: 'status',
    label: 'Status',
    minWidth: 140,
    render: (row) => field(row, ['status']),
    sortValue: (row) => field(row, ['status'])
  },
  {
    filterValue: (row) => field(row, ['price', 'raw_price']),
    id: 'price',
    label: 'Price',
    minWidth: 110,
    render: (row) => field(row, ['price', 'raw_price']),
    sortValue: (row) => numericField(row, ['price']) ?? field(row, ['price', 'raw_price'])
  },
  {
    filterValue: (row) => field(row, ['availability']),
    id: 'availability',
    label: 'Availability',
    minWidth: 140,
    render: (row) => field(row, ['availability']),
    sortValue: (row) => field(row, ['availability'])
  },
  {
    filterValue: (row) => field(row, ['language']),
    id: 'language',
    label: 'Language',
    minWidth: 110,
    render: (row) => field(row, ['language']),
    sortValue: (row) => field(row, ['language'])
  },
  {
    filterValue: (row) => field(row, ['last_updated']),
    id: 'last_updated',
    label: 'Updated',
    minWidth: 190,
    render: (row) => field(row, ['last_updated']),
    sortValue: (row) => field(row, ['last_updated'])
  }
];

type ItemsPageProps = {
  onClearSelectedItemId?: () => void;
  selectedItemId?: string;
};

export function ItemsPage({ onClearSelectedItemId, selectedItemId }: ItemsPageProps = {}) {
  const [detailState, setDetailState] = useState<LoadState>('ready');
  const [linkedStoreItems, setLinkedStoreItems] = useState<AdminRecord[]>([]);
  const [relatedState, setRelatedState] = useState<LoadState>('ready');
  const [selectedItem, setSelectedItem] = useState<AdminRecord | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const table = useServerTableState('canonical_name');
  const { hasMore, isLoadingMore, loadMore, rows, setRows, state, totalRows } = useInfiniteServerRows(
    table,
    adminApi.getItemsPage
  );

  useEffect(() => {
    if (!selectedItemId) {
      setDetailState('ready');
      setLinkedStoreItems([]);
      setRelatedState('ready');
      setSaveError('');
      setSaveMessage('');
      setSelectedItem(null);
      setViewMode('table');
      return;
    }

    let ignore = false;
    setDetailState('loading');
    setSaveError('');
    setSaveMessage('');
    setViewMode('form');

    Promise.all([
      adminApi.getItem(selectedItemId),
      adminApi.getItemStoreItems(selectedItemId)
    ])
      .then(([item, storeItems]) => {
        if (!ignore) {
          setSelectedItem(item);
          setLinkedStoreItems(storeItems);
          setRelatedState('ready');
          setViewMode('form');
          setDetailState('ready');
        }
      })
      .catch(() => {
        if (!ignore) {
          setDetailState('error');
          setRelatedState('error');
        }
      });

    return () => {
      ignore = true;
    };
  }, [selectedItemId]);

  async function handleSaveItem(input: AdminRecord) {
    if (!selectedItem) {
      return;
    }

    const itemId = field(selectedItem, ['id'], '');
    setIsSaving(true);
    setSaveError('');
    setSaveMessage('');

    try {
      const savedItem = await adminApi.updateItem(itemId, input);
      setRows((currentRows) => currentRows.map((row, index) => (field(row, ['id'], String(index)) === itemId ? savedItem : row)));
      setSelectedItem(savedItem);
      setSaveMessage('Item saved.');
    } catch {
      setSaveError('Item could not be saved.');
    } finally {
      setIsSaving(false);
    }
  }

  async function loadLinkedItemData(itemId: string) {
    setLinkedStoreItems([]);
    setRelatedState('loading');

    try {
      const storeItems = await adminApi.getItemStoreItems(itemId);
      setLinkedStoreItems(storeItems);
      setRelatedState('ready');
    } catch {
      setRelatedState('error');
    }
  }

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700 }}>
          Items
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Curated catalog items available to the platform.
        </Typography>
      </Box>

      {state === 'loading' && viewMode === 'table' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading items</Typography>
        </Stack>
      ) : null}

      {detailState === 'loading' && viewMode === 'form' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading item</Typography>
        </Stack>
      ) : null}

      {state === 'error' && viewMode === 'table' ? <Alert severity="error">Items could not be loaded.</Alert> : null}
      {detailState === 'error' && viewMode === 'form' ? <Alert severity="error">Item could not be loaded.</Alert> : null}

      {detailState === 'ready' && viewMode === 'form' && selectedItem ? (
        <ItemForm
          isSaving={isSaving}
          item={selectedItem}
          linkedStoreItems={linkedStoreItems}
          onBack={() => {
            setSelectedItem(null);
            setDetailState('ready');
            setLinkedStoreItems([]);
            setRelatedState('ready');
            setSaveError('');
            setSaveMessage('');
            setViewMode('table');
            onClearSelectedItemId?.();
          }}
          onSave={handleSaveItem}
          relatedState={relatedState}
          saveError={saveError}
          saveMessage={saveMessage}
        />
      ) : null}

      {state === 'ready' && viewMode === 'table' ? (
        <DataTable
          ariaLabel="Items"
          columns={itemColumns}
          getRowKey={(row, index) => field(row, ['id'], String(index))}
          minWidth={1330}
          onRowDoubleClick={(row) => {
            setDetailState('ready');
            setSaveError('');
            setSaveMessage('');
            setSelectedItem(row);
            setViewMode('form');
            void loadLinkedItemData(field(row, ['id'], ''));
          }}
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

function ItemForm({
  isSaving,
  item,
  linkedStoreItems,
  onBack,
  onSave,
  relatedState,
  saveError,
  saveMessage
}: {
  isSaving: boolean;
  item: AdminRecord;
  linkedStoreItems: AdminRecord[];
  onBack: () => void;
  onSave: (input: AdminRecord) => void;
  relatedState: LoadState;
  saveError: string;
  saveMessage: string;
}) {
  const title = field(item, ['canonical_name'], 'Item');
  const imageUrl = field(item, ['image_url'], '');
  const imageUrlEs = field(item, ['image_url_es'], '');
  const bggUrl = field(item, ['bgg_url'], '');
  const formKey = itemDetailFields.map((detailField) => detailValue(item, detailField.key)).join('\u001f');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(inputFromForm(new FormData(event.currentTarget)));
  }

  return (
    <Stack spacing={2}>
      <Paper component="section" variant="outlined" sx={{ p: 2 }}>
        <Stack component="form" key={formKey} spacing={2} onSubmit={handleSubmit}>
          <Stack alignItems="flex-start" direction={{ sm: 'row', xs: 'column' }} justifyContent="space-between" spacing={1.5}>
            <Box>
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                Item Details
              </Typography>
              <Typography color="text.secondary" variant="body2">
                {title}
              </Typography>
            </Box>
            <Stack direction={{ sm: 'row', xs: 'column' }} spacing={1} sx={{ width: { sm: 'auto', xs: '100%' } }}>
              <Button disabled={isSaving} startIcon={<SaveIcon />} type="submit" variant="contained">
                {isSaving ? 'Saving...' : 'Save Item'}
              </Button>
              <Button startIcon={<ArrowBackIcon />} type="button" variant="outlined" onClick={onBack}>
                Back to Items
              </Button>
            </Stack>
          </Stack>

          {saveMessage ? <Alert severity="success">{saveMessage}</Alert> : null}
          {saveError ? <Alert severity="error">{saveError}</Alert> : null}

          <Stack alignItems={{ md: 'flex-start', xs: 'stretch' }} direction={{ md: 'row', xs: 'column' }} spacing={2}>
            {imageUrl ? (
              <Box
                alt={`${title} item image`}
                component="img"
                src={imageUrl}
                sx={{
                  bgcolor: 'grey.100',
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 1,
                  height: 180,
                  objectFit: 'contain',
                  width: 180
                }}
              />
            ) : null}

            <Stack spacing={1}>
              {bggUrl ? (
                <Link href={bggUrl} rel="noreferrer" target="_blank">
                  Open BGG page
                </Link>
              ) : null}
              {imageUrl ? (
                <Link href={imageUrl} rel="noreferrer" target="_blank">
                  Open image
                </Link>
              ) : null}
              {imageUrlEs ? (
                <Link href={imageUrlEs} rel="noreferrer" target="_blank">
                  Open Spanish image
                </Link>
              ) : null}
            </Stack>
          </Stack>

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
            {itemDetailFields.map((detailField) => (
              <TextField
                defaultValue={detailValue(item, detailField.key)}
                fullWidth
                InputProps={{ readOnly: detailField.readOnly }}
                key={detailField.key}
                label={detailField.label}
                minRows={detailField.multiline ? 4 : undefined}
                multiline={detailField.multiline}
                name={detailField.readOnly ? undefined : detailField.key}
                sx={{ gridColumn: detailField.gridColumn }}
              />
            ))}
          </Box>
        </Stack>
      </Paper>

      <ItemRelations storeItems={linkedStoreItems} state={relatedState} />
    </Stack>
  );
}

function ItemRelations({ storeItems, state }: { storeItems: AdminRecord[]; state: LoadState }) {
  if (state === 'loading') {
    return (
      <Stack alignItems="center" direction="row" spacing={1.5}>
        <CircularProgress size={18} />
        <Typography variant="body2">Loading linked item data</Typography>
      </Stack>
    );
  }

  if (state === 'error') {
    return <Alert severity="error">Linked item data could not be loaded.</Alert>;
  }

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          Linked Store Items
        </Typography>
      </Box>
      <DataTable
        ariaLabel="Linked store items"
        columns={linkedCandidateColumns}
        defaultSortColumnId="last_updated"
        getRowKey={(row, index) => field(row, ['id'], String(index))}
        minWidth={1190}
        rows={storeItems}
      />
    </Stack>
  );
}

function inputFromForm(formData: FormData): AdminRecord {
  return Object.fromEntries(
    itemDetailFields
      .filter((detailField) => !detailField.readOnly)
      .map((detailField) => [detailField.key, String(formData.get(detailField.key) ?? '')])
  );
}
