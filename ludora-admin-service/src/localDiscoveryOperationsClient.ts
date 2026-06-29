import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  DiscoveryOperationError,
  type DiscoveryOperationsClient,
  type StoreDiscoveryRun,
  type StoreDiscoveryRunStatus
} from './discoveryOperations.js';

export type SpawnDiscoveryProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

type LocalDiscoveryOptions = {
  envFile: string;
  now?: () => Date;
  packageDir: string;
  pythonExecutable: string;
  spawnProcess?: SpawnDiscoveryProcess;
};

type ManagedRun = StoreDiscoveryRun & {
  child?: ChildProcessWithoutNullStreams;
};

export function createLocalDiscoveryOperationsClient({
  envFile,
  now = () => new Date(),
  packageDir,
  pythonExecutable,
  spawnProcess = spawn
}: LocalDiscoveryOptions): DiscoveryOperationsClient {
  const runs = new Map<string, ManagedRun>();
  let latestRunId: string | null = null;
  let activeRunId: string | null = null;

  function startRun(type: StoreDiscoveryRun['type'], commandArgs: string[]): StoreDiscoveryRun {
    if (activeRunId) {
      throw new DiscoveryOperationError('Discovery operation is already running', 409);
    }

    const run: ManagedRun = {
      completed_at: null,
      error: null,
      id: randomUUID(),
      result: null,
      started_at: formatDate(now()),
      status: 'running',
      type
    };

    const args = ['-m', 'ludora.operation_cli', '--env-file', envFile, ...commandArgs];
    const child = spawnProcess(pythonExecutable, args, {
      cwd: packageDir,
      env: {
        ...process.env,
        PYTHONPATH: path.join(packageDir, 'src')
      }
    });

    run.child = child;
    runs.set(run.id, run);
    latestRunId = run.id;
    activeRunId = run.id;

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code, signal) => {
      if (run.status === 'cancelling' || signal) {
        finishRun(run, 'cancelled', null, null);
        activeRunId = null;
        return;
      }
      if (code === 0) {
        finishRun(run, 'completed', parseResult(stdout), null);
        activeRunId = null;
        return;
      }
      finishRun(run, 'failed', null, errorMessage(stderr, stdout, code));
      activeRunId = null;
    });

    return publicRun(run);
  }

  return {
    async cancelStoreDiscoveryRun(runId: string): Promise<StoreDiscoveryRun> {
      const run = runs.get(runId);
      if (!run) {
        throw new DiscoveryOperationError('Run not found', 404);
      }
      if (activeRunId !== runId || !['running', 'cancelling'].includes(run.status)) {
        throw new DiscoveryOperationError('Run is not running', 409);
      }
      run.status = 'cancelling';
      run.child?.kill('SIGTERM');
      return publicRun(run);
    },
    async getLatestStoreDiscoveryRun(): Promise<StoreDiscoveryRun | null> {
      return latestRunId ? publicRun(runs.get(latestRunId) ?? null) : null;
    },
    async getStoreDiscoveryRun(runId: string): Promise<StoreDiscoveryRun | null> {
      return publicRun(runs.get(runId) ?? null);
    },
    async startItemDiscoveryRun(storeId: number, websiteUrl: string): Promise<StoreDiscoveryRun> {
      return startRun('item_discovery', [
        'item-discovery',
        '--store-id',
        String(storeId),
        '--website-url',
        websiteUrl
      ]);
    },
    async startItemEmbeddingRun(refreshMode: 'full' | 'missing'): Promise<StoreDiscoveryRun> {
      return startRun('item_embeddings', ['item-embeddings', '--refresh-mode', refreshMode]);
    },
    async startItemUpdateRun(): Promise<StoreDiscoveryRun> {
      return startRun('item_update', ['item-update']);
    },
    async startStoreDiscoveryRun(): Promise<StoreDiscoveryRun> {
      return startRun('store_discovery', ['store-discovery']);
    }
  };
}

function finishRun(
  run: ManagedRun,
  status: StoreDiscoveryRunStatus,
  result: StoreDiscoveryRun['result'],
  error: string | null
): void {
  run.child = undefined;
  run.completed_at = formatDate(new Date());
  run.error = error;
  run.result = result;
  run.status = status;
}

function publicRun(run: ManagedRun | null): StoreDiscoveryRun | null;
function publicRun(run: ManagedRun): StoreDiscoveryRun;
function publicRun(run: ManagedRun | null): StoreDiscoveryRun | null {
  if (!run) {
    return null;
  }
  const { child: _child, ...payload } = run;
  return { ...payload };
}

function parseResult(stdout: string): StoreDiscoveryRun['result'] {
  const parsed = JSON.parse(stdout.trim()) as { result?: StoreDiscoveryRun['result'] };
  return parsed.result ?? null;
}

function errorMessage(stderr: string, stdout: string, code: number | null): string {
  const rawMessage = stderr.trim() || stdout.trim();
  if (rawMessage) {
    try {
      const parsed = JSON.parse(rawMessage) as { error?: { message?: string } };
      if (parsed.error?.message) {
        return parsed.error.message;
      }
    } catch {
      return rawMessage;
    }
    return rawMessage;
  }
  return `Discovery operation exited with code ${code ?? 'unknown'}`;
}

function formatDate(value: Date): string {
  return value.toISOString();
}
