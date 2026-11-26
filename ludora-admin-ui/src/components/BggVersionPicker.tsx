import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import { Alert, Autocomplete, Box, Button, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';

import { adminApi, type BggVersion } from '../api/client';

type Props = { itemId: string; parentBggId: number };

function versionLabel(version: BggVersion) {
  return version.nickname && version.nickname !== version.name
    ? `${version.name} (${version.nickname})`
    : version.name;
}

export function BggVersionPicker({ itemId, parentBggId }: Props) {
  const [versions, setVersions] = useState<BggVersion[] | null>(null);
  const [selectedBggId, setSelectedBggId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  const selected = versions?.find((version) => version.bgg_id === selectedBggId) ?? null;

  async function loadVersions() {
    if (versions || loading) return;
    setLoading(true);
    setError('');
    try {
      setVersions(await adminApi.getBggVersions(itemId));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'BGG versions could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  async function importVersion() {
    if (!selected || selected.item_id || importing) return;
    setImporting(true);
    setError('');
    try {
      const imported = await adminApi.importBggVersion(parentBggId, selected.bgg_id);
      if (typeof imported.id !== 'string' && typeof imported.id !== 'number') {
        throw new Error('The imported item could not be identified.');
      }
      const itemId = imported.id;
      setVersions((current) => current?.map((version) =>
        version.bgg_id === selected.bgg_id ? { ...version, item_id: itemId } : version
      ) ?? null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The selected version could not be imported.');
    } finally {
      setImporting(false);
    }
  }

  return (
    <Stack spacing={1} sx={{ minWidth: 0, width: '100%' }}>
      <Stack alignItems={{ xs: 'stretch', sm: 'center' }} direction={{ xs: 'column', sm: 'row' }} gap={1}>
        <Autocomplete
          disabled={importing}
          getOptionKey={(version) => version.bgg_id}
          getOptionLabel={versionLabel}
          isOptionEqualToValue={(option, value) => option.bgg_id === value.bgg_id}
          loading={loading}
          loadingText="Loading BGG versions…"
          noOptionsText={error || 'No BGG versions found'}
          onChange={(_, version) => setSelectedBggId(version?.bgg_id ?? null)}
          onOpen={() => void loadVersions()}
          options={versions ?? []}
          renderInput={(props) => <TextField {...props} label="Versions" size="small" />}
          renderOption={({ key, ...props }, version) => (
            <Box component="li" key={key} {...props} sx={{ gap: 1.5 }}>
              {version.thumbnail_url ? (
                <Box
                  alt=""
                  component="img"
                  src={version.thumbnail_url}
                  sx={{ flexShrink: 0, height: 44, objectFit: 'contain', width: 44 }}
                />
              ) : <ImageOutlinedIcon aria-hidden sx={{ flexShrink: 0, fontSize: 44 }} />}
              <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                <Typography variant="body2">{version.name}</Typography>
                {version.nickname && version.nickname !== version.name ? (
                  <Typography color="text.secondary" display="block" variant="caption">
                    {version.nickname}
                  </Typography>
                ) : null}
              </Box>
            </Box>
          )}
          slotProps={{
            listbox: { sx: { maxHeight: 'min(24rem, 45vh)', overscrollBehavior: 'contain' } },
            popper: {
              modifiers: [
                { name: 'flip', options: { padding: 16 } },
                { name: 'preventOverflow', options: { padding: 16, tether: false } }
              ],
              placement: 'bottom-start',
              sx: { maxWidth: 'calc(100vw - 32px)', minWidth: 'min(30rem, calc(100vw - 32px))' }
            }
          }}
          sx={{ flex: { sm: 1 }, minWidth: 0 }}
          value={selected}
        />
        {selected?.item_id ? (
          <Button href={`#items?id=${encodeURIComponent(selected.item_id)}`} variant="outlined">Open item</Button>
        ) : (
          <Button disabled={!selected || importing} onClick={() => void importVersion()} type="button" variant="outlined">
            {importing ? 'Importing…' : 'Import'}
          </Button>
        )}
      </Stack>
      {error ? <Alert severity="error">{error}</Alert> : null}
    </Stack>
  );
}
