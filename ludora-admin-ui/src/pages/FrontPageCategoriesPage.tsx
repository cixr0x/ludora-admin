import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import BalanceIcon from '@mui/icons-material/Balance';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';
import ShuffleIcon from '@mui/icons-material/Shuffle';
import { Alert, Box, Button, Chip, CircularProgress, Paper, Stack, TextField, Typography } from '@mui/material';
import { type FormEvent, useState } from 'react';
import { adminApi, type AdminRecord, type FrontPageCategoryInput } from '../api/client';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { FloatingSuccessAlert } from '../components/FloatingSuccessAlert';
import { useInfiniteServerRows, useServerTableState } from '../components/useServerTableState';

type CategoryType = FrontPageCategoryInput['category_type'];
type FormMode = 'create' | 'edit' | 'table';

type FrontPageCategoryFormState = {
  category_id: string;
  category_type: CategoryType;
  order: string;
  title: string;
};

const emptyFormState: FrontPageCategoryFormState = {
  category_id: '',
  category_type: 'category',
  order: '0',
  title: ''
};

const categoryTypes: CategoryType[] = ['category', 'family', 'mechanic'];

function valueFor(record: AdminRecord, keys: string[], fallback = '-') {
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  return value === undefined ? fallback : String(value);
}

function optionalValueFor(record: AdminRecord, keys: string[]) {
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  return value === undefined ? '' : String(value);
}

function formStateFromRecord(record: AdminRecord): FrontPageCategoryFormState {
  const categoryType = optionalValueFor(record, ['category_type']);
  return {
    category_id: optionalValueFor(record, ['category_id']),
    category_type: categoryTypes.includes(categoryType as CategoryType) ? (categoryType as CategoryType) : 'category',
    order: optionalValueFor(record, ['order']) || '0',
    title: optionalValueFor(record, ['title'])
  };
}

function inputFromForm(form: FrontPageCategoryFormState): FrontPageCategoryInput {
  const categoryId = Number(form.category_id);
  const order = Number(form.order);
  return {
    category_id: Number.isInteger(categoryId) && categoryId > 0 ? categoryId : 0,
    category_type: form.category_type,
    order: Number.isFinite(order) ? order : 0,
    title: form.title.trim()
  };
}

function categoryNameLabel(record: AdminRecord) {
  const name = optionalValueFor(record, ['category_name']);
  const nameEs = optionalValueFor(record, ['category_name_es']);
  return nameEs || name || '-';
}

function categoryTitleLabel(record: AdminRecord) {
  const title = optionalValueFor(record, ['title']);
  const name = optionalValueFor(record, ['category_name']);
  const nameEs = optionalValueFor(record, ['category_name_es']);
  if (!title) {
    return categoryNameLabel(record);
  }
  if (nameEs && name && title === name) {
    return nameEs;
  }
  return title;
}

