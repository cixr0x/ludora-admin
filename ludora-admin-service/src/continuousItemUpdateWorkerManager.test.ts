import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
  createContinuousItemUpdateWorkerManager,
  type SpawnContinuousItemUpdateWorker
} from './continuousItemUpdateWorkerManager.js';

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killSignals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    if (signal) {
      this.killSignals.push(signal);
      if (signal === 'SIGTERM') {
        queueMicrotask(() => this.emit('close', 0, signal));
      }
    }
    return true;
  }
}

describe('continuous item update worker manager', () => {
  it('starts the persistent Python worker with cadence, lease, and internal auth configuration', async () => {
    const spawned: Array<{ command: string; args: string[]; options: unknown; child: FakeChildProcess }> = [];
    const spawnProcess: SpawnContinuousItemUpdateWorker = (command, args, options) => {
      const child = new FakeChildProcess();
      spawned.push({ command, args, options, child });
      return child as never;
    };
    const manager = createContinuousItemUpdateWorkerManager({
      adminApiUrl: 'http://127.0.0.1:4001',
      envFile: 'C:/PROJECTS/ludora/ludora-admin/ludora-discovery/.env',
      internalApiToken: 'internal-token',
      leaseSeconds: 300,
      packageDir: 'C:/PROJECTS/ludora/ludora-admin/ludora-discovery',
      pollSeconds: 5,
      pythonExecutable: 'python',
      spawnProcess
    });

    manager.start();

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      args: [
        '-m',
        'ludora.continuous_update_worker',
        '--env-file',
        'C:/PROJECTS/ludora/ludora-admin/ludora-discovery/.env',
        '--poll-seconds',
        '5',
        '--lease-seconds',
        '300'
      ],
      command: 'python',
      options: {
        cwd: 'C:/PROJECTS/ludora/ludora-admin/ludora-discovery',
        env: expect.objectContaining({
          LUDORA_ADMIN_API_URL: 'http://127.0.0.1:4001',
          LUDORA_INTERNAL_API_TOKEN: 'internal-token',
          PYTHONPATH: 'C:\\PROJECTS\\ludora\\ludora-admin\\ludora-discovery\\src'
        })
      }
    });

    await manager.shutdown();
    expect(spawned[0].child.killSignals).toEqual(['SIGTERM']);
  });
});
