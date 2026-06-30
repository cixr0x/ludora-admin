# Admin Discovery Sibling Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the existing Python `ludora-discovery` package into `ludora-admin` as a sibling of `ludora-admin-service` and `ludora-admin-ui`, then make admin-service run discovery operations locally instead of requiring a separately started discovery HTTP service.

**Architecture:** Keep discovery as Python and keep its package layout intact under `ludora-admin/ludora-discovery`. Add a small Python operation CLI that runs one operation synchronously and prints JSON. Admin-service owns in-memory operation run state, starts the colocated Python package as a child process, and keeps the existing admin UI/API contract unchanged.

**Tech Stack:** Python 3.10+ `unittest`, Node.js TypeScript, Express, Vitest, `child_process.spawn`, existing Postgres/OpenAI/Playwright dependencies.

---

## File Structure

- `C:/PROJECTS/ludora/ludora-admin/ludora-discovery/`: moved Python package. Keep `pyproject.toml`, `src/ludora`, `tests`, `scripts`, and README together.
- `C:/PROJECTS/ludora/ludora-admin/ludora-discovery/src/ludora/operation_cli.py`: new synchronous command entry point for admin-service child processes.
- `C:/PROJECTS/ludora/ludora-admin/ludora-discovery/tests/test_operation_cli.py`: unit tests for CLI argument routing and JSON output.
- `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/discoveryOperations.ts`: shared operation types and error class.
- `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/discoveryOperationsClient.ts`: existing HTTP implementation, kept only as an optional fallback.
- `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/localDiscoveryOperationsClient.ts`: new local child-process implementation.
- `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/config.ts`: local discovery runner config.
- `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/server.ts`: choose the local runner by default.
- `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/routes/operations.ts`: import shared operation type, route behavior stays unchanged.
- `C:/PROJECTS/ludora/ludora-admin/README.md`: document one-service startup.
- `C:/PROJECTS/ludora/ludora-admin/AGENTS.md`: update fixed local startup instructions.
- `C:/PROJECTS/ludora/AGENTS.md`: update workspace-level fixed local startup instructions.

Do not copy or move `C:/PROJECTS/ludora/ludora-discovery/.git` into `ludora-admin`. The moved package should be normal tracked files inside the admin repo, not a nested Git repository.

---

