import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { DiscoveryOperationError } from './discoveryOperations.js';
import { createLocalDiscoveryOperationsClient, type SpawnDiscoveryProcess } from './localDiscoveryOperationsClient.js';

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killedWith: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal;
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
}

function createClient() {
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
    spawnProcess
  });
  return { client, spawned };
}

describe('local discovery operations client', () => {
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
    expect(failed?.error).toBe('Missing database URL');
  });

  it('returns 404-style error when cancelling an unknown run', async () => {
    const { client } = createClient();

    await expect(client.cancelStoreDiscoveryRun('missing')).rejects.toBeInstanceOf(DiscoveryOperationError);
    await expect(client.cancelStoreDiscoveryRun('missing')).rejects.toMatchObject({
      message: 'Run not found',
      status: 404
    });
  });
});
