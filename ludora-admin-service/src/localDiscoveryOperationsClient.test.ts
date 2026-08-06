import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiscoveryOperationError } from './discoveryOperations.js';
import { createLocalDiscoveryOperationsClient, type SpawnDiscoveryProcess } from './localDiscoveryOperationsClient.js';

const ITEM_DISCOVERY_ACCEPTANCE_FRAME =
  '@@LUDORA_OPERATION_EVENT@@{"event":"item_discovery.accepted"}\n';

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killedWith: NodeJS.Signals | undefined;
  killSignals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal;
    if (signal) {
      this.killSignals.push(signal);
    }
    return true;
  }

  succeed(payload: unknown): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
    this.emit('close', 0, null);
  }

  fail(message: string): void {
    this.stderr.emit('data', Buffer.from(JSON.stringify({ error: { message } })));
    this.emit('close', 1, null);
  }

  failToSpawn(error: Error): void {
    this.emit('error', error);
  }

  acceptItemDiscovery(...chunks: string[]): void {
    for (const chunk of chunks.length > 0 ? chunks : [ITEM_DISCOVERY_ACCEPTANCE_FRAME]) {
      this.stderr.emit('data', Buffer.from(chunk));
    }
  }

  succeedWithRawStdout(stdout: string): void {
    this.stdout.emit('data', Buffer.from(stdout));
    this.emit('close', 0, null);
  }

  exitWithSignal(signal: NodeJS.Signals): void {
    this.emit('close', null, signal);
  }
}

function createClient(overrides: Partial<Parameters<typeof createLocalDiscoveryOperationsClient>[0]> = {}) {
  const spawned: Array<{ command: string; args: string[]; child: FakeChildProcess; options: unknown }> = [];
  const spawnProcess: SpawnDiscoveryProcess = (command, args, options) => {
    const child = new FakeChildProcess();
    spawned.push({ command, args, child, options });
    return child as never;
  };
  const client = createLocalDiscoveryOperationsClient({
    envFile: 'C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/.env',
    now: () => new Date('2026-06-29T20:00:00.000Z'),
    packageDir: 'C:/PROJECTS/ludora/ludora-admin/ludora-discovery',
    pythonExecutable: 'python',
    spawnProcess,
    ...overrides
  });
  return { client, spawned };
}

