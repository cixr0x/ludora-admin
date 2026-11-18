import { execFile, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import path from 'node:path';

const SHUTDOWN_GRACE_MS = 10_000;

export type SpawnContinuousItemUpdateWorker = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

export type TerminateContinuousItemUpdateWorkerProcessTree = (
  child: Pick<ChildProcessWithoutNullStreams, 'kill' | 'pid'>,
  signal: NodeJS.Signals
) => void;

type ProcessTreeTerminatorOptions = {
  executeTaskkill?: (pid: number) => void;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  platform?: NodeJS.Platform;
};

export function createContinuousItemUpdateWorkerProcessTreeTerminator({
  executeTaskkill = (pid) => {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error) {
        console.error(`[continuous-item-update] failed to terminate Windows worker tree for pid ${pid}: ${error.message}`);
      }
    });
  },
  killProcess = (pid, signal) => process.kill(pid, signal),
  platform = process.platform
}: ProcessTreeTerminatorOptions = {}): TerminateContinuousItemUpdateWorkerProcessTree {
  return (child, signal) => {
    if (!child.pid) {
      child.kill(signal);
      return;
    }
    if (platform === 'win32') {
      executeTaskkill(child.pid);
      return;
    }
    try {
      killProcess(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
        throw error;
      }
    }
  };
}

type ContinuousItemUpdateWorkerManagerOptions = {
  adminApiUrl: string;
  concurrency: number;
  envFile: string;
  internalApiToken: string;
  itemTimeoutSeconds: number;
  leaseSeconds: number;
  packageDir: string;
  pollSeconds: number;
  pythonExecutable: string;
  restartDelayMs?: number;
  spawnProcess?: SpawnContinuousItemUpdateWorker;
  terminateProcessTree?: TerminateContinuousItemUpdateWorkerProcessTree;
};

export type ContinuousItemUpdateWorkerManager = {
  getStatus(): ContinuousItemUpdateWorkerControlStatus;
  pause(): ContinuousItemUpdateWorkerControlStatus;
  resume(): ContinuousItemUpdateWorkerControlStatus;
  shutdown(): Promise<void>;
  start(): void;
};

export type ContinuousItemUpdateWorkerControlStatus = 'paused' | 'running' | 'stopping';

