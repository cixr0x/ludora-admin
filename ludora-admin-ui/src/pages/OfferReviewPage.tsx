import { useCallback, useMemo, useState } from 'react';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { Alert, Box, Button, CircularProgress, IconButton, Link, Stack, Tooltip, Typography } from '@mui/material';
import { adminApi, type AdminRecord, type StoreItemListingStatus } from '../api/client';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { FloatingSuccessAlert } from '../components/FloatingSuccessAlert';
import { useInfiniteServerRows, useServerTableState } from '../components/useServerTableState';

function field(record: AdminRecord, keys: string[], fallback = '-') {
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  return value === undefined ? fallback : String(value);
}

function numericField(record: AdminRecord, keys: string[]) {
  const value = field(record, keys, '');
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function bggUrl(record: AdminRecord) {
  const bggId = field(record, ['item_bgg_id'], '');
  return bggId ? `https://boardgamegeek.com/boardgame/${encodeURIComponent(bggId)}` : '';
}

function imageCell(record: AdminRecord, urlKeys: string | string[], nameKey: string, label: string, linkUrl = '') {
  const url = field(record, Array.isArray(urlKeys) ? urlKeys : [urlKeys], '');
  const name = field(record, [nameKey], 'item');
  if (!url) {
    return (
      <Box
        sx={{
          alignItems: 'center',
          bgcolor: 'grey.100',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          color: 'text.secondary',
          display: 'flex',
          fontSize: 12,
          height: 88,
          justifyContent: 'center',
          width: 88
        }}
      >
        No image
      </Box>
    );
  }

  const image = (
    <Box
      alt={`${label} image for ${name}`}
      component="img"
      src={url}
      sx={{
        bgcolor: 'grey.100',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        display: 'block',
        height: 88,
        objectFit: 'contain',
        width: 88
      }}
    />
  );

  if (!linkUrl) {
    return image;
  }

  return (
    <Link href={linkUrl} rel="noreferrer" target="_blank">
      {image}
    </Link>
  );
}

function internalLink(value: string, url: string) {
  if (!url || value === '-') {
    return value;
  }

  return <Link href={url}>{value}</Link>;
}

function itemDisplayName(record: AdminRecord) {
  const itemName = field(record, ['item_name']);
  const spanishName = field(record, ['item_name_es'], '');
  if (!spanishName || spanishName === itemName) {
    return itemName;
  }

  return `${itemName} (${spanishName})`;
}

function candidateNameLink(record: AdminRecord) {
  const candidateName = field(record, ['candidate_name']);
  const candidateId = field(record, ['candidate_id'], '');
  return internalLink(candidateName, candidateId ? `#listings?id=${encodeURIComponent(candidateId)}` : '');
}

function itemNameLink(record: AdminRecord) {
  const itemId = field(record, ['item_id'], '');
  return internalLink(itemDisplayName(record), itemId ? `#items?id=${encodeURIComponent(itemId)}` : '');
}

function setSpanishNameAction(
  record: AdminRecord,
  onSetSpanishName: (row: AdminRecord) => void,
  savingCandidateId: string
) {
  const candidateId = field(record, ['candidate_id'], '');
  const candidateName = field(record, ['candidate_name'], '');
  const itemId = field(record, ['item_id'], '');
  const isSaving = candidateId !== '' && candidateId === savingCandidateId;
  const canSave = Boolean(itemId && candidateName && candidateName !== '-');

  return (
    <Button
      aria-label={isSaving ? 'Saving Spanish item name' : 'Use candidate name as Spanish item name'}
      disabled={!canSave || isSaving}
      onClick={() => onSetSpanishName(record)}
      size="small"
      sx={{ lineHeight: 1.25, minWidth: 34, px: 0.75, py: 0.25 }}
      title="Use candidate name as Spanish item name"
      variant="outlined"
    >
      {isSaving ? '...' : '->'}
    </Button>
  );
}

function generateSpanishDescriptionAction(
  record: AdminRecord,
  onGenerateSpanishDescription: (row: AdminRecord) => void,
  generatingCandidateId: string
) {
  const candidateDescription = field(record, ['candidate_description'], '');
  const candidateId = field(record, ['candidate_id'], '');
  const itemDescription = field(record, ['item_description'], '');
  const itemDescriptionEs = field(record, ['item_description_es'], '');
  const itemId = field(record, ['item_id'], '');
  const isGenerating = candidateId !== '' && candidateId === generatingCandidateId;
  const hasSourceDescriptions = Boolean(
    itemDescription && itemDescription !== '-' && candidateDescription && candidateDescription !== '-'
  );
  const isMissingSpanishDescription = !itemDescriptionEs || itemDescriptionEs === '-';
  const isEnabled = Boolean(itemId && hasSourceDescriptions && isMissingSpanishDescription && !isGenerating);
  const title = isMissingSpanishDescription
    ? hasSourceDescriptions
      ? 'Generate Spanish item description'
      : 'Missing source descriptions'
    : 'Spanish item description already exists';

  return (
    <Tooltip title={title}>
      <span>
        <IconButton
          aria-label={isGenerating ? 'Generating Spanish item description' : 'Generate Spanish item description'}
          disabled={!isEnabled}
          onClick={() => onGenerateSpanishDescription(record)}
          size="small"
        >
          {isGenerating ? <CircularProgress size={18} /> : <AutoFixHighIcon fontSize="inherit" />}
        </IconButton>
      </span>
    </Tooltip>
  );
}

function listingStatusActions(
  record: AdminRecord,
  onSetListingStatus: (row: AdminRecord, listingStatus: StoreItemListingStatus) => void,
  updatingListingStatusCandidateId: string
) {
  const candidateId = field(record, ['candidate_id', 'store_item_id'], '');
  const currentStatus = field(record, ['store_item_listing_status'], '').toUpperCase();
  const isUpdating = candidateId !== '' && candidateId === updatingListingStatusCandidateId;

  return (
    <Stack direction="row" spacing={0.5} sx={{ minWidth: 92 }}>
      <Tooltip title="Approve listing">
        <span>
          <IconButton
            aria-label="Approve listing"
            color="success"
            disabled={!candidateId || isUpdating || currentStatus === 'LISTED'}
            onClick={() => onSetListingStatus(record, 'LISTED')}
            size="small"
            sx={{ p: 0.5 }}
          >
            <CheckCircleIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Reject listing">
        <span>
          <IconButton
            aria-label="Reject listing"
            color="error"
            disabled={!candidateId || isUpdating || currentStatus === 'REJECTED'}
            onClick={() => onSetListingStatus(record, 'REJECTED')}
            size="small"
            sx={{ p: 0.5 }}
          >
            <CancelIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  );
}

function candidateLink(record: AdminRecord) {
  const url = field(record, ['candidate_url'], '');
  if (!url) {
    return '-';
  }

  return (
    <Link href={url} rel="noreferrer" target="_blank">
      Store item page
    </Link>
  );
}

function bggLink(record: AdminRecord) {
  const bggId = field(record, ['item_bgg_id'], '');
  const url = bggUrl(record);
  if (!url) {
    return '-';
  }

  return (
    <Link href={url} rel="noreferrer" target="_blank">
      BGG {bggId}
    </Link>
  );
}

function buildOfferReviewColumns(
  onSetSpanishName: (row: AdminRecord) => void,
  savingCandidateId: string,
  onGenerateSpanishDescription: (row: AdminRecord) => void,
  generatingDescriptionCandidateId: string,
  onSetListingStatus: (row: AdminRecord, listingStatus: StoreItemListingStatus) => void,
  updatingListingStatusCandidateId: string
): DataTableColumn<AdminRecord>[] {
  return [
  {
    filterValue: (row) => field(row, ['candidate_name']),
    id: 'candidate_name',
    label: 'Store item name',
    minWidth: 220,
    render: (row) => candidateNameLink(row),
    sortValue: (row) => field(row, ['candidate_name'])
  },
  {
    filterable: false,
    id: 'set_spanish_name',
    label: 'ES',
    minWidth: 72,
    render: (row) => setSpanishNameAction(row, onSetSpanishName, savingCandidateId),
    sortable: false
  },
  {
    filterable: false,
    id: 'generate_description_es',
    label: 'Desc',
    minWidth: 72,
    render: (row) => generateSpanishDescriptionAction(row, onGenerateSpanishDescription, generatingDescriptionCandidateId),
    sortable: false
  },
  {
    filterValue: (row) => itemDisplayName(row),
    id: 'item_name',
    label: 'Item name',
    minWidth: 220,
    render: (row) => itemNameLink(row),
    sortValue: (row) => itemDisplayName(row)
  },
  {
    filterValue: (row) => field(row, ['candidate_image_url']),
    id: 'candidate_image',
    label: 'Store item picture',
    minWidth: 128,
    render: (row) => imageCell(row, 'candidate_image_url', 'candidate_name', 'Store item', field(row, ['candidate_url'], '')),
    sortable: false
  },
  {
    filterValue: (row) => field(row, ['item_image_url_es', 'item_image_url']),
    id: 'item_image',
    label: 'Item picture',
    minWidth: 128,
    render: (row) => imageCell(row, ['item_image_url_es', 'item_image_url'], 'item_name', 'Item', bggUrl(row)),
    sortable: false
  },
  {
    filterValue: (row) => field(row, ['store_name', 'store_domain']),
    id: 'store',
    label: 'Store',
    minWidth: 170,
    render: (row) => field(row, ['store_name', 'store_domain']),
    sortValue: (row) => field(row, ['store_name', 'store_domain'])
  },
  {
    filterable: false,
    id: 'listing_status_actions',
    label: 'List',
    minWidth: 104,
    render: (row) => listingStatusActions(row, onSetListingStatus, updatingListingStatusCandidateId),
    sortable: false
  },
  {
    filterValue: (row) => field(row, ['store_item_listing_status']),
    id: 'store_item_listing_status',
    label: 'Listing status',
    minWidth: 150,
    render: (row) => field(row, ['store_item_listing_status']),
    sortValue: (row) => field(row, ['store_item_listing_status'])
  },
  {
    filterValue: (row) => field(row, ['match_source']),
    id: 'match_source',
    label: 'Source',
    minWidth: 110,
    render: (row) => field(row, ['match_source']),
    sortValue: (row) => field(row, ['match_source'])
  },
  {
    filterValue: (row) => field(row, ['match_score']),
    id: 'match_score',
    label: 'Score',
    minWidth: 100,
    render: (row) => field(row, ['match_score']),
    sortValue: (row) => numericField(row, ['match_score']) ?? field(row, ['match_score'])
  },
  {
    filterValue: (row) => field(row, ['candidate_price']),
    id: 'candidate_price',
    label: 'Store item price',
    minWidth: 140,
    render: (row) => field(row, ['candidate_price']),
    sortValue: (row) => numericField(row, ['candidate_price']) ?? field(row, ['candidate_price'])
  },
  {
    filterValue: (row) => field(row, ['candidate_availability']),
    id: 'candidate_availability',
    label: 'Store item availability',
    minWidth: 190,
    render: (row) => field(row, ['candidate_availability']),
    sortValue: (row) => field(row, ['candidate_availability'])
  },
  {
    filterValue: (row) => field(row, ['candidate_language']),
    id: 'candidate_language',
    label: 'Language',
    minWidth: 110,
    render: (row) => field(row, ['candidate_language']),
    sortValue: (row) => field(row, ['candidate_language'])
  },
  {
    filterValue: (row) => field(row, ['item_type']),
    id: 'item_type',
    label: 'Item type',
    minWidth: 130,
    render: (row) => field(row, ['item_type']),
    sortValue: (row) => field(row, ['item_type'])
  },
  {
    filterValue: (row) => field(row, ['candidate_url']),
    id: 'candidate_url',
    label: 'Store item URL',
    minWidth: 150,
    render: (row) => candidateLink(row),
    sortValue: (row) => field(row, ['candidate_url'])
  },
  {
    filterValue: (row) => field(row, ['item_bgg_id']),
    id: 'bgg',
    label: 'BGG',
    minWidth: 130,
    render: (row) => bggLink(row),
    sortValue: (row) => numericField(row, ['item_bgg_id']) ?? field(row, ['item_bgg_id'])
  }
  ];
}

export function OfferReviewPage() {
  const table = useServerTableState('candidate_name');
  const [saveError, setSaveError] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [generatingDescriptionCandidateId, setGeneratingDescriptionCandidateId] = useState('');
  const [savingSpanishNameCandidateId, setSavingSpanishNameCandidateId] = useState('');
  const [updatingListingStatusCandidateId, setUpdatingListingStatusCandidateId] = useState('');
  const { hasMore, isLoadingMore, loadMore, rows, setRows, state, totalRows } = useInfiniteServerRows(
    table,
    adminApi.getOfferReviewsPage
  );
  const handleSetSpanishName = useCallback(
    async (row: AdminRecord) => {
      const candidateId = field(row, ['candidate_id'], '');
      const candidateName = field(row, ['candidate_name'], '');
      const itemId = field(row, ['item_id'], '');

      if (!itemId || !candidateName || candidateName === '-') {
        return;
      }

      setSaveError('');
      setSaveMessage('');
      setSavingSpanishNameCandidateId(candidateId);

      try {
        const item = await adminApi.getItem(itemId);
        const savedItem = await adminApi.updateItem(itemId, {
          ...item,
          canonical_name_es: candidateName,
          normalized_name_es: ''
        });
        const savedSpanishName = field(savedItem, ['canonical_name_es'], candidateName);

        setRows((currentRows) =>
          currentRows.map((currentRow, index) =>
            field(currentRow, ['candidate_id'], String(index)) === candidateId
              ? { ...currentRow, item_name_es: savedSpanishName }
              : currentRow
          )
        );
        setSaveMessage('Spanish item name saved.');
      } catch {
        setSaveError('Spanish item name could not be saved.');
      } finally {
        setSavingSpanishNameCandidateId('');
      }
    },
    [setRows]
  );
  const handleSetListingStatus = useCallback(
    async (row: AdminRecord, listingStatus: StoreItemListingStatus) => {
      const candidateId = field(row, ['candidate_id', 'store_item_id'], '');
      if (!candidateId) {
        return;
      }

      setSaveError('');
      setSaveMessage('');
      setUpdatingListingStatusCandidateId(candidateId);

      try {
        const savedStoreItem = await adminApi.updateItemCandidateListingStatus(candidateId, listingStatus);
        const savedListingStatus = field(savedStoreItem, ['listing_status'], listingStatus);

        setRows((currentRows) =>
          currentRows.map((currentRow, index) =>
            field(currentRow, ['candidate_id', 'store_item_id'], String(index)) === candidateId
              ? { ...currentRow, store_item_listing_status: savedListingStatus }
              : currentRow
          )
        );
        setSaveMessage(
          listingStatus === 'LISTED' ? 'Store item listing approved.' : 'Store item listing rejected.'
        );
        table.refresh();
      } catch {
        setSaveError('Store item listing status could not be saved.');
      } finally {
        setUpdatingListingStatusCandidateId('');
      }
    },
    [setRows, table]
  );
  const handleGenerateSpanishDescription = useCallback(
    async (row: AdminRecord) => {
      const candidateDescription = field(row, ['candidate_description'], '');
      const candidateId = field(row, ['candidate_id'], '');
      const itemDescription = field(row, ['item_description'], '');
      const itemId = field(row, ['item_id'], '');
      const itemName = field(row, ['item_name_es'], '') || field(row, ['item_name'], '');

      if (!itemId || !itemName || !itemDescription || itemDescription === '-' || !candidateDescription || candidateDescription === '-') {
        return;
      }

      setSaveError('');
      setSaveMessage('');
      setGeneratingDescriptionCandidateId(candidateId);

      try {
        const generated = await adminApi.generateDescription({
          boardgame_name: itemName,
          description_1: itemDescription,
          description_2: candidateDescription
        });
        const item = await adminApi.getItem(itemId);
        const savedItem = await adminApi.updateItem(itemId, {
          ...item,
          description_es: generated.description_es
        });
        const savedDescription = field(savedItem, ['description_es'], generated.description_es);

        setRows((currentRows) =>
          currentRows.map((currentRow, index) =>
            field(currentRow, ['candidate_id'], String(index)) === candidateId
              ? { ...currentRow, item_description_es: savedDescription }
              : currentRow
          )
        );
        setSaveMessage('Spanish item description saved.');
      } catch {
        setSaveError('Spanish item description could not be saved.');
      } finally {
        setGeneratingDescriptionCandidateId('');
      }
    },
    [setRows]
  );
  const columns = useMemo(
    () =>
      buildOfferReviewColumns(
        handleSetSpanishName,
        savingSpanishNameCandidateId,
        handleGenerateSpanishDescription,
        generatingDescriptionCandidateId,
        handleSetListingStatus,
        updatingListingStatusCandidateId
      ),
    [
      generatingDescriptionCandidateId,
      handleGenerateSpanishDescription,
      handleSetListingStatus,
      handleSetSpanishName,
      savingSpanishNameCandidateId,
      updatingListingStatusCandidateId
    ]
  );

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700 }}>
          Store Item Review
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Compare discovered store items with their linked catalog items.
        </Typography>
      </Box>

      {state === 'loading' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading store item reviews</Typography>
        </Stack>
      ) : null}

      {state === 'error' ? <Alert severity="error">Store item reviews could not be loaded.</Alert> : null}
      <FloatingSuccessAlert message={saveMessage} onClose={() => setSaveMessage('')} />
      {saveError ? <Alert severity="error">{saveError}</Alert> : null}

      {state === 'ready' ? (
        <DataTable
          ariaLabel="Store item review"
          columns={columns}
          defaultSortColumnId="candidate_name"
          getRowKey={(row, index) => field(row, ['candidate_id'], String(index))}
          minWidth={2824}
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
