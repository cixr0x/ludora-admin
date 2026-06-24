import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import DeleteIcon from '@mui/icons-material/Delete';
import ImageSearchIcon from '@mui/icons-material/ImageSearch';
import SaveIcon from '@mui/icons-material/Save';
import { Alert, Box, Button, Chip, CircularProgress, IconButton, Link, MenuItem, Paper, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { Fragment, type FormEvent, type MouseEvent, useEffect, useState } from 'react';
import { adminApi, type AdminRecord, type ItemRelationshipInput, type ItemTaxonomy, type LocalCoverWorkflow } from '../api/client';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { FloatingSuccessAlert } from '../components/FloatingSuccessAlert';
import { useInfiniteServerRows, useServerTableState } from '../components/useServerTableState';

type LoadState = 'loading' | 'ready' | 'error';
type ViewMode = 'form' | 'table';

const emptyItemTaxonomy: ItemTaxonomy = {
  categories: [],
  families: [],
  mechanics: []
};

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

function textValue(record: AdminRecord, key: string) {
  return detailValue(record, key).trim();
}

function firstTextValue(record: AdminRecord, keys: string[]) {
  return keys.map((key) => textValue(record, key)).find((value) => value !== '') ?? '';
}

function firstLinkedStoreDescription(storeItems: AdminRecord[]) {
  return storeItems.map((storeItem) => textValue(storeItem, 'description')).find((description) => description !== '') ?? '';
}

function normalizeItemName(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function namedFormTextControl(form: HTMLFormElement, name: string) {
  const control = form.elements.namedItem(name);
  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    return control;
  }
  return null;
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

function relatedItemFormLink(record: AdminRecord) {
  const id = field(record, ['related_item_id'], '');
  const name = field(record, ['related_item_name'], 'Related item');
  if (!id) {
    return name;
  }

  return <Link href={`#items?id=${encodeURIComponent(id)}`}>{name}</Link>;
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
  { key: 'rating', label: 'Rating' },
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
    filterValue: (row) => field(row, ['id']),
    id: 'id',
    label: 'ID',
    minWidth: 80,
    render: (row) => field(row, ['id']),
    sortValue: (row) => numericField(row, ['id']) ?? field(row, ['id'])
  },
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
    filterValue: (row) => field(row, ['rating']),
    id: 'rating',
    label: 'Rating',
    minWidth: 100,
    render: (row) => field(row, ['rating']),
    sortValue: (row) => numericField(row, ['rating']) ?? field(row, ['rating'])
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

const baseLinkedCandidateColumns: DataTableColumn<AdminRecord>[] = [
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

function linkedCandidateColumns({
  onStartCoverWorkflow,
  startingCoverWorkflowId
}: {
  onStartCoverWorkflow: (record: AdminRecord) => void;
  startingCoverWorkflowId: string;
}): DataTableColumn<AdminRecord>[] {
  return [
    ...baseLinkedCandidateColumns,
    {
      align: 'center',
      filterable: false,
      id: 'cover_workflow',
      label: 'Cover',
      minWidth: 90,
      render: (row) => (
        <CoverWorkflowAction
          record={row}
          startingCoverWorkflowId={startingCoverWorkflowId}
          onStartCoverWorkflow={onStartCoverWorkflow}
        />
      ),
      sortable: false
    }
  ];
}

type RelationshipChoice = {
  direction: NonNullable<ItemRelationshipInput['direction']>;
  label: string;
  link_type: 'extension' | 'implementation';
  value: string;
};

const relationshipChoices: RelationshipChoice[] = [
  { direction: 'outgoing', label: 'Extends', link_type: 'extension', value: 'extension_outgoing' },
  { direction: 'incoming', label: 'Extended by', link_type: 'extension', value: 'extension_incoming' },
  { direction: 'outgoing', label: 'Implements', link_type: 'implementation', value: 'implementation_outgoing' },
  { direction: 'incoming', label: 'Implemented by', link_type: 'implementation', value: 'implementation_incoming' }
];

const baseItemRelationshipColumns: DataTableColumn<AdminRecord>[] = [
  {
    filterValue: (row) => relationshipTypeLabel(row),
    id: 'relationship_type',
    label: 'Relationship Type',
    minWidth: 170,
    render: (row) => <Chip label={relationshipTypeLabel(row)} size="small" variant="outlined" />,
    sortValue: (row) => relationshipTypeLabel(row)
  },
  {
    filterValue: (row) => field(row, ['related_item_name']),
    id: 'related_item_name',
    label: 'Related Item',
    minWidth: 240,
    render: (row) => relatedItemFormLink(row),
    sortValue: (row) => field(row, ['related_item_name'])
  },
  {
    filterValue: (row) => field(row, ['related_item_id']),
    id: 'related_item_id',
    label: 'Related ID',
    minWidth: 110,
    render: (row) => field(row, ['related_item_id']),
    sortValue: (row) => numericField(row, ['related_item_id']) ?? field(row, ['related_item_id'])
  },
  {
    filterValue: (row) => field(row, ['created_at']),
    id: 'created_at',
    label: 'Created',
    minWidth: 190,
    render: (row) => field(row, ['created_at']),
    sortValue: (row) => field(row, ['created_at'])
  }
];

function itemRelationshipColumns({
  deletingRelationshipId,
  onDeleteRelationship
}: {
  deletingRelationshipId: string;
  onDeleteRelationship: (record: AdminRecord) => void;
}): DataTableColumn<AdminRecord>[] {
  return [
    ...baseItemRelationshipColumns,
    {
      align: 'center',
      filterable: false,
      id: 'actions',
      label: 'Actions',
      minWidth: 90,
      render: (row) => (
        <RelationshipDeleteAction
          deletingRelationshipId={deletingRelationshipId}
          record={row}
          onDeleteRelationship={onDeleteRelationship}
        />
      ),
      sortable: false
    }
  ];
}

function RelationshipDeleteAction({
  deletingRelationshipId,
  onDeleteRelationship,
  record
}: {
  deletingRelationshipId: string;
  onDeleteRelationship: (record: AdminRecord) => void;
  record: AdminRecord;
}) {
  const relationshipId = field(record, ['id'], '');
  const relatedItemName = field(record, ['related_item_name'], 'relationship');
  const isDeleting = relationshipId !== '' && relationshipId === deletingRelationshipId;
  const isDisabled = !relationshipId || isDeleting;

  return (
    <Tooltip title="Delete relationship">
      <span>
        <IconButton
          aria-label={`Delete relationship ${relatedItemName}`}
          color="error"
          disabled={isDisabled}
          size="small"
          sx={{ p: 0.5 }}
          onClick={(event) => {
            event.stopPropagation();
            onDeleteRelationship(record);
          }}
        >
          {isDeleting ? <CircularProgress size={18} /> : <DeleteIcon fontSize="small" />}
        </IconButton>
      </span>
    </Tooltip>
  );
}

function CoverWorkflowAction({
  onStartCoverWorkflow,
  record,
  startingCoverWorkflowId
}: {
  onStartCoverWorkflow: (record: AdminRecord) => void;
  record: AdminRecord;
  startingCoverWorkflowId: string;
}) {
  const storeItemId = field(record, ['id'], '');
  const title = field(record, ['title'], 'store item');
  const imageUrl = field(record, ['image_url'], '');
  const itemId = field(record, ['item_id'], '');
  const isStarting = storeItemId !== '' && storeItemId === startingCoverWorkflowId;
  const canStart = Boolean(storeItemId && imageUrl && itemId && !isStarting);

  return (
    <Tooltip title={canStart ? 'Start cover workflow' : 'Requires a linked item and image'}>
      <span>
        <IconButton
          aria-label={`Start cover workflow for ${title}`}
          disabled={!canStart}
          size="small"
          sx={{ p: 0.5 }}
          onClick={(event) => {
            event.stopPropagation();
            onStartCoverWorkflow(record);
          }}
        >
          {isStarting ? <CircularProgress size={18} /> : <ImageSearchIcon fontSize="small" />}
        </IconButton>
      </span>
    </Tooltip>
  );
}

type ItemsPageProps = {
  onClearSelectedItemId?: () => void;
  selectedItemId?: string;
};

export function ItemsPage({ onClearSelectedItemId, selectedItemId }: ItemsPageProps = {}) {
  const [detailState, setDetailState] = useState<LoadState>('ready');
  const [itemTaxonomy, setItemTaxonomy] = useState<ItemTaxonomy>(emptyItemTaxonomy);
  const [itemRelationships, setItemRelationships] = useState<AdminRecord[]>([]);
  const [linkedStoreItems, setLinkedStoreItems] = useState<AdminRecord[]>([]);
  const [relatedState, setRelatedState] = useState<LoadState>('ready');
  const [selectedItem, setSelectedItem] = useState<AdminRecord | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [isAddingRelationship, setIsAddingRelationship] = useState(false);
  const [deletingRelationshipId, setDeletingRelationshipId] = useState('');
  const [isGeneratingDescription, setIsGeneratingDescription] = useState(false);
  const [localCoverWorkflow, setLocalCoverWorkflow] = useState<LocalCoverWorkflow | null>(null);
  const [localCoverWorkflowError, setLocalCoverWorkflowError] = useState('');
  const [relationshipError, setRelationshipError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [startingCoverWorkflowId, setStartingCoverWorkflowId] = useState('');
  const [startingItemCoverWorkflowId, setStartingItemCoverWorkflowId] = useState('');
  const table = useServerTableState('canonical_name');
  const { hasMore, isLoadingMore, loadMore, rows, setRows, state, totalRows } = useInfiniteServerRows(
    table,
    adminApi.getItemsPage
  );

  useEffect(() => {
    if (!selectedItemId) {
      setDetailState('ready');
      setItemTaxonomy(emptyItemTaxonomy);
      setItemRelationships([]);
      setLinkedStoreItems([]);
      setRelatedState('ready');
      setRelationshipError('');
      setDeletingRelationshipId('');
      setLocalCoverWorkflow(null);
      setLocalCoverWorkflowError('');
      setSaveError('');
      setSaveMessage('');
      setStartingCoverWorkflowId('');
      setStartingItemCoverWorkflowId('');
      setSelectedItem(null);
      setViewMode('table');
      return;
    }

    let ignore = false;
    setDetailState('loading');
    setItemTaxonomy(emptyItemTaxonomy);
    setItemRelationships([]);
    setLinkedStoreItems([]);
    setRelatedState('loading');
    setRelationshipError('');
    setDeletingRelationshipId('');
    setLocalCoverWorkflow(null);
    setLocalCoverWorkflowError('');
    setSaveError('');
    setSaveMessage('');
    setStartingCoverWorkflowId('');
    setStartingItemCoverWorkflowId('');
    setViewMode('form');

    Promise.all([
      adminApi.getItem(selectedItemId),
      adminApi.getItemRelationships(selectedItemId),
      adminApi.getItemStoreItems(selectedItemId),
      adminApi.getItemTaxonomy(selectedItemId)
    ])
      .then(([item, relationships, storeItems, taxonomy]) => {
        if (!ignore) {
          setSelectedItem(item);
          setItemRelationships(relationships);
          setLinkedStoreItems(storeItems);
          setItemTaxonomy(taxonomy);
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

  async function handleGenerateSpanishDescription(input: AdminRecord) {
    if (!selectedItem) {
      return;
    }

    const itemId = field(selectedItem, ['id'], '');
    const itemName = firstTextValue(input, ['canonical_name_es', 'canonical_name']);
    const itemDescription = textValue(input, 'description');
    const storeItemDescription = firstLinkedStoreDescription(linkedStoreItems);

    if (!itemId || !itemName || (!itemDescription && !storeItemDescription)) {
      return;
    }

    setIsGeneratingDescription(true);
    setSaveError('');
    setSaveMessage('');

    try {
      const generated = await adminApi.generateDescription({
        boardgame_name: itemName,
        description_1: itemDescription,
        description_2: storeItemDescription
      });
      const savedItem = await adminApi.updateItem(itemId, {
        ...input,
        description_es: generated.description_es
      });

      setRows((currentRows) => currentRows.map((row, index) => (field(row, ['id'], String(index)) === itemId ? savedItem : row)));
      setSelectedItem(savedItem);
      setSaveMessage('Spanish item description saved.');
    } catch {
      setSaveError('Spanish item description could not be saved.');
    } finally {
      setIsGeneratingDescription(false);
    }
  }

  async function loadLinkedItemData(itemId: string) {
    setItemTaxonomy(emptyItemTaxonomy);
    setItemRelationships([]);
    setLinkedStoreItems([]);
    setRelationshipError('');
    setDeletingRelationshipId('');
    setStartingCoverWorkflowId('');
    setStartingItemCoverWorkflowId('');
    setRelatedState('loading');

    try {
      const [relationships, storeItems, taxonomy] = await Promise.all([
        adminApi.getItemRelationships(itemId),
        adminApi.getItemStoreItems(itemId),
        adminApi.getItemTaxonomy(itemId)
      ]);
      setItemRelationships(relationships);
      setLinkedStoreItems(storeItems);
      setItemTaxonomy(taxonomy);
      setRelatedState('ready');
    } catch {
      setRelatedState('error');
    }
  }

  async function handleCreateRelationship(input: ItemRelationshipInput): Promise<boolean> {
    if (!selectedItem) {
      return false;
    }

    const itemId = field(selectedItem, ['id'], '');
    setIsAddingRelationship(true);
    setRelationshipError('');
    setSaveMessage('');

    try {
      const createdRelationship = await adminApi.createItemRelationship(itemId, input);
      setItemRelationships((currentRelationships) =>
        upsertRecordById(
          currentRelationships.filter((relationship) => !isReciprocalRelationship(relationship, createdRelationship)),
          createdRelationship
        )
      );
      if (field(createdRelationship, ['link_type']) === 'implementation' && field(createdRelationship, ['direction']) === 'outgoing') {
        try {
          setItemTaxonomy(await adminApi.getItemTaxonomy(itemId));
        } catch {
          // The relationship was saved; keep the form success path even if the follow-up refresh fails.
        }
      }
      setSaveMessage('Relationship added.');
      return true;
    } catch {
      setRelationshipError('Relationship could not be added.');
      return false;
    } finally {
      setIsAddingRelationship(false);
    }
  }

  async function handleDeleteRelationship(record: AdminRecord) {
    if (!selectedItem) {
      return;
    }

    const itemId = field(selectedItem, ['id'], '');
    const relationshipId = field(record, ['id'], '');
    if (!itemId || !relationshipId) {
      return;
    }

    setDeletingRelationshipId(relationshipId);
    setRelationshipError('');
    setSaveMessage('');

    try {
      await adminApi.deleteItemRelationship(itemId, relationshipId);
      setItemRelationships((currentRelationships) =>
        currentRelationships.filter((relationship, index) => field(relationship, ['id'], String(index)) !== relationshipId)
      );
      setSaveMessage('Relationship deleted.');
    } catch {
      setRelationshipError('Relationship could not be deleted.');
    } finally {
      setDeletingRelationshipId('');
    }
  }

  async function handleStartLocalCoverWorkflow(record: AdminRecord) {
    const storeItemId = field(record, ['id'], '');
    if (!storeItemId) {
      return;
    }

    setStartingCoverWorkflowId(storeItemId);
    setLocalCoverWorkflowError('');
    setSaveMessage('');

    try {
      const workflow = await adminApi.startLocalCoverWorkflow(storeItemId);
      setLocalCoverWorkflow(workflow);
    } catch {
      setLocalCoverWorkflowError('Cover workflow could not be started.');
    } finally {
      setStartingCoverWorkflowId('');
    }
  }

  async function handleStartItemLocalCoverWorkflow(item: AdminRecord) {
    const itemId = field(item, ['id'], '');
    if (!itemId) {
      return;
    }

    setStartingItemCoverWorkflowId(itemId);
    setLocalCoverWorkflow(null);
    setLocalCoverWorkflowError('');
    setSaveMessage('');

    try {
      const workflow = await adminApi.startItemLocalCoverWorkflow(itemId);
      setLocalCoverWorkflow(workflow);
    } catch {
      setLocalCoverWorkflowError('Cover workflow could not be started.');
    } finally {
      setStartingItemCoverWorkflowId('');
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
      <FloatingSuccessAlert message={saveMessage} onClose={() => setSaveMessage('')} />

      {detailState === 'ready' && viewMode === 'form' && selectedItem ? (
        <ItemForm
          deletingRelationshipId={deletingRelationshipId}
          isAddingRelationship={isAddingRelationship}
          isGeneratingDescription={isGeneratingDescription}
          isSaving={isSaving}
          item={selectedItem}
          itemRelationships={itemRelationships}
          itemTaxonomy={itemTaxonomy}
          linkedStoreItems={linkedStoreItems}
          localCoverWorkflow={localCoverWorkflow}
          localCoverWorkflowError={localCoverWorkflowError}
          onBack={() => {
            setSelectedItem(null);
            setDetailState('ready');
            setItemTaxonomy(emptyItemTaxonomy);
            setItemRelationships([]);
            setLinkedStoreItems([]);
            setRelatedState('ready');
            setRelationshipError('');
            setDeletingRelationshipId('');
            setLocalCoverWorkflow(null);
            setLocalCoverWorkflowError('');
            setSaveError('');
            setSaveMessage('');
            setStartingCoverWorkflowId('');
            setStartingItemCoverWorkflowId('');
            setViewMode('table');
            onClearSelectedItemId?.();
          }}
          onCreateRelationship={handleCreateRelationship}
          onDeleteRelationship={handleDeleteRelationship}
          onGenerateSpanishDescription={handleGenerateSpanishDescription}
          onSave={handleSaveItem}
          onStartItemLocalCoverWorkflow={handleStartItemLocalCoverWorkflow}
          onStartLocalCoverWorkflow={handleStartLocalCoverWorkflow}
          relatedState={relatedState}
          relationshipError={relationshipError}
          saveError={saveError}
          startingCoverWorkflowId={startingCoverWorkflowId}
          startingItemCoverWorkflowId={startingItemCoverWorkflowId}
        />
      ) : null}

      {state === 'ready' && viewMode === 'table' ? (
        <DataTable
          ariaLabel="Items"
          columns={itemColumns}
          getRowKey={(row, index) => field(row, ['id'], String(index))}
          minWidth={1410}
          onRowDoubleClick={(row) => {
            setDetailState('ready');
            setLocalCoverWorkflow(null);
            setLocalCoverWorkflowError('');
            setSaveError('');
            setSaveMessage('');
            setStartingCoverWorkflowId('');
            setStartingItemCoverWorkflowId('');
            setSelectedItem(row);
            setItemTaxonomy(emptyItemTaxonomy);
            setItemRelationships([]);
            setRelationshipError('');
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
  deletingRelationshipId,
  isAddingRelationship,
  isGeneratingDescription,
  isSaving,
  item,
  itemRelationships,
  itemTaxonomy,
  linkedStoreItems,
  localCoverWorkflow,
  localCoverWorkflowError,
  onBack,
  onCreateRelationship,
  onDeleteRelationship,
  onGenerateSpanishDescription,
  onSave,
  onStartItemLocalCoverWorkflow,
  onStartLocalCoverWorkflow,
  relatedState,
  relationshipError,
  saveError,
  startingCoverWorkflowId,
  startingItemCoverWorkflowId
}: {
  deletingRelationshipId: string;
  isAddingRelationship: boolean;
  isGeneratingDescription: boolean;
  isSaving: boolean;
  item: AdminRecord;
  itemRelationships: AdminRecord[];
  itemTaxonomy: ItemTaxonomy;
  linkedStoreItems: AdminRecord[];
  localCoverWorkflow: LocalCoverWorkflow | null;
  localCoverWorkflowError: string;
  onBack: () => void;
  onCreateRelationship: (input: ItemRelationshipInput) => Promise<boolean>;
  onDeleteRelationship: (record: AdminRecord) => void;
  onGenerateSpanishDescription: (input: AdminRecord) => void;
  onSave: (input: AdminRecord) => void;
  onStartItemLocalCoverWorkflow: (item: AdminRecord) => void;
  onStartLocalCoverWorkflow: (record: AdminRecord) => void;
  relatedState: LoadState;
  relationshipError: string;
  saveError: string;
  startingCoverWorkflowId: string;
  startingItemCoverWorkflowId: string;
}) {
  const title = field(item, ['canonical_name'], 'Item');
  const itemId = field(item, ['id'], '');
  const imageUrl = field(item, ['image_url'], '');
  const imageUrlEs = field(item, ['image_url_es'], '');
  const bggUrl = field(item, ['bgg_url'], '');
  const formKey = itemDetailFields.map((detailField) => detailValue(item, detailField.key)).join('\u001f');
  const hasSourceDescriptions = Boolean(textValue(item, 'description') || firstLinkedStoreDescription(linkedStoreItems));
  const canGenerateDescription = hasSourceDescriptions && !isGeneratingDescription && !isSaving;
  const isStartingItemCoverWorkflow = Boolean(itemId && itemId === startingItemCoverWorkflowId);
  const canStartItemCoverWorkflow = Boolean(itemId && imageUrl && !isStartingItemCoverWorkflow);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(inputFromForm(new FormData(event.currentTarget)));
  }

  function handleGenerateDescription(event: MouseEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    if (!form) {
      return;
    }

    onGenerateSpanishDescription(inputFromForm(new FormData(form)));
  }

  function handleGenerateSpanishNormalizedName(event: MouseEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    if (!form) {
      return;
    }

    const canonicalNameEsInput = namedFormTextControl(form, 'canonical_name_es');
    const normalizedNameEsInput = namedFormTextControl(form, 'normalized_name_es');
    if (!canonicalNameEsInput || !normalizedNameEsInput) {
      return;
    }

    normalizedNameEsInput.value = normalizeItemName(canonicalNameEsInput.value);
    normalizedNameEsInput.dispatchEvent(new Event('input', { bubbles: true }));
    normalizedNameEsInput.dispatchEvent(new Event('change', { bubbles: true }));
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
              <Tooltip title={canStartItemCoverWorkflow ? 'Start cover workflow from item image' : 'Requires an item image'}>
                <span>
                  <Button
                    aria-label={`Start cover workflow from item image for ${title}`}
                    disabled={!canStartItemCoverWorkflow}
                    startIcon={isStartingItemCoverWorkflow ? <CircularProgress size={18} /> : <ImageSearchIcon />}
                    type="button"
                    variant="outlined"
                    onClick={() => onStartItemLocalCoverWorkflow(item)}
                  >
                    {isStartingItemCoverWorkflow ? 'Starting...' : 'Start cover workflow'}
                  </Button>
                </span>
              </Tooltip>
              <Button disabled={isSaving} startIcon={<SaveIcon />} type="submit" variant="contained">
                {isSaving ? 'Saving...' : 'Save Item'}
              </Button>
              <Button startIcon={<ArrowBackIcon />} type="button" variant="outlined" onClick={onBack}>
                Back to Items
              </Button>
            </Stack>
          </Stack>

          {saveError ? <Alert severity="error">{saveError}</Alert> : null}
          {localCoverWorkflowError ? <Alert severity="error">{localCoverWorkflowError}</Alert> : null}
          {localCoverWorkflow ? (
            <Alert severity="success">
              <Stack spacing={0.5}>
                <Typography variant="body2">Cover workflow started for {localCoverWorkflow.filename}.</Typography>
                <Typography variant="body2">Save the edited cover to one of:</Typography>
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
            {imageUrl || imageUrlEs ? (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
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
                {imageUrlEs ? (
                  <Box
                    alt={`${title} Spanish item image`}
                    component="img"
                    src={imageUrlEs}
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
              </Box>
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
              <Fragment key={detailField.key}>
                {detailField.key === 'description' ? (
                  <Box sx={{ gridColumn: { md: '1 / -1' } }}>
                    <Button
                      disabled={!canGenerateDescription}
                      startIcon={isGeneratingDescription ? <CircularProgress size={16} /> : <AutoFixHighIcon />}
                      type="button"
                      variant="outlined"
                      onClick={handleGenerateDescription}
                    >
                      {isGeneratingDescription ? 'Generating Spanish description...' : 'Generate Spanish item description'}
                    </Button>
                  </Box>
                ) : null}
                {detailField.key === 'canonical_name_es' ? (
                  <Box
                    sx={{
                      alignItems: 'flex-start',
                      display: 'flex',
                      gap: 1,
                      gridColumn: detailField.gridColumn
                    }}
                  >
                    <TextField
                      defaultValue={detailValue(item, detailField.key)}
                      fullWidth
                      InputProps={{ readOnly: detailField.readOnly }}
                      label={detailField.label}
                      minRows={detailField.multiline ? 4 : undefined}
                      multiline={detailField.multiline}
                      name={detailField.readOnly ? undefined : detailField.key}
                      sx={{ flex: 1, minWidth: 0 }}
                    />
                    <Tooltip title="Generate normalized Spanish name">
                      <span>
                        <IconButton
                          aria-label="Generate normalized Spanish name"
                          disabled={isSaving}
                          size="small"
                          sx={{ mt: 1, p: 0.75 }}
                          type="button"
                          onClick={handleGenerateSpanishNormalizedName}
                        >
                          <AutoFixHighIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Box>
                ) : (
                  <TextField
                    defaultValue={detailValue(item, detailField.key)}
                    fullWidth
                    InputProps={{ readOnly: detailField.readOnly }}
                    label={detailField.label}
                    minRows={detailField.multiline ? 4 : undefined}
                    multiline={detailField.multiline}
                    name={detailField.readOnly ? undefined : detailField.key}
                    sx={{ gridColumn: detailField.gridColumn }}
                  />
                )}
              </Fragment>
            ))}
          </Box>
        </Stack>
      </Paper>

      <ItemRelations
        deletingRelationshipId={deletingRelationshipId}
        isAddingRelationship={isAddingRelationship}
        itemRelationships={itemRelationships}
        onCreateRelationship={onCreateRelationship}
        onDeleteRelationship={onDeleteRelationship}
        relationshipError={relationshipError}
        state={relatedState}
        storeItems={linkedStoreItems}
        startingCoverWorkflowId={startingCoverWorkflowId}
        taxonomy={itemTaxonomy}
        onStartCoverWorkflow={onStartLocalCoverWorkflow}
      />
    </Stack>
  );
}

function ItemRelations({
  deletingRelationshipId,
  isAddingRelationship,
  itemRelationships,
  onCreateRelationship,
  onDeleteRelationship,
  relationshipError,
  state,
  storeItems,
  startingCoverWorkflowId,
  taxonomy,
  onStartCoverWorkflow
}: {
  deletingRelationshipId: string;
  isAddingRelationship: boolean;
  itemRelationships: AdminRecord[];
  onCreateRelationship: (input: ItemRelationshipInput) => Promise<boolean>;
  onDeleteRelationship: (record: AdminRecord) => void;
  relationshipError: string;
  state: LoadState;
  storeItems: AdminRecord[];
  startingCoverWorkflowId: string;
  taxonomy: ItemTaxonomy;
  onStartCoverWorkflow: (record: AdminRecord) => void;
}) {
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
          Taxonomy
        </Typography>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: {
            md: 'repeat(3, minmax(0, 1fr))',
            xs: '1fr'
          }
        }}
      >
        <TaxonomySection records={taxonomy.categories} title="Categories" />
        <TaxonomySection records={taxonomy.mechanics} title="Mechanics" />
        <TaxonomySection records={taxonomy.families} title="Families" />
      </Box>

      <Box>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          Item Relationships
        </Typography>
      </Box>
      <ItemRelationshipForm
        error={relationshipError}
        isAdding={isAddingRelationship}
        onCreateRelationship={onCreateRelationship}
      />
      <DataTable
        ariaLabel="Item relationships"
        columns={itemRelationshipColumns({ deletingRelationshipId, onDeleteRelationship })}
        defaultSortColumnId="relationship_type"
        getRowKey={(row, index) => field(row, ['id'], String(index))}
        minWidth={800}
        rows={itemRelationships}
      />

      <Box>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          Linked Store Items
        </Typography>
      </Box>
      <DataTable
        ariaLabel="Linked store items"
        columns={linkedCandidateColumns({ onStartCoverWorkflow, startingCoverWorkflowId })}
        defaultSortColumnId="last_updated"
        getRowKey={(row, index) => field(row, ['id'], String(index))}
        minWidth={1190}
        rows={storeItems}
      />
    </Stack>
  );
}

function ItemRelationshipForm({
  error,
  isAdding,
  onCreateRelationship
}: {
  error: string;
  isAdding: boolean;
  onCreateRelationship: (input: ItemRelationshipInput) => Promise<boolean>;
}) {
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = relationshipInputFromForm(new FormData(form));
    const created = await onCreateRelationship(input);
    if (created) {
      form.reset();
    }
  }

  return (
    <Paper aria-label="Add item relationship" component="form" variant="outlined" sx={{ p: 2 }} onSubmit={handleSubmit}>
      <Stack spacing={1.5}>
        {error ? <Alert severity="error">{error}</Alert> : null}
        <Box
          sx={{
            display: 'grid',
            gap: 1.5,
            gridTemplateColumns: {
              md: '1.2fr 1fr auto',
              xs: '1fr'
            }
          }}
        >
          <TextField
            defaultValue={relationshipChoices[0].value}
            fullWidth
            label="Relationship Type"
            name="relationship_choice"
            required
            select
            size="small"
          >
            {relationshipChoices.map((choice) => (
              <MenuItem key={choice.value} value={choice.value}>
                {choice.label}
              </MenuItem>
            ))}
          </TextField>
          <TextField fullWidth label="Related Item ID" name="related_item_id" required size="small" type="number" />
          <Button disabled={isAdding} startIcon={<AddIcon />} type="submit" variant="contained">
            {isAdding ? 'Adding...' : 'Add Relationship'}
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
}

function TaxonomySection({ records, title }: { records: AdminRecord[]; title: string }) {
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {title}
      </Typography>
      {records.length ? (
        <Stack direction="row" flexWrap="wrap" gap={1}>
          {records.map((record, index) => (
            <Chip key={field(record, ['id'], String(index))} label={taxonomyLabel(record)} size="small" variant="outlined" />
          ))}
        </Stack>
      ) : (
        <Typography color="text.secondary" variant="body2">
          No linked {title.toLowerCase()}.
        </Typography>
      )}
    </Stack>
  );
}

function taxonomyLabel(record: AdminRecord) {
  const value = field(record, ['value', 'name'], '');
  const valueEs = field(record, ['value_es', 'name_es'], '');
  if (valueEs && valueEs !== value) {
    return `${valueEs} (${value})`;
  }
  return value || '-';
}

function relationshipTypeLabel(record: AdminRecord) {
  const choice = relationshipChoiceFromParts(
    field(record, ['link_type'], '').toLocaleLowerCase(),
    field(record, ['direction'], '') === 'incoming' ? 'incoming' : 'outgoing'
  );
  return choice?.label ?? field(record, ['link_type']);
}

function relationshipInputFromForm(formData: FormData): ItemRelationshipInput {
  const choice = relationshipChoices.find((candidate) => candidate.value === String(formData.get('relationship_choice'))) ?? relationshipChoices[0];
  return {
    direction: choice.direction,
    link_type: choice.link_type,
    related_item_id: String(formData.get('related_item_id') ?? '').trim(),
    source: 'admin',
    source_ref: ''
  };
}

function relationshipChoiceFromParts(linkType: string, direction: NonNullable<ItemRelationshipInput['direction']>) {
  const normalizedLinkType = linkType === 'expansion' ? 'extension' : linkType;
  return relationshipChoices.find((choice) => choice.link_type === normalizedLinkType && choice.direction === direction);
}

function upsertRecordById(records: AdminRecord[], nextRecord: AdminRecord) {
  const nextId = field(nextRecord, ['id'], '');
  if (!nextId) {
    return [...records, nextRecord];
  }

  const hasExistingRecord = records.some((record, index) => field(record, ['id'], String(index)) === nextId);
  if (!hasExistingRecord) {
    return [...records, nextRecord];
  }

  return records.map((record, index) => (field(record, ['id'], String(index)) === nextId ? nextRecord : record));
}

function isReciprocalRelationship(record: AdminRecord, nextRecord: AdminRecord) {
  const linkType = field(record, ['link_type'], '').toLocaleLowerCase();
  if (linkType !== field(nextRecord, ['link_type'], '').toLocaleLowerCase()) {
    return false;
  }
  if (linkType !== 'extension' && linkType !== 'implementation') {
    return false;
  }

  return field(record, ['item_a_id'], '') === field(nextRecord, ['item_b_id'], '') && field(record, ['item_b_id'], '') === field(nextRecord, ['item_a_id'], '');
}

function inputFromForm(formData: FormData): AdminRecord {
  return Object.fromEntries(
    itemDetailFields
      .filter((detailField) => !detailField.readOnly)
      .map((detailField) => [detailField.key, String(formData.get(detailField.key) ?? '')])
  );
}
