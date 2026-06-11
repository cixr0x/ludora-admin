import { Alert, Box } from '@mui/material';
import { useEffect } from 'react';

type FloatingSuccessAlertProps = {
  autoHideDuration?: number;
  message: string;
  onClose: () => void;
};

export function FloatingSuccessAlert({ autoHideDuration, message, onClose }: FloatingSuccessAlertProps) {
  useEffect(() => {
    if (!message || !autoHideDuration) {
      return undefined;
    }

    const timeoutId = window.setTimeout(onClose, autoHideDuration);
    return () => window.clearTimeout(timeoutId);
  }, [autoHideDuration, message, onClose]);

  if (!message) {
    return null;
  }

  return (
    <Box
      data-testid="floating-success-alert"
      sx={(theme) => ({
        bottom: 24,
        maxWidth: 'min(420px, calc(100vw - 32px))',
        position: 'fixed',
        right: 24,
        zIndex: theme.zIndex.snackbar
      })}
    >
      <Alert severity="success" variant="filled" sx={{ width: '100%' }} onClose={onClose}>
        {message}
      </Alert>
    </Box>
  );
}
