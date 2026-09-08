import { execFile, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

export type ProcessIdentity = { pid: number; ppid: number; identity: string; state?: string };
export type DiscoveryProcessTree = { capture(): void; terminate(): Promise<void> };
type Child = Pick<ChildProcessWithoutNullStreams, 'pid' | 'kill'> & Partial<Pick<ChildProcessWithoutNullStreams, 'once' | 'off' | 'exitCode'>>;
type Options = {
  supervised?: boolean;
  platform?: NodeJS.Platform;
  listProcesses?: () => ProcessIdentity[];
  readIdentity?: (pid: number) => ProcessIdentity | undefined;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  executeTaskkill?: (pid: number) => Promise<void>;
};

// Never signal a process group: Python may share the service PGID and Chromium
// may create a different session. Retain identity, not just PID, across SIGTERM.
export function createDiscoveryProcessTree(child: Child, options: Options = {}): DiscoveryProcessTree {
  const platform = options.platform ?? process.platform;
  const list = options.listProcesses ?? (() => listProcesses(platform));
  const read = options.readIdentity ?? (platform === 'linux' ? readLinuxIdentity : (pid) => list().find((row) => row.pid === pid));
  const kill = options.killProcess ?? ((pid, signal) => { process.kill(pid, signal); });
  const taskkill = options.executeTaskkill ?? executeTaskkill;
  const owned = new Map<number, ProcessIdentity>();
  if (child.pid && child.pid !== process.pid) {
    const root = read(child.pid);
    if (root) owned.set(root.pid, root);
  }
  function current(row: ProcessIdentity): boolean {
    return row.pid !== process.pid && read(row.pid)?.identity === row.identity;
  }
  function capture(): void {
    if (!owned.size) return;
    const rows = list();
    const live = new Map(rows.map((row) => [row.pid, row]));
    const parents = new Set([...owned.values()].filter((row) => live.get(row.pid)?.identity === row.identity).map((row) => row.pid));
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (row.pid === process.pid || parents.has(row.pid) || !parents.has(row.ppid)) continue;
        owned.set(row.pid, row);
        parents.add(row.pid);
        changed = true;
      }
    }
  }
  return {
    capture,
    async terminate(): Promise<void> {
      if (!child.pid) { child.kill('SIGKILL'); return; }
      if (child.pid === process.pid) throw new Error('Refusing to terminate the admin service');
      if (platform === 'linux' && options.supervised) {
        const root = owned.get(child.pid);
        if (root && current(root) && await requestSupervisorCleanup(child, () => {
          if (current(root)) kill(root.pid, 'SIGUSR1');
        })) return;
        // Unresponsive supervisor: it is still the subreaper, so ancestry now
        // includes late-born orphans. Keep it alive until descendants are killed.
      }
      const failures: string[] = [];
      const stopped = new Set<number>();
      const signal = (row: ProcessIdentity, value: NodeJS.Signals): void => {
        if (options.supervised && row.pid === child.pid && value === 'SIGKILL' && failures.length) return;
        try { if (current(row)) kill(row.pid, value); }
        catch (error) { if (!gone(error)) failures.push(`pid ${row.pid} ${value}: ${message(error)}`); }
      };
      try {
        if (platform !== 'win32') {
          // Freeze known parents first, then discover and freeze any children
          // forked before the stop. Repeat until ownership is stable.
          for (let pass = 0; pass < 20; pass += 1) {
            for (const row of owned.values()) {
              if (!stopped.has(row.pid)) { signal(row, 'SIGSTOP'); stopped.add(row.pid); }
            }
            capture();
            if ([...owned.keys()].every((pid) => stopped.has(pid))) {
              const stillRunning = [...owned.values()].some((row) => {
                const live = read(row.pid);
                return live?.identity === row.identity && live.state && !['T', 't', 'Z', 'X'].includes(live.state);
              });
              if (stillRunning) {
                await new Promise((resolve) => setTimeout(resolve, 5));
              } else {
                // A child may have forked between our earlier snapshot and
                // delivery of SIGSTOP. Once stops are confirmed, resnapshot.
                capture();
                if ([...owned.keys()].every((pid) => stopped.has(pid))) break;
              }
            }
            if (pass === 19) failures.push('Process tree did not stabilize before termination');
          }
          for (const row of [...owned.values()].reverse()) signal(row, 'SIGKILL');
        } else {
          capture();
          // taskkill /T handles new descendants. Retained identities also cover
          // descendants reparented when cooperative cancellation exited Python.
          for (const row of owned.values()) {
            try { if (current(row)) await taskkill(row.pid); }
            catch (error) { if (current(row)) failures.push(`pid ${row.pid} taskkill: ${message(error)}`); }
          }
        }
      } catch (error) {
        failures.push(message(error));
        // Enumeration failure must still make a best effort on known identities.
        if (platform !== 'win32') for (const row of [...owned.values()].reverse()) signal(row, 'SIGKILL');
      } finally {
        if (failures.length && platform !== 'win32') {
          for (const row of owned.values()) if (stopped.has(row.pid)) signal(row, 'SIGCONT');
        }
      }
      if (failures.length) throw new Error(failures.join('; '));
    }
  };
}

function requestSupervisorCleanup(child: Child, request: () => void): Promise<boolean> {
  if (!child.once || !child.off) return Promise.resolve(false);
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const onExit = (): void => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => {
      child.off?.('exit', onExit);
      resolve(false);
    }, 5_000);
    child.once?.('exit', onExit);
    try { request(); }
    catch (error) {
      clearTimeout(timer);
      child.off?.('exit', onExit);
      reject(error);
    }
  });
}

function readLinuxIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, ppid: Number(fields[1]), identity: fields[19], state: fields[0] };
  } catch (error) {
    if (gone(error)) return undefined;
    throw error;
  }
}

function listProcesses(platform: NodeJS.Platform): ProcessIdentity[] {
  if (platform === 'linux') {
    return readdirSync('/proc').filter((name) => /^\d+$/.test(name))
      .map((name) => readLinuxIdentity(Number(name))).filter((row): row is ProcessIdentity => !!row);
  }
  if (platform === 'win32') {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name="Identity";Expression={$_.CreationDate.ToUniversalTime().Ticks.ToString()}} | ConvertTo-Json -Compress'
    ], { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
    const rows = JSON.parse(output) as Array<{ ProcessId: number; ParentProcessId: number; Identity: string }>;
    return rows.map((row) => ({ pid: row.ProcessId, ppid: row.ParentProcessId, identity: row.Identity }));
  }
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf8', timeout: 5_000 });
  return output.trim().split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), identity: match[3] }] : [];
  });
}

function executeTaskkill(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, (error) => {
      if (error) reject(error); else resolve();
    });
  });
}
function gone(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && ['ESRCH', 'ENOENT'].includes(String(error.code));
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
