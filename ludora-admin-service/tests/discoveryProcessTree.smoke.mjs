// Actual Linux supervisor launch with only its operation_cli worker replaced by a fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLocalDiscoveryOperationsClient } from '../dist/localDiscoveryOperationsClient.js';

const browserCode = `
import json, os, subprocess, sys, time
renderer = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
print(json.dumps({'browser':os.getpid(),'browser_group':os.getpgrp(),'renderer':renderer.pid}), flush=True)
if sys.argv[1] == 'browser_parent_exit': sys.exit(0)
time.sleep(60)
`;
const driverCode = `
import subprocess, sys, time
browser = subprocess.Popen([sys.executable, '-c', ${JSON.stringify(browserCode)}, sys.argv[1]], start_new_session=True)
browser.wait()
time.sleep(60)
`;
const workerCode = `
import json, os, signal, subprocess, sys, time
from pathlib import Path
directory = Path(__file__).resolve().parents[2]
mode = sys.argv[sys.argv.index('--env-file') + 1]
def cancel(_signal, _frame):
    (directory / 'cancel-forwarded').write_text('yes')
    sys.exit(130)
signal.signal(signal.SIGTERM, cancel)
signal.signal(signal.SIGINT, cancel)
print('@@LUDORA_OPERATION_EVENT@@' + json.dumps({'event':'item_discovery.accepted'}), file=sys.stderr, flush=True)
print('@@LUDORA_OPERATION_EVENT@@' + json.dumps({'event':'item_discovery.browser.started','fetch_id':'smoke','run_id':'smoke:17','store_id':17,'url':'https://example.test/game/','phase':'startup'}), file=sys.stderr, flush=True)
# R1: lifecycle snapshot is taken BEFORE driver/browser creation.
time.sleep(0.15)
driver = subprocess.Popen([sys.executable, '-c', ${JSON.stringify(driverCode)}, mode], stdout=subprocess.PIPE, text=True)
tree = json.loads(driver.stdout.readline())
tree.update({'worker':os.getpid(),'supervisor':os.getppid(),'worker_group':os.getpgrp(),'driver':driver.pid})
(directory / 'tree.json').write_text(json.dumps(tree))
if mode == 'driver_exit_before_timeout':
    driver.kill()
    driver.wait()
elif mode == 'worker_exit_with_held_stderr': os._exit(7)
elif mode == 'success':
    assert sys.stdin.readline() == 'from-node\\n'
    print('@@LUDORA_OPERATION_EVENT@@' + json.dumps({'event':'item_discovery.browser.completed','fetch_id':'smoke','run_id':'smoke:17','store_id':17,'url':'https://example.test/game/','phase':'startup'}), file=sys.stderr, flush=True)
    print(json.dumps({'result':{'item_candidates':0,'store_id':None,'website_url':'','stores_scanned':1}}), flush=True)
    sys.exit(0)
time.sleep(60)
`;
function identity(pid) {
  try { const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return { state:fields[0], ppid:Number(fields[1]) }; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function alive(pid) { const row = pid && identity(pid); return !!row && row.state !== 'Z'; }
async function until(predicate) {
  const deadline = Date.now() + 7000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'condition did not complete within seven seconds'); await delay(10); }
}
for (const mode of ['driver_exit_before_timeout','worker_exit_with_held_stderr','browser_parent_exit','cancel','shutdown','success','unresponsive_supervisor']) {
  test(`Linux supervisor owns late descendants: ${mode}`, {skip:process.platform !== 'linux',timeout:12000}, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ludora-subreaper-smoke-'));
    const packageDir = join(directory, 'src', 'ludora');
    mkdirSync(packageDir, {recursive:true});
    writeFileSync(join(packageDir, '__init__.py'), '');
    writeFileSync(join(packageDir, 'operation_cli.py'), workerCode);
    copyFileSync(fileURLToPath(new URL('../../ludora-discovery/src/ludora/operation_supervisor.py', import.meta.url)), join(packageDir, 'operation_supervisor.py'));
    let tree, root, exitCode;
    const persisted = [];
    const unrelated = spawn('/usr/bin/python3', ['-c','import time; time.sleep(60)']);
    const client = createLocalDiscoveryOperationsClient({
      browserFetchTimeoutSeconds:['cancel','shutdown','success'].includes(mode) ? 120 : 0.6,
      cancelEscalationMs:100,cancelForceFailMs:100,envFile:mode,packageDir:directory,pythonExecutable:'/usr/bin/python3',
      persistBrowserFailure:async (failure) => { persisted.push(failure); },
      spawnProcess:(command,args,options) => {
        assert.equal(args[1], 'ludora.operation_supervisor');
        root = spawn(command,args,options);
        root.on('exit', (value) => { exitCode = value; });
        if (mode === 'success') root.stdin.end('from-node\n');
        return root;
      }
    });
    try {
      const run = await client.startItemDiscoveryRun({all_stores:true});
      await until(() => existsSync(join(directory, 'tree.json')));
      tree = JSON.parse(readFileSync(join(directory, 'tree.json'), 'utf8'));
      assert.equal(tree.supervisor, root.pid);
      assert.notEqual(tree.browser_group, tree.worker_group);
      if (mode === 'unresponsive_supervisor') process.kill(root.pid, 'SIGSTOP');
      if (mode === 'driver_exit_before_timeout') await until(() => identity(tree.browser)?.ppid === root.pid);
      else if (mode === 'browser_parent_exit') await until(() => identity(tree.renderer)?.ppid === root.pid);
      else if (mode === 'cancel') await client.cancelStoreDiscoveryRun(run.id);
      else if (mode === 'shutdown') await client.shutdown();
      await until(async () => ['failed','cancelled','completed'].includes((await client.getStoreDiscoveryRun(run.id)).status));
      const result = await client.getStoreDiscoveryRun(run.id);
      // Require reaped/absent descendants, not merely stopped or zombie state.
      await until(() => [root.pid,tree.worker,tree.driver,tree.browser,tree.renderer].every((pid) => mode === 'unresponsive_supervisor' ? !alive(pid) : !identity(pid)));
      assert.ok(alive(unrelated.pid), 'unrelated process must survive');
      if (mode === 'success') {
        assert.equal(result.status, 'completed'); assert.equal(exitCode, 0); assert.equal(result.result.stores_scanned, 1);
      } else if (mode === 'worker_exit_with_held_stderr') {
        assert.equal(result.status, 'failed'); assert.equal(exitCode, 7);
      } else {
        assert.equal(persisted.length, 1); assert.equal(persisted[0].runId, 'smoke:17');
        const cancelled = ['cancel','shutdown'].includes(mode);
        assert.equal(persisted[0].reason, cancelled ? 'cancelled' : 'timeout');
        if (cancelled) assert.ok(existsSync(join(directory, 'cancel-forwarded')));
      }
      console.log(JSON.stringify({mode,...tree,descendants_dead:true,descendants_reaped:mode !== 'unresponsive_supervisor',unrelated_alive:true,status:result.status,exitCode}));
    } finally {
      for (const pid of [root?.pid,tree?.worker,tree?.driver,tree?.browser,tree?.renderer,unrelated.pid]) if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      await client.shutdown();
      rmSync(directory, {recursive:true,force:true});
    }
  });
}
