"""Linux ownership boundary for one local item-discovery operation.

The subreaper remains alive while worker/browser descendants are adopted and
reaped. It does not perform discovery, parse worker output or enforce fetch
deadlines: admin-service owns the external watchdog and bounded fallback.
"""
from __future__ import annotations

import ctypes
import json
import os
import select
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    ppid: int
    started: str
    state: str


def _enable_subreaper() -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def _identity(pid: int) -> ProcessIdentity | None:
    try:
        stat = Path(f'/proc/{pid}/stat').read_text()
        fields = stat[stat.rfind(')') + 2:].split()
        return ProcessIdentity(pid, int(fields[1]), fields[19], fields[0])
    except (FileNotFoundError, ProcessLookupError):
        return None


def _descendants() -> list[ProcessIdentity]:
    rows = [_identity(int(entry.name)) for entry in Path('/proc').iterdir() if entry.name.isdigit()]
    parents = {os.getpid()}
    result = []
    while True:
        children = [row for row in rows if row and row.pid not in parents and row.ppid in parents]
        if not children:
            return result
        result.extend(children)
        parents.update(row.pid for row in children)


def _signal_owned(row: ProcessIdentity, value: int) -> None:
    current = _identity(row.pid)
    if current is not None and current.started == row.started:
        try:
            os.kill(row.pid, value)
        except ProcessLookupError:
            pass


def _reap(worker: subprocess.Popen) -> bool:
    """Return true only when the kernel reports no remaining direct children."""
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        if pid == 0:
            return False
        if pid == worker.pid:
            worker.returncode = os.waitstatus_to_exitcode(status)


def _cleanup(worker: subprocess.Popen, timeout_seconds: float = 3.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    stopped: dict[int, ProcessIdentity] = {}
    succeeded = False
    try:
        while time.monotonic() < deadline:
            if _reap(worker):
                succeeded = True
                return
            rows = _descendants()
            for row in rows:
                _signal_owned(row, signal.SIGSTOP)
                stopped[row.pid] = row
            # Verify the stop took effect, then take another snapshot. With all
            # parents stopped and this supervisor alive, no late fork/reparent
            # can escape the boundary while children are killed and adopted.
            stable = _descendants()
            if any(row.pid not in stopped or row.started != stopped[row.pid].started
                   or row.state not in {'T', 't', 'Z', 'X'} for row in stable):
                time.sleep(0.005)
                continue
            for row in reversed(stable):
                _signal_owned(row, signal.SIGKILL)
            if _reap(worker):
                succeeded = True
                return
            time.sleep(0.005)
        raise RuntimeError('descendants survived the 3-second supervisor cleanup deadline')
    finally:
        if not succeeded:
            # Retain ownership and allow Node's external fallback to run; never
            # leave a surviving child frozen after a failed cleanup attempt.
            for row in stopped.values():
                try:
                    _signal_owned(row, signal.SIGCONT)
                except OSError:
                    pass


def _exit_code(returncode: int) -> int:
    return returncode if returncode >= 0 else 128 - returncode


def _report_cleanup_failure(error: Exception) -> None:
    print('@@LUDORA_OPERATION_EVENT@@' + json.dumps({
        'event': 'item_discovery.supervisor.cleanup_failed', 'error': str(error)[:1000]
    }), file=sys.stderr, flush=True)


def main(argv: list[str] | None = None) -> int:
    if sys.platform != 'linux':
        raise RuntimeError('The discovery operation supervisor requires Linux')
    _enable_subreaper()  # Must precede Popen: no worker/driver can orphan first.
    read_fd, write_fd = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
    previous_wakeup = signal.set_wakeup_fd(write_fd)
    hard_stop = False
    pending_signal: int | None = None
    worker: subprocess.Popen | None = None

    def handle(value: int, _frame: object) -> None:
        nonlocal hard_stop, pending_signal
        if value == signal.SIGUSR1:
            hard_stop = True
        elif value in (signal.SIGTERM, signal.SIGINT):
            pending_signal = value

    previous_handlers = {value: signal.signal(value, handle) for value in
                         (signal.SIGCHLD, signal.SIGTERM, signal.SIGINT, signal.SIGUSR1)}
    try:
        # Inherit stdin/stdout/stderr unchanged. The parent sees the operation's
        # original acceptance frames, diagnostics and result JSON directly.
        worker = subprocess.Popen([sys.executable, '-m', 'ludora.operation_cli', *(sys.argv[1:] if argv is None else argv)])
        worker_identity = _identity(worker.pid)
        cleanup_failed = False
        while True:
            _reap(worker)
            if pending_signal is not None:
                if worker.returncode is None and worker_identity is not None:
                    _signal_owned(worker_identity, pending_signal)
                pending_signal = None
            if hard_stop or (worker.returncode is not None and not cleanup_failed):
                requested_hard_stop = hard_stop
                hard_stop = False
                try:
                    _cleanup(worker)
                except Exception as error:
                    cleanup_failed = True
                    # Remain the living ownership boundary until Node retries
                    # or invokes its bounded external process-tree fallback.
                    _report_cleanup_failure(error)
                else:
                    return 137 if requested_hard_stop else _exit_code(worker.returncode or 0)
            select.select([read_fd], [], [])
            try:
                os.read(read_fd, 4096)
            except BlockingIOError:
                pass
    except Exception:
        if worker is not None:
            try:
                _cleanup(worker)
            except Exception as cleanup_error:
                _report_cleanup_failure(cleanup_error)
                # An unexpected supervisor error must not drop the subreaper
                # while owned children survive. Node's external fallback is
                # authoritative and bounded even if this wrapper cannot recover.
                while True:
                    signal.pause()
        raise
    finally:
        signal.set_wakeup_fd(previous_wakeup)
        for value, handler in previous_handlers.items():
            signal.signal(value, handler)
        os.close(read_fd)
        os.close(write_fd)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'error': {'message': f'Discovery supervisor failed: {str(error)[:1000]}'}}), file=sys.stderr, flush=True)
        raise SystemExit(70)