function frontPageCategoryColumns(): DataTableColumn<AdminRecord>[] {
  return [
    {
      filterValue: (row) => valueFor(row, ['order']),
      id: 'order',
      label: 'Order',
      minWidth: 100,
      render: (row) => valueFor(row, ['order']),
      sortValue: (row) => Number(valueFor(row, ['order'], '0'))
    },
    {
      filterValue: (row) => categoryTitleLabel(row),
      id: 'title',
      label: 'Title',
      minWidth: 220,
      render: (row) => categoryTitleLabel(row),
      sortValue: (row) => categoryTitleLabel(row)
    },
    {
      filterValue: (row) => valueFor(row, ['category_type']),
      id: 'category_type',
      label: 'Type',
      minWidth: 130,
      render: (row) => <Chip label={valueFor(row, ['category_type'])} size="small" variant="outlined" />,
      sortValue: (row) => valueFor(row, ['category_type'])
    },
    {
      filterValue: (row) => valueFor(row, ['category_id']),
      id: 'category_id',
      label: 'Category ID',
      minWidth: 130,
      render: (row) => valueFor(row, ['category_id']),
      sortValue: (row) => Number(valueFor(row, ['category_id'], '0'))
    },
    {
      filterValue: (row) => categoryNameLabel(row),
      id: 'category_name',
      label: 'Linked Category',
      minWidth: 220,
      render: (row) => categoryNameLabel(row),
      sortValue: (row) => categoryNameLabel(row)
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

export function FrontPageCategoriesPage() {
  const [editingId, setEditingId] = useState('');
  const [formMode, setFormMode] = useState<FormMode>('table');
  const [formState, setFormState] = useState<FrontPageCategoryFormState>(emptyFormState);
  const [assignmentError, setAssignmentError] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const table = useServerTableState('order');
  const { hasMore, isLoadingMore, loadMore, rows, setRows, state, totalRows } = useInfiniteServerRows(
    table,
    adminApi.getFrontPageCategoriesPage
  );

  function openCreateForm() {
    setEditingId('');
    setFormState(emptyFormState);
    setAssignmentError('');
    setSaveError('');
    setSaveMessage('');
    setFormMode('create');
  }

  function openEditForm(row: AdminRecord) {
    setEditingId(valueFor(row, ['id'], ''));
    setFormState(formStateFromRecord(row));
    setAssignmentError('');
    setSaveError('');
    setSaveMessage('');
    setFormMode('edit');
  }

  function handleFieldChange(field: keyof FrontPageCategoryFormState, value: string) {
    setFormState((current) => {
      const nextValue =
        field === 'category_type' && categoryTypes.includes(value as CategoryType) ? (value as CategoryType) : value;
      return { ...current, [field]: nextValue } as FrontPageCategoryFormState;
    });
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setSaveError('');
    setSaveMessage('');

    try {
      const input = inputFromForm(formState);
      const saved =
        formMode === 'create'
          ? await adminApi.createFrontPageCategory(input)
          : await adminApi.updateFrontPageCategory(editingId, input);
      if (formMode === 'create') {
        setRows((currentRows) => [saved, ...currentRows]);
      } else {
        setRows((currentRows) =>
          currentRows.map((row, index) => (valueFor(row, ['id'], String(index)) === editingId ? saved : row))
        );
      }
      setSaveMessage('Front page category saved.');
      setFormMode('table');
    } catch {
      setSaveError('Front page category could not be saved.');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!editingId) {
      return;
    }

    setIsSaving(true);
    setSaveError('');
    setSaveMessage('');

    try {
      await adminApi.deleteFrontPageCategory(editingId);
      const deletedId = editingId;
      setRows((currentRows) =>
        currentRows.filter((row, index) => valueFor(row, ['id'], String(index)) !== deletedId)
      );
      setEditingId('');
      setFormState(emptyFormState);
      setFormMode('table');
      setSaveMessage('Front page category deleted.');
    } catch {
      setSaveError('Front page category could not be deleted.');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleAssignRandomItems() {
    setIsAssigning(true);
    setAssignmentError('');
    setSaveMessage('');

    try {
      const result = await adminApi.assignRandomFrontPageCategoryItems();
      setSaveMessage(
        `Random assignments complete: ${result.assigned_count} assigned, ${result.skipped_count} skipped.`
      );
    } catch {
      setAssignmentError('Random assignments could not be completed.');
    } finally {
      setIsAssigning(false);
    }
  }

  async function handleAssignBalancedItems() {
    setIsAssigning(true);
    setAssignmentError('');
    setSaveMessage('');

    try {
      const result = await adminApi.assignBalancedFrontPageCategoryItems();
      setSaveMessage(
        `Balanced assignments complete: ${result.assigned_count} assigned, ${result.skipped_count} skipped.`
      );
    } catch {
      setAssignmentError('Balanced assignments could not be completed.');
    } finally {
      setIsAssigning(false);
    }
  }

  const isFormMode = formMode !== 'table';

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700 }}>
          Front Page Categories
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Curated homepage rails mapped to existing boardgame metadata.
        </Typography>
      </Box>

      {state === 'loading' && !isFormMode ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading front page categories</Typography>
        </Stack>
      ) : null}

      {state === 'error' && !isFormMode ? <Alert severity="error">Front page categories could not be loaded.</Alert> : null}
      {assignmentError && !isFormMode ? <Alert severity="error">{assignmentError}</Alert> : null}
      <FloatingSuccessAlert message={saveMessage} onClose={() => setSaveMessage('')} />

      {isFormMode ? (
        <Paper component="section" variant="outlined" sx={{ maxWidth: 820, p: 2 }}>
          <Box component="form" onSubmit={handleSave}>
            <Stack spacing={2}>
              <Typography variant="h6">
                {formMode === 'create' ? 'New Front Page Category' : 'Edit Front Page Category'}
              </Typography>

              {saveError ? <Alert severity="error">{saveError}</Alert> : null}

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
                  inputProps={{ step: 'any' }}
                  label="Order"
                  type="number"
                  value={formState.order}
                  onChange={(event) => handleFieldChange('order', event.target.value)}
                />
                <TextField
                  fullWidth
                  label="Title"
                  value={formState.title}
                  onChange={(event) => handleFieldChange('title', event.target.value)}
                />
                <TextField
                  fullWidth
                  label="Type"
                  select
                  SelectProps={{ native: true }}
                  value={formState.category_type}
                  onChange={(event) => handleFieldChange('category_type', event.target.value)}
                >
                  {categoryTypes.map((categoryType) => (
                    <option key={categoryType} value={categoryType}>
                      {categoryType}
                    </option>
                  ))}
                </TextField>
                <TextField
                  fullWidth
                  inputProps={{ min: 1 }}
                  label="Category ID"
                  type="number"
                  value={formState.category_id}
                  onChange={(event) => handleFieldChange('category_id', event.target.value)}
                />
              </Box>

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Button disabled={isSaving} startIcon={<SaveIcon />} type="submit" variant="contained">
                  Save Category
                </Button>
                <Button
                  disabled={isSaving}
                  startIcon={<ArrowBackIcon />}
                  type="button"
                  variant="outlined"
                  onClick={() => {
                    setFormMode('table');
                    setSaveError('');
                  }}
                >
                  Cancel
                </Button>
                {formMode === 'edit' ? (
                  <Button
                    color="error"
                    disabled={isSaving}
                    startIcon={<DeleteIcon />}
                    type="button"
                    variant="outlined"
                    onClick={handleDelete}
                  >
                    Delete Category
                  </Button>
                ) : null}
              </Stack>
            </Stack>
          </Box>
        </Paper>
      ) : null}

      {state === 'ready' && !isFormMode ? (
        <Stack spacing={1.5}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            <Button startIcon={<AddIcon />} variant="contained" onClick={openCreateForm}>
              New Category
            </Button>
            <Button
              disabled={isAssigning || rows.length === 0}
              startIcon={isAssigning ? <CircularProgress size={16} /> : <ShuffleIcon />}
              variant="outlined"
              onClick={handleAssignRandomItems}
            >
              Assign Random Games
            </Button>
            <Button
              disabled={isAssigning || rows.length === 0}
              startIcon={isAssigning ? <CircularProgress size={16} /> : <BalanceIcon />}
              variant="outlined"
              onClick={handleAssignBalancedItems}
            >
              Assign Balanced Games
            </Button>
          </Box>
          <DataTable
            ariaLabel="Front page categories"
            columns={frontPageCategoryColumns()}
            defaultSortColumnId="order"
            getRowKey={(row, index) => valueFor(row, ['id'], String(index))}
            minWidth={990}
            onRowDoubleClick={openEditForm}
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
        </Stack>
      ) : null}
    </Stack>
  );
}
