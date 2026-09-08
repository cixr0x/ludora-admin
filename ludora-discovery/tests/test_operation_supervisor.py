import signal
import unittest
from unittest.mock import Mock, patch

from ludora import operation_supervisor as supervisor


class OperationSupervisorTests(unittest.TestCase):
    def test_enable_subreaper_checks_prctl_error(self):
        libc = Mock()
        libc.prctl.return_value = -1
        with patch.object(supervisor.ctypes, 'CDLL', return_value=libc), patch.object(supervisor.ctypes, 'get_errno', return_value=1):
            with self.assertRaises(PermissionError):
                supervisor._enable_subreaper()
        self.assertEqual(libc.prctl.call_args.args[:2], (36, 1))

    def test_process_identity_parser_handles_spaces_and_parentheses_in_command(self):
        fields = ['S', '17'] + ['0'] * 17 + ['12345']
        with patch.object(supervisor.Path, 'read_text', return_value='20 (a strange ) name) ' + ' '.join(fields)):
            self.assertEqual(supervisor._identity(20), supervisor.ProcessIdentity(20, 17, '12345', 'S'))

    def test_signaling_rejects_a_reused_pid(self):
        original = supervisor.ProcessIdentity(20, 17, 'old', 'S')
        with patch.object(supervisor, '_identity', return_value=supervisor.ProcessIdentity(20, 1, 'new', 'S')), patch.object(supervisor.os, 'kill') as kill:
            supervisor._signal_owned(original, signal.SIGTERM)
        kill.assert_not_called()

    def test_wait_status_propagates_worker_exit_and_signal(self):
        self.assertEqual(supervisor._exit_code(0), 0)
        self.assertEqual(supervisor._exit_code(7), 7)
        self.assertEqual(supervisor._exit_code(-9), 137)
