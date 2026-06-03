import pg, { type PoolConfig } from 'pg';

export type QueryResult = {
  rows: unknown[];
};

export type Database = {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  close?(): Promise<void>;
};

export function createDatabase(databaseUrl: string): Database {
  const pool = new pg.Pool(databaseConfig(databaseUrl));

  return {
    async query(text: string, params?: unknown[]): Promise<QueryResult> {
      const result = await pool.query(text, params);
      return { rows: result.rows };
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
