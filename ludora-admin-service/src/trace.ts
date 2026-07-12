import type { IncomingHttpHeaders } from 'node:http';

import type { Database } from './db.js';

export type TraceLogger = {
  log(event: string, fields?: Record<string, unknown>): void;
  flush?(): Promise<void>;
};

export class DatabaseTraceLogger implements TraceLogger {
  private readonly startedAt = process.hrtime.bigint();
  private pendingWrite = Promise.resolve();

  constructor(
    private readonly database: Database,
    private readonly runId: string
  ) {}

  log(event: string, fields: Record<string, unknown> = {}): void {
    const payload = {
      elapsed_ms: Number((process.hrtime.bigint() - this.startedAt) / 1_000_000n),
      ...fields
    };

    this.pendingWrite = this.pendingWrite
      .then(() =>
        this.database.query(
          `insert into store_item_discovery_trace_log (run_id, source, event, payload)
           values ($1, 'admin_service', $2, $3::jsonb)`,
          [this.runId, event, JSON.stringify(payload)]
        )
      )
      .then(() => undefined)
      .catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
  }
}

export const nullTraceLogger: TraceLogger = {
  log: () => undefined
};

export function createTraceLoggerFromHeaders(headers: IncomingHttpHeaders, database: Database): TraceLogger | undefined {
  const runId = singleHeaderValue(headers['x-ludora-trace-run-id']);
  if (!runId) {
    return undefined;
  }
  return new DatabaseTraceLogger(database, runId);
}

function singleHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return String(value[0] ?? '').trim();
  }
  return String(value ?? '').trim();
}
