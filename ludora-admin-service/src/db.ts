import pg, { type PoolConfig } from 'pg';

export type QueryResult = {
  rows: unknown[];
};

export type Database = {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  close?(): Promise<void>;
};

export type SessionDatabase = Database & {
  withSession<T>(operation: (session: Database) => Promise<T>): Promise<T>;
};

const profiles = {
  interactive: { max: 3, maxWaiting: 6, statementTimeout: 8_000 },
  maintenance: { max: 1, maxWaiting: 2, statementTimeout: 60_000 }
};

export function createDatabase(databaseUrl: string, profile: keyof typeof profiles = 'maintenance'): SessionDatabase {
  const { max, maxWaiting, statementTimeout } = profiles[profile];
  const pool = new pg.Pool(databaseConfig(databaseUrl, max, statementTimeout));
  pool.on('error', (error) => {
    console.error('Idle PostgreSQL connection failed', error.name);
  });

  function assertQueueHasCapacity(): void {
    if (pool.waitingCount >= maxWaiting) {
      throw Object.assign(new Error('Database pool is busy'), { code: 'LUDORA_DB_BUSY' });
    }
  }

  const toQueryResult = (result: pg.QueryResult): QueryResult => ({ rows: result.rows });
  return {
    async query(text: string, params?: unknown[]): Promise<QueryResult> {
      assertQueueHasCapacity();
      return toQueryResult(await pool.query(text, params));
    },
    async withSession<T>(operation: (session: Database) => Promise<T>): Promise<T> {
      assertQueueHasCapacity();
      const client = await pool.connect();
      let discardClient = false;
      try {
        return await operation({
          close: async () => {
            discardClient = true;
          },
          query: async (text, params) => toQueryResult(await client.query(text, params))
        });
      } finally {
        if (discardClient) {
          client.release(true);
        } else {
          client.release();
        }
      }
    },
    close: () => pool.end()
  };
}

export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as Error & { code?: string }).code;
  return (
    code === 'LUDORA_DB_BUSY' ||
    code === '57014' || // Query cancelled.
    code === '55P03' || // Lock timeout.
    code === '25P03' || // Idle transaction timeout.
    code === '53300' || // Server connection limit.
    code === '57P03' || // Server cannot accept connections now.
    error.message === 'timeout exceeded when trying to connect' ||
    error.message === 'Connection terminated due to connection timeout'
  );
}

function databaseConfig(databaseUrl: string, max: number, statementTimeout: number): PoolConfig {
  const deadlines = {
    statement_timeout: statementTimeout,
    lock_timeout: 1_000,
    idle_in_transaction_session_timeout: 60_000
  };
  const fragmentStart = databaseUrl.indexOf('#');
  const queryEnd = fragmentStart === -1 ? databaseUrl.length : fragmentStart;
  const queryStart = databaseUrl.indexOf('?');
  const hasQuery = !databaseUrl.startsWith('/') && queryStart >= 0 && queryStart < queryEnd;
  const params = new URLSearchParams(hasQuery ? databaseUrl.slice(queryStart + 1, queryEnd) : '');
  const suppliedOptions = params.getAll('options').at(-1) || process.env.PGOPTIONS;
  const reservedParams = ['options', 'connectionTimeoutMillis', ...Object.keys(deadlines)];
  let connectionString = databaseUrl;

  // node-postgres applies URL settings after PoolConfig, so remove conflicting keys.
  if (reservedParams.some((key) => params.has(key))) {
    for (const key of reservedParams) {
      params.delete(key);
    }
    const query = params.toString();
    connectionString = databaseUrl.slice(0, queryStart) + (query ? `?${query}` : '') + databaseUrl.slice(queryEnd);
  }

  // Keep unrelated startup options, with the service deadlines last.
  const deadlineOptions = Object.entries(deadlines).map(([key, value]) => `-c ${key}=${value}`);
  const config: PoolConfig = {
    connectionString,
    max,
    connectionTimeoutMillis: 2_000,
    ...deadlines,
    options: [suppliedOptions, ...deadlineOptions].filter(Boolean).join(' ')
  };

  if (process.env.PGSSLMODE === 'no-verify') {
    config.ssl = {
      rejectUnauthorized: false
    };
  }

  return config;
}
