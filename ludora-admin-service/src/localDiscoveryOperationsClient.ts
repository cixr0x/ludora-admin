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
  cancelEscalationMs?: number;
  cancelForceFailMs?: number;
  envFile: string;
  now?: () => Date;
  packageDir: string;
  pythonExecutable: string;
  spawnProcess?: SpawnDiscoveryProcess;
};

type ManagedRun = StoreDiscoveryRun & {
  cancelEscalationTimer?: ReturnType<typeof setTimeout>;
  cancelForceFailTimer?: ReturnType<typeof setTimeout>;
  child?: ChildProcessWithoutNullStreams;
  settleRun?: (status: StoreDiscoveryRunStatus, result: StoreDiscoveryRun['result'], error: string | null) => void;
  waiters?: Array<() => void>;
};

export function createLocalDiscoveryOperationsClient({
  cancelEscalationMs = 10_000,
  cancelForceFailMs = 5_000,
  envFile,
  now = () => new Date(),
  packageDir,
  pythonExecutable,
  spawnProcess = spawn
}: LocalDiscoveryOptions): LocalDiscoveryOperationsClient {
  const runs = new Map<string, ManagedRun>();
  let latestRunId: string | null = null;
  let activeRunId: string | null = null;
  let isShuttingDown = false;

  function startRun(type: StoreDiscoveryRun['type'], commandArgs: string[]): StoreDiscoveryRun {
    if (isShuttingDown) {
      throw new DiscoveryOperationError('Discovery operations client is shutting down', 503);
    }
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
    let settled = false;
    const settleRun = (
      status: StoreDiscoveryRunStatus,
      result: StoreDiscoveryRun['result'],
      error: string | null
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearCancellationTimers(run);
      finishRun(run, status, result, error, now());
      if (activeRunId === run.id) {
        activeRunId = null;
      }
      const waiters = run.waiters ?? [];
      run.waiters = [];
      for (const waiter of waiters) {
        waiter();
      }
    };
    run.settleRun = settleRun;
    child.on('error', (error) => {
      settleRun('failed', null, error.message);
    });
    child.on('close', (code, signal) => {
      if (run.status === 'cancelling') {
        settleRun('cancelled', null, null);
        return;
      }
      if (signal) {
        settleRun('failed', null, `Discovery operation exited with signal ${signal}`);
        return;
      }
      if (code === 0) {
        const parsedResult = tryParseResult(stdout, run.type);
        if (parsedResult.ok) {
          settleRun('completed', parsedResult.result, null);
          return;
        }
        settleRun('failed', null, parsedResult.error);
        return;
      }
      settleRun('failed', null, errorMessage(stderr, stdout, code));
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
      requestCancellation(run);
      return publicRun(run);
    },
    async getLatestStoreDiscoveryRun(): Promise<StoreDiscoveryRun | null> {
      return latestRunId ? publicRun(runs.get(latestRunId) ?? null) : null;
    },
    async getStoreDiscoveryRun(runId: string): Promise<StoreDiscoveryRun | null> {
      return publicRun(runs.get(runId) ?? null);
    },
    async startItemDiscoveryRun(storeId: number, websiteUrl: string, platform = '', storeName = ''): Promise<StoreDiscoveryRun> {
      const args = [
        'item-discovery',
        '--store-id',
        String(storeId),
        '--website-url',
        websiteUrl
      ];
      const normalizedStoreName = storeName.trim();
      if (normalizedStoreName) {
        args.push('--store-name', normalizedStoreName);
      }
      const normalizedPlatform = platform.trim().toLowerCase();
      if (normalizedPlatform) {
        args.push('--platform', normalizedPlatform);
      }
      return startRun('item_discovery', args);
    },
    async startItemEmbeddingRun(refreshMode: 'full' | 'missing'): Promise<StoreDiscoveryRun> {
      return startRun('item_embeddings', ['item-embeddings', '--refresh-mode', refreshMode]);
    },
    async startItemUpdateRun(): Promise<StoreDiscoveryRun> {
      return startRun('item_update', ['item-update']);
    },
    async startStoreDiscoveryRun(): Promise<StoreDiscoveryRun> {
      return startRun('store_discovery', ['store-discovery']);
    },
    async shutdown(): Promise<void> {
      isShuttingDown = true;
      const run = activeRunId ? runs.get(activeRunId) : null;
      if (!run) {
        return;
      }
      requestCancellation(run);
      await waitForRunToSettle(run, cancelEscalationMs + cancelForceFailMs + 100);
    }
  };

  function requestCancellation(run: ManagedRun): void {
    if (run.status === 'running') {
      run.status = 'cancelling';
      run.child?.kill('SIGTERM');
      scheduleCancellationEscalation(run);
    }
  }

  function scheduleCancellationEscalation(run: ManagedRun): void {
    clearCancellationTimers(run);
    run.cancelEscalationTimer = setTimeout(() => {
      run.cancelEscalationTimer = undefined;
      if (activeRunId !== run.id || run.status !== 'cancelling') {
        return;
      }
      run.child?.kill('SIGKILL');
      run.cancelForceFailTimer = setTimeout(() => {
        run.cancelForceFailTimer = undefined;
        if (activeRunId === run.id && run.status === 'cancelling') {
          run.settleRun?.('failed', null, 'Discovery operation did not exit after cancellation');
        }
      }, cancelForceFailMs);
      run.cancelForceFailTimer.unref?.();
    }, cancelEscalationMs);
    run.cancelEscalationTimer.unref?.();
  }

  function waitForRunToSettle(run: ManagedRun, timeoutMs: number): Promise<void> {
    if (activeRunId !== run.id) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const waiters = run.waiters ?? [];
        run.waiters = waiters.filter((waiter) => waiter !== resolve);
        if (activeRunId === run.id && run.status === 'cancelling') {
          run.settleRun?.('failed', null, 'Discovery operation did not exit during shutdown');
        }
        resolve();
      }, timeoutMs);
      timeout.unref?.();
      const waiter = () => {
        clearTimeout(timeout);
        resolve();
      };
      run.waiters = [...(run.waiters ?? []), waiter];
    });
  }
}

