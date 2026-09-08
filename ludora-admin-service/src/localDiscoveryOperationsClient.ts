import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createDiscoveryProcessTree, type DiscoveryProcessTree } from './discoveryProcessTree.js';

import {
  DiscoveryOperationError,
  type DiscoveryOperationsClient,
  type ItemDiscoveryRunScope,
  type ItemUpdateRunScope,
  type StoreDiscoveryRun,
  type StoreDiscoveryRunStatus
} from './discoveryOperations.js';

const ITEM_DISCOVERY_ACCEPTANCE_EVENT = 'item_discovery.accepted';
const OPERATION_ALREADY_RUNNING_ERROR_CODE = 'OPERATION_ALREADY_RUNNING';
const OPERATION_EVENT_PREFIX = '@@LUDORA_OPERATION_EVENT@@';

export type SpawnDiscoveryProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

type LocalDiscoveryOptions = {
  browserFetchTimeoutSeconds?: number;
  cleanupTimeoutMs?: number;
  processTreeFactory?: (child: ChildProcessWithoutNullStreams) => DiscoveryProcessTree;
  persistBrowserFailure?: (failure: DiscoveryBrowserFailure) => Promise<void>;
  cancelEscalationMs?: number;
  cancelForceFailMs?: number;
  envFile: string;
  internalApiToken?: string;
  now?: () => Date;
  packageDir: string;
  pythonExecutable: string;
  spawnProcess?: SpawnDiscoveryProcess;
};

export type DiscoveryBrowserFailure = {
  runId: string;
  storeId: number;
  url: string;
  phase: string;
  timeoutSeconds: number;
  reason: 'timeout' | 'cancelled';
  error: string;
};
type BrowserFetch = Pick<DiscoveryBrowserFailure, 'runId' | 'storeId' | 'url' | 'phase'> & { fetchId: string };

type ManagedRun = StoreDiscoveryRun & {
  exitDrainTimer?: ReturnType<typeof setTimeout>;
  browserWatchdogTimer?: ReturnType<typeof setTimeout>;
  watchedBrowser?: BrowserFetch;
  lastBrowser?: BrowserFetch;
  processTree?: DiscoveryProcessTree;
  hardStopStarted?: boolean;
  acceptanceRequired?: boolean;
  accepted?: boolean;
  cancelEscalationTimer?: ReturnType<typeof setTimeout>;
  cancelForceFailTimer?: ReturnType<typeof setTimeout>;
  child?: ChildProcessWithoutNullStreams;
  rejectAcceptance?: (error: DiscoveryOperationError) => void;
  resolveAcceptance?: () => void;
  settleRun?: (status: StoreDiscoveryRunStatus, result: StoreDiscoveryRun['result'], error: string | null) => void;
  terminalFailure?: string;
  waiters?: Array<() => void>;
};

