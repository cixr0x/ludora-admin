import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteIcon from '@mui/icons-material/Delete';
import ImageSearchIcon from '@mui/icons-material/ImageSearch';
import SaveIcon from '@mui/icons-material/Save';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Link,
  List,
  ListItemAvatar,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  adminApi,
  type AdminRecord,
  type CreateItemFromCandidateInput,
  type LocalCoverWorkflow,
  type ManualAiBggMatchResult,
  type StoreItemListingStatus
} from '../api/client';
import { CoverFlatteningDialog, type CoverFlatteningRequest } from '../components/CoverFlatteningDialog';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { FloatingSuccessAlert } from '../components/FloatingSuccessAlert';
import { useInfiniteServerRows, useServerTableState } from '../components/useServerTableState';
import { ItemsPage } from './ItemsPage';

type LoadState = 'loading' | 'ready' | 'error';
type ViewMode = 'form' | 'table';
type DetailMode = 'standard' | 'review';
const ADDITIONAL_ITEM_SEARCH_LIMIT = 20;

type ItemCandidateDetailField = {
  fieldType?: 'boolean';
  gridColumn?: { md?: string; xs?: string };
  key: string;
  label: string;
  multiline?: boolean;
  readOnly?: boolean;
};

type BatchSelectionOptions = {
  enabled: boolean;
  isProcessing: boolean;
  onToggle: (record: AdminRecord, checked: boolean, selectRange: boolean) => void;
  selectedIds: Set<string>;
};

