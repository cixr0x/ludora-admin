"""Bounded cleanup of a subprocess and every process it owns."""
from __future__ import annotations

import os
import signal
import subprocess
import sys


def prepare_to_own_children() -> None:
    """No parent-wide subreaper: every child has its own wrapper on Linux."""


def owned_command(command: list[str]) -> list[str]:
    if sys.platform == "linux":
        return [sys.executable, "-m", "ludora.operation_supervisor", "--owned-child", *command]
    return command


def terminate_and_reap_tree(process: subprocess.Popen, *, timeout_seconds: float = 3.0,
                            allow_exited_root: bool = False) -> None:
    if sys.platform == "linux":
        if process.poll() is None:
            process.send_signal(signal.SIGUSR1)
        try:
            process.wait(timeout=timeout_seconds + 0.5)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"Owned subreaper {process.pid} did not reap its child tree") from exc
        if process.returncode not in (0, 137):
            raise RuntimeError(f"Owned subreaper {process.pid} exited without verified cleanup ({process.returncode})")
        return
    if os.name == "nt":
        if process.poll() is not None:
            if allow_exited_root:
                process.wait(timeout=timeout_seconds)
                return
            raise RuntimeError(f"Child {process.pid} exited before its descendant tree could be verified")
        result = subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
        try:
            process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"Child process tree {process.pid} was not reaped") from exc
        if result.returncode != 0 and not allow_exited_root:
            raise RuntimeError(f"Failed to terminate process tree {process.pid}: {result.stderr.decode(errors='replace')}")
        return
    raise RuntimeError(f"Unsupported process-tree cleanup platform: {sys.platform}")
