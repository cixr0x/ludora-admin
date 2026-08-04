import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import path from 'node:path';

export type SpawnContinuousItemUpdateWorker = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

type ContinuousItemUpdateWorkerManagerOptions = {
  adminApiUrl: string;
  envFile: string;
  internalApiToken: string;
  leaseSeconds: number;
  packageDir: string;
  pollSeconds: number;
  pythonExecutable: string;
  restartDelayMs?: number;
  spawnProcess?: SpawnContinuousItemUpdateWorker;
};

export type ContinuousItemUpdateWorkerManager = {
  shutdown(): Promise<void>;
  start(): void;
};

export function createContinuousItemUpdateWorkerManager({
  adminApiUrl,
  envFile,
  internalApiToken,
  leaseSeconds,
  packageDir,
  pollSeconds,
  pythonExecutable,
  restartDelayMs = 15_000,
  spawnProcess = spawn
}: ContinuousItemUpdateWorkerManagerOptions): ContinuousItemUpdateWorkerManager {
  let child: ChildProcessWithoutNullStreams | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let isShuttingDown = false;

  function launch(): void {
    if (isShuttingDown || child) {
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
      String(leaseSeconds)
    ];
    const spawnedChild = spawnProcess(pythonExecutable, args, {
      cwd: packageDir,
      env: {
        ...process.env,
        LUDORA_ADMIN_API_URL: adminApiUrl,
        LUDORA_INTERNAL_API_TOKEN: internalApiToken,
        PYTHONPATH: packagePath.join(packageDir, 'src')
      }
    });
    child = spawnedChild;
    spawnedChild.stdout.on('data', (chunk) => {
      process.stdout.write(`[continuous-item-update] ${String(chunk)}`);
    });
    spawnedChild.stderr.on('data', (chunk) => {
      process.stderr.write(`[continuous-item-update] ${String(chunk)}`);
    });
    spawnedChild.on('error', (error) => {
      console.error(`[continuous-item-update] failed to start: ${error.message}`);
    });
    spawnedChild.on('close', (code, signal) => {
      if (child === spawnedChild) {
        child = null;
      }
      if (isShuttingDown) {
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
    start: launch,
    async shutdown(): Promise<void> {
      isShuttingDown = true;
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
          activeChild.kill('SIGKILL');
          settle();
        }, 10_000);
        activeChild.once('close', settle);
        activeChild.kill('SIGTERM');
      });
    }
  };
}