export function createLocalDiscoveryOperationsClient({
  browserFetchTimeoutSeconds = 120,
  cleanupTimeoutMs = 10_000,
  processTreeFactory = createDiscoveryProcessTree,
  persistBrowserFailure,
  cancelEscalationMs = 10_000,
  cancelForceFailMs = 5_000,
  envFile,
  internalApiToken,
  now = () => new Date(),
  packageDir,
  pythonExecutable,
  spawnProcess = spawn
}: LocalDiscoveryOptions): LocalDiscoveryOperationsClient {
  if (!Number.isFinite(browserFetchTimeoutSeconds) || browserFetchTimeoutSeconds <= 0 || browserFetchTimeoutSeconds * 1000 > 2_147_483_647) {
    throw new Error('Discovery browser fetch timeout must be positive and no greater than 2147483.647 seconds');
  }
  const runs = new Map<string, ManagedRun>();
  let latestRunId: string | null = null;
  let activeRunId: string | null = null;
  let isShuttingDown = false;

  function startRun(
    type: StoreDiscoveryRun['type'],
    commandArgs: string[],
    { waitForAcceptance = false }: { waitForAcceptance?: boolean } = {}
  ): StoreDiscoveryRun | Promise<StoreDiscoveryRun> {
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
      type,
      ...(waitForAcceptance ? { acceptanceRequired: true, accepted: false } : {})
    };

    let acceptancePromise: Promise<StoreDiscoveryRun> | undefined;
    if (waitForAcceptance) {
      acceptancePromise = new Promise<StoreDiscoveryRun>((resolve, reject) => {
        run.resolveAcceptance = () => {
          if (!run.rejectAcceptance) {
            return;
          }
          run.accepted = true;
          run.rejectAcceptance = undefined;
          run.resolveAcceptance = undefined;
          resolve(publicRun(run));
        };
        run.rejectAcceptance = (error) => {
          if (!run.resolveAcceptance) {
            return;
          }
          run.rejectAcceptance = undefined;
          run.resolveAcceptance = undefined;
          reject(error);
        };
      });
    }

    const args = ['-m', 'ludora.operation_cli', '--env-file', envFile, ...commandArgs];
    const packagePath = /^[A-Za-z]:[\\/]/.test(packageDir) ? path.win32 : path;
    const childEnv = {
      ...process.env,
      LUDORA_DISCOVERY_BROWSER_WATCHDOG: type === 'item_discovery' ? '1' : '0',
      PYTHONPATH: packagePath.join(packageDir, 'src'),
      ...(internalApiToken?.trim() ? { LUDORA_INTERNAL_API_TOKEN: internalApiToken.trim() } : {})
    };
    const child = spawnProcess(pythonExecutable, args, {
      cwd: packageDir,
      env: childEnv
    });

    run.child = child;
    // Capture the root creation identity while it is still our newly spawned child.
    try { run.processTree = processTreeFactory(child); }
    catch (error) {
      child.kill('SIGKILL');
      throw new DiscoveryOperationError(`Failed to track discovery process tree: ${failureMessage(error)}`, 500);
    }
    runs.set(run.id, run);
    latestRunId = run.id;
    activeRunId = run.id;

    let stdout = '';
    let stderr = '';
    let protocolBuffer = '';
    let settled = false;
    let removeChildListeners = (): void => undefined;
    const rejectPendingAcceptance = (error: DiscoveryOperationError): void => {
      run.rejectAcceptance?.(error);
    };
    const settleRun = (
      status: StoreDiscoveryRunStatus,
      result: StoreDiscoveryRun['result'],
      error: string | null
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearBrowserWatchdog(run);
      clearCancellationTimers(run);
      removeChildListeners();
      if (run.acceptanceRequired && !run.accepted) {
        rejectPendingAcceptance(
          new DiscoveryOperationError(
            error ?? 'Item discovery operation ended before acceptance',
            500
          )
        );
      }
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

    const failAcceptanceProtocol = (message: string): void => {
      if (!run.acceptanceRequired || run.accepted || run.terminalFailure) {
        return;
      }
      run.terminalFailure = message;
      rejectPendingAcceptance(new DiscoveryOperationError(message, 500));
      requestCancellation(run);
    };
    const onStdoutData = (chunk: unknown): void => {
      stdout += String(chunk);
    };
    const onStderrData = (chunk: unknown): void => {
      const text = String(chunk);
      stderr += text;
      if (run.type !== 'item_discovery' || run.terminalFailure || run.status !== 'running') {
        return;
      }

      protocolBuffer += text;
      let newlineIndex = protocolBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = protocolBuffer.slice(0, newlineIndex).replace(/\r$/, '');
        protocolBuffer = protocolBuffer.slice(newlineIndex + 1);
        const eventPrefixIndex = line.indexOf(OPERATION_EVENT_PREFIX);
        if (eventPrefixIndex >= 0) {
          let event: unknown;
          try {
            event = JSON.parse(line.slice(eventPrefixIndex + OPERATION_EVENT_PREFIX.length));
          } catch {
            if (!run.accepted) failAcceptanceProtocol('Malformed item discovery acceptance event');
            else failBrowserProtocol('Malformed item discovery browser event');
            return;
          }
          if (!isRecord(event)) {
            failAcceptanceProtocol('Malformed item discovery acceptance event');
            return;
          }
          if (event.event === ITEM_DISCOVERY_ACCEPTANCE_EVENT) {
            run.resolveAcceptance?.();
          } else if (event.event === 'item_discovery.browser.started' || event.event === 'item_discovery.browser.completed') {
            const browser = parseBrowserEvent(event);
            if (!run.accepted || !browser) {
              failBrowserProtocol('Malformed item discovery browser event');
              return;
            }
            if (event.event === 'item_discovery.browser.started') {
              // Duplicate starts cannot extend an already armed deadline.
              if (run.watchedBrowser) {
                if (run.watchedBrowser.fetchId !== browser.fetchId) failBrowserProtocol('Overlapping item discovery browser fetches');
              } else {
                run.watchedBrowser = browser;
                run.lastBrowser = browser;
                run.browserWatchdogTimer = setTimeout(() => {
                  if (settled || activeRunId !== run.id || run.watchedBrowser !== browser || run.status !== 'running') return;
                  const error = `Discovery browser timeout after ${browserFetchTimeoutSeconds} seconds: run_id=${browser.runId} store_id=${browser.storeId} phase=${browser.phase} url=${browser.url}`;
                  run.terminalFailure = error;
                  void hardStop(run, error, 'timeout');
                }, browserFetchTimeoutSeconds * 1000);
                run.browserWatchdogTimer.unref?.();
                try { run.processTree?.capture(); }
                catch (error) { failBrowserProtocol(`Failed to track browser descendants: ${failureMessage(error)}`); }
              }
            } else if (run.watchedBrowser?.fetchId === browser.fetchId && run.watchedBrowser.runId === browser.runId && run.watchedBrowser.storeId === browser.storeId) {
              clearBrowserWatchdog(run);
            }
          } else if (!run.accepted) {
            failAcceptanceProtocol('Malformed item discovery acceptance event');
            return;
          }
        }
        newlineIndex = protocolBuffer.indexOf('\n');
      }
    };
    const failBrowserProtocol = (message: string): void => {
      run.terminalFailure = message;
      void hardStop(run, message);
    };
    const onChildError = (error: Error): void => {
      if (run.hardStopStarted) return;
      rejectPendingAcceptance(new DiscoveryOperationError(error.message, 500));
      if (run.child?.pid) {
        run.terminalFailure = error.message;
        void hardStop(run, error.message);
        return;
      }
      settleRun('failed', null, error.message);
    };
    const onChildExit = (): void => {
      clearBrowserWatchdog(run);
      if (run.hardStopStarted || settled) return;
      run.exitDrainTimer = setTimeout(() => {
        void hardStop(run, 'Discovery operation exited but output pipes did not close', run.status === 'cancelling' ? 'cancelled' : undefined, true);
      }, cancelForceFailMs);
      run.exitDrainTimer.unref?.();
    };
    const onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (run.hardStopStarted) return;
      if (run.status === 'cancelling' && (run.child?.pid || run.lastBrowser)) {
        void hardStop(run, run.terminalFailure ?? 'Discovery operation cancelled', 'cancelled');
        return;
      }
      if (run.terminalFailure) {
        settleRun('failed', null, run.terminalFailure);
        return;
      }
      if (run.acceptanceRequired && !run.accepted) {
        if (run.status === 'cancelling') {
          rejectPendingAcceptance(
            new DiscoveryOperationError(
              isShuttingDown
                ? 'Discovery operations client shut down before item discovery was accepted'
                : 'Item discovery operation was cancelled before acceptance',
              isShuttingDown ? 503 : 409
            )
          );
          settleRun('cancelled', null, null);
          return;
        }
        if (signal) {
          const message = `Discovery operation exited with signal ${signal}`;
          rejectPendingAcceptance(new DiscoveryOperationError(message, 500));
          settleRun('failed', null, message);
          return;
        }
        if (code !== 0) {
          const exitError = operationExitError(stderr, stdout, code);
          const status = exitError.code === OPERATION_ALREADY_RUNNING_ERROR_CODE ? 409 : 500;
          rejectPendingAcceptance(new DiscoveryOperationError(exitError.message, status));
          settleRun('failed', null, exitError.message);
          return;
        }
        const message = 'Item discovery operation exited before acceptance';
        rejectPendingAcceptance(new DiscoveryOperationError(message, 500));
        settleRun('failed', null, message);
        return;
      }
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
    };
    removeChildListeners = () => {
      child.stdout.off('data', onStdoutData);
      child.stderr.off('data', onStderrData);
      child.off('error', onChildError);
      child.off('close', onChildClose);
      child.off('exit', onChildExit);
    };
    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);
    child.on('error', onChildError);
    child.on('close', onChildClose);
    child.on('exit', onChildExit);

    return acceptancePromise ?? publicRun(run);
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
      requestCancellation(
        run,
        new DiscoveryOperationError('Item discovery operation was cancelled before acceptance', 409)
      );
      return publicRun(run);
    },
    async getLatestStoreDiscoveryRun(): Promise<StoreDiscoveryRun | null> {
      return latestRunId ? publicRun(runs.get(latestRunId) ?? null) : null;
    },
    async getStoreDiscoveryRun(runId: string): Promise<StoreDiscoveryRun | null> {
      return publicRun(runs.get(runId) ?? null);
    },
    async startItemDiscoveryRun(
      storeIdOrScope: number | ItemDiscoveryRunScope,
      websiteUrl = '',
      platform = '',
      storeName = ''
    ): Promise<StoreDiscoveryRun> {
      return startRun(
        'item_discovery',
        itemDiscoveryCommandArgs(storeIdOrScope, websiteUrl, platform, storeName),
        { waitForAcceptance: true }
      );
    },
    async startItemEmbeddingRun(refreshMode: 'full' | 'missing'): Promise<StoreDiscoveryRun> {
      return startRun('item_embeddings', ['item-embeddings', '--refresh-mode', refreshMode]);
    },
    async startItemUpdateRun(scope?: ItemUpdateRunScope): Promise<StoreDiscoveryRun> {
      return startRun('item_update', itemUpdateCommandArgs(scope));
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
      requestCancellation(
        run,
        new DiscoveryOperationError(
          'Discovery operations client shut down before item discovery was accepted',
          503
        )
      );
      await waitForRunToSettle(run, cancelEscalationMs + cancelForceFailMs + 2 * cleanupTimeoutMs + 100);
    }
  };

  function requestCancellation(run: ManagedRun, pendingAcceptanceError?: DiscoveryOperationError): void {
    if (run.hardStopStarted) return;
    if (run.status === 'running') {
      clearBrowserWatchdog(run);
      if (pendingAcceptanceError && run.acceptanceRequired && !run.accepted) {
        run.rejectAcceptance?.(pendingAcceptanceError);
      }
      run.status = 'cancelling';
      scheduleCancellationEscalation(run);
      try {
        run.processTree?.capture();
        run.child?.kill('SIGTERM');
      } catch (error) {
        run.terminalFailure = `Discovery cancellation failed: ${failureMessage(error)}`;
        void hardStop(run, run.terminalFailure, 'cancelled');
      }
    }
  }

  function scheduleCancellationEscalation(run: ManagedRun): void {
    clearCancellationTimers(run);
    run.cancelEscalationTimer = setTimeout(() => {
      run.cancelEscalationTimer = undefined;
      if (activeRunId !== run.id || run.status !== 'cancelling') {
        return;
      }
      if (run.child?.pid || run.lastBrowser) {
        void hardStop(run, run.terminalFailure ?? 'Discovery operation did not exit after cancellation', 'cancelled', true);
        return;
      }
      void run.processTree?.terminate().catch((error: unknown) => {
        run.terminalFailure = `Discovery process cleanup failed: ${failureMessage(error)}`;
      });
      run.cancelForceFailTimer = setTimeout(() => {
        run.cancelForceFailTimer = undefined;
        if (activeRunId === run.id && run.status === 'cancelling') {
          run.settleRun?.(
            'failed',
            null,
            run.terminalFailure ?? 'Discovery operation did not exit after cancellation'
          );
        }
      }, cancelForceFailMs);
      run.cancelForceFailTimer.unref?.();
    }, cancelEscalationMs);
    run.cancelEscalationTimer.unref?.();
  }

  async function hardStop(run: ManagedRun, error: string, reason?: DiscoveryBrowserFailure['reason'], forceFailed = false): Promise<void> {
    if (run.hardStopStarted || activeRunId !== run.id) return;
    run.hardStopStarted = true;
    clearBrowserWatchdog(run);
    clearCancellationTimers(run);
    const failures: string[] = [];
    try {
      await boundedCleanup(() => run.processTree?.terminate() ?? Promise.resolve(), cleanupTimeoutMs, 'Process tree termination');
    } catch (failure) { failures.push(`process cleanup failed: ${failureMessage(failure)}`); }
    if (reason && run.lastBrowser && persistBrowserFailure) {
      try {
        await boundedCleanup(() => persistBrowserFailure({
          ...run.lastBrowser!, timeoutSeconds: browserFetchTimeoutSeconds, reason, error
        }), cleanupTimeoutMs, 'Discovery terminal-state persistence');
      } catch (failure) { failures.push(`persistence failed: ${failureMessage(failure)}`); }
    }
    const finalError = [error, ...failures].join('; ');
    if (reason === 'timeout' || failures.length) console.error(`[item-discovery] ${finalError}`);
    const cancelled = reason === 'cancelled' && !forceFailed && !run.terminalFailure && !failures.length;
    run.settleRun?.(cancelled ? 'cancelled' : 'failed', null, cancelled ? null : finalError);
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
          run.settleRun?.(
            'failed',
            null,
            run.terminalFailure ?? 'Discovery operation did not exit during shutdown'
          );
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
  run.acceptanceRequired = undefined;
  run.accepted = undefined;
  run.child = undefined;
  run.completed_at = formatDate(completedAt);
  run.error = error;
  run.result = result;
  run.rejectAcceptance = undefined;
  run.resolveAcceptance = undefined;
  run.status = status;
  run.settleRun = undefined;
  run.terminalFailure = undefined;
}

