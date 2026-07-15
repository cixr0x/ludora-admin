import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ImageSearchIcon from '@mui/icons-material/ImageSearch';
import SaveIcon from '@mui/icons-material/Save';
import {
  Alert,
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
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, type AdminRecord, type CreateItemFromCandidateInput, type LocalCoverWorkflow } from '../api/client';
import { CoverFlatteningDialog, type CoverFlatteningRequest } from '../components/CoverFlatteningDialog';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { FloatingSuccessAlert } from '../components/FloatingSuccessAlert';
import { useInfiniteServerRows, useServerTableState } from '../components/useServerTableState';

type LoadState = 'loading' | 'ready' | 'error';
type ViewMode = 'form' | 'table';

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
  onClearSelectedCandidateId?: () => void;
  onOpenItem?: (itemId: string) => void;
  selectedCandidateId?: string;
};

export function ListingCandidatesPage({ onClearSelectedCandidateId, onOpenItem, selectedCandidateId }: ListingCandidatesPageProps = {}) {
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const [detailState, setDetailState] = useState<LoadState>('ready');
  const [isBatchConfirming, setIsBatchConfirming] = useState(false);
  const [isBatchModeEnabled, setIsBatchModeEnabled] = useState(false);
  const [isCreatingBggItem, setIsCreatingBggItem] = useState(false);
  const [isCreatingItem, setIsCreatingItem] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [localCoverWorkflow, setLocalCoverWorkflow] = useState<LocalCoverWorkflow | null>(null);
  const [localCoverWorkflowError, setLocalCoverWorkflowError] = useState('');
  const [updatingBoardgameCandidateId, setUpdatingBoardgameCandidateId] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [selectedBatchCandidateIds, setSelectedBatchCandidateIds] = useState<Set<string>>(() => new Set());
  const batchSelectionAnchorId = useRef<string | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<AdminRecord | null>(null);
  const [startingCoverWorkflowId, setStartingCoverWorkflowId] = useState('');
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
      setViewMode('table');
      return;
    }

    let ignore = false;
    setDetailState('loading');
    setLocalCoverWorkflow(null);
    setLocalCoverWorkflowError('');
    setSaveError('');
    setSaveMessage('');
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

  function handleStartCoverFlattening(candidate: AdminRecord) {
    const candidateId = field(candidate, ['id'], '');
    if (!candidateId) {
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
              Store Items
            </Typography>
            <Typography color="text.secondary" variant="body2">
              Discovered store product rows captured from approved store inventories.
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
          setSaveMessage(`Flattened cover saved as ${result.target_field === 'image_url' ? 'image' : 'Spanish image'}.`);
        }}
        onClose={() => setCoverFlatteningRequest(null)}
      />
      {viewMode === 'table' && saveError ? <Alert severity="error">{saveError}</Alert> : null}

      {detailState === 'ready' && viewMode === 'form' && selectedCandidate ? (
        <ItemCandidateForm
          candidate={selectedCandidate}
          isCreatingBggItem={isCreatingBggItem}
          isCreatingItem={isCreatingItem}
          isSaving={isSaving}
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
          onSave={handleSaveCandidate}
          onCreateItem={handleCreateItemFromCandidate}
          onStartCoverFlattening={handleStartCoverFlattening}
          onStartLocalCoverWorkflow={handleStartLocalCoverWorkflow}
          saveError={saveError}
          startingCoverWorkflowId={startingCoverWorkflowId}
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
  isCreatingBggItem,
  isCreatingItem,
  isSaving,
  localCoverWorkflow,
  localCoverWorkflowError,
  onBack,
  onCreateItemFromBggId,
  onCreateItem,
  onSave,
  onStartCoverFlattening,
  onStartLocalCoverWorkflow,
  saveError,
  startingCoverWorkflowId
}: {
  candidate: AdminRecord;
  isCreatingBggItem: boolean;
  isCreatingItem: boolean;
  isSaving: boolean;
  localCoverWorkflow: LocalCoverWorkflow | null;
  localCoverWorkflowError: string;
  onBack: () => void;
  onCreateItemFromBggId: (bggId: string) => void;
  onCreateItem: (input?: CreateItemFromCandidateInput) => Promise<void>;
  onSave: (input: AdminRecord) => void;
  onStartCoverFlattening: (candidate: AdminRecord) => void;
  onStartLocalCoverWorkflow: (candidate: AdminRecord) => void;
  saveError: string;
  startingCoverWorkflowId: string;
}) {
  const title = field(candidate, ['title'], 'Item candidate');
  const candidateIdValue = field(candidate, ['id'], '');
  const imageUrl = field(candidate, ['image_url'], '');
  const itemId = field(candidate, ['item_id'], '');
  const matchedBggId = field(candidate, ['matched_bgg_id'], '');
  const sourceUrl = field(candidate, ['source_url'], '');
  const formKey = itemCandidateDetailFields.map((detailField) => detailValue(candidate, detailField.key)).join('\u001f');
  const [bggDialogBggId, setBggDialogBggId] = useState(matchedBggId);
  const [isBggDialogOpen, setIsBggDialogOpen] = useState(false);
  const [isCandidateDialogOpen, setIsCandidateDialogOpen] = useState(false);
  const [candidateDialogBggId, setCandidateDialogBggId] = useState(matchedBggId);
  const [candidateExtends, setCandidateExtends] = useState(false);
  const [candidateExtendsItemId, setCandidateExtendsItemId] = useState('');
  const [candidateImplements, setCandidateImplements] = useState(false);

  useEffect(() => {
    setBggDialogBggId(matchedBggId);
    setCandidateDialogBggId(matchedBggId);
  }, [matchedBggId]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(itemCandidateInputFromForm(new FormData(event.currentTarget)));
  }

  const canConfirmBggDialog = Boolean(bggDialogBggId.trim()) && !isSaving && !isCreatingBggItem && !isCreatingItem;
  const canConfirmCandidateDialog =
    !isSaving &&
    !isCreatingBggItem &&
    !isCreatingItem &&
    (!candidateImplements || Boolean(candidateDialogBggId.trim())) &&
    (!candidateExtends || Boolean(candidateExtendsItemId.trim()));
  const isStartingCoverWorkflow = Boolean(candidateIdValue && candidateIdValue === startingCoverWorkflowId);
  const canStartCoverWorkflow = Boolean(candidateIdValue && imageUrl && itemId && !isStartingCoverWorkflow);

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

  return (
    <Paper component="section" variant="outlined" sx={{ p: 2 }}>
      <Stack component="form" key={formKey} spacing={2} onSubmit={handleSubmit}>
        <Stack alignItems="flex-start" direction={{ sm: 'row', xs: 'column' }} justifyContent="space-between" spacing={1.5}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              Store Item Details
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
            <Tooltip title={canStartCoverWorkflow ? 'Flatten cover' : 'Requires a linked item and image'}>
              <span>
                <Button
                  aria-label={`Flatten cover for ${title}`}
                  disabled={!canStartCoverWorkflow}
                  startIcon={<AutoFixHighIcon />}
                  sx={{ width: { sm: 'auto', xs: '100%' } }}
                  type="button"
                  variant="outlined"
                  onClick={() => onStartCoverFlattening(candidate)}
                >
                  Flatten cover
                </Button>
              </span>
            </Tooltip>
            <Button disabled={isSaving} startIcon={<SaveIcon />} type="submit" variant="contained">
              {isSaving ? 'Saving...' : 'Save Store Item'}
            </Button>
            <Button startIcon={<ArrowBackIcon />} type="button" variant="outlined" onClick={onBack}>
              Back to Store Items
            </Button>
          </Stack>
        </Stack>

        <Stack alignItems={{ md: 'center', xs: 'stretch' }} direction={{ md: 'row', xs: 'column' }} spacing={1}>
          <Button
            disabled={isSaving || isCreatingBggItem || isCreatingItem}
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
            disabled={isSaving || isCreatingItem || isCreatingBggItem}
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
          {itemCandidateDetailFields.map((detailField) =>
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
  );
}

function itemCandidateInputFromForm(formData: FormData): AdminRecord {
  return Object.fromEntries(
    itemCandidateDetailFields
      .filter((detailField) => !detailField.readOnly)
      .map((detailField) => [
        detailField.key,
        detailField.fieldType === 'boolean' ? formData.has(detailField.key) : String(formData.get(detailField.key) ?? '')
      ])
  );
}