function field(record: AdminRecord, keys: string[], fallback = '-') {
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  return value === undefined ? fallback : String(value);
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

function itemUrlLink(record: AdminRecord) {
  const url = field(record, ['source_url'], '');
  if (!url) {
    return '-';
  }

  return (
    <Link
      href={url}
      rel="noreferrer"
      sx={{ display: 'block', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      target="_blank"
    >
      {url}
    </Link>
  );
}

function candidateProductImage(record: AdminRecord) {
  const imageUrl = field(record, ['image_url'], '');
  const title = field(record, ['title', 'name'], 'Item candidate');
  if (!imageUrl) {
    return '-';
  }

  return (
    <Box
      alt={`${title} product image`}
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

function boardgameConfirmationActions(
  record: AdminRecord,
  onSetBoardgameState: (record: AdminRecord, isBoardgame: boolean) => void,
  updatingBoardgameCandidateId: string
) {
  const candidateId = field(record, ['id'], '');
  const isUpdating = candidateId !== '' && candidateId === updatingBoardgameCandidateId;
  const isDisabled = !candidateId || isUpdating;

  return (
    <Stack direction="row" spacing={0.5} sx={{ minWidth: 104 }} onDoubleClick={(event) => event.stopPropagation()}>
      <Tooltip title="Mark as boardgame">
        <span>
          <IconButton
            aria-label="Mark as boardgame"
            color="success"
            disabled={isDisabled}
            size="large"
            sx={{ p: 0.5 }}
            onClick={(event) => {
              event.stopPropagation();
              onSetBoardgameState(record, true);
            }}
          >
            <CheckCircleIcon fontSize="large" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Mark as not boardgame">
        <span>
          <IconButton
            aria-label="Mark as not boardgame"
            color="error"
            disabled={isDisabled}
            size="large"
            sx={{ p: 0.5 }}
            onClick={(event) => {
              event.stopPropagation();
              onSetBoardgameState(record, false);
            }}
          >
            <CancelIcon fontSize="large" />
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  );
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

function booleanValue(record: AdminRecord, key: string) {
  const value = record[key];
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return false;
}

function candidateId(record: AdminRecord) {
  return field(record, ['id'], '');
}

function isBoardgameConfirmed(record: AdminRecord) {
  return field(record, ['is_boardgame_confirmed'], '').toLowerCase() === 'true';
}

const itemCandidateDetailFields: ItemCandidateDetailField[] = [
  { key: 'id', label: 'ID', readOnly: true },
  { key: 'store_id', label: 'Store ID' },
  { gridColumn: { md: 'span 2' }, key: 'source_url', label: 'Source URL' },
  { gridColumn: { md: 'span 2' }, key: 'source_listing_url', label: 'Source Listing URL' },
  { gridColumn: { md: 'span 2' }, key: 'title', label: 'Title' },
  { gridColumn: { md: 'span 2' }, key: 'original_title', label: 'Original Title' },
  { key: 'publisher', label: 'Publisher' },
  { key: 'item_id', label: 'Item ID' },
  { key: 'item_type', label: 'Item Type' },
  { key: 'min_players', label: 'Min Players' },
  { key: 'max_players', label: 'Max Players' },
  { key: 'min_minutes', label: 'Min Minutes' },
  { key: 'max_minutes', label: 'Max Minutes' },
  { key: 'min_age', label: 'Min Age' },
  { key: 'language', label: 'Language' },
  { key: 'language_source', label: 'Language Source' },
  { gridColumn: { md: 'span 2' }, key: 'language_evidence', label: 'Language Evidence', multiline: true },
  { gridColumn: { md: 'span 2' }, key: 'image_url', label: 'Image URL' },
  { key: 'listing_status', label: 'Listing Status' },
  { key: 'raw_price', label: 'Raw Price' },
  { key: 'price', label: 'Price' },
  { key: 'price_source', label: 'Price Source' },
  { key: 'currency', label: 'Currency' },
  { key: 'availability', label: 'Availability' },
  { key: 'availability_source', label: 'Availability Source' },
  { key: 'store_sku', label: 'Store SKU' },
  { fieldType: 'boolean', key: 'is_boardgame', label: 'Is Boardgame' },
  { fieldType: 'boolean', key: 'is_boardgame_confirmed', label: 'Is Boardgame Confirmed' },
  { key: 'category_confidence', label: 'Category Confidence' },
  { key: 'match_source', label: 'Match Source' },
  { key: 'matched_bgg_id', label: 'Matched BGG ID' },
  { key: 'matched_name', label: 'Matched Name' },
  { key: 'match_score', label: 'Match Score' },
  { key: 'matched_at', label: 'Matched At', readOnly: true },
  { key: 'processed_at', label: 'Processed At', readOnly: true },
  { key: 'processing_error', label: 'Processing Error', multiline: true },
  { key: 'last_seen_at', label: 'Last Seen At', readOnly: true },
  { key: 'last_updated', label: 'Last Updated', readOnly: true },
  { key: 'refreshed_date', label: 'Refreshed At', readOnly: true },
  { gridColumn: { md: '1 / -1' }, key: 'description', label: 'Description', multiline: true },
  { gridColumn: { md: '1 / -1' }, key: 'classification_reasons', label: 'Classification Reasons', multiline: true },
  { gridColumn: { md: '1 / -1' }, key: 'match_reasons', label: 'Match Reasons', multiline: true },
  { gridColumn: { md: '1 / -1' }, key: 'raw_payload', label: 'Raw Payload', multiline: true },
  { gridColumn: { md: '1 / -1' }, key: 'match_payload', label: 'Match Payload', multiline: true }
];

const storeItemReviewDetailFields = itemCandidateDetailFields.filter((detailField) =>
  ['title', 'description'].includes(detailField.key)
);

function buildItemCandidateColumns(
  onSetBoardgameState: (record: AdminRecord, isBoardgame: boolean) => void,
  updatingBoardgameCandidateId: string,
  batchSelection?: BatchSelectionOptions
): DataTableColumn<AdminRecord>[] {
  const columns: DataTableColumn<AdminRecord>[] = [
  {
    filterable: false,
    id: 'image_url',
    label: 'Image',
    minWidth: 72,
    render: (row) => candidateProductImage(row),
    sortable: false
  },
  {
    filterValue: (row) => field(row, ['title', 'name']),
    id: 'title',
    label: 'Title',
    minWidth: 220,
    render: (row) => field(row, ['title', 'name']),
    sortValue: (row) => field(row, ['title', 'name'])
  },
  {
    filterValue: (row) => field(row, ['original_title']),
    id: 'original_title',
    label: 'Original Title',
    minWidth: 220,
    render: (row) => field(row, ['original_title']),
    sortValue: (row) => field(row, ['original_title'])
  },
  {
    filterable: false,
    id: 'boardgame_actions',
    label: 'BG',
    minWidth: 112,
    render: (row) => boardgameConfirmationActions(row, onSetBoardgameState, updatingBoardgameCandidateId),
    sortable: false
  },
  {
    filterValue: (row) => field(row, ['source_url']),
    id: 'source_url',
    label: 'Item URL',
    minWidth: 320,
    render: (row) => itemUrlLink(row),
    sortValue: (row) => field(row, ['source_url'])
  },
  {
    filterValue: (row) => field(row, ['store_id']),
    id: 'store',
    label: 'Store',
    minWidth: 90,
    render: (row) => field(row, ['store_id']),
    sortValue: (row) => numericField(row, ['store_id']) ?? field(row, ['store_id'])
  },
  {
    filterValue: (row) => field(row, ['publisher']),
    id: 'publisher',
    label: 'Publisher',
    minWidth: 160,
    render: (row) => field(row, ['publisher']),
    sortValue: (row) => field(row, ['publisher'])
  },
  {
    filterValue: (row) => field(row, ['is_boardgame']),
    id: 'is_boardgame',
    label: 'Boardgame',
    minWidth: 120,
    render: (row) => field(row, ['is_boardgame']),
    sortValue: (row) => field(row, ['is_boardgame'])
  },
  {
    filterValue: (row) => field(row, ['is_boardgame_confirmed']),
    id: 'is_boardgame_confirmed',
    label: 'BG Confirmed',
    minWidth: 140,
    render: (row) => field(row, ['is_boardgame_confirmed']),
    sortValue: (row) => field(row, ['is_boardgame_confirmed'])
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
    filterValue: (row) => field(row, ['language']),
    id: 'language',
    label: 'Language',
    minWidth: 110,
    render: (row) => field(row, ['language']),
    sortValue: (row) => field(row, ['language'])
  },
  {
    filterValue: (row) => field(row, ['language_source']),
    id: 'language_source',
    label: 'Language Source',
    minWidth: 180,
    render: (row) => field(row, ['language_source']),
    sortValue: (row) => field(row, ['language_source'])
  },
  {
    filterValue: (row) => field(row, ['raw_price', 'price']),
    id: 'price',
    label: 'Price',
    minWidth: 110,
    render: (row) => field(row, ['price', 'raw_price']),
    sortValue: (row) => numericField(row, ['price', 'raw_price']) ?? field(row, ['price', 'raw_price'])
  },
  {
    filterValue: (row) => field(row, ['price_source']),
    id: 'price_source',
    label: 'Price Source',
    minWidth: 170,
    render: (row) => field(row, ['price_source']),
    sortValue: (row) => field(row, ['price_source'])
  },
  {
    filterValue: (row) => field(row, ['availability']),
    id: 'availability',
    label: 'Availability',
    minWidth: 150,
    render: (row) => field(row, ['availability']),
    sortValue: (row) => field(row, ['availability'])
  },
  {
    filterValue: (row) => field(row, ['availability_source']),
    id: 'availability_source',
    label: 'Availability Source',
    minWidth: 210,
    render: (row) => field(row, ['availability_source']),
    sortValue: (row) => field(row, ['availability_source'])
  },
  {
    filterValue: (row) => field(row, ['listing_status']),
    id: 'listing_status',
    label: 'Listing Status',
    minWidth: 130,
    render: (row) => field(row, ['listing_status']),
    sortValue: (row) => field(row, ['listing_status'])
  },
  {
    filterValue: (row) => field(row, ['match_source']),
    id: 'match_source',
    label: 'Match Source',
    minWidth: 150,
    render: (row) => field(row, ['match_source']),
    sortValue: (row) => field(row, ['match_source'])
  },
  {
    filterValue: (row) => field(row, ['matched_name']),
    id: 'matched_name',
    label: 'Matched Name',
    minWidth: 180,
    render: (row) => field(row, ['matched_name']),
    sortValue: (row) => field(row, ['matched_name'])
  },
  {
    filterValue: (row) => field(row, ['match_score']),
    id: 'match_score',
    label: 'Match Score',
    minWidth: 140,
    render: (row) => field(row, ['match_score']),
    sortValue: (row) => numericField(row, ['match_score']) ?? field(row, ['match_score'])
  },
  {
    filterValue: (row) => field(row, ['processing_error']),
    id: 'processing_error',
    label: 'Processing Error',
    minWidth: 240,
    render: (row) => field(row, ['processing_error']),
    sortValue: (row) => field(row, ['processing_error'])
  },
  {
    filterValue: (row) => field(row, ['refreshed_date']),
    id: 'refreshed_date',
    label: 'Refreshed At',
    minWidth: 190,
    render: (row) => field(row, ['refreshed_date']),
    sortValue: (row) => field(row, ['refreshed_date'])
  },
  {
    filterValue: (row) => field(row, ['last_updated']),
    id: 'last_updated',
    label: 'Last Updated',
    minWidth: 190,
    render: (row) => field(row, ['last_updated']),
    sortValue: (row) => field(row, ['last_updated'])
  }
  ];
  return batchSelection?.enabled ? [batchSelectionColumn(batchSelection), ...columns] : columns;
}

function batchSelectionColumn(options: BatchSelectionOptions): DataTableColumn<AdminRecord> {
  return {
    filterable: false,
    id: 'batch_selection',
    label: 'Select',
    minWidth: 72,
    render: (row) => {
      const id = candidateId(row);
      const title = field(row, ['title', 'name'], 'store item');
      return (
        <Checkbox
          checked={options.selectedIds.has(id)}
          disabled={!id || isBoardgameConfirmed(row) || options.isProcessing}
          inputProps={{ 'aria-label': `Select ${title}` }}
          size="small"
          onChange={(event) => {
            options.onToggle(row, event.target.checked, (event.nativeEvent as MouseEvent).shiftKey);
          }}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      );
    },
    sortable: false
  };
}

type ListingCandidatesPageProps = {
  detailMode?: DetailMode;
  onClearSelectedCandidateId?: () => void;
  onOpenCandidate?: (candidateId: string) => void;
  onOpenItem?: (itemId: string) => void;
  reloadPage?: () => void;
  selectedCandidateId?: string;
};

export function ListingCandidatesPage({
  detailMode = 'standard',
  onClearSelectedCandidateId,
  onOpenCandidate,
  onOpenItem,
  reloadPage = reloadCurrentPage,
  selectedCandidateId
}: ListingCandidatesPageProps = {}) {
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const [detailState, setDetailState] = useState<LoadState>('ready');
  const [isBatchConfirming, setIsBatchConfirming] = useState(false);
  const [isBatchModeEnabled, setIsBatchModeEnabled] = useState(false);
  const [isCreatingBggItem, setIsCreatingBggItem] = useState(false);
  const [isCreatingItem, setIsCreatingItem] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [linkedItemRefreshToken, setLinkedItemRefreshToken] = useState(0);
  const [localCoverWorkflow, setLocalCoverWorkflow] = useState<LocalCoverWorkflow | null>(null);
  const [localCoverWorkflowError, setLocalCoverWorkflowError] = useState('');
  const [updatingBoardgameCandidateId, setUpdatingBoardgameCandidateId] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [selectedBatchCandidateIds, setSelectedBatchCandidateIds] = useState<Set<string>>(() => new Set());
  const batchSelectionAnchorId = useRef<string | null>(null);
  const translateAndApproveCandidateIds = useRef<Set<string>>(new Set());
  const [selectedCandidate, setSelectedCandidate] = useState<AdminRecord | null>(null);
  const [preparingCoverFlatteningCandidateId, setPreparingCoverFlatteningCandidateId] = useState('');
  const [startingCoverWorkflowId, setStartingCoverWorkflowId] = useState('');
  const [startingTranslateAndApproveCandidateId, setStartingTranslateAndApproveCandidateId] = useState('');
  const [updatingListingStatusCandidateId, setUpdatingListingStatusCandidateId] = useState('');
  const [coverFlatteningRequest, setCoverFlatteningRequest] = useState<CoverFlatteningRequest | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const table = useServerTableState('last_updated', 'desc');
  const { hasMore, isLoadingMore, loadMore, rows, setRows, state, totalRows } = useInfiniteServerRows(
    table,
    adminApi.getItemCandidatesPage
  );
  const selectableBatchCandidateIds = useMemo(
    () => rows.filter((row) => !isBoardgameConfirmed(row)).map(candidateId).filter(Boolean),
    [rows]
  );

  const handleSetBoardgameState = useCallback(
    async (candidate: AdminRecord, isBoardgame: boolean) => {
      const candidateId = field(candidate, ['id'], '');
      if (!candidateId) {
        return;
      }

      setUpdatingBoardgameCandidateId(candidateId);
      setSaveError('');
      setSaveMessage('');

      try {
        const savedCandidate = isBoardgame
          ? await adminApi.confirmItemCandidateBoardgame(candidateId)
          : await adminApi.updateItemCandidate(candidateId, {
              ...candidate,
              is_boardgame: false,
              is_boardgame_confirmed: true
            });
        setRows((currentRows) =>
          currentRows.map((row, index) => (field(row, ['id'], String(index)) === candidateId ? savedCandidate : row))
        );
        setSelectedCandidate((currentCandidate) =>
          currentCandidate && field(currentCandidate, ['id'], '') === candidateId ? savedCandidate : currentCandidate
        );
        setSaveMessage(isBoardgame ? 'Store item marked as boardgame.' : 'Store item marked as not boardgame.');
        table.refresh();
      } catch {
        setSaveError('Store item boardgame status could not be saved.');
      } finally {
        setUpdatingBoardgameCandidateId('');
      }
    },
    [setRows, table]
  );

  const handleToggleBatchCandidate = useCallback(
    (candidate: AdminRecord, checked: boolean, selectRange: boolean) => {
      const id = candidateId(candidate);
      if (!id) {
        return;
      }

      setSelectedBatchCandidateIds((currentIds) => {
        const nextIds = new Set(currentIds);
        const anchorIndex = batchSelectionAnchorId.current
          ? rows.findIndex((row) => candidateId(row) === batchSelectionAnchorId.current)
          : -1;
        const candidateIndex = rows.findIndex((row) => candidateId(row) === id);

        if (selectRange && anchorIndex >= 0 && candidateIndex >= 0) {
          const rangeStart = Math.min(anchorIndex, candidateIndex);
          const rangeEnd = Math.max(anchorIndex, candidateIndex);
          rows.slice(rangeStart, rangeEnd + 1).forEach((row) => {
            const rangeId = candidateId(row);
            if (!rangeId || isBoardgameConfirmed(row)) {
              return;
            }
            if (checked) {
              nextIds.add(rangeId);
            } else {
              nextIds.delete(rangeId);
            }
          });
        } else if (checked) {
          nextIds.add(id);
        } else {
          nextIds.delete(id);
        }

        return nextIds;
      });

      if (!selectRange || !batchSelectionAnchorId.current) {
        batchSelectionAnchorId.current = id;
      }
    },
    [rows]
  );

  async function handleBatchConfirmSelected(isBoardgame: boolean) {
    const candidatesById = new Map(rows.map((row) => [candidateId(row), row]));
    const candidatesToConfirm = [...selectedBatchCandidateIds]
      .map((id) => candidatesById.get(id))
      .filter((candidate): candidate is AdminRecord => Boolean(candidate));

    if (candidatesToConfirm.length === 0) {
      return;
    }

    setIsBatchConfirming(true);
    setSaveError('');
    setSaveMessage('');
    let successCount = 0;
    let failureCount = 0;

    try {
      for (const [index, candidate] of candidatesToConfirm.entries()) {
        const id = candidateId(candidate);
        setBatchProgress({ current: index + 1, total: candidatesToConfirm.length });
        setUpdatingBoardgameCandidateId(id);

        try {
          const savedCandidate = isBoardgame
            ? await adminApi.confirmItemCandidateBoardgame(id)
            : await adminApi.updateItemCandidate(id, {
                ...candidate,
                is_boardgame: false,
                is_boardgame_confirmed: true
              });
          successCount += 1;
          setRows((currentRows) =>
            currentRows.map((row, rowIndex) => (field(row, ['id'], String(rowIndex)) === id ? savedCandidate : row))
          );
          setSelectedCandidate((currentCandidate) =>
            currentCandidate && field(currentCandidate, ['id'], '') === id ? savedCandidate : currentCandidate
          );
          setSelectedBatchCandidateIds((currentIds) => {
            const nextIds = new Set(currentIds);
            nextIds.delete(id);
            return nextIds;
          });
        } catch {
          failureCount += 1;
        }
      }

      if (successCount > 0) {
        const classificationLabel = isBoardgame ? 'boardgames' : 'not boardgames';
        setSaveMessage(`Confirmed ${successCount} store ${successCount === 1 ? 'item' : 'items'} as ${classificationLabel}.`);
      }
      if (failureCount > 0) {
        setSaveError(`Batch confirmation completed with ${failureCount} failed ${failureCount === 1 ? 'item' : 'items'}.`);
      }
      table.refresh();
    } finally {
      setBatchProgress(null);
      setIsBatchConfirming(false);
      setUpdatingBoardgameCandidateId('');
    }
  }

  const itemCandidateColumns = useMemo(
    () =>
      buildItemCandidateColumns(
        handleSetBoardgameState,
        updatingBoardgameCandidateId,
        isBatchModeEnabled
          ? {
              enabled: isBatchModeEnabled,
              isProcessing: isBatchConfirming,
              onToggle: handleToggleBatchCandidate,
              selectedIds: selectedBatchCandidateIds
            }
          : undefined
      ),
    [
      handleSetBoardgameState,
      handleToggleBatchCandidate,
      isBatchConfirming,
      isBatchModeEnabled,
      selectedBatchCandidateIds,
      updatingBoardgameCandidateId
    ]
  );

  useEffect(() => {
    if (!selectedCandidateId) {
      setDetailState('ready');
      setLocalCoverWorkflow(null);
      setLocalCoverWorkflowError('');
      setSaveError('');
      setSaveMessage('');
      setSelectedCandidate(null);
      setLinkedItemRefreshToken(0);
      setPreparingCoverFlatteningCandidateId('');
      setStartingTranslateAndApproveCandidateId('');
      setUpdatingListingStatusCandidateId('');
      setViewMode('table');
      return;
    }

    let ignore = false;
    setDetailState('loading');
    setLocalCoverWorkflow(null);
    setLocalCoverWorkflowError('');
    setSaveError('');
    setSaveMessage('');
    setLinkedItemRefreshToken(0);
    setPreparingCoverFlatteningCandidateId('');
    setStartingTranslateAndApproveCandidateId('');
    setUpdatingListingStatusCandidateId('');
    setViewMode('form');

    adminApi
      .getItemCandidate(selectedCandidateId)
      .then((candidate) => {
        if (!ignore) {
          setSelectedCandidate(candidate);
          setViewMode('form');
          setDetailState('ready');
        }
      })
      .catch(() => {
        if (!ignore) {
          setDetailState('error');
        }
      });

    return () => {
      ignore = true;
    };
  }, [selectedCandidateId]);

  async function handleSaveCandidate(input: AdminRecord) {
    if (!selectedCandidate) {
      return;
    }

    const candidateId = field(selectedCandidate, ['id'], '');
    setIsSaving(true);
    setSaveError('');
    setSaveMessage('');

    try {
      const savedCandidate = await adminApi.updateItemCandidate(candidateId, input);
      setRows((currentRows) =>
        currentRows.map((row, index) => (field(row, ['id'], String(index)) === candidateId ? savedCandidate : row))
      );
      setSelectedCandidate(savedCandidate);
      setSaveMessage('Store item saved.');
    } catch {
      setSaveError('Item candidate could not be saved.');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCreateItemFromCandidate(input: CreateItemFromCandidateInput = {}) {
    if (!selectedCandidate) {
      return;
    }

    const candidateId = field(selectedCandidate, ['id'], '');
    setIsCreatingItem(true);
    setSaveError('');
    setSaveMessage('');

    try {
      const savedCandidate = await adminApi.createItemFromCandidate(candidateId, input);
      setRows((currentRows) =>
        currentRows.map((row, index) => (field(row, ['id'], String(index)) === candidateId ? savedCandidate : row))
      );
      setSelectedCandidate(savedCandidate);
      setSaveMessage('Item created from candidate.');
      const itemId = field(savedCandidate, ['item_id'], '');
      if (itemId) {
        onOpenItem?.(itemId);
      }
    } catch {
      setSaveError('Item could not be created from candidate.');
    } finally {
      setIsCreatingItem(false);
    }
  }

  async function handleCreateItemFromBggId(bggId: string) {
    if (!selectedCandidate) {
      return;
    }

    const candidateId = field(selectedCandidate, ['id'], '');
    setIsCreatingBggItem(true);
    setSaveError('');
    setSaveMessage('');

    try {
      const savedCandidate = await adminApi.createItemFromBggId(candidateId, bggId.trim());
      setRows((currentRows) =>
        currentRows.map((row, index) => (field(row, ['id'], String(index)) === candidateId ? savedCandidate : row))
      );
      setSelectedCandidate(savedCandidate);
      setSaveMessage('Item created from BGG ID.');
      const itemId = field(savedCandidate, ['item_id'], '');
      if (itemId) {
        onOpenItem?.(itemId);
      }
    } catch {
      setSaveError('Item could not be created from BGG ID.');
    } finally {
      setIsCreatingBggItem(false);
    }
  }

  function handlePrimaryItemAssociated(savedCandidate: AdminRecord, item: AdminRecord) {
    const candidateId = field(savedCandidate, ['id'], '');
    setRows((currentRows) =>
      currentRows.map((row, index) => (field(row, ['id'], String(index)) === candidateId ? savedCandidate : row))
    );
    setSelectedCandidate(savedCandidate);
    setLinkedItemRefreshToken((currentToken) => currentToken + 1);
    setSaveError('');
    setSaveMessage(`Store item associated with ${catalogItemDisplayName(item)}.`);
    table.refresh();
  }

  function handleManualAiMatch(candidate: AdminRecord, result: ManualAiBggMatchResult) {
    const id = field(candidate, ['id'], '');
    setRows((currentRows) =>
      currentRows.map((row, index) => (field(row, ['id'], String(index)) === id ? candidate : row))
    );
    setSelectedCandidate(candidate);
    if (result.status === 'matched') {
      setLinkedItemRefreshToken((currentToken) => currentToken + 1);
      setSaveMessage(`AI matched ${result.matched_name}.`);
    } else {
      setSaveMessage('');
    }
    setSaveError('');
    table.refresh();
  }

  async function openNextPendingReview(currentCandidateId: string) {
    if (detailMode !== 'review' || !onOpenCandidate) {
      return;
    }

    const nextReviews = await adminApi.getOfferReviewsPage({
      filters: { store_item_listing_status: 'PENDING' },
      page: 0,
      pageSize: translateAndApproveCandidateIds.current.size + 2,
      sortColumnId: 'candidate_name',
      sortDirection: 'asc'
    });
    const nextCandidateId = nextReviews.rows
      .map((review) => field(review, ['candidate_id', 'store_item_id'], ''))
      .find(
        (candidateId) =>
          candidateId &&
          candidateId !== currentCandidateId &&
          !translateAndApproveCandidateIds.current.has(candidateId)
      );

    if (nextCandidateId) {
      onOpenCandidate(nextCandidateId);
    } else {
      onClearSelectedCandidateId?.();
    }
  }

  async function handleSetListingStatus(candidate: AdminRecord, listingStatus: StoreItemListingStatus) {
    const id = field(candidate, ['id'], '');
    if (!id) {
      return;
    }

    setSaveError('');
    setSaveMessage('');
    setUpdatingListingStatusCandidateId(id);

    try {
      const savedStoreItem = await adminApi.updateItemCandidateListingStatus(id, listingStatus);
      const savedListingStatus = field(savedStoreItem, ['listing_status'], listingStatus);
      const updatedCandidate = {
        ...candidate,
        ...savedStoreItem,
        listing_status: savedListingStatus
      };
      setRows((currentRows) =>
        currentRows.map((row, index) => (field(row, ['id'], String(index)) === id ? updatedCandidate : row))
      );
      setSelectedCandidate((currentCandidate) =>
        currentCandidate && field(currentCandidate, ['id'], '') === id ? updatedCandidate : currentCandidate
      );
      setSaveMessage(
        listingStatus === 'LISTED' ? 'Store item listing approved.' : 'Store item listing rejected.'
      );
      table.refresh();
      const shouldOpenNextReview =
        detailMode === 'review' &&
        (listingStatus === 'LISTED' || listingStatus === 'REJECTED') &&
        Boolean(onOpenCandidate);
      if (shouldOpenNextReview) {
        try {
          await openNextPendingReview(id);
        } catch {
          const completedAction = listingStatus === 'LISTED' ? 'approved' : 'rejected';
          setSaveError(`Store item listing was ${completedAction}, but the next review could not be loaded.`);
        }
      }
    } catch {
      setSaveError('Store item listing status could not be saved.');
    } finally {
      setUpdatingListingStatusCandidateId('');
    }
  }

  async function handleTranslateAndApprove(candidate: AdminRecord) {
    const id = field(candidate, ['id'], '');
    if (!id) {
      return;
    }

    setSaveError('');
    setSaveMessage('');
    setStartingTranslateAndApproveCandidateId(id);

    try {
      await adminApi.translateAndApproveItemCandidate(id);
      translateAndApproveCandidateIds.current.add(id);
    } catch {
      setSaveError('Translation and approval job could not be started.');
      setStartingTranslateAndApproveCandidateId('');
      return;
    }

    table.refresh();
    try {
      await openNextPendingReview(id);
    } catch {
      setSaveError('Translation and approval started, but the next review could not be loaded.');
    } finally {
      setStartingTranslateAndApproveCandidateId('');
    }
  }

  async function handleDeleteCandidate(): Promise<boolean> {
    if (!selectedCandidate) {
      return false;
    }

    const candidateId = field(selectedCandidate, ['id'], '');
    setIsDeleting(true);
    setSaveError('');
    setSaveMessage('');

    try {
      await adminApi.deleteItemCandidate(candidateId);
      setRows((currentRows) => currentRows.filter((row) => field(row, ['id'], '') !== candidateId));
      setSelectedCandidate(null);
      setDetailState('ready');
      setLocalCoverWorkflow(null);
      setLocalCoverWorkflowError('');
      setViewMode('table');
      setSaveMessage('Store item deleted.');
      onClearSelectedCandidateId?.();
      table.refresh();
      return true;
    } catch {
      setSaveError('Store item could not be deleted.');
      return false;
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleStartLocalCoverWorkflow(candidate: AdminRecord) {
    const candidateId = field(candidate, ['id'], '');
    if (!candidateId) {
      return;
    }

    setStartingCoverWorkflowId(candidateId);
    setLocalCoverWorkflow(null);
    setLocalCoverWorkflowError('');
    setSaveError('');
    setSaveMessage('');

    try {
      const workflow = await adminApi.startLocalCoverWorkflow(candidateId);
      setLocalCoverWorkflow(workflow);
    } catch {
      setLocalCoverWorkflowError('Cover workflow could not be started.');
    } finally {
      setStartingCoverWorkflowId('');
    }
  }

  async function handleStartCoverFlattening(candidate: AdminRecord) {
    const candidateId = field(candidate, ['id'], '');
    if (!candidateId) {
      return;
    }

    if (detailMode === 'review') {
      const itemId = field(candidate, ['item_id'], '');
      if (!itemId) {
        setSaveError('Link a catalog item before flattening a cover.');
        return;
      }

      setPreparingCoverFlatteningCandidateId(candidateId);
      setSaveError('');
      try {
        const linkedItem = await adminApi.getItem(itemId);
        const sources: Extract<CoverFlatteningRequest, { kind: 'review' }>['sources'] = [];
        const storeItemImageUrl = field(candidate, ['image_url'], '');
        const itemImageUrl = field(linkedItem, ['image_url'], '');
        const itemImageUrlEs = field(linkedItem, ['image_url_es'], '');
        if (storeItemImageUrl) {
          sources.push({ field: 'store_item_image', url: storeItemImageUrl });
        }
        if (itemImageUrl) {
          sources.push({ field: 'image_url', url: itemImageUrl });
        }
        if (itemImageUrlEs) {
          sources.push({ field: 'image_url_es', url: itemImageUrlEs });
        }
        if (sources.length === 0) {
          setSaveError('No cover images are available to flatten.');
          return;
        }
        setCoverFlatteningRequest({
          id: candidateId,
          itemId,
          kind: 'review',
          sources,
          title: field(candidate, ['title'], 'Store item')
        });
      } catch {
        setSaveError('Cover sources could not be loaded.');
      } finally {
        setPreparingCoverFlatteningCandidateId('');
      }
      return;
    }

    setCoverFlatteningRequest({
      id: candidateId,
      kind: 'store_item',
      title: field(candidate, ['title'], 'Store item')
    });
  }

  return (
    <Stack spacing={2}>
      <Box>
        <Stack alignItems={{ md: 'center', xs: 'flex-start' }} direction={{ md: 'row', xs: 'column' }} justifyContent="space-between" spacing={1.5}>
          <Box>
            <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700 }}>
              {detailMode === 'review' ? 'Store Item Review' : 'Store Items'}
            </Typography>
            <Typography color="text.secondary" variant="body2">
              {detailMode === 'review'
                ? 'Review the store item and its linked catalog item in one place.'
                : 'Discovered store product rows captured from approved store inventories.'}
            </Typography>
          </Box>
          {viewMode === 'table' ? (
            <Stack alignItems={{ md: 'center', xs: 'stretch' }} direction={{ md: 'row', xs: 'column' }} spacing={1}>
              <Button
                disabled={isBatchConfirming}
                type="button"
                variant={isBatchModeEnabled ? 'contained' : 'outlined'}
                onClick={() => {
                  setIsBatchModeEnabled((current) => {
                    const next = !current;
                    batchSelectionAnchorId.current = null;
                    if (!next) {
                      setSelectedBatchCandidateIds(new Set());
                    }
                    return next;
                  });
                  setSaveError('');
                  setSaveMessage('');
                }}
              >
                {isBatchModeEnabled ? 'Exit batch confirmation' : 'Batch confirmation'}
              </Button>
              {isBatchModeEnabled ? (
                <>
                  <Button
                    disabled={selectableBatchCandidateIds.length === 0 || isBatchConfirming}
                    type="button"
                    variant="outlined"
                    onClick={() => setSelectedBatchCandidateIds(new Set(selectableBatchCandidateIds))}
                  >
                    Select all loaded ({selectableBatchCandidateIds.length})
                  </Button>
                  <Button
                    disabled={selectedBatchCandidateIds.size === 0 || isBatchConfirming}
                    type="button"
                    variant="text"
                    onClick={() => {
                      batchSelectionAnchorId.current = null;
                      setSelectedBatchCandidateIds(new Set());
                    }}
                  >
                    Clear selection
                  </Button>
                  <Button
                    disabled={selectedBatchCandidateIds.size === 0 || isBatchConfirming}
                    type="button"
                    variant="contained"
                    onClick={() => {
                      void handleBatchConfirmSelected(true);
                    }}
                  >
                    {isBatchConfirming ? 'Confirming...' : 'Confirm selected boardgames'}
                  </Button>
                  <Button
                    color="error"
                    disabled={selectedBatchCandidateIds.size === 0 || isBatchConfirming}
                    type="button"
                    variant="outlined"
                    onClick={() => {
                      void handleBatchConfirmSelected(false);
                    }}
                  >
                    {isBatchConfirming ? 'Confirming...' : 'Mark selected not boardgames'}
                  </Button>
                  <Typography color="text.secondary" variant="body2">
                    {batchProgress
                      ? `Confirming ${batchProgress.current} / ${batchProgress.total}`
                      : `${selectedBatchCandidateIds.size} selected`}
                  </Typography>
                  {!batchProgress ? (
                    <Typography color="text.secondary" variant="caption">
                      Use the checkboxes or select all loaded. Shift-click selects a range on desktop.
                    </Typography>
                  ) : null}
                </>
              ) : null}
            </Stack>
          ) : null}
        </Stack>
      </Box>

      {state === 'loading' && viewMode === 'table' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading store items</Typography>
        </Stack>
      ) : null}

      {detailState === 'loading' && viewMode === 'form' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading store item</Typography>
        </Stack>
      ) : null}

      {state === 'error' && viewMode === 'table' ? <Alert severity="error">Store items could not be loaded.</Alert> : null}
      {detailState === 'error' && viewMode === 'form' ? <Alert severity="error">Store item could not be loaded.</Alert> : null}
      <FloatingSuccessAlert message={saveMessage} onClose={() => setSaveMessage('')} />
      <CoverFlatteningDialog
        request={coverFlatteningRequest}
        onAccepted={(result) => {
          setCoverFlatteningRequest(null);
          if (detailMode === 'review') {
            reloadPage();
            return;
          }
          setLinkedItemRefreshToken((currentToken) => currentToken + 1);
          setSaveMessage(`Flattened cover saved as ${result.target_field === 'image_url' ? 'image' : 'Spanish image'}.`);
        }}
        onClose={() => setCoverFlatteningRequest(null)}
      />
      {viewMode === 'table' && saveError ? <Alert severity="error">{saveError}</Alert> : null}

      {detailState === 'ready' && viewMode === 'form' && selectedCandidate ? (
        <ItemCandidateForm
          candidate={selectedCandidate}
          detailMode={detailMode}
          isCreatingBggItem={isCreatingBggItem}
          isCreatingItem={isCreatingItem}
          isDeleting={isDeleting}
          isSaving={isSaving}
          linkedItemRefreshToken={linkedItemRefreshToken}
          localCoverWorkflow={localCoverWorkflow}
          localCoverWorkflowError={localCoverWorkflowError}
          onBack={() => {
            setSelectedCandidate(null);
            setDetailState('ready');
            setLocalCoverWorkflow(null);
            setLocalCoverWorkflowError('');
            setSaveError('');
            setSaveMessage('');
            setViewMode('table');
            onClearSelectedCandidateId?.();
          }}
          onCreateItemFromBggId={handleCreateItemFromBggId}
          onDelete={handleDeleteCandidate}
          onLinkedItemUpdated={() => setLinkedItemRefreshToken((currentToken) => currentToken + 1)}
          onLinkedItemSaved={detailMode === 'review' ? reloadPage : undefined}
          onManualAiMatch={detailMode === 'review' ? handleManualAiMatch : undefined}
          onPrimaryItemAssociated={handlePrimaryItemAssociated}
          onSave={handleSaveCandidate}
          onSetListingStatus={handleSetListingStatus}
          onTranslateAndApprove={handleTranslateAndApprove}
          onCreateItem={handleCreateItemFromCandidate}
          onStartCoverFlattening={handleStartCoverFlattening}
          onStartLocalCoverWorkflow={handleStartLocalCoverWorkflow}
          saveError={saveError}
          preparingCoverFlatteningCandidateId={preparingCoverFlatteningCandidateId}
          startingCoverWorkflowId={startingCoverWorkflowId}
          startingTranslateAndApproveCandidateId={startingTranslateAndApproveCandidateId}
          updatingListingStatusCandidateId={updatingListingStatusCandidateId}
        />
      ) : null}

      {state === 'ready' && viewMode === 'table' ? (
        <DataTable
          ariaLabel="Store items"
          columns={itemCandidateColumns}
          getRowKey={(row, index) => field(row, ['id'], String(index))}
          mobileActionLabel={(row) => `Open ${field(row, ['title', 'name'], 'store item')}`}
          minWidth={isBatchModeEnabled ? 3466 : 3394}
          onRowDoubleClick={(row) => {
            setDetailState('ready');
            setLocalCoverWorkflow(null);
            setLocalCoverWorkflowError('');
            setSaveError('');
            setSaveMessage('');
            setSelectedCandidate(row);
            setViewMode('form');
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

function ItemCandidateForm({
  candidate,
  detailMode,
  isCreatingBggItem,
  isCreatingItem,
  isDeleting,
  isSaving,
  linkedItemRefreshToken,
  localCoverWorkflow,
  localCoverWorkflowError,
  onBack,
  onCreateItemFromBggId,
  onCreateItem,
  onDelete,
  onLinkedItemUpdated,
  onLinkedItemSaved,
  onManualAiMatch,
  onPrimaryItemAssociated,
  onSave,
  onSetListingStatus,
  onTranslateAndApprove,
  onStartCoverFlattening,
  onStartLocalCoverWorkflow,
  preparingCoverFlatteningCandidateId,
  saveError,
  startingCoverWorkflowId,
  startingTranslateAndApproveCandidateId,
  updatingListingStatusCandidateId
}: {
  candidate: AdminRecord;
  detailMode: DetailMode;
  isCreatingBggItem: boolean;
  isCreatingItem: boolean;
  isDeleting: boolean;
  isSaving: boolean;
  linkedItemRefreshToken: number;
  localCoverWorkflow: LocalCoverWorkflow | null;
  localCoverWorkflowError: string;
  onBack: () => void;
  onCreateItemFromBggId: (bggId: string) => void;
  onCreateItem: (input?: CreateItemFromCandidateInput) => Promise<void>;
  onDelete: () => Promise<boolean>;
  onLinkedItemUpdated: () => void;
  onLinkedItemSaved?: () => void;
  onManualAiMatch?: (candidate: AdminRecord, result: ManualAiBggMatchResult) => void;
  onPrimaryItemAssociated: (candidate: AdminRecord, item: AdminRecord) => void;
  onSave: (input: AdminRecord) => void;
  onSetListingStatus: (candidate: AdminRecord, listingStatus: StoreItemListingStatus) => void;
  onTranslateAndApprove: (candidate: AdminRecord) => void;
  onStartCoverFlattening: (candidate: AdminRecord) => void | Promise<void>;
  onStartLocalCoverWorkflow: (candidate: AdminRecord) => void;
  preparingCoverFlatteningCandidateId: string;
  saveError: string;
  startingCoverWorkflowId: string;
  startingTranslateAndApproveCandidateId: string;
  updatingListingStatusCandidateId: string;
}) {
  const title = field(candidate, ['title'], 'Item candidate');
  const candidateIdValue = field(candidate, ['id'], '');
  const imageUrl = field(candidate, ['image_url'], '');
  const itemId = field(candidate, ['item_id'], '');
  const listingStatus = field(candidate, ['listing_status'], '').toUpperCase();
  const matchedBggId = field(candidate, ['matched_bgg_id'], '');
  const sourceUrl = field(candidate, ['source_url'], '');
  const detailFields = detailMode === 'review' ? storeItemReviewDetailFields : itemCandidateDetailFields;
  const formKey = detailFields.map((detailField) => detailValue(candidate, detailField.key)).join('\u001f');
  const [bggDialogBggId, setBggDialogBggId] = useState(matchedBggId);
  const [isBggDialogOpen, setIsBggDialogOpen] = useState(false);
  const [isCandidateDialogOpen, setIsCandidateDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [candidateDialogBggId, setCandidateDialogBggId] = useState(matchedBggId);
  const [candidateExtends, setCandidateExtends] = useState(false);
  const [candidateExtendsItemId, setCandidateExtendsItemId] = useState('');
  const [candidateImplements, setCandidateImplements] = useState(false);
  const [isGeneratingTranslation, setIsGeneratingTranslation] = useState(false);
  const [linkedItemPreview, setLinkedItemPreview] = useState<AdminRecord | null>(null);
  const [translationError, setTranslationError] = useState('');
  const hasGeneratedTranslation = Boolean(linkedItemPreview && field(linkedItemPreview, ['description_es'], '').trim());
  const canGenerateTranslation = Boolean(
    linkedItemPreview &&
      field(linkedItemPreview, ['canonical_name_es', 'canonical_name'], '') &&
      (field(linkedItemPreview, ['description'], '') || field(candidate, ['description'], ''))
  );

  useEffect(() => {
    setBggDialogBggId(matchedBggId);
    setCandidateDialogBggId(matchedBggId);
  }, [matchedBggId]);

  useEffect(() => {
    setIsGeneratingTranslation(false);
    setTranslationError('');
  }, [itemId]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isDeleting) {
      return;
    }
    onSave(itemCandidateInputFromForm(new FormData(event.currentTarget), detailFields, detailMode === 'review' ? candidate : undefined));
  }

  const canConfirmBggDialog =
    Boolean(bggDialogBggId.trim()) && !isSaving && !isCreatingBggItem && !isCreatingItem && !isDeleting;
  const canConfirmCandidateDialog =
    !isSaving &&
    !isCreatingBggItem &&
    !isCreatingItem &&
    !isDeleting &&
    (!candidateImplements || Boolean(candidateDialogBggId.trim())) &&
    (!candidateExtends || Boolean(candidateExtendsItemId.trim()));
  const isStartingCoverWorkflow = Boolean(candidateIdValue && candidateIdValue === startingCoverWorkflowId);
  const canStartCoverWorkflow = Boolean(candidateIdValue && imageUrl && itemId && !isStartingCoverWorkflow && !isDeleting);
  const isPreparingCoverFlattening =
    Boolean(candidateIdValue) && candidateIdValue === preparingCoverFlatteningCandidateId;
  const canStartCoverFlattening = Boolean(
    candidateIdValue &&
      itemId &&
      !isPreparingCoverFlattening &&
      !isDeleting &&
      (detailMode === 'review' || imageUrl)
  );
  const isUpdatingListingStatus =
    Boolean(candidateIdValue) && candidateIdValue === updatingListingStatusCandidateId;
  const isStartingTranslateAndApprove =
    Boolean(candidateIdValue) && candidateIdValue === startingTranslateAndApproveCandidateId;

  async function handleConfirmBggDialog() {
    await onCreateItemFromBggId(bggDialogBggId);
    setIsBggDialogOpen(false);
  }

  async function handleConfirmCandidateDialog() {
    await onCreateItem({
      bgg_id: candidateDialogBggId.trim(),
      extends: candidateExtends,
      extends_item_id: candidateExtendsItemId.trim(),
      implements: candidateImplements
    });
    setIsCandidateDialogOpen(false);
  }

  async function handleConfirmDelete() {
    if (await onDelete()) {
      setIsDeleteDialogOpen(false);
    }
  }

  async function handleGenerateTranslation() {
    if (!linkedItemPreview || isGeneratingTranslation) {
      return;
    }

    const linkedItemId = field(linkedItemPreview, ['id'], itemId);
    const itemName = field(linkedItemPreview, ['canonical_name_es', 'canonical_name'], '');
    const itemDescription = field(linkedItemPreview, ['description'], '');
    const storeItemDescription = field(candidate, ['description'], '');

    if (!linkedItemId || !itemName || (!itemDescription && !storeItemDescription)) {
      setTranslationError('An item name and at least one source description are required.');
      return;
    }

    setIsGeneratingTranslation(true);
    setTranslationError('');
    try {
      const generated = await adminApi.generateDescription({
        boardgame_name: itemName,
        description_1: itemDescription,
        description_2: storeItemDescription
      });
      const savedItem = await adminApi.updateItem(linkedItemId, {
        ...linkedItemPreview,
        description_es: generated.description_es
      });
      setLinkedItemPreview(savedItem);
      onLinkedItemUpdated();
    } catch {
      setTranslationError('Spanish item description could not be saved.');
    } finally {
      setIsGeneratingTranslation(false);
    }
  }

  return (
    <Stack spacing={2}>
      <Paper component="section" variant="outlined" sx={{ p: 2 }}>
        <Stack component="form" key={formKey} spacing={2} onSubmit={handleSubmit}>
        <Stack alignItems="flex-start" direction={{ sm: 'row', xs: 'column' }} justifyContent="space-between" spacing={1.5}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              {detailMode === 'review' ? 'Store Item Review Details' : 'Store Item Details'}
            </Typography>
            <Typography color="text.secondary" variant="body2">
              {title}
            </Typography>
          </Box>
          <Stack direction={{ sm: 'row', xs: 'column' }} spacing={1} sx={{ width: { sm: 'auto', xs: '100%' } }}>
            <Tooltip title={canStartCoverWorkflow ? 'Start cover workflow' : 'Requires a linked item and image'}>
              <span>
                <Button
                  aria-label={`Start cover workflow for ${title}`}
                  disabled={!canStartCoverWorkflow}
                  startIcon={isStartingCoverWorkflow ? <CircularProgress size={18} /> : <ImageSearchIcon />}
                  sx={{ width: { sm: 'auto', xs: '100%' } }}
                  type="button"
                  variant="outlined"
                  onClick={() => onStartLocalCoverWorkflow(candidate)}
                >
                  {isStartingCoverWorkflow ? 'Starting...' : 'Start cover workflow'}
                </Button>
              </span>
            </Tooltip>
            <Tooltip title={canStartCoverFlattening ? 'Flatten cover' : 'Requires a linked item and available cover image'}>
              <span>
                <Button
                  aria-label={`Flatten cover for ${title}`}
                  disabled={!canStartCoverFlattening}
                  startIcon={isPreparingCoverFlattening ? <CircularProgress size={18} /> : <AutoFixHighIcon />}
                  sx={{ width: { sm: 'auto', xs: '100%' } }}
                  type="button"
                  variant="outlined"
                  onClick={() => void onStartCoverFlattening(candidate)}
                >
                  {isPreparingCoverFlattening ? 'Loading sources...' : 'Flatten cover'}
                </Button>
              </span>
            </Tooltip>
            <Button disabled={isSaving || isDeleting} startIcon={<SaveIcon />} type="submit" variant="contained">
              {isSaving ? 'Saving...' : 'Save Store Item'}
            </Button>
            <Button disabled={isDeleting} startIcon={<ArrowBackIcon />} type="button" variant="outlined" onClick={onBack}>
              {detailMode === 'review' ? 'Back to Review' : 'Back to Store Items'}
            </Button>
            <Button
              color="error"
              disabled={isDeleting || isSaving || isCreatingBggItem || isCreatingItem}
              startIcon={isDeleting ? <CircularProgress color="inherit" size={18} /> : <DeleteIcon />}
              type="button"
              variant="outlined"
              onClick={() => setIsDeleteDialogOpen(true)}
            >
              {isDeleting ? 'Deleting...' : 'Delete Store Item'}
            </Button>
          </Stack>
        </Stack>

        <Stack alignItems={{ md: 'center', xs: 'stretch' }} direction={{ md: 'row', xs: 'column' }} spacing={1}>
          {detailMode === 'review' ? (
            <>
              <Button
                color="success"
                disabled={
                  !candidateIdValue ||
                  !hasGeneratedTranslation ||
                  isUpdatingListingStatus ||
                  listingStatus === 'LISTED'
                }
                startIcon={
                  isUpdatingListingStatus ? <CircularProgress color="inherit" size={18} /> : <CheckCircleIcon />
                }
                type="button"
                variant="contained"
                onClick={() => onSetListingStatus(candidate, 'LISTED')}
              >
                Approve listing
              </Button>
              {!hasGeneratedTranslation ? (
                <Tooltip
                  title={
                    canGenerateTranslation
                      ? 'Generate the translation in the background and approve only when it succeeds'
                      : 'Requires an item name and at least one source description'
                  }
                >
                  <span>
                    <Button
                      color="success"
                      disabled={
                        !candidateIdValue ||
                        !canGenerateTranslation ||
                        isStartingTranslateAndApprove ||
                        isUpdatingListingStatus ||
                        listingStatus !== 'PENDING'
                      }
                      startIcon={
                        isStartingTranslateAndApprove ? (
                          <CircularProgress color="inherit" size={18} />
                        ) : (
                          <AutoFixHighIcon />
                        )
                      }
                      type="button"
                      variant="outlined"
                      onClick={() => onTranslateAndApprove(candidate)}
                    >
                      {isStartingTranslateAndApprove ? 'Starting...' : 'Translate and approve'}
                    </Button>
                  </span>
                </Tooltip>
              ) : null}
              <Button
                color="error"
                disabled={!candidateIdValue || isUpdatingListingStatus || listingStatus === 'REJECTED'}
                startIcon={
                  isUpdatingListingStatus ? <CircularProgress color="inherit" size={18} /> : <CancelIcon />
                }
                type="button"
                variant="outlined"
                onClick={() => onSetListingStatus(candidate, 'REJECTED')}
              >
                Reject listing
              </Button>
              <Typography color="text.secondary" variant="body2">
                Listing status: {listingStatus || 'Unknown'}
              </Typography>
            </>
          ) : null}
          <Button
            disabled={isSaving || isCreatingBggItem || isCreatingItem || isDeleting}
            sx={{ minHeight: 40, minWidth: { md: 190 }, textTransform: 'none', whiteSpace: 'nowrap' }}
            type="button"
            variant="outlined"
            onClick={() => {
              setBggDialogBggId(matchedBggId);
              setIsBggDialogOpen(true);
            }}
          >
            {isCreatingBggItem ? 'Creating BGG item...' : 'Create item from BGG ID'}
          </Button>
          <Button
            disabled={isSaving || isCreatingItem || isCreatingBggItem || isDeleting}
            startIcon={<AddCircleIcon />}
            sx={{ minHeight: 40, minWidth: { md: 230 }, textTransform: 'none', whiteSpace: 'nowrap' }}
            type="button"
            variant="outlined"
            onClick={() => {
              setCandidateDialogBggId(matchedBggId);
              setCandidateExtends(false);
              setCandidateExtendsItemId('');
              setCandidateImplements(false);
              setIsCandidateDialogOpen(true);
            }}
          >
            {isCreatingItem ? 'Creating Item...' : 'Create Item from Candidate'}
          </Button>
        </Stack>

        {saveError ? <Alert severity="error">{saveError}</Alert> : null}
        {localCoverWorkflowError ? <Alert severity="error">{localCoverWorkflowError}</Alert> : null}
        {localCoverWorkflow ? (
          <Alert severity="success">
            <Stack spacing={0.5}>
              <Typography variant="body2">Cover workflow started for {localCoverWorkflow.filename}.</Typography>
              <Typography color="text.secondary" variant="caption">
                Save the edited cover to one of:
              </Typography>
              {(localCoverWorkflow.expected_paths?.length ? localCoverWorkflow.expected_paths : [localCoverWorkflow.expected_path]).map(
                (expectedPath) => (
                  <Typography component="code" key={expectedPath} sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }} variant="body2">
                    {expectedPath}
                  </Typography>
                )
              )}
            </Stack>
          </Alert>
        ) : null}

        {detailMode === 'review' ? (
          <>
            <ReviewCoverComparison
              canGenerateTranslation={canGenerateTranslation}
              isGeneratingTranslation={isGeneratingTranslation}
              item={linkedItemPreview}
              itemId={itemId}
              translationError={translationError}
              storeItemImageUrl={imageUrl}
              storeItemTitle={title}
              onGenerateTranslation={() => void handleGenerateTranslation()}
            />
            <Stack direction={{ sm: 'row', xs: 'column' }} spacing={2}>
              {sourceUrl ? (
                <Link href={sourceUrl} rel="noreferrer" target="_blank">
                  Open product page
                </Link>
              ) : null}
              {imageUrl ? (
                <Link href={imageUrl} rel="noreferrer" target="_blank">
                  Open image
                </Link>
              ) : null}
            </Stack>
          </>
        ) : (
          <Stack alignItems={{ md: 'flex-start', xs: 'stretch' }} direction={{ md: 'row', xs: 'column' }} spacing={2}>
            {imageUrl ? (
              <Box
                alt={`${title} candidate image`}
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
              {sourceUrl ? (
                <Link href={sourceUrl} rel="noreferrer" target="_blank">
                  Open product page
                </Link>
              ) : null}
              {imageUrl ? (
                <Link href={imageUrl} rel="noreferrer" target="_blank">
                  Open image
                </Link>
              ) : null}
            </Stack>
          </Stack>
        )}

        <PrimaryItemSection
          itemId={itemId}
          onAiMatch={onManualAiMatch}
          onItemLoaded={detailMode === 'review' ? setLinkedItemPreview : undefined}
          onItemUpdated={onLinkedItemUpdated}
          refreshToken={detailMode === 'review' ? linkedItemRefreshToken : 0}
          storeItemId={candidateIdValue}
          storeItemImageUrl={imageUrl}
          storeItemTitle={title}
          onAssociated={onPrimaryItemAssociated}
        />

        <AdditionalItemsSection
          primaryItemId={itemId}
          storeItemId={candidateIdValue}
          storeItemTitle={title}
        />

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
          {detailFields.map((detailField) =>
            detailField.fieldType === 'boolean' ? (
              <FormControlLabel
                control={
                  <Checkbox
                    defaultChecked={booleanValue(candidate, detailField.key)}
                    name={detailField.readOnly ? undefined : detailField.key}
                  />
                }
                key={detailField.key}
                label={detailField.label}
                sx={{ gridColumn: detailField.gridColumn }}
              />
            ) : (
              <TextField
                defaultValue={detailValue(candidate, detailField.key)}
                fullWidth
                InputProps={{ readOnly: detailField.readOnly }}
                key={detailField.key}
                label={detailField.label}
                minRows={detailField.multiline ? 3 : undefined}
                multiline={detailField.multiline}
                name={detailField.readOnly ? undefined : detailField.key}
                sx={{ gridColumn: detailField.gridColumn }}
              />
            )
          )}
        </Box>
        </Stack>

        <Dialog fullWidth maxWidth="xs" open={isBggDialogOpen} onClose={() => setIsBggDialogOpen(false)}>
        <DialogTitle>Create Item from BGG</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="BGG ID"
            margin="dense"
            value={bggDialogBggId}
            onChange={(event) => setBggDialogBggId(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button type="button" onClick={() => setIsBggDialogOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!canConfirmBggDialog} type="button" variant="contained" onClick={handleConfirmBggDialog}>
            Create BGG Item
          </Button>
        </DialogActions>
        </Dialog>

        <Dialog fullWidth maxWidth="xs" open={isDeleteDialogOpen} onClose={() => !isDeleting && setIsDeleteDialogOpen(false)}>
        <DialogTitle>Delete Store Item</DialogTitle>
        <DialogContent>
          <Typography>
            Delete “{title}”? This permanently removes the store item and its review data. A linked catalog item will not be deleted.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button disabled={isDeleting} type="button" onClick={() => setIsDeleteDialogOpen(false)}>
            Cancel
          </Button>
          <Button color="error" disabled={isDeleting} type="button" variant="contained" onClick={handleConfirmDelete}>
            {isDeleting ? 'Deleting...' : 'Delete Store Item'}
          </Button>
        </DialogActions>
        </Dialog>

        <Dialog fullWidth maxWidth="xs" open={isCandidateDialogOpen} onClose={() => setIsCandidateDialogOpen(false)}>
        <DialogTitle>Create Item from Candidate</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <FormControlLabel
              control={
                <Checkbox checked={candidateImplements} onChange={(event) => setCandidateImplements(event.target.checked)} />
              }
              label="Implements"
            />
            <TextField
              fullWidth
              label="BGG ID"
              value={candidateDialogBggId}
              onChange={(event) => setCandidateDialogBggId(event.target.value)}
            />
            <FormControlLabel
              control={
                <Checkbox checked={candidateExtends} onChange={(event) => setCandidateExtends(event.target.checked)} />
              }
              label="Extends"
            />
            <TextField
              fullWidth
              label="Extends Item ID"
              value={candidateExtendsItemId}
              onChange={(event) => setCandidateExtendsItemId(event.target.value)}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button type="button" onClick={() => setIsCandidateDialogOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!canConfirmCandidateDialog} type="button" variant="contained" onClick={handleConfirmCandidateDialog}>
            Create Item
          </Button>
        </DialogActions>
        </Dialog>
      </Paper>

      {detailMode === 'review' && itemId ? (
        <ItemsPage
          detailOnly
          detailVariant="review"
          onItemSaved={onLinkedItemSaved}
          refreshToken={linkedItemRefreshToken}
          selectedItemId={itemId}
        />
      ) : null}
      {detailMode === 'review' && !itemId ? (
        <Alert severity="info">Link or create a catalog item to edit its review fields.</Alert>
      ) : null}
    </Stack>
  );
}

const reviewCoverFrameSx = {
  backgroundColor: 'grey.300',
  border: 1,
  borderColor: 'grey.500',
  borderRadius: 1.5,
  boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.35), 0 1px 3px rgba(15, 23, 42, 0.18)',
  boxSizing: 'border-box',
  height: 'auto',
  overflow: 'hidden',
  width: '100%'
} as const;

const reviewCoverFrameStyle = {
  aspectRatio: '1 / 1',
  backgroundImage: 'linear-gradient(135deg, #aeb7c2 0%, #d7dce1 52%, #9fa9b5 100%)'
} as const;

function ReviewCoverComparison({
  canGenerateTranslation,
  isGeneratingTranslation,
  item,
  itemId,
  onGenerateTranslation,
  storeItemImageUrl,
  storeItemTitle,
  translationError
}: {
  canGenerateTranslation: boolean;
  isGeneratingTranslation: boolean;
  item: AdminRecord | null;
  itemId: string;
  onGenerateTranslation: () => void;
  storeItemImageUrl: string;
  storeItemTitle: string;
  translationError: string;
}) {
  const itemImageUrl = item ? catalogItemImageUrl(item) : '';
  const itemName = item ? reviewItemDisplayName(item) : itemId ? `Item ${itemId}` : 'No linked item';
  const translationGenerated = Boolean(item && field(item, ['description_es'], '').trim());
  const covers = [
    {
      alt: `${storeItemTitle} store item cover`,
      imageUrl: storeItemImageUrl,
      label: 'Store item',
      name: storeItemTitle
    },
    {
      alt: `${itemName} item cover`,
      imageUrl: itemImageUrl,
      label: 'Item',
      name: itemName
    }
  ];

  return (
    <Box
      aria-label="Store item and linked item cover comparison"
      role="group"
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        maxWidth: 560,
        width: '100%'
      }}
    >
      {covers.map((cover) => (
        <Stack alignItems="center" key={cover.label} spacing={1} sx={{ minWidth: 0 }}>
          <Typography color="text.secondary" variant="caption">
            {cover.label}
          </Typography>
          {cover.imageUrl ? (
            <Box
              alt={cover.alt}
              component="img"
              src={cover.imageUrl}
              style={reviewCoverFrameStyle}
              sx={{
                ...reviewCoverFrameSx,
                objectFit: 'contain'
              }}
            />
          ) : (
            <Box
              alignItems="center"
              display="flex"
              justifyContent="center"
              style={reviewCoverFrameStyle}
              sx={{
                ...reviewCoverFrameSx,
                color: 'text.secondary'
              }}
            >
              <Typography variant="body2">No cover</Typography>
            </Box>
          )}
          <Typography
            aria-label={`${cover.label} name`}
            sx={{ fontWeight: 600, overflowWrap: 'anywhere', textAlign: 'center' }}
            variant="body2"
          >
            {cover.name}
          </Typography>
        </Stack>
      ))}
      <Stack alignItems="center" spacing={1} sx={{ gridColumn: '1 / -1' }}>
        {translationGenerated ? (
          <Stack
            alignItems="center"
            aria-label="Translation generated"
            direction="row"
            role="status"
            spacing={0.75}
          >
            <CheckCircleIcon color="success" fontSize="small" />
            <Typography color="success.main" sx={{ fontWeight: 600 }} variant="body2">
              Translation generated
            </Typography>
          </Stack>
        ) : (
          <Tooltip
            title={
              canGenerateTranslation
                ? 'Generate Spanish item description'
                : 'Requires an item name and at least one source description'
            }
          >
            <span>
              <Button
                disabled={!canGenerateTranslation || isGeneratingTranslation}
                startIcon={isGeneratingTranslation ? <CircularProgress size={16} /> : <AutoFixHighIcon />}
                type="button"
                variant="outlined"
                onClick={onGenerateTranslation}
              >
                {isGeneratingTranslation ? 'Generating translation...' : 'Generate translation'}
              </Button>
            </span>
          </Tooltip>
        )}
        {translationError ? <Alert severity="error">{translationError}</Alert> : null}
      </Stack>
    </Box>
  );
}

function PrimaryItemSection({
  itemId,
  onAiMatch,
  onItemLoaded,
  onItemUpdated,
  onAssociated,
  refreshToken,
  storeItemId,
  storeItemImageUrl,
  storeItemTitle
}: {
  itemId: string;
  onAiMatch?: (candidate: AdminRecord, result: ManualAiBggMatchResult) => void;
  onItemLoaded?: (item: AdminRecord | null) => void;
  onItemUpdated: (item: AdminRecord) => void;
  onAssociated: (candidate: AdminRecord, item: AdminRecord) => void;
  refreshToken: number;
  storeItemId: string;
  storeItemImageUrl: string;
  storeItemTitle: string;
}) {
  const [copyError, setCopyError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [copyTargetField, setCopyTargetField] = useState<'image_url' | 'image_url_es'>('image_url');
  const [error, setError] = useState('');
  const [aiMatchMessage, setAiMatchMessage] = useState('');
  const [isAssociating, setIsAssociating] = useState(false);
  const [isCopyingCover, setIsCopyingCover] = useState(false);
  const [isMatchingWithAi, setIsMatchingWithAi] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [item, setItem] = useState<AdminRecord | null>(null);
  const [loadState, setLoadState] = useState<LoadState>(itemId ? 'loading' : 'ready');

  useEffect(() => {
    setCopyError('');
    setCopyMessage('');
  }, [itemId]);

  useEffect(() => {
    if (!itemId) {
      setItem(null);
      onItemLoaded?.(null);
      setLoadState('ready');
      return;
    }

    let ignore = false;
    setItem(null);
    onItemLoaded?.(null);
    setLoadState('loading');
    adminApi
      .getItem(itemId)
      .then((linkedItem) => {
        if (!ignore) {
          setItem(linkedItem);
          onItemLoaded?.(linkedItem);
          setLoadState('ready');
        }
      })
      .catch(() => {
        if (!ignore) {
          setItem(null);
          onItemLoaded?.(null);
          setLoadState('error');
        }
      });

    return () => {
      ignore = true;
    };
  }, [itemId, onItemLoaded, refreshToken]);

  const linkedItemId = item ? field(item, ['id'], itemId) : itemId;
  const itemName = item ? catalogItemDisplayName(item) : '';
  const imageUrl = item ? catalogItemImageUrl(item) : '';
  const excludedItemIds = useMemo(() => new Set(itemId ? [itemId] : []), [itemId]);
  const canCopyCover = Boolean(storeItemId && storeItemImageUrl && linkedItemId && item && loadState === 'ready' && !isCopyingCover);

  async function handleAssociate(selectedItem: AdminRecord) {
    const selectedItemId = field(selectedItem, ['id'], '');
    if (!storeItemId || !selectedItemId) {
      setError('The store item or catalog item is missing an ID.');
      return;
    }

    setIsAssociating(true);
    setError('');
    try {
      const savedCandidate = await adminApi.associateItemCandidate(storeItemId, selectedItemId);
      onAssociated(savedCandidate, selectedItem);
      setIsSearchOpen(false);
    } catch {
      setError('The store item could not be associated with this catalog item.');
    } finally {
      setIsAssociating(false);
    }
  }

  async function handleAiMatch() {
    if (!storeItemId || !onAiMatch || isMatchingWithAi) {
      return;
    }

    setIsMatchingWithAi(true);
    setError('');
    setAiMatchMessage('');
    try {
      const response = await adminApi.matchItemCandidateWithAi(storeItemId);
      onAiMatch(response.candidate, response.result);
      if (response.result.status === 'not_found') {
        setAiMatchMessage('AI did not find a reliable BGG match.');
      }
    } catch {
      setError('AI matching could not be completed.');
    } finally {
      setIsMatchingWithAi(false);
    }
  }

  async function handleCopyCover() {
    if (!canCopyCover) {
      return;
    }

    setIsCopyingCover(true);
    setCopyError('');
    setCopyMessage('');
    try {
      const savedItem = await adminApi.copyStoreItemCoverToItem(storeItemId, copyTargetField);
      setItem(savedItem);
      onItemLoaded?.(savedItem);
      onItemUpdated(savedItem);
      setCopyMessage(
        `Store item cover copied to the linked item's ${copyTargetField === 'image_url' ? 'image' : 'Spanish image'}.`
      );
    } catch {
      setCopyError('The store item cover could not be copied to the linked item.');
    } finally {
      setIsCopyingCover(false);
    }
  }

  return (
    <>
      <Paper sx={{ p: 2 }} variant="outlined">
        <Stack spacing={1.5}>
          <Stack
            alignItems={{ sm: 'center', xs: 'stretch' }}
            direction={{ sm: 'row', xs: 'column' }}
            justifyContent="space-between"
            spacing={1}
          >
            <Box>
              <Typography fontWeight={700}>Linked item</Typography>
              <Typography color="text.secondary" variant="body2">
                Primary catalog item for this store item.
              </Typography>
            </Box>
            <Stack direction={{ sm: 'row', xs: 'column' }} spacing={1}>
              {onAiMatch ? (
                <Button
                  disabled={!storeItemId || isMatchingWithAi || isAssociating}
                  startIcon={isMatchingWithAi ? <CircularProgress size={18} /> : <AutoFixHighIcon />}
                  type="button"
                  variant="contained"
                  onClick={() => void handleAiMatch()}
                >
                  {isMatchingWithAi ? 'Matching...' : 'Match AI'}
                </Button>
              ) : null}
              <Button
                disabled={!storeItemId || loadState === 'loading' || isMatchingWithAi}
                startIcon={<AddCircleIcon />}
                type="button"
                variant="outlined"
                onClick={() => {
                  setError('');
                  setAiMatchMessage('');
                  setIsSearchOpen(true);
                }}
              >
                {itemId ? 'Change linked item' : 'Link item'}
              </Button>
            </Stack>
          </Stack>

          {!itemId ? <Alert severity="info">No primary catalog item is linked.</Alert> : null}
          {aiMatchMessage ? <Alert severity="info">{aiMatchMessage}</Alert> : null}
          {error && !isSearchOpen ? <Alert severity="error">{error}</Alert> : null}
          {copyError ? <Alert severity="error">{copyError}</Alert> : null}
          {copyMessage ? <Alert severity="success">{copyMessage}</Alert> : null}
          <Stack alignItems={{ sm: 'center', xs: 'stretch' }} direction={{ sm: 'row', xs: 'column' }} spacing={1}>
            <TextField
              disabled={!itemId || !storeItemImageUrl || isCopyingCover}
              label="Copy cover as"
              select
              size="small"
              sx={{ minWidth: 180 }}
              value={copyTargetField}
              onChange={(event) => setCopyTargetField(event.target.value as 'image_url' | 'image_url_es')}
            >
              <MenuItem value="image_url">Image</MenuItem>
              <MenuItem value="image_url_es">Spanish image</MenuItem>
            </TextField>
            <Tooltip title={canCopyCover ? 'Copy the store item cover URL to the linked item' : 'Requires a linked item and store item image'}>
              <Box component="span">
                <Button
                  disabled={!canCopyCover}
                  startIcon={isCopyingCover ? <CircularProgress size={18} /> : <ContentCopyIcon />}
                  type="button"
                  variant="outlined"
                  onClick={handleCopyCover}
                >
                  {isCopyingCover ? 'Copying...' : 'Copy cover to item'}
                </Button>
              </Box>
            </Tooltip>
          </Stack>
          {loadState === 'loading' ? (
            <Stack alignItems="center" direction="row" spacing={1.5}>
              <CircularProgress size={18} />
              <Typography color="text.secondary" variant="body2">
                Loading linked item
              </Typography>
            </Stack>
          ) : null}
          {loadState === 'error' ? <Alert severity="error">Linked item details could not be loaded.</Alert> : null}
          {loadState === 'ready' && item ? (
            <Stack
              alignItems="center"
              direction="row"
              spacing={1.5}
              sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}
            >
              <Avatar
                alt={`${itemName} cover`}
                src={imageUrl || undefined}
                sx={{ bgcolor: 'grey.100', height: 72, width: 72, '& img': { objectFit: 'contain' } }}
                variant="rounded"
              />
              <Box sx={{ minWidth: 0 }}>
                <Link href={`#items?id=${encodeURIComponent(linkedItemId)}`} sx={{ fontWeight: 600 }}>
                  {itemName}
                </Link>
                <Typography color="text.secondary" variant="caption">
                  Item {linkedItemId}
                </Typography>
              </Box>
            </Stack>
          ) : null}
        </Stack>
      </Paper>

      <CatalogItemSearchDialog
        dialogTitle="Link Catalog Item"
        error={error}
        excludedItemIds={excludedItemIds}
        initialQuery={storeItemTitle}
        isSubmitting={isAssociating}
        listAriaLabel="Catalog item matches"
        open={isSearchOpen}
        resultActionLabel="Associate with"
        onClose={() => {
          if (!isAssociating) {
            setIsSearchOpen(false);
            setError('');
          }
        }}
        onSelect={handleAssociate}
      />
    </>
  );
}

function AdditionalItemsSection({
  primaryItemId,
  storeItemId,
  storeItemTitle
}: {
  primaryItemId: string;
  storeItemId: string;
  storeItemTitle: string;
}) {
  const [additionalItems, setAdditionalItems] = useState<AdminRecord[]>([]);
  const [deletingItemId, setDeletingItemId] = useState('');
  const [error, setError] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('loading');

  useEffect(() => {
    if (!storeItemId) {
      setAdditionalItems([]);
      setError('');
      setLoadState('ready');
      return;
    }

    let ignore = false;
    setLoadState('loading');
    setError('');
    adminApi
      .getStoreItemAdditionalItems(storeItemId)
      .then((items) => {
        if (!ignore) {
          setAdditionalItems(items);
          setLoadState('ready');
        }
      })
      .catch(() => {
        if (!ignore) {
          setAdditionalItems([]);
          setError('Additional items could not be loaded.');
          setLoadState('error');
        }
      });

    return () => {
      ignore = true;
    };
  }, [primaryItemId, storeItemId]);

  const excludedItemIds = useMemo(
    () =>
      new Set(
        [primaryItemId, ...additionalItems.map((item) => field(item, ['id'], ''))].filter(Boolean)
      ),
    [additionalItems, primaryItemId]
  );

  async function handleAdd(item: AdminRecord) {
    const itemId = field(item, ['id'], '');
    if (!storeItemId || !itemId) {
      setError('The store item or catalog item is missing an ID.');
      return;
    }

    setIsAdding(true);
    setError('');
    try {
      const savedItem = await adminApi.addStoreItemAdditionalItem(storeItemId, itemId);
      setAdditionalItems((currentItems) =>
        [...currentItems.filter((currentItem) => field(currentItem, ['id'], '') !== itemId), savedItem].sort((left, right) =>
          catalogItemDisplayName(left).localeCompare(catalogItemDisplayName(right))
        )
      );
      setIsSearchOpen(false);
    } catch {
      setError('The additional item could not be added.');
    } finally {
      setIsAdding(false);
    }
  }

  async function handleRemove(item: AdminRecord) {
    const itemId = field(item, ['id'], '');
    if (!storeItemId || !itemId) {
      return;
    }

    setDeletingItemId(itemId);
    setError('');
    try {
      await adminApi.deleteStoreItemAdditionalItem(storeItemId, itemId);
      setAdditionalItems((currentItems) =>
        currentItems.filter((currentItem) => field(currentItem, ['id'], '') !== itemId)
      );
    } catch {
      setError('The additional item could not be removed.');
    } finally {
      setDeletingItemId('');
    }
  }

  return (
    <>
      <Paper sx={{ p: 2 }} variant="outlined">
        <Stack spacing={1.5}>
          <Stack alignItems={{ sm: 'center', xs: 'stretch' }} direction={{ sm: 'row', xs: 'column' }} justifyContent="space-between" spacing={1}>
            <Box>
              <Typography fontWeight={700}>Additional items</Typography>
              <Typography color="text.secondary" variant="body2">
                Offers for this store item will also appear on these catalog items.
              </Typography>
            </Box>
            <Button
              disabled={!primaryItemId || loadState === 'loading'}
              startIcon={<AddCircleIcon />}
              type="button"
              variant="outlined"
              onClick={() => {
                setError('');
                setIsSearchOpen(true);
              }}
            >
              Add additional item
            </Button>
          </Stack>

          {!primaryItemId ? (
            <Alert severity="info">Link a primary catalog item before adding additional items.</Alert>
          ) : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
          {loadState === 'loading' ? (
            <Stack alignItems="center" direction="row" spacing={1.5}>
              <CircularProgress size={18} />
              <Typography color="text.secondary" variant="body2">
                Loading additional items
              </Typography>
            </Stack>
          ) : null}
          {loadState === 'ready' && additionalItems.length === 0 ? (
            <Typography color="text.secondary" variant="body2">
              No additional items linked.
            </Typography>
          ) : null}
          {additionalItems.map((item) => {
            const itemId = field(item, ['id'], '');
            const itemName = catalogItemDisplayName(item);
            const imageUrl = catalogItemImageUrl(item);
            return (
              <Stack
                alignItems="center"
                direction="row"
                justifyContent="space-between"
                key={itemId}
                spacing={1}
                sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}
              >
                <Stack alignItems="center" direction="row" spacing={1.5} sx={{ flex: 1, minWidth: 0 }}>
                  <Avatar
                    alt={`${itemName} cover`}
                    src={imageUrl || undefined}
                    sx={{ bgcolor: 'grey.100', height: 64, width: 64, '& img': { objectFit: 'contain' } }}
                    variant="rounded"
                  />
                  <Box sx={{ minWidth: 0 }}>
                    <Link href={`#items?id=${encodeURIComponent(itemId)}`} sx={{ fontWeight: 600 }}>
                      {itemName}
                    </Link>
                    <Typography color="text.secondary" variant="caption">
                      Item {itemId}
                    </Typography>
                  </Box>
                </Stack>
                <Tooltip title="Remove additional item">
                  <span>
                    <IconButton
                      aria-label={`Remove ${itemName}`}
                      color="error"
                      disabled={deletingItemId === itemId}
                      type="button"
                      onClick={() => void handleRemove(item)}
                    >
                      {deletingItemId === itemId ? <CircularProgress size={18} /> : <DeleteIcon />}
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
            );
          })}
        </Stack>
      </Paper>

      <CatalogItemSearchDialog
        dialogTitle="Add Additional Item"
        error={error}
        excludedItemIds={excludedItemIds}
        initialQuery={storeItemTitle}
        isSubmitting={isAdding}
        listAriaLabel="Additional catalog item matches"
        open={isSearchOpen}
        resultActionLabel="Add"
        onClose={() => {
          if (!isAdding) {
            setIsSearchOpen(false);
            setError('');
          }
        }}
        onSelect={handleAdd}
      />
    </>
  );
}

function CatalogItemSearchDialog({
  dialogTitle,
  error,
  excludedItemIds,
  initialQuery,
  isSubmitting,
  listAriaLabel,
  onClose,
  onSelect,
  resultActionLabel,
  open
}: {
  dialogTitle: string;
  error: string;
  excludedItemIds: Set<string>;
  initialQuery: string;
  isSubmitting: boolean;
  listAriaLabel: string;
  onClose: () => void;
  onSelect: (item: AdminRecord) => Promise<void>;
  resultActionLabel: string;
  open: boolean;
}) {
  const [isSearching, setIsSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AdminRecord[]>([]);
  const [searchError, setSearchError] = useState('');

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setSearchError('');
      setIsSearching(false);
      return;
    }

    setQuery(initialQuery);
    setResults([]);
    setSearchError('');
  }, [initialQuery, open]);

  useEffect(() => {
    if (!open) {
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
          pageSize: ADDITIONAL_ITEM_SEARCH_LIMIT,
          sortColumnId: 'canonical_name',
          sortDirection: 'asc'
        })
        .then((page) => {
          if (!ignore) {
            setResults(page.rows.filter((item) => !excludedItemIds.has(field(item, ['id'], ''))));
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
  }, [excludedItemIds, open, query]);

  return (
    <Dialog fullWidth maxWidth="sm" open={open} onClose={isSubmitting ? undefined : onClose}>
      <DialogTitle>{dialogTitle}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <TextField
            autoFocus
            disabled={isSubmitting}
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
            <List
              aria-label={listAriaLabel}
              disablePadding
              sx={{ border: 1, borderColor: 'divider', borderRadius: 1, maxHeight: 480, overflowY: 'auto' }}
            >
              {results.map((item) => {
                const itemId = field(item, ['id'], '');
                const primaryName = catalogItemDisplayName(item);
                const canonicalName = field(item, ['canonical_name'], '');
                const secondaryName = canonicalName && canonicalName !== primaryName ? canonicalName : '';
                const imageUrl = field(item, ['image_url_es', 'image_url'], '');
                return (
                  <ListItemButton
                    aria-label={`${resultActionLabel} ${primaryName}`}
                    disabled={isSubmitting || !itemId}
                    key={itemId}
                    onClick={() => void onSelect(item)}
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
        <Button disabled={isSubmitting} type="button" onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function catalogItemDisplayName(item: AdminRecord) {
  return field(item, ['canonical_name_es', 'canonical_name'], 'Untitled item');
}

function reviewItemDisplayName(item: AdminRecord) {
  const name = field(item, ['canonical_name'], '');
  const nameEs = field(item, ['canonical_name_es'], '');

  if (name && nameEs) {
    return `${name} (${nameEs})`;
  }

  return name || nameEs || 'Untitled item';
}

function catalogItemImageUrl(item: AdminRecord) {
  return field(item, ['image_url_es', 'image_url'], '');
}

function itemCandidateInputFromForm(
  formData: FormData,
  detailFields = itemCandidateDetailFields,
  baseRecord?: AdminRecord
): AdminRecord {
  const displayedFieldKeys = new Set(detailFields.map((detailField) => detailField.key));
  return Object.fromEntries(
    itemCandidateDetailFields
      .filter((detailField) => !detailField.readOnly)
      .map((detailField) => [
        detailField.key,
        detailField.fieldType === 'boolean'
          ? displayedFieldKeys.has(detailField.key)
            ? formData.has(detailField.key)
            : booleanValue(baseRecord ?? {}, detailField.key)
          : displayedFieldKeys.has(detailField.key)
            ? String(formData.get(detailField.key) ?? '')
            : detailValue(baseRecord ?? {}, detailField.key)
      ])
  );
}

function reloadCurrentPage() {
  window.location.reload();
}