function publicRun(run: ManagedRun): StoreDiscoveryRun;
function publicRun(run: ManagedRun | null): StoreDiscoveryRun | null;
function publicRun(run: ManagedRun | null): StoreDiscoveryRun | null {
  if (!run) {
    return null;
  }
  return { id: run.id, type: run.type, status: run.status, started_at: run.started_at,
    completed_at: run.completed_at, error: run.error, result: run.result };
}

function clearBrowserWatchdog(run: ManagedRun): void {
  if (run.browserWatchdogTimer) clearTimeout(run.browserWatchdogTimer);
  run.browserWatchdogTimer = undefined;
  run.watchedBrowser = undefined;
}

function parseBrowserEvent(event: Record<string, unknown>): BrowserFetch | null {
  if (typeof event.fetch_id !== 'string' || !event.fetch_id || event.fetch_id.length > 128
    || typeof event.run_id !== 'string' || !event.run_id || event.run_id.length > 128
    || typeof event.store_id !== 'number' || !Number.isSafeInteger(event.store_id) || event.store_id <= 0
    || typeof event.url !== 'string' || event.url.length > 2048
    || !['fetch', 'startup', 'cleanup'].includes(String(event.phase))) return null;
  try {
    const url = new URL(event.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  } catch { return null; }
  return { fetchId: event.fetch_id, runId: event.run_id, storeId: event.store_id, url: event.url, phase: String(event.phase) };
}

async function boundedCleanup(operation: () => Promise<void>, timeoutMs: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs); })
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
function failureMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function clearCancellationTimers(run: ManagedRun): void {
  if (run.exitDrainTimer) {
    clearTimeout(run.exitDrainTimer);
    run.exitDrainTimer = undefined;
  }
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

function itemDiscoveryCommandArgs(
  storeIdOrScope: number | ItemDiscoveryRunScope,
  websiteUrl: string,
  platform: string,
  storeName: string
): string[] {
  if (typeof storeIdOrScope !== 'number') {
    return scopedStoreCommandArgs('item-discovery-batch', storeIdOrScope);
  }
  const args = [
    'item-discovery',
    '--store-id',
    String(storeIdOrScope),
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
  return args;
}

function itemUpdateCommandArgs(scope?: ItemUpdateRunScope): string[] {
  return scopedStoreCommandArgs('item-update', scope);
}

function scopedStoreCommandArgs(command: string, scope?: ItemDiscoveryRunScope | ItemUpdateRunScope): string[] {
  const args = [command];
  if (scope && 'store_ids' in scope) {
    for (const storeId of scope.store_ids) {
      args.push('--store-id', String(storeId));
    }
  }
  return args;
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
      return (
        isNumber(result.item_candidates) &&
        (isNumber(result.store_id) || result.store_id === null) &&
        typeof result.website_url === 'string'
      );
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
  return operationExitError(stderr, stdout, code).message;
}

function operationExitError(
  stderr: string,
  stdout: string,
  code: number | null
): { code?: string; message: string } {
  for (const output of [stderr, stdout]) {
    const lines = output.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line || line.startsWith(OPERATION_EVENT_PREFIX)) {
        continue;
      }
      const structuredError = parseStructuredErrorLine(line);
      if (structuredError) {
        return structuredError;
      }
    }
  }

  const rawMessage = diagnosticOutput(stderr) || diagnosticOutput(stdout);
  return {
    message: rawMessage || `Discovery operation exited with code ${code ?? 'unknown'}`
  };
}

function parseStructuredErrorLine(line: string): { code?: string; message: string } | null {
  const embeddedErrorIndex = line.lastIndexOf('{"error"');
  const candidates = embeddedErrorIndex > 0 ? [line, line.slice(embeddedErrorIndex)] : [line];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        isRecord(parsed) &&
        isRecord(parsed.error) &&
        typeof parsed.error.message === 'string'
      ) {
        return {
          ...(typeof parsed.error.code === 'string' ? { code: parsed.error.code } : {}),
          message: parsed.error.message
        };
      }
    } catch {
      // Ordinary diagnostics are valid stderr and may directly precede the structured error.
    }
  }
  return null;
}

function diagnosticOutput(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(OPERATION_EVENT_PREFIX))
    .join('\n')
    .trim();
}

function formatDate(value: Date): string {
  return value.toISOString();
}
