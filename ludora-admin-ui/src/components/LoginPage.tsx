import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { type FormEvent, useState } from 'react';

type LoginPageProps = {
  error: string | null;
  isSubmitting: boolean;
  onSubmit: (input: { password: string; username: string }) => Promise<void>;
};

export function LoginPage({ error, isSubmitting, onSubmit }: LoginPageProps) {
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit({ password, username });
  }

  return (
    <Box sx={{ alignItems: 'center', bgcolor: 'grey.100', display: 'flex', minHeight: '100vh', px: 2 }}>
      <Paper
        component="form"
        elevation={0}
        sx={{
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          maxWidth: 420,
          mx: 'auto',
          p: 4,
          width: '100%'
        }}
        onSubmit={handleSubmit}
      >
        <Stack spacing={2.5}>
          <Box sx={{ alignItems: 'center', display: 'flex', gap: 1.5 }}>
            <LockOutlinedIcon color="primary" />
            <Typography component="h1" variant="h5" sx={{ fontSize: '1.35rem', fontWeight: 700 }}>
              Ludora Admin
            </Typography>
          </Box>
          {error ? <Alert severity="error">{error}</Alert> : null}
          <TextField
            autoComplete="username"
            autoFocus
            fullWidth
            label="Username"
            name="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <TextField
            autoComplete="current-password"
            fullWidth
            label="Password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button disabled={isSubmitting} fullWidth type="submit" variant="contained">
            Sign in
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
}
