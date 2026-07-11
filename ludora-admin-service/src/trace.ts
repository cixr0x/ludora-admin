import fs from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';

export type TraceLogger = {
  log(event: string, fields?: Record<string, unknown>): void;
};

export class JsonlTraceLogger implements TraceLogger {
  private readonly startedAt = process.hrtime.bigint();

  constructor(
    private readonly tracePath: string,
    private readonly runId: string
  ) {}

  log(event: string, fields: Record<string, unknown> = {}): void {
    const record = {
      ts: new Date().toISOString(),
      run_id: this.runId,
      event,
      elapsed_ms: Number((process.hrtime.bigint() - this.startedAt) / 1_000_000n),
      ...fields
    };

    try {
      fs.mkdirSync(path.dirname(this.tracePath), { recursive: true });
      fs.appendFileSync(this.tracePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      return;
    }
  }
}

export const nullTraceLogger: TraceLogger = {
  log: () => undefined
};

export function createTraceLoggerFromHeaders(headers: IncomingHttpHeaders): TraceLogger | undefined {
  const runId = singleHeaderValue(headers['x-ludora-trace-run-id']);
  const tracePath = singleHeaderValue(headers['x-ludora-trace-path']);
  if (!runId || !tracePath) {
    return undefined;
  }
  return new JsonlTraceLogger(tracePath, runId);
}

function singleHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return String(value[0] ?? '').trim();
  }
  return String(value ?? '').trim();
}