### Task 1: Move Discovery Package Into Admin

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-discovery/**`
- Do not create: `C:/PROJECTS/ludora/ludora-admin/ludora-discovery/.git`

- [ ] **Step 1: Record both repo states before moving files**

Run:

```powershell
git -C C:\PROJECTS\ludora\ludora-admin status --short
git -C C:\PROJECTS\ludora\ludora-discovery status --short
```

Expected: output may show existing admin and discovery changes. Do not discard them. If discovery has uncommitted work, include those working-tree files in the copy.

- [ ] **Step 2: Copy discovery into admin without nested Git metadata**

Run:

```powershell
robocopy C:\PROJECTS\ludora\ludora-discovery C:\PROJECTS\ludora\ludora-admin\ludora-discovery /E /XD .git __pycache__ .pytest_cache .mypy_cache .ruff_cache .venv venv output data /XF *.pyc
if ($LASTEXITCODE -le 7) { $global:LASTEXITCODE = 0 }
```

Expected: files exist under `C:\PROJECTS\ludora\ludora-admin\ludora-discovery`, and there is no `C:\PROJECTS\ludora\ludora-admin\ludora-discovery\.git`.

- [ ] **Step 3: Verify the moved package imports from its new location**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-discovery
$env:PYTHONPATH='src'
@'
from ludora.operations import StoreDiscoveryRunManager
print(StoreDiscoveryRunManager.__name__)
'@ | python -
```

Expected: prints `StoreDiscoveryRunManager`.

- [ ] **Step 4: Commit the source move in admin**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin
git add ludora-discovery
git status --short
git commit -m "chore: move discovery package into admin"
```

Expected: commit succeeds and contains the copied discovery package, excluding nested Git metadata and generated caches.

---

### Task 2: Add A Synchronous Discovery Operation CLI

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-discovery/src/ludora/operation_cli.py`
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-discovery/tests/test_operation_cli.py`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-discovery/pyproject.toml`

- [ ] **Step 1: Write failing CLI tests**

Create `tests/test_operation_cli.py`:

```python
import json
import unittest
from io import StringIO
from unittest.mock import patch

from ludora.operations import (
    ItemDiscoveryRunResult,
    ItemEmbeddingRunResult,
    ItemUpdateRunResult,
    StoreDiscoveryRunResult,
)
from ludora.operation_cli import main


class OperationCliTests(unittest.TestCase):
    def test_runs_store_discovery_and_prints_result_json(self):
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "ludora.operation_cli.run_store_discovery",
            return_value=StoreDiscoveryRunResult(searched_queries=3, candidate_domains=4, accepted_stores=2),
        ) as runner:
            exit_code = main(["--env-file", "admin.env", "store-discovery"])

        self.assertEqual(exit_code, 0)
        runner.assert_called_once()
        self.assertEqual(runner.call_args.kwargs["env_file"], "admin.env")
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["result"]["accepted_stores"], 2)

    def test_runs_item_discovery_with_store_id_and_website_url(self):
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "ludora.operation_cli.run_item_discovery",
            return_value=ItemDiscoveryRunResult(store_id=12, website_url="https://store.test", item_candidates=5),
        ) as runner:
            exit_code = main(
                [
                    "--env-file",
                    "admin.env",
                    "item-discovery",
                    "--store-id",
                    "12",
                    "--website-url",
                    "https://store.test",
                ]
            )

        self.assertEqual(exit_code, 0)
        runner.assert_called_once()
        self.assertEqual(runner.call_args.kwargs["store_id"], 12)
        self.assertEqual(runner.call_args.kwargs["website_url"], "https://store.test")
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["result"]["item_candidates"], 5)

    def test_runs_item_update(self):
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "ludora.operation_cli.run_item_update",
            return_value=ItemUpdateRunResult(updated_items=7),
        ):
            exit_code = main(["item-update"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(stdout.getvalue())["result"]["updated_items"], 7)

    def test_runs_item_embeddings_with_refresh_mode(self):
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "ludora.operation_cli.run_item_embeddings",
            return_value=ItemEmbeddingRunResult(
                refresh_mode="full",
                selected_items=10,
                embedded_items=9,
                model="text-embedding-3-small",
            ),
        ) as runner:
            exit_code = main(["item-embeddings", "--refresh-mode", "full"])

        self.assertEqual(exit_code, 0)
        runner.assert_called_once()
        self.assertEqual(runner.call_args.kwargs["refresh_mode"], "full")
        self.assertEqual(json.loads(stdout.getvalue())["result"]["embedded_items"], 9)

    def test_runtime_error_prints_json_error_to_stderr(self):
        stderr = StringIO()
        with patch("sys.stderr", stderr), patch(
            "ludora.operation_cli.run_store_discovery",
            side_effect=RuntimeError("Missing Brave API key"),
        ):
            exit_code = main(["store-discovery"])

        self.assertEqual(exit_code, 1)
        self.assertEqual(json.loads(stderr.getvalue())["error"]["message"], "Missing Brave API key")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests and verify they fail because the module is missing**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-discovery
$env:PYTHONPATH='src'
python -m unittest tests.test_operation_cli -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'ludora.operation_cli'`.

- [ ] **Step 3: Implement the CLI**

Create `src/ludora/operation_cli.py`:

```python
from __future__ import annotations

import argparse
import json
import signal
import sys

from ludora.cancellation import CancellationToken, OperationCancelled
from ludora.operations import (
    EmbeddingRefreshMode,
    run_item_discovery,
    run_item_embeddings,
    run_item_update,
    run_store_discovery,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one Ludora discovery operation and print JSON.")
    parser.add_argument("--env-file", default=".env", help="Path to the .env file used by the operation.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("store-discovery")

    item_discovery = subparsers.add_parser("item-discovery")
    item_discovery.add_argument("--store-id", type=int, required=True)
    item_discovery.add_argument("--website-url", required=True)

    subparsers.add_parser("item-update")

    item_embeddings = subparsers.add_parser("item-embeddings")
    item_embeddings.add_argument("--refresh-mode", choices=["missing", "full"], default="missing")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cancellation_token = CancellationToken()
    _install_signal_handlers(cancellation_token)

    try:
        result = _run_command(args, cancellation_token)
    except OperationCancelled:
        print(json.dumps({"cancelled": True}), file=sys.stderr)
        return 130
    except Exception as exc:
        print(json.dumps({"error": {"message": str(exc)}}), file=sys.stderr)
        return 1

    print(json.dumps({"result": result.to_dict()}))
    return 0


def _run_command(args: argparse.Namespace, cancellation_token: CancellationToken):
    if args.command == "store-discovery":
        return run_store_discovery(env_file=args.env_file, cancellation_token=cancellation_token)
    if args.command == "item-discovery":
        return run_item_discovery(
            store_id=args.store_id,
            website_url=args.website_url,
            env_file=args.env_file,
            cancellation_token=cancellation_token,
        )
    if args.command == "item-update":
        return run_item_update(env_file=args.env_file, cancellation_token=cancellation_token)
    if args.command == "item-embeddings":
        return run_item_embeddings(
            refresh_mode=args.refresh_mode,
            env_file=args.env_file,
            cancellation_token=cancellation_token,
        )
    raise RuntimeError(f"Unknown operation command: {args.command}")


def _install_signal_handlers(cancellation_token: CancellationToken) -> None:
    def request_cancel(_signum: int, _frame: object) -> None:
        cancellation_token.cancel()

    signal.signal(signal.SIGINT, request_cancel)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, request_cancel)


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Register the command in `pyproject.toml`**

Add this entry under `[project.scripts]`:

```toml
ludora-operation = "ludora.operation_cli:main"
```

- [ ] **Step 5: Run focused CLI tests**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-discovery
$env:PYTHONPATH='src'
python -m unittest tests.test_operation_cli -v
```

Expected: PASS.

- [ ] **Step 6: Commit the CLI**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin
git add ludora-discovery/src/ludora/operation_cli.py ludora-discovery/tests/test_operation_cli.py ludora-discovery/pyproject.toml
git commit -m "feat: add discovery operation cli"
```

Expected: commit succeeds.

---

### Task 3: Split Shared Admin Operation Types From HTTP Client

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/discoveryOperations.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/discoveryOperationsClient.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/routes/operations.ts`
- Modify tests importing operation types from `discoveryOperationsClient.ts`

- [ ] **Step 1: Create shared operation types**

Create `src/discoveryOperations.ts`:

```ts
export type StoreDiscoveryRunStatus = 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed';

export type StoreDiscoveryRunResult = {
  accepted_stores: number;
  candidate_domains: number;
  searched_queries: number;
};

export type ItemDiscoveryRunResult = {
  item_candidates: number;
  store_id: number;
  website_url: string;
};

export type ItemUpdateRunResult = {
  updated_items: number;
};

export type ItemEmbeddingRunResult = {
  embedded_items: number;
  model: string;
  refresh_mode: 'full' | 'missing';
  selected_items: number;
};

export type StoreDiscoveryRun = {
  completed_at: string | null;
  error: string | null;
  id: string;
  result: StoreDiscoveryRunResult | ItemDiscoveryRunResult | ItemUpdateRunResult | ItemEmbeddingRunResult | null;
  started_at: string;
  status: StoreDiscoveryRunStatus;
  type: 'item_discovery' | 'item_embeddings' | 'item_update' | 'store_discovery';
};

export type DiscoveryOperationsClient = {
  cancelStoreDiscoveryRun(runId: string): Promise<StoreDiscoveryRun>;
  getLatestStoreDiscoveryRun(): Promise<StoreDiscoveryRun | null>;
  getStoreDiscoveryRun(runId: string): Promise<StoreDiscoveryRun | null>;
  startItemDiscoveryRun(storeId: number, websiteUrl: string): Promise<StoreDiscoveryRun>;
  startItemEmbeddingRun(refreshMode: 'full' | 'missing'): Promise<StoreDiscoveryRun>;
  startItemUpdateRun(): Promise<StoreDiscoveryRun>;
  startStoreDiscoveryRun(): Promise<StoreDiscoveryRun>;
};

export class DiscoveryOperationError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}
```

- [ ] **Step 2: Update the HTTP client to import shared types**

In `src/discoveryOperationsClient.ts`, remove the local type definitions and import them:

```ts
import {
  DiscoveryOperationError,
  type DiscoveryOperationsClient,
  type StoreDiscoveryRun
} from './discoveryOperations.js';

export type { DiscoveryOperationsClient, StoreDiscoveryRun } from './discoveryOperations.js';

export { DiscoveryOperationError };
```

Change the HTTP error throw to:

```ts
throw new DiscoveryOperationError(payload.error?.message ?? `Discovery API request failed with ${response.status}`, response.status);
```

- [ ] **Step 3: Update imports in admin-service**

Replace imports of `DiscoveryOperationsClient`, `StoreDiscoveryRun`, or `DiscoveryApiError` from `./discoveryOperationsClient.js` with imports from `./discoveryOperations.js`.

Use this search to find all imports:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
rg -n "discoveryOperationsClient|DiscoveryApiError|DiscoveryOperationsClient|StoreDiscoveryRun" src
```

Expected: route and test imports compile against `discoveryOperations.js`. Runtime HTTP factory imports still come from `discoveryOperationsClient.js`.

- [ ] **Step 4: Run admin-service tests**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npm test -- src/discoveryOperationsClient.test.ts src/app.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the type split**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin
git add ludora-admin-service/src
git commit -m "refactor: share discovery operation types"
```

Expected: commit succeeds.

---

### Task 4: Add Local Discovery Operations Client

**Files:**
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/localDiscoveryOperationsClient.ts`
- Create: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/localDiscoveryOperationsClient.test.ts`

- [ ] **Step 1: Write tests for local run lifecycle**

Create `src/localDiscoveryOperationsClient.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests and verify they fail because the local client is missing**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npm test -- src/localDiscoveryOperationsClient.test.ts
```

Expected: FAIL with module-not-found for `localDiscoveryOperationsClient`.

- [ ] **Step 3: Implement the local client**

Create `src/localDiscoveryOperationsClient.ts`:

```ts
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
```

- [ ] **Step 4: Run focused local client tests**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npm test -- src/localDiscoveryOperationsClient.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the local client**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin
git add ludora-admin-service/src/localDiscoveryOperationsClient.ts ludora-admin-service/src/localDiscoveryOperationsClient.test.ts
git commit -m "feat: run discovery operations locally"
```

Expected: commit succeeds.

---

### Task 5: Switch Admin-Service Default Wiring To Local Discovery

**Files:**
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/config.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/config.test.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/server.ts`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/src/app.test.ts`

- [ ] **Step 1: Add config tests for local discovery defaults**

In `src/config.test.ts`, add assertions that `loadConfig()` returns:

```ts
expect(config.discoveryRunner).toEqual({
  apiUrl: 'http://localhost:8001',
  envFile: expect.stringContaining('ludora-admin-service'),
  mode: 'local',
  packageDir: expect.stringContaining('ludora-discovery'),
  pythonExecutable: 'python'
});
```

Add a second test with environment overrides:

```ts
process.env.LUDORA_DISCOVERY_RUNNER = 'http';
process.env.LUDORA_DISCOVERY_API_URL = 'http://127.0.0.1:9009';
process.env.LUDORA_DISCOVERY_PYTHON = 'py';
process.env.LUDORA_DISCOVERY_PACKAGE_DIR = 'C:\\tmp\\ludora-discovery';
process.env.LUDORA_DISCOVERY_ENV_FILE = 'C:\\tmp\\admin.env';

const config = loadConfig();

expect(config.discoveryRunner).toEqual({
  apiUrl: 'http://127.0.0.1:9009',
  envFile: 'C:\\tmp\\admin.env',
  mode: 'http',
  packageDir: 'C:\\tmp\\ludora-discovery',
  pythonExecutable: 'py'
});
```

- [ ] **Step 2: Run config tests and verify they fail**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npm test -- src/config.test.ts
```

Expected: FAIL because `discoveryRunner` is not implemented.

- [ ] **Step 3: Implement config fields**

In `src/config.ts`, add imports:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
```

Add this type:

```ts
type DiscoveryRunnerMode = 'local' | 'http';
```

Replace `discoveryApiUrl: string;` in `Config` with:

```ts
discoveryRunner: {
  apiUrl: string;
  envFile: string;
  mode: DiscoveryRunnerMode;
  packageDir: string;
  pythonExecutable: string;
};
```

Replace the returned `discoveryApiUrl` field with:

```ts
discoveryRunner: readDiscoveryRunnerConfig()
```

Add these helpers:

```ts
function readDiscoveryRunnerConfig(): Config['discoveryRunner'] {
  return {
    apiUrl: process.env.LUDORA_DISCOVERY_API_URL ?? 'http://localhost:8001',
    envFile: process.env.LUDORA_DISCOVERY_ENV_FILE ?? path.resolve(process.cwd(), '.env'),
    mode: readDiscoveryRunnerMode(),
    packageDir: process.env.LUDORA_DISCOVERY_PACKAGE_DIR ?? defaultDiscoveryPackageDir(),
    pythonExecutable: process.env.LUDORA_DISCOVERY_PYTHON ?? 'python'
  };
}

function readDiscoveryRunnerMode(): DiscoveryRunnerMode {
  const rawMode = process.env.LUDORA_DISCOVERY_RUNNER?.trim().toLowerCase();
  if (!rawMode || rawMode === 'local') {
    return 'local';
  }
  if (rawMode === 'http') {
    return 'http';
  }
  throw new Error('LUDORA_DISCOVERY_RUNNER must be local or http');
}

function defaultDiscoveryPackageDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), '..', '..', 'ludora-discovery');
}
```

- [ ] **Step 4: Update server wiring**

In `src/server.ts`, import the local client:

```ts
import { createLocalDiscoveryOperationsClient } from './localDiscoveryOperationsClient.js';
```

Replace:

```ts
const operationsClient = createDiscoveryOperationsClient(config.discoveryApiUrl);
```

with:

```ts
const operationsClient =
  config.discoveryRunner.mode === 'http'
    ? createDiscoveryOperationsClient(config.discoveryRunner.apiUrl)
    : createLocalDiscoveryOperationsClient({
        envFile: config.discoveryRunner.envFile,
        packageDir: config.discoveryRunner.packageDir,
        pythonExecutable: config.discoveryRunner.pythonExecutable
      });
```

- [ ] **Step 5: Run admin-service focused tests**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npm test -- src/config.test.ts src/localDiscoveryOperationsClient.test.ts src/app.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run admin-service build**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit default local wiring**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin
git add ludora-admin-service/src
git commit -m "feat: default admin operations to local discovery"
```

Expected: commit succeeds.

---

### Task 6: Update Documentation And Local Startup Instructions

**Files:**
- Modify: `C:/PROJECTS/ludora/ludora-admin/README.md`
- Modify: `C:/PROJECTS/ludora/ludora-admin/AGENTS.md`
- Modify: `C:/PROJECTS/ludora/AGENTS.md`
- Modify: `C:/PROJECTS/ludora/ludora-admin/ludora-discovery/README.md`

- [ ] **Step 1: Update admin README operations section**

Replace the section that tells developers to start discovery API separately with:

````markdown
## Operations

The Operations page runs discovery through `ludora-admin-service`. The Python discovery package lives at `ludora-discovery/` inside this admin repo and is started by the service as a local child process when an operation begins.

Install discovery dependencies when setting up admin operations:

```powershell
cd .\ludora-discovery
python -m pip install -e .
```

Then start `ludora-admin-service` and `ludora-admin-ui` normally. The admin service reads discovery credentials from its own `.env` by default through `LUDORA_DISCOVERY_ENV_FILE`.

Set `LUDORA_DISCOVERY_RUNNER=http` only when intentionally testing against a separately started discovery API.
````

- [ ] **Step 2: Update admin AGENTS instructions**

In `C:/PROJECTS/ludora/ludora-admin/AGENTS.md`, remove the instruction to start discovery as a required local service. Add:

```markdown
- Discovery package: lives at `ludora-discovery/` and is invoked by `ludora-admin-service`; do not start a separate discovery API unless explicitly testing `LUDORA_DISCOVERY_RUNNER=http`.
```

Keep the fixed admin service and admin UI ports unchanged.

- [ ] **Step 3: Update workspace AGENTS instructions**

In `C:/PROJECTS/ludora/AGENTS.md`, replace the discovery service fixed-port line with:

```markdown
- Discovery package: from `ludora-admin/ludora-discovery/`, run tests with `python -m unittest discover -s tests -v`; normal admin operations invoke it through the Admin service.
```

Keep the note that no alternate port should be chosen if a service port is busy. The normal local service list should no longer require port `8001`.

- [ ] **Step 4: Update moved discovery README paths**

In `C:/PROJECTS/ludora/ludora-admin/ludora-discovery/README.md`, update examples that assume discovery is at `C:\PROJECTS\ludora\ludora-discovery`. Use `C:\PROJECTS\ludora\ludora-admin\ludora-discovery`.

Keep the `Discovery API` section, but mark it as optional direct debugging:

```markdown
The admin service runs discovery operations locally by default. The HTTP API is kept for direct debugging and fallback testing with `LUDORA_DISCOVERY_RUNNER=http`.
```

- [ ] **Step 5: Commit documentation changes**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin
git add README.md AGENTS.md ludora-discovery/README.md
git commit -m "docs: document colocated discovery operations"
```

If `C:/PROJECTS/ludora/AGENTS.md` is outside the admin repo, update it in the workspace but do not include it in the admin commit.

Expected: admin documentation commit succeeds.

---

### Task 7: Full Verification

**Files:**
- All changed files.

- [ ] **Step 1: Run moved discovery tests**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-discovery
$env:PYTHONPATH='src'
python -m unittest discover -s tests -v
```

Expected: PASS.

- [ ] **Step 2: Run admin-service tests**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npm test
```

Expected: PASS.

- [ ] **Step 3: Run admin-service build**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npm run build
```

Expected: PASS.

- [ ] **Step 4: Run admin UI tests only if UI files changed**

Run this only if `ludora-admin-ui` files changed:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui
npm test
```

Expected: PASS.

- [ ] **Step 5: Confirm no SQL DDL or DML was run**

Report this line in the implementation summary:

```text
No SQL DDL or DML commands were run.
```

- [ ] **Step 6: Commit verification-only fixes**

If verification required fixes, commit only those fixes:

```powershell
cd C:\PROJECTS\ludora\ludora-admin
git add ludora-discovery ludora-admin-service README.md AGENTS.md
git commit -m "fix: complete discovery admin migration"
```

Expected: commit succeeds only when there are verification fixes. If there are no fixes, skip this commit.

---

### Task 8: Retire The Old Root Discovery Checkout After Approval

**Files:**
- Candidate for removal after approval: `C:/PROJECTS/ludora/ludora-discovery`

- [ ] **Step 1: Verify no remaining references point to root discovery**

Run:

```powershell
cd C:\PROJECTS\ludora
rg -n "C:\\PROJECTS\\ludora\\ludora-discovery|\\.\\.\\\\ludora-discovery|\\.\\ludora-discovery|localhost:8001|127\\.0\\.0\\.1:8001" AGENTS.md docs ludora-admin
```

Expected: only historical design/plan docs mention the old path or port, or no matches. Do not edit historical plans/specs unless they are active runbooks.

- [ ] **Step 2: Ask the user before deleting the old checkout**

Ask:

```text
The migrated package is committed under ludora-admin/ludora-discovery and verification passed. Do you want me to remove the old separate checkout at C:\PROJECTS\ludora\ludora-discovery?
```

Expected: continue only after explicit user confirmation.

- [ ] **Step 3: If approved, archive or remove the old checkout safely**

Before deletion, run:

```powershell
git -C C:\PROJECTS\ludora\ludora-discovery status --short
```

Expected: no uncommitted changes that are absent from `C:\PROJECTS\ludora\ludora-admin\ludora-discovery`.

If the user approved removal and status is safe, remove with PowerShell:

```powershell
$target = Resolve-Path C:\PROJECTS\ludora\ludora-discovery
if ($target.Path -eq 'C:\PROJECTS\ludora\ludora-discovery') {
  Remove-Item -LiteralPath $target.Path -Recurse -Force
}
```

Expected: old separate checkout is gone. The admin repo still contains `C:\PROJECTS\ludora\ludora-admin\ludora-discovery`.
