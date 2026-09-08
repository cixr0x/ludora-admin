// Run after npm run build with a Linux Node runtime; uses only disposable local
// Python subprocesses, never a browser, service port, database or network.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createLocalDiscoveryOperationsClient } from '../dist/localDiscoveryOperationsClient.js';

const browserCode = `
import json, os, subprocess, sys, time
renderer = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(3600)'])
print(json.dumps({'browser': os.getpid(), 'browser_group': os.getpgrp(), 'renderer': renderer.pid}), flush=True)
time.sleep(3600)
`;
const rootCode = `
import json, os, subprocess, sys, time
browser = subprocess.Popen([sys.executable, '-c', ${JSON.stringify(browserCode)}], start_new_session=True, stdout=subprocess.PIPE, text=True)
tree = json.loads(browser.stdout.readline())
tree.update({'root': os.getpid(), 'root_group': os.getpgrp()})
print(json.dumps(tree), flush=True)
print('@@LUDORA_OPERATION_EVENT@@' + json.dumps({'event':'item_discovery.accepted'}), file=sys.stderr, flush=True)
print('@@LUDORA_OPERATION_EVENT@@' + json.dumps({'event':'item_discovery.browser.started', 'fetch_id':'smoke', 'run_id':'smoke:17', 'store_id':17, 'url':'https://example.test/game/', 'phase':'fetch'}), file=sys.stderr, flush=True)
time.sleep(3600)
`;

function alive(pid) {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z'; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, 'condition did not complete within five seconds');
    await delay(20);
  }
}

for (const action of ['timeout', 'cancel']) {
  test(`real Linux ${action} kills a detached browser session and preserves an unrelated process`, { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
    let tree;
    let root;
    const persisted = [];
    const unrelated = spawn('/usr/bin/python3', ['-c', 'import time; time.sleep(3600)']);
    const client = createLocalDiscoveryOperationsClient({
      browserFetchTimeoutSeconds: action === 'timeout' ? 0.25 : 120,
      cancelEscalationMs: 100, cancelForceFailMs: 100,
      envFile: '/unused.env', packageDir: '/tmp', pythonExecutable: '/usr/bin/python3',
      persistBrowserFailure: async (failure) => { persisted.push(failure); },
      spawnProcess: () => {
        root = spawn('/usr/bin/python3', ['-c', rootCode]);
        let output = '';
        root.stdout.on('data', (chunk) => {
          output += String(chunk);
          if (output.includes('\n')) tree = JSON.parse(output.trim());
        });
        return root;
      }
    });
    try {
      const run = await client.startItemDiscoveryRun({ all_stores: true });
      await until(() => !!tree);
      assert.notEqual(tree.browser_group, tree.root_group);
      if (action === 'cancel') await client.cancelStoreDiscoveryRun(run.id);
      await until(async () => ['failed', 'cancelled'].includes((await client.getStoreDiscoveryRun(run.id)).status));
      await until(() => [tree.root, tree.browser, tree.renderer].every((pid) => !alive(pid)));
      assert.ok(alive(unrelated.pid), 'unrelated process must survive');
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].runId, 'smoke:17');
      assert.equal(persisted[0].reason, action === 'timeout' ? 'timeout' : 'cancelled');
      console.log(JSON.stringify({ action, ...tree, descendants_dead: true, unrelated_alive: true }));
    } finally {
      // Only the exact disposable children created by this fixture are targeted.
      for (const pid of [root?.pid, tree?.browser, tree?.renderer, unrelated.pid]) {
        if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      }
      await client.shutdown();
    }
  });
}
