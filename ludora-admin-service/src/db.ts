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

export function createDatabase(databaseUrl: string): SessionDatabase {
  const pool = new pg.Pool(databaseConfig(databaseUrl));
  const toQueryResult = (result: pg.QueryResult): QueryResult => ({ rows: result.rows });

  return {
    async query(text: string, params?: unknown[]): Promise<QueryResult> {
      return toQueryResult(await pool.query(text, params));
    },
    async withSession<T>(operation: (session: Database) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        return await operation({
          query: async (text, params) => toQueryResult(await client.query(text, params))
        });
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
}

function databaseConfig(databaseUrl: string): PoolConfig {
  const config: PoolConfig = {
    connectionString: databaseUrl
  };

  if (process.env.PGSSLMODE === 'no-verify') {
    config.ssl = {
      rejectUnauthorized: false
    };
  }

  return config;
}