export function createContinuousItemUpdateWorkerManager({
  adminApiUrl,
  concurrency,
  envFile,
  internalApiToken,
  itemTimeoutSeconds,
  leaseSeconds,
  packageDir,
  pollSeconds,
  pythonExecutable,
  restartDelayMs = 15_000,
  spawnProcess = spawn,
  terminateProcessTree = createContinuousItemUpdateWorkerProcessTreeTerminator()
}: ContinuousItemUpdateWorkerManagerOptions): ContinuousItemUpdateWorkerManager {
  let child: ChildProcessWithoutNullStreams | null = null;
  const itemWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  let drainWatchdog: ReturnType<typeof setTimeout> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stdoutBuffer = '';
  let forceTerminationRequested = false;
  let isPaused = false;
  let isShuttingDown = false;
  let isStopping = false;

  function clearItemWatchdogs(): void {
    for (const timer of itemWatchdogs.values()) {
      clearTimeout(timer);
    }
    itemWatchdogs.clear();
  }

  function clearDrainWatchdog(): void {
    if (drainWatchdog) {
      clearTimeout(drainWatchdog);
      drainWatchdog = null;
    }
  }

  function forceTerminateChild(activeChild: ChildProcessWithoutNullStreams): void {
    if (child !== activeChild || forceTerminationRequested) {
      return;
    }
    forceTerminationRequested = true;
    clearItemWatchdogs();
    clearDrainWatchdog();
    terminateProcessTree(activeChild, 'SIGKILL');
  }

  function armDrainWatchdog(activeChild: ChildProcessWithoutNullStreams): void {
    if (drainWatchdog || forceTerminationRequested) {
      return;
    }
    drainWatchdog = setTimeout(() => {
      console.error('[continuous-item-update] worker timed out while draining item slots');
      forceTerminateChild(activeChild);
    }, itemTimeoutSeconds * 1_000 + SHUTDOWN_GRACE_MS);
  }

  function handleWorkerLifecycleOutput(spawnedChild: ChildProcessWithoutNullStreams, chunk: unknown): void {
    if (child !== spawnedChild || isShuttingDown || forceTerminationRequested) {
      return;
    }
    stdoutBuffer += String(chunk);
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf('\n');
      if (!line) {
        continue;
      }
      try {
        const event: unknown = JSON.parse(line);
        if (!event || typeof event !== 'object' || !('event' in event)) {
          continue;
        }
        const lifecycleEvent = event as Record<string, unknown>;
        if (lifecycleEvent.event === 'worker.session.draining') {
          armDrainWatchdog(spawnedChild);
          continue;
        }
        if (lifecycleEvent.event === 'worker.session.failed') {
          clearItemWatchdogs();
          clearDrainWatchdog();
          continue;
        }
        const { attempt_id: attemptId } = lifecycleEvent;
        if (typeof attemptId !== 'number' && typeof attemptId !== 'string') {
          continue;
        }
        const key = String(attemptId);
        if (lifecycleEvent.event === 'worker.item.started') {
          if (itemWatchdogs.has(key)) {
            continue;
          }
          const platform = String(lifecycleEvent.platform);
          const storeItemId = String(lifecycleEvent.store_item_id);
          const startedAt = Date.now();
          const timer = setTimeout(() => {
            if (child !== spawnedChild || itemWatchdogs.get(key) !== timer) {
              return;
            }
            const elapsedMs = Date.now() - startedAt;
            console.error(
              `[continuous-item-update] item watchdog timed out: attempt_id=${key} store_item_id=${storeItemId} platform=${platform} timeout_seconds=${itemTimeoutSeconds} elapsed_ms=${elapsedMs}`
            );
            forceTerminateChild(spawnedChild);
          }, itemTimeoutSeconds * 1_000);
          itemWatchdogs.set(key, timer);
        } else if (
          lifecycleEvent.event === 'worker.item.succeeded'
          || lifecycleEvent.event === 'worker.item.failed'
          || lifecycleEvent.event === 'worker.item.deactivated'
        ) {
          clearTimeout(itemWatchdogs.get(key));
          itemWatchdogs.delete(key);
        }
      } catch {
        // Child stdout also includes non-lifecycle logs; keep forwarding it unchanged.
      }
    }
  }

  function launch(): void {
    if (isPaused || isShuttingDown || child) {
      return;
    }
    const packagePath = /^[A-Za-z]:[\\/]/.test(packageDir) ? path.win32 : path;
    const args = [
      '-m',
      'ludora.continuous_update_worker',
      '--env-file',
      envFile,
      '--poll-seconds',
      String(pollSeconds),
      '--lease-seconds',
      String(leaseSeconds),
      '--concurrency',
      String(concurrency)
    ];
    const spawnedChild = spawnProcess(pythonExecutable, args, {
      cwd: packageDir,
      env: {
        ...process.env,
        LUDORA_ADMIN_API_URL: adminApiUrl,
        LUDORA_INTERNAL_API_TOKEN: internalApiToken,
        PYTHONPATH: packagePath.join(packageDir, 'src')
      },
      detached: process.platform !== 'win32'
    });
    child = spawnedChild;
    spawnedChild.stdout.on('data', (chunk) => {
      process.stdout.write(`[continuous-item-update] ${String(chunk)}`);
      handleWorkerLifecycleOutput(spawnedChild, chunk);
    });
    spawnedChild.stderr.on('data', (chunk) => {
      process.stderr.write(`[continuous-item-update] ${String(chunk)}`);
    });
    spawnedChild.on('error', (error) => {
      console.error(`[continuous-item-update] failed to start: ${error.message}`);
    });
    spawnedChild.on('close', (code, signal) => {
      if (child !== spawnedChild) {
        return;
      }
      const stoppedForPause = isStopping;
      clearItemWatchdogs();
      clearDrainWatchdog();
      stdoutBuffer = '';
      forceTerminationRequested = false;
      child = null;
      isStopping = false;
      if (isShuttingDown) {
        return;
      }
      if (isPaused) {
        return;
      }
      if (stoppedForPause) {
        launch();
        return;
      }
      console.error(
        `[continuous-item-update] worker exited (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}); restarting`
      );
      restartTimer = setTimeout(() => {
        restartTimer = null;
        launch();
      }, restartDelayMs);
    });
  }

  return {
    getStatus(): ContinuousItemUpdateWorkerControlStatus {
      if (child) {
        return isStopping ? 'stopping' : 'running';
      }
      return isPaused ? 'paused' : 'running';
    },
    pause(): ContinuousItemUpdateWorkerControlStatus {
      isPaused = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (child && !isStopping) {
        isStopping = true;
        armDrainWatchdog(child);
        child.kill('SIGTERM');
      }
      return child ? 'stopping' : 'paused';
    },
    resume(): ContinuousItemUpdateWorkerControlStatus {
      isPaused = false;
      if (!child && !restartTimer) {
        launch();
      }
      return child && isStopping ? 'stopping' : 'running';
    },
    start: launch,
    async shutdown(): Promise<void> {
      isShuttingDown = true;
      clearItemWatchdogs();
      clearDrainWatchdog();
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      const activeChild = child;
      if (!activeChild) {
        return;
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
        const settle = () => {
          if (settled) {
            return;
          }
          settled = true;
          if (forceKillTimer) {
            clearTimeout(forceKillTimer);
          }
          resolve();
        };
        forceKillTimer = setTimeout(() => {
          forceTerminateChild(activeChild);
          settle();
        }, SHUTDOWN_GRACE_MS);
        activeChild.once('close', settle);
        activeChild.kill('SIGTERM');
      });
    }
  };
}
