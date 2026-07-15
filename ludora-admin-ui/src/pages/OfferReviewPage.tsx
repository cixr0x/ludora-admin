import { useCallback, useEffect, useMemo, useState } from 'react';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import LinkIcon from '@mui/icons-material/Link';
import {
  Alert,
  Avatar,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  List,
  ListItemAvatar,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
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
          height: { sm: 88, xs: 72 },
          justifyContent: 'center',
          width: { sm: 88, xs: 72 }
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
        height: { sm: 88, xs: 72 },
        objectFit: 'contain',
        width: { sm: 88, xs: 72 }
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

function imageComparisonCell(record: AdminRecord) {
  const candidateName = field(record, ['candidate_name'], 'store item');
  const itemName = field(record, ['item_name'], 'item');

  return (
    <Stack
      aria-label={`Image comparison for ${candidateName} and ${itemName}`}
      direction="row"
      role="group"
      spacing={{ sm: 1.5, xs: 1 }}
      sx={{ alignItems: 'flex-start' }}
    >
      <Stack alignItems="center" spacing={0.5}>
        <Typography color="text.secondary" variant="caption">
          Store item
        </Typography>
        {imageCell(record, 'candidate_image_url', 'candidate_name', 'Store item', field(record, ['candidate_url'], ''))}
      </Stack>
      <Stack alignItems="center" spacing={0.5}>
        <Typography color="text.secondary" variant="caption">
          Catalog item
        </Typography>
        {imageCell(record, ['item_image_url_es', 'item_image_url'], 'item_name', 'Item', bggUrl(record))}
      </Stack>
    </Stack>
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

function candidateNameLink(record: AdminRecord, onOpenItemSearch: (row: AdminRecord) => void) {
  const candidateName = field(record, ['candidate_name']);
  const candidateId = field(record, ['candidate_id'], '');
  return (
    <Stack alignItems="center" direction="row" spacing={0.5}>
      {internalLink(candidateName, candidateId ? `#listings?id=${encodeURIComponent(candidateId)}` : '')}
      <Tooltip title="Associate with an existing item">
        <IconButton
          aria-label={`Associate ${candidateName} with an existing item`}
          color="primary"
          disabled={!candidateId}
          size="small"
          onClick={() => onOpenItemSearch(record)}
        >
          <LinkIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

function itemNameLink(record: AdminRecord) {
  const itemId = field(record, ['item_id'], '');
  return internalLink(itemDisplayName(record), itemId ? `#items?id=${encodeURIComponent(itemId)}` : '');
}

function titleWithoutTrailingLanguage(value: string) {
  const spanishLanguageMarker = '(?:español|espanol)';
  const languageMarker =
    '(?:español|espanol|spanish|castellano|es|esp|inglés|ingles|english|en)';
  return value
    .replace(new RegExp(`\\s*[\\(\\[\\{]\\s*${languageMarker}\\s*[\\)\\]\\}]\\s*$`, 'i'), '')
    .replace(new RegExp(`\\s*[-–—:]\\s*${languageMarker}\\s*$`, 'i'), '')
    .replace(new RegExp(`\\s+en\\s+${spanishLanguageMarker}\\s*$`, 'i'), '')
    .trim();
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
  const hasCandidateDescription = Boolean(candidateDescription && candidateDescription !== '-');
  const hasItemDescription = Boolean(itemDescription && itemDescription !== '-');
  const hasSourceDescriptions = hasItemDescription || hasCandidateDescription;
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
  onOpenItemSearch: (row: AdminRecord) => void,
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
    mobilePreview: true,
    minWidth: 220,
    render: (row) => candidateNameLink(row, onOpenItemSearch),
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
    filterable: false,
    id: 'image_comparison',
    label: 'Pictures',
    mobilePreview: true,
    minWidth: 224,
    render: (row) => imageComparisonCell(row),
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
    mobilePreview: true,
    minWidth: 104,
    render: (row) => listingStatusActions(row, onSetListingStatus, updatingListingStatusCandidateId),
    sortable: false
  },
  {
    filterValue: (row) => field(row, ['store_item_listing_status']),
    id: 'store_item_listing_status',
    label: 'Listing status',
    mobilePreview: true,
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
  const table = useServerTableState('candidate_name', 'asc', { store_item_listing_status: 'PENDING' });
  const [associationReview, setAssociationReview] = useState<AdminRecord | null>(null);
  const [associationError, setAssociationError] = useState('');
  const [isAssociatingItem, setIsAssociatingItem] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [generatingDescriptionCandidateId, setGeneratingDescriptionCandidateId] = useState('');
  const [savingSpanishNameCandidateId, setSavingSpanishNameCandidateId] = useState('');
  const [updatingListingStatusCandidateId, setUpdatingListingStatusCandidateId] = useState('');
  const { hasMore, isLoadingMore, loadMore, rows, setRows, state, totalRows } = useInfiniteServerRows(
    table,
    adminApi.getOfferReviewsPage
  );
  const handleOpenItemSearch = useCallback((row: AdminRecord) => {
    setAssociationReview(row);
    setAssociationError('');
    setSaveError('');
    setSaveMessage('');
  }, []);
  const handleAssociateItem = useCallback(
    async (item: AdminRecord) => {
      if (!associationReview) {
        return;
      }

      const candidateId = field(associationReview, ['candidate_id', 'store_item_id'], '');
      const itemId = field(item, ['id'], '');
      if (!candidateId || !itemId) {
        setAssociationError('The store item or catalog item is missing an ID.');
        return;
      }

      setIsAssociatingItem(true);
      setAssociationError('');
      setSaveError('');
      setSaveMessage('');

      try {
        await adminApi.associateItemCandidate(candidateId, itemId);
        setRows((currentRows) =>
          currentRows.map((currentRow, index) =>
            field(currentRow, ['candidate_id', 'store_item_id'], String(index)) === candidateId
              ? {
                  ...currentRow,
                  item_bgg_id: item.bgg_id ?? null,
                  item_id: item.id,
                  item_image_url: item.image_url ?? '',
                  item_image_url_es: item.image_url_es ?? '',
                  item_name: item.canonical_name ?? '',
                  item_name_es: item.canonical_name_es ?? '',
                  item_type: item.item_type ?? '',
                  match_score: 1,
                  match_source: 'MANUAL'
                }
              : currentRow
          )
        );
        setAssociationReview(null);
        setSaveMessage(`Store item associated with ${field(item, ['canonical_name_es', 'canonical_name'], 'catalog item')}.`);
        table.refresh();
      } catch {
        setAssociationError('The store item could not be associated with this catalog item.');
      } finally {
        setIsAssociatingItem(false);
      }
    },
    [associationReview, setRows, table]
  );
  const handleSetSpanishName = useCallback(
    async (row: AdminRecord) => {
      const candidateId = field(row, ['candidate_id'], '');
      const candidateName = field(row, ['candidate_name'], '');
      const spanishName = titleWithoutTrailingLanguage(candidateName);
      const itemId = field(row, ['item_id'], '');

      if (!itemId || !candidateName || candidateName === '-' || !spanishName) {
        return;
      }

      setSaveError('');
      setSaveMessage('');
      setSavingSpanishNameCandidateId(candidateId);

      try {
        const item = await adminApi.getItem(itemId);
        const savedItem = await adminApi.updateItem(itemId, {
          ...item,
          canonical_name_es: spanishName,
          normalized_name_es: ''
        });
        const savedSpanishName = field(savedItem, ['canonical_name_es'], spanishName);

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
      const candidateSourceDescription = candidateDescription === '-' ? '' : candidateDescription;
      const itemSourceDescription = itemDescription === '-' ? '' : itemDescription;

      if (!itemId || !itemName || (!itemSourceDescription && !candidateSourceDescription)) {
        return;
      }

      setSaveError('');
      setSaveMessage('');
      setGeneratingDescriptionCandidateId(candidateId);

      try {
        const generated = await adminApi.generateDescription({
          boardgame_name: itemName,
          description_1: itemSourceDescription,
          description_2: candidateSourceDescription
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
        handleOpenItemSearch,
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
      handleOpenItemSearch,
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
      <ItemAssociationDialog
        review={associationReview}
        error={associationError}
        isAssociating={isAssociatingItem}
        onAssociate={handleAssociateItem}
        onClose={() => {
          if (!isAssociatingItem) {
            setAssociationReview(null);
            setAssociationError('');
          }
        }}
      />
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

function ItemAssociationDialog({
  error,
  isAssociating,
  onAssociate,
  onClose,
  review
}: {
  error: string;
  isAssociating: boolean;
  onAssociate: (item: AdminRecord) => Promise<void>;
  onClose: () => void;
  review: AdminRecord | null;
}) {
  const [isSearching, setIsSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AdminRecord[]>([]);
  const [searchError, setSearchError] = useState('');

  useEffect(() => {
    if (!review) {
      setQuery('');
      setResults([]);
      setSearchError('');
      setIsSearching(false);
      return;
    }

    setQuery(field(review, ['candidate_name'], ''));
    setResults([]);
    setSearchError('');
  }, [review]);

  useEffect(() => {
    if (!review) {
      return;
    }

    const searchQuery = query.trim();
    if (searchQuery.length < 2) {
      setResults([]);
      setSearchError('');
      setIsSearching(false);
      return;
    }

    let ignore = false;
    setIsSearching(true);
    setSearchError('');
    const timeoutId = window.setTimeout(() => {
      adminApi
        .getItemsPage({
          filters: { name: searchQuery },
          page: 0,
          pageSize: 8,
          sortColumnId: 'canonical_name',
          sortDirection: 'asc'
        })
        .then((page) => {
          if (!ignore) {
            setResults(page.rows);
          }
        })
        .catch(() => {
          if (!ignore) {
            setResults([]);
            setSearchError('Catalog items could not be searched.');
          }
        })
        .finally(() => {
          if (!ignore) {
            setIsSearching(false);
          }
        });
    }, 200);

    return () => {
      ignore = true;
      window.clearTimeout(timeoutId);
    };
  }, [query, review]);

  const currentItemId = review ? field(review, ['item_id'], '') : '';

  return (
    <Dialog fullWidth maxWidth="sm" open={Boolean(review)} onClose={isAssociating ? undefined : onClose}>
      <DialogTitle>Associate Store Item</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Box>
            <Typography fontWeight={600} variant="body2">
              {review ? field(review, ['candidate_name'], 'Store item') : 'Store item'}
            </Typography>
            {currentItemId ? (
              <Typography color="text.secondary" variant="caption">
                Currently associated with item {currentItemId}
              </Typography>
            ) : null}
          </Box>
          <TextField
            autoFocus
            disabled={isAssociating}
            fullWidth
            label="Search catalog items"
            placeholder="Type at least 2 characters"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {error ? <Alert severity="error">{error}</Alert> : null}
          {searchError ? <Alert severity="error">{searchError}</Alert> : null}
          {isSearching ? (
            <Stack alignItems="center" direction="row" spacing={1.5} sx={{ py: 2 }}>
              <CircularProgress size={18} />
              <Typography color="text.secondary" variant="body2">
                Searching catalog items
              </Typography>
            </Stack>
          ) : null}
          {!isSearching && query.trim().length >= 2 && results.length === 0 && !searchError ? (
            <Typography color="text.secondary" sx={{ py: 2 }} textAlign="center" variant="body2">
              No matching catalog items.
            </Typography>
          ) : null}
          {!isSearching && results.length > 0 ? (
            <List aria-label="Catalog item matches" disablePadding sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
              {results.map((item) => {
                const itemId = field(item, ['id'], '');
                const primaryName = field(item, ['canonical_name_es', 'canonical_name'], 'Untitled item');
                const canonicalName = field(item, ['canonical_name'], '');
                const secondaryName = canonicalName && canonicalName !== primaryName ? canonicalName : '';
                const imageUrl = field(item, ['image_url_es', 'image_url'], '');
                return (
                  <ListItemButton
                    aria-label={`Associate with ${primaryName}`}
                    disabled={isAssociating || !itemId}
                    key={itemId}
                    onClick={() => void onAssociate(item)}
                  >
                    <ListItemAvatar>
                      <Avatar alt={`${primaryName} cover`} src={imageUrl} sx={{ bgcolor: 'grey.100' }} variant="rounded" />
                    </ListItemAvatar>
                    <ListItemText
                      primary={primaryName}
                      secondary={[secondaryName, itemId ? `Item ${itemId}` : ''].filter(Boolean).join(' · ')}
                    />
                  </ListItemButton>
                );
              })}
            </List>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={isAssociating} onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