export type LocalDiscoveryOperationsClient = DiscoveryOperationsClient & {
  shutdown(): Promise<void>;
};

function finishRun(
  run: ManagedRun,
  status: StoreDiscoveryRunStatus,
  result: StoreDiscoveryRun['result'],
  error: string | null,
  completedAt: Date
): void {
  run.child = undefined;
  run.completed_at = formatDate(completedAt);
  run.error = error;
  run.result = result;
  run.status = status;
  run.settleRun = undefined;
}

function publicRun(run: ManagedRun): StoreDiscoveryRun;
function publicRun(run: ManagedRun | null): StoreDiscoveryRun | null;
function publicRun(run: ManagedRun | null): StoreDiscoveryRun | null {
  if (!run) {
    return null;
  }
  const {
    cancelEscalationTimer: _cancelEscalationTimer,
    cancelForceFailTimer: _cancelForceFailTimer,
    child: _child,
    settleRun: _settleRun,
    waiters: _waiters,
    ...payload
  } = run;
  return { ...payload };
}

function clearCancellationTimers(run: ManagedRun): void {
  if (run.cancelEscalationTimer) {
    clearTimeout(run.cancelEscalationTimer);
    run.cancelEscalationTimer = undefined;
  }
  if (run.cancelForceFailTimer) {
    clearTimeout(run.cancelForceFailTimer);
    run.cancelForceFailTimer = undefined;
  }
}

function parseResult(stdout: string, type: StoreDiscoveryRun['type']): StoreDiscoveryRun['result'] {
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Object.hasOwn(parsed, 'result') ||
    (parsed as { result: unknown }).result === null
  ) {
    throw new Error('Malformed discovery operation result: expected non-null result property');
  }
  const result = (parsed as { result: unknown }).result;
  if (!isResultForRunType(type, result)) {
    throw new Error(`Malformed discovery operation result for ${type}`);
  }
  return result;
}

function tryParseResult(
  stdout: string,
  type: StoreDiscoveryRun['type']
): { ok: true; result: StoreDiscoveryRun['result'] } | { ok: false; error: string } {
  try {
    return { ok: true, result: parseResult(stdout, type) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (
      detail.startsWith('Malformed discovery operation result:') ||
      detail.startsWith('Malformed discovery operation result for ')
    ) {
      return { ok: false, error: detail };
    }
    return { ok: false, error: `Failed to parse discovery operation result: ${detail}` };
  }
}

function isResultForRunType(type: StoreDiscoveryRun['type'], result: unknown): result is NonNullable<StoreDiscoveryRun['result']> {
  if (!isRecord(result)) {
    return false;
  }

  switch (type) {
    case 'store_discovery':
      return (
        isNumber(result.accepted_stores) &&
        isNumber(result.candidate_domains) &&
        isNumber(result.searched_queries)
      );
    case 'item_discovery':
      return isNumber(result.item_candidates) && isNumber(result.store_id) && typeof result.website_url === 'string';
    case 'item_update':
      return isNumber(result.updated_items);
    case 'item_embeddings':
      return (
        isNumber(result.embedded_items) &&
        typeof result.model === 'string' &&
        (result.refresh_mode === 'full' || result.refresh_mode === 'missing') &&
        isNumber(result.selected_items)
      );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
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
