import AddIcon from '@mui/icons-material/Add';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { Alert, Box, Button, Checkbox, Chip, CircularProgress, FormControlLabel, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { adminApi, type FrontPageCategoryOption } from '../api/client';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { FloatingSuccessAlert } from '../components/FloatingSuccessAlert';

type LoadState = 'error' | 'loading' | 'ready';

function optionKey(option: FrontPageCategoryOption) {
  return `${option.category_type}:${option.category_id}`;
}

function optionName(option: FrontPageCategoryOption) {
  return String(option.name ?? '').trim();
}

function optionNameEs(option: FrontPageCategoryOption) {
  return String(option.name_es ?? '').trim();
}

function optionLabel(option: FrontPageCategoryOption) {
  const name = optionName(option);
  const nameEs = optionNameEs(option);
  return nameEs || name || '-';
}

function titleForOption(option: FrontPageCategoryOption) {
  return optionNameEs(option) || optionName(option);
}

function isAlreadyAdded(option: FrontPageCategoryOption) {
  const value = option.front_page_category_id;
  return value !== undefined && value !== null && String(value) !== '';
}

function taxonomyOptionColumns(
  addingKey: string,
  onAdd: (option: FrontPageCategoryOption) => void
): DataTableColumn<FrontPageCategoryOption>[] {
  return [
    {
      filterValue: (row) => row.category_type,
      id: 'category_type',
      label: 'Type',
      minWidth: 130,
      render: (row) => <Chip label={row.category_type} size="small" variant="outlined" />,
      sortValue: (row) => row.category_type
    },
    {
      filterValue: optionLabel,
      id: 'name',
      label: 'Name',
      minWidth: 280,
      render: optionLabel,
      sortValue: optionLabel
    },
    {
      align: 'right',
      filterValue: (row) => String(row.game_count ?? 0),
      id: 'game_count',
      label: 'Games',
      minWidth: 120,
      render: (row) => row.game_count ?? 0,
      sortValue: (row) => Number(row.game_count ?? 0)
    },
    {
      filterable: false,
      id: 'status',
      label: 'Status',
      minWidth: 150,
      render: (row) =>
        isAlreadyAdded(row) ? (
          <Chip color="success" icon={<CheckCircleIcon />} label="Added" size="small" variant="outlined" />
        ) : (
          <Button
            aria-label={`Add ${optionLabel(row)}`}
            disabled={addingKey === optionKey(row)}
            size="small"
            startIcon={<AddIcon />}
            variant="contained"
            onClick={(event) => {
              event.stopPropagation();
              onAdd(row);
            }}
          >
            Add
          </Button>
        ),
      sortable: false
    }
  ];
}

type FrontPageCategoryOptionsPageProps = {
  onOpenProducts?: (option: FrontPageCategoryOption) => void;
};

export function FrontPageCategoryOptionsPage({ onOpenProducts }: FrontPageCategoryOptionsPageProps = {}) {
  const [addingKey, setAddingKey] = useState('');
  const [loadError, setLoadError] = useState('');
  const [onlyUnlinkedGames, setOnlyUnlinkedGames] = useState(false);
  const [rows, setRows] = useState<FrontPageCategoryOption[]>([]);
  const [saveError, setSaveError] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    let isActive = true;

    async function loadOptions() {
      setState('loading');
      setLoadError('');
      try {
        const options = await adminApi.getFrontPageCategoryOptions({ onlyUnlinkedGames });
        if (isActive) {
          setRows(options);
          setState('ready');
        }
      } catch {
        if (isActive) {
          setLoadError('Boardgame taxonomy could not be loaded.');
          setState('error');
        }
      }
    }

    void loadOptions();
    return () => {
      isActive = false;
    };
  }, [onlyUnlinkedGames]);

  async function handleAdd(option: FrontPageCategoryOption) {
    const key = optionKey(option);
    setAddingKey(key);
    setSaveError('');
    setSaveMessage('');

    try {
      const saved = await adminApi.createFrontPageCategory({
        category_id: Number(option.category_id),
        category_type: option.category_type,
        order: 0,
        title: titleForOption(option)
      });
      const savedId = Number(saved.id ?? option.category_id);
      setRows((currentRows) =>
        currentRows.map((row) =>
          optionKey(row) === key
            ? {
                ...row,
                front_page_category_id: Number.isFinite(savedId) && savedId > 0 ? savedId : option.category_id
              }
            : row
        )
      );
      setSaveMessage('Front page category added.');
    } catch {
      setSaveError('Front page category could not be added.');
    } finally {
      setAddingKey('');
    }
  }

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700 }}>
          Add Front Page Category
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Boardgame taxonomy rows available for homepage curation.
        </Typography>
      </Box>

      {state === 'loading' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading boardgame taxonomy</Typography>
        </Stack>
      ) : null}

      {state === 'error' ? <Alert severity="error">{loadError}</Alert> : null}
      {saveError ? <Alert severity="error">{saveError}</Alert> : null}
      <FloatingSuccessAlert message={saveMessage} onClose={() => setSaveMessage('')} />

      <FormControlLabel
        control={
          <Checkbox
            checked={onlyUnlinkedGames}
            onChange={(event) => setOnlyUnlinkedGames(event.target.checked)}
            size="small"
          />
        }
        label="Only count uncovered games"
      />

      {state === 'ready' ? (
        <DataTable
          ariaLabel="Front page category options"
          columns={taxonomyOptionColumns(addingKey, handleAdd)}
          defaultSortColumnId="category_type"
          getRowKey={(row) => optionKey(row)}
          mobileActionLabel={(row) => `Open products for ${row.name_es || row.name || row.category_type}`}
          minWidth={690}
          onRowClick={onOpenProducts}
          rows={rows}
        />
      ) : null}
    </Stack>
  );
}
