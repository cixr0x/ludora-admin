import { Paper, Stack, Typography } from '@mui/material';

type PlaceholderPageProps = {
  title: string;
  description: string;
};

export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <Stack spacing={2}>
      <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700 }}>
        {title}
      </Typography>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography color="text.secondary" variant="body2">
          {description}
        </Typography>
      </Paper>
    </Stack>
  );
}
