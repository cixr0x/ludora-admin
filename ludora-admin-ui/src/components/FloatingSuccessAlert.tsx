import { Alert, Box } from '@mui/material';
import { useEffect, useRef } from 'react';

const DEFAULT_AUTO_HIDE_DURATION_MS = 3000;

type FloatingSuccessAlertProps = {
  autoHideDuration?: number;
  message: string;
  onClose: () => void;
};

export function FloatingSuccessAlert({
  autoHideDuration = DEFAULT_AUTO_HIDE_DURATION_MS,
  message,
  onClose
}: FloatingSuccessAlertProps) {
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!message || !autoHideDuration) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => onCloseRef.current(), autoHideDuration);
    return () => window.clearTimeout(timeoutId);
  }, [autoHideDuration, message]);

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