describe('local discovery operations client', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts store discovery by spawning the colocated Python operation CLI', async () => {
    const { client, spawned } = createClient();

    const run = await client.startStoreDiscoveryRun();

    expect(run.status).toBe('running');
    expect(run.type).toBe('store_discovery');
    expect(spawned[0].command).toBe('python');
    expect(spawned[0].args).toContain('-m');
    expect(spawned[0].args).toContain('ludora.operation_cli');
    expect(spawned[0].args).toContain('store-discovery');
    expect(spawned[0].args).toContain('--env-file');
    expect(spawned[0].options).toMatchObject({
      cwd: 'C:/PROJECTS/ludora/ludora-admin/ludora-discovery',
      env: expect.objectContaining({
        PYTHONPATH: 'C:\\PROJECTS\\ludora\\ludora-admin\\ludora-discovery\\src'
      })
    });
  });

  it('passes the internal API token to the spawned discovery process', async () => {
    const { client, spawned } = createClient({ internalApiToken: 'internal-test-token' });

    await client.startStoreDiscoveryRun();

    expect(spawned[0].options).toMatchObject({
      env: expect.objectContaining({
        LUDORA_INTERNAL_API_TOKEN: 'internal-test-token'
      })
    });
  });

  it('marks a completed run with parsed Python result', async () => {
    const { client, spawned } = createClient();
    const run = await client.startStoreDiscoveryRun();

    spawned[0].child.succeed({
      result: {
        accepted_stores: 2,
        candidate_domains: 4,
        searched_queries: 3
      }
    });

    const completed = await client.getStoreDiscoveryRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.completed_at).toBe('2026-06-29T20:00:00.000Z');
    expect(completed?.result).toEqual({
      accepted_stores: 2,
      candidate_domains: 4,
      searched_queries: 3
    });
  });

  it('rejects a second active operation with HTTP 409 semantics', async () => {
    const { client } = createClient();
    await client.startStoreDiscoveryRun();

    await expect(client.startItemUpdateRun()).rejects.toMatchObject({
      message: 'Discovery operation is already running',
      status: 409
    });
  });

  it('starts item discovery with the store URL, platform, and store name', async () => {
    const { client, spawned } = createClient();

    const started = client.startItemDiscoveryRun(12, 'https://example.mx/', 'amazon_brand', 'Hasbro Gaming');
    spawned[0].child.acceptItemDiscovery();
    const run = await started;

    expect(run.status).toBe('running');
    expect(run.type).toBe('item_discovery');
    expect(spawned[0].args).toEqual([
      '-m',
      'ludora.operation_cli',
      '--env-file',
      'C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/.env',
      'item-discovery',
      '--store-id',
      '12',
      '--website-url',
      'https://example.mx/',
      '--store-name',
      'Hasbro Gaming',
      '--platform',
      'amazon_brand'
    ]);
  });

  it('starts item discovery by spawning the CLI with selected store ids', async () => {
    const { client, spawned } = createClient();

    const started = client.startItemDiscoveryRun({ store_ids: [12, 34] });
    spawned[0].child.acceptItemDiscovery();
    const run = await started;

    expect(run.status).toBe('running');
    expect(run.type).toBe('item_discovery');
    expect(spawned[0].args).toEqual([
      '-m',
      'ludora.operation_cli',
      '--env-file',
      'C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/.env',
      'item-discovery-batch',
      '--store-id',
      '12',
      '--store-id',
      '34'
    ]);
  });

  it('starts item discovery for all stores without CLI store ids', async () => {
    const { client, spawned } = createClient();

    const started = client.startItemDiscoveryRun({ all_stores: true });
    spawned[0].child.acceptItemDiscovery();
    const run = await started;

    expect(run.status).toBe('running');
    expect(run.type).toBe('item_discovery');
    expect(spawned[0].args).toEqual([
      '-m',
      'ludora.operation_cli',
      '--env-file',
      'C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/.env',
      'item-discovery-batch'
    ]);
  });

  it('waits for a complete framed item-discovery acceptance across diagnostic stderr chunks', async () => {
    const { client, spawned } = createClient();
    let startSettled = false;

    const started = client.startItemDiscoveryRun({ all_stores: true }).finally(() => {
      startSettled = true;
    });
    await flushPromises();
    expect(startSettled).toBe(false);

    spawned[0].child.acceptItemDiscovery(
      'ordinary diagnostic output\n@@LUDORA_OPER',
      'ATION_EVENT@@{"event":"item_discovery.',
      'accepted"}',
      '\n'
    );
    const run = await started;
    expect(run).toMatchObject({ status: 'running', type: 'item_discovery' });

    spawned[0].child.succeed({
      result: {
        item_candidates: 4,
        store_id: null,
        stores_scanned: 2,
        website_url: ''
      }
    });

    expect(await client.getStoreDiscoveryRun(run.id)).toMatchObject({
      result: {
        item_candidates: 4,
        store_id: null,
        stores_scanned: 2,
        website_url: ''
      },
      status: 'completed'
    });
    expectChildListenersRemoved(spawned[0].child);
  });

  it('rejects an item-discovery coordinator conflict before launch acceptance with HTTP 409 semantics', async () => {
    const { client, spawned } = createClient();
    const started = client.startItemDiscoveryRun({ all_stores: true });

    spawned[0].child.stderr.emit('data', Buffer.from('checking coordinator without newline: '));
    spawned[0].child.stderr.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          error: {
            code: 'OPERATION_ALREADY_RUNNING',
            message: 'Item discovery is already running'
          }
        })
      )
    );
    spawned[0].child.emit('close', 1, null);

    await expect(started).rejects.toMatchObject({
      message: 'Item discovery is already running',
      status: 409
    });
    expect(await client.getLatestStoreDiscoveryRun()).toMatchObject({
      error: 'Item discovery is already running',
      status: 'failed'
    });
    expectChildListenersRemoved(spawned[0].child);
    await expect(client.startStoreDiscoveryRun()).resolves.toMatchObject({ status: 'running' });
  });

  it('rejects an item-discovery spawn error before acceptance and releases the active slot', async () => {
    const { client, spawned } = createClient();
    const started = client.startItemDiscoveryRun({ all_stores: true });

    spawned[0].child.failToSpawn(new Error('spawn ENOENT'));

    await expect(started).rejects.toThrow('spawn ENOENT');
    expect(await client.getLatestStoreDiscoveryRun()).toMatchObject({ error: 'spawn ENOENT', status: 'failed' });
    expectChildListenersRemoved(spawned[0].child);
    await expect(client.startStoreDiscoveryRun()).resolves.toMatchObject({ status: 'running' });
  });

  it('rejects an item-discovery child that exits successfully before acceptance', async () => {
    const { client, spawned } = createClient();
    const started = client.startItemDiscoveryRun(12, 'https://example.mx/');

    spawned[0].child.succeed({
      result: {
        item_candidates: 4,
        store_id: 12,
        website_url: 'https://example.mx/'
      }
    });

    await expect(started).rejects.toThrow('Item discovery operation exited before acceptance');
    expect(await client.getLatestStoreDiscoveryRun()).toMatchObject({
      error: 'Item discovery operation exited before acceptance',
      status: 'failed'
    });
    expectChildListenersRemoved(spawned[0].child);
  });

  it('rejects malformed item-discovery acceptance and terminates the untrusted child', async () => {
    const { client, spawned } = createClient();
    const started = client.startItemDiscoveryRun({ all_stores: true });

    spawned[0].child.stderr.emit('data', Buffer.from('@@LUDORA_OPERATION_EVENT@@not-json\n'));

    await expect(started).rejects.toThrow('Malformed item discovery acceptance event');
    expect(spawned[0].child.killSignals).toEqual(['SIGTERM']);
    spawned[0].child.emit('close', null, 'SIGTERM');
    expect(await client.getLatestStoreDiscoveryRun()).toMatchObject({
      error: 'Malformed item discovery acceptance event',
      status: 'failed'
    });
    expectChildListenersRemoved(spawned[0].child);
    await expect(client.startStoreDiscoveryRun()).resolves.toMatchObject({ status: 'running' });
  });

  it('rejects pending item-discovery acceptance when shutdown cancels the child', async () => {
    const { client, spawned } = createClient();
    const started = client.startItemDiscoveryRun({ all_stores: true });

    const shutdown = client.shutdown();
    expect(spawned[0].child.killSignals).toEqual(['SIGTERM']);
    spawned[0].child.emit('close', null, 'SIGTERM');

    await expect(started).rejects.toMatchObject({ status: 503 });
    await shutdown;
    expect(await client.getLatestStoreDiscoveryRun()).toMatchObject({ status: 'cancelled' });
    expectChildListenersRemoved(spawned[0].child);
  });

  it('rejects pending item-discovery acceptance as soon as explicit cancellation begins', async () => {
    const { client, spawned } = createClient();
    let startError: unknown;
    const started = client.startItemDiscoveryRun({ all_stores: true });
    void started.catch((error: unknown) => {
      startError = error;
    });
    const pendingRun = await client.getLatestStoreDiscoveryRun();

    const cancelling = await client.cancelStoreDiscoveryRun(pendingRun!.id);
    await flushPromises();

    expect(cancelling.status).toBe('cancelling');
    expect(startError).toMatchObject({ status: 409 });
    spawned[0].child.emit('close', null, 'SIGTERM');
    await expect(started).rejects.toMatchObject({ status: 409 });
    expect(await client.getLatestStoreDiscoveryRun()).toMatchObject({ status: 'cancelled' });
    expectChildListenersRemoved(spawned[0].child);
  });

  it('cancels the active child process and marks the run cancelled', async () => {
    const { client, spawned } = createClient();
    const run = await client.startStoreDiscoveryRun();

    const cancelling = await client.cancelStoreDiscoveryRun(run.id);

    expect(cancelling.status).toBe('cancelling');
    expect(spawned[0].child.killedWith).toBe('SIGTERM');
    spawned[0].child.emit('close', null, 'SIGTERM');
    expect((await client.getLatestStoreDiscoveryRun())?.status).toBe('cancelled');
  });

  it('marks a failed run with Python stderr JSON message', async () => {
    const { client, spawned } = createClient();
    const run = await client.startItemUpdateRun();

    spawned[0].child.fail('Missing database URL');

    const failed = await client.getStoreDiscoveryRun(run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.completed_at).toBe('2026-06-29T20:00:00.000Z');
    expect(failed?.error).toBe('Missing database URL');
  });

  it('starts item update by spawning the CLI with selected store ids', async () => {
    const { client, spawned } = createClient();

    const run = await client.startItemUpdateRun({ store_ids: [12, 34] });

    expect(run.status).toBe('running');
    expect(run.type).toBe('item_update');
    expect(spawned[0].args).toEqual([
      '-m',
      'ludora.operation_cli',
      '--env-file',
      'C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/.env',
      'item-update',
      '--store-id',
      '12',
      '--store-id',
      '34'
    ]);
  });

  it('starts item update for all stores without CLI store ids', async () => {
    const { client, spawned } = createClient();

    const run = await client.startItemUpdateRun({ all_stores: true });

    expect(run.status).toBe('running');
    expect(run.type).toBe('item_update');
    expect(spawned[0].args).toEqual([
      '-m',
      'ludora.operation_cli',
      '--env-file',
      'C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/.env',
      'item-update'
    ]);
  });

  it('marks the run failed when the child process emits an error', async () => {
    const { client, spawned } = createClient();
    const run = await client.startItemUpdateRun();

    expect(() => spawned[0].child.failToSpawn(new Error('spawn ENOENT'))).not.toThrow();

    const failed = await client.getStoreDiscoveryRun(run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.completed_at).toBe('2026-06-29T20:00:00.000Z');
    expect(failed?.error).toBe('spawn ENOENT');

    await expect(client.startStoreDiscoveryRun()).resolves.toMatchObject({
      status: 'running',
      type: 'store_discovery'
    });
  });

  it('marks the run failed when successful stdout is not valid JSON', async () => {
    const { client, spawned } = createClient();
    const run = await client.startStoreDiscoveryRun();

    expect(() => spawned[0].child.succeedWithRawStdout('not json')).not.toThrow();

    const failed = await client.getStoreDiscoveryRun(run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.completed_at).toBe('2026-06-29T20:00:00.000Z');
    expect(failed?.error).toContain('Failed to parse discovery operation result');
    expect(failed?.result).toBeNull();

    await expect(client.startItemUpdateRun()).resolves.toMatchObject({
      status: 'running',
      type: 'item_update'
    });
  });

  it('marks the run failed when successful stdout does not include a valid non-null result', async () => {
    for (const payload of [{}, { ok: true }, { result: null }]) {
      const { client, spawned } = createClient();
      const run = await client.startStoreDiscoveryRun();

      expect(() => spawned[0].child.succeedWithRawStdout(JSON.stringify(payload))).not.toThrow();

      const failed = await client.getStoreDiscoveryRun(run.id);
      expect(failed?.status).toBe('failed');
      expect(failed?.completed_at).toBe('2026-06-29T20:00:00.000Z');
      expect(failed?.error).toBe('Malformed discovery operation result: expected non-null result property');
      expect(failed?.result).toBeNull();

      await expect(client.startItemUpdateRun()).resolves.toMatchObject({
        status: 'running',
        type: 'item_update'
      });
    }
  });

  it('marks store discovery failed when successful stdout has a malformed result shape', async () => {
    const { client, spawned } = createClient();
    const run = await client.startStoreDiscoveryRun();

    expect(() => spawned[0].child.succeed({ result: { candidate_domains: 4, searched_queries: 3 } })).not.toThrow();

    const failed = await client.getStoreDiscoveryRun(run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.completed_at).toBe('2026-06-29T20:00:00.000Z');
    expect(failed?.error).toBe('Malformed discovery operation result for store_discovery');
    expect(failed?.result).toBeNull();

    await expect(client.startItemUpdateRun()).resolves.toMatchObject({
      status: 'running',
      type: 'item_update'
    });
  });

  it('marks item embeddings failed when successful stdout has an invalid refresh mode', async () => {
    const { client, spawned } = createClient();
    const run = await client.startItemEmbeddingRun('missing');

    expect(() =>
      spawned[0].child.succeed({
        result: {
          embedded_items: 2,
          model: 'text-embedding-3-small',
          refresh_mode: 'partial',
          selected_items: 3
        }
      })
    ).not.toThrow();

    const failed = await client.getStoreDiscoveryRun(run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.completed_at).toBe('2026-06-29T20:00:00.000Z');
    expect(failed?.error).toBe('Malformed discovery operation result for item_embeddings');
    expect(failed?.result).toBeNull();

    await expect(client.startStoreDiscoveryRun()).resolves.toMatchObject({
      status: 'running',
      type: 'store_discovery'
    });
  });

  it('marks an unrequested signal exit as failed and clears the active run', async () => {
    const { client, spawned } = createClient();
    const run = await client.startStoreDiscoveryRun();

    spawned[0].child.exitWithSignal('SIGTERM');

    const failed = await client.getStoreDiscoveryRun(run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.completed_at).toBe('2026-06-29T20:00:00.000Z');
    expect(failed?.error).toBe('Discovery operation exited with signal SIGTERM');
    expect(failed?.result).toBeNull();

    await expect(client.startItemUpdateRun()).resolves.toMatchObject({
      status: 'running',
      type: 'item_update'
    });
  });

  it('returns 404-style error when cancelling an unknown run', async () => {
    const { client } = createClient();

    await expect(client.cancelStoreDiscoveryRun('missing')).rejects.toBeInstanceOf(DiscoveryOperationError);
    await expect(client.cancelStoreDiscoveryRun('missing')).rejects.toMatchObject({
      message: 'Run not found',
      status: 404
    });
  });

  it('escalates cancellation and frees the active slot when the child never closes', async () => {
    vi.useFakeTimers();
    const { client, spawned } = createClient({
      cancelEscalationMs: 100,
      cancelForceFailMs: 50
    });
    const run = await client.startStoreDiscoveryRun();

    await client.cancelStoreDiscoveryRun(run.id);
    expect(spawned[0].child.killSignals).toEqual(['SIGTERM']);

    await vi.advanceTimersByTimeAsync(100);
    expect(spawned[0].child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);

    await vi.advanceTimersByTimeAsync(50);
    const failed = await client.getStoreDiscoveryRun(run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('Discovery operation did not exit after cancellation');

    await expect(client.startItemUpdateRun()).resolves.toMatchObject({
      status: 'running',
      type: 'item_update'
    });
  });

  it('does not restart the escalation deadline when cancelling an already cancelling run', async () => {
    vi.useFakeTimers();
    const { client, spawned } = createClient({
      cancelEscalationMs: 100,
      cancelForceFailMs: 50
    });
    const run = await client.startStoreDiscoveryRun();

    await client.cancelStoreDiscoveryRun(run.id);
    await vi.advanceTimersByTimeAsync(90);
    await client.cancelStoreDiscoveryRun(run.id);

    await vi.advanceTimersByTimeAsync(10);
    expect(spawned[0].child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('shutdown requests cancellation and waits for the active run to close', async () => {
    const { client, spawned } = createClient();
    const run = await client.startStoreDiscoveryRun();

    const shutdown = client.shutdown();
    expect(spawned[0].child.killSignals).toEqual(['SIGTERM']);

    spawned[0].child.emit('close', null, 'SIGTERM');
    await shutdown;

    expect((await client.getStoreDiscoveryRun(run.id))?.status).toBe('cancelled');
  });

  it('rejects new operations after shutdown has started', async () => {
    const { client, spawned } = createClient();
    const run = await client.startStoreDiscoveryRun();

    const shutdown = client.shutdown();
    spawned[0].child.emit('close', null, 'SIGTERM');
    await shutdown;

    await expect(client.startItemUpdateRun()).rejects.toMatchObject({
      message: 'Discovery operations client is shutting down',
      status: 503
    });
    expect(await client.getStoreDiscoveryRun(run.id)).toMatchObject({
      status: 'cancelled'
    });
    expect(spawned).toHaveLength(1);
  });
});

function expectChildListenersRemoved(child: FakeChildProcess): void {
  expect(child.listenerCount('close')).toBe(0);
  expect(child.listenerCount('error')).toBe(0);
  expect(child.stdout.listenerCount('data')).toBe(0);
  expect(child.stderr.listenerCount('data')).toBe(0);
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
