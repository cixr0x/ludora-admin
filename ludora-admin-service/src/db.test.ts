import { EventEmitter } from 'node:events';

import type { PoolConfig } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockPool = (waitingCount = 0) => {
  const client = Object.assign(new EventEmitter(), { query: vi.fn(), release: vi.fn() });
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    end: vi.fn(),
    on: vi.fn(),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    waitingCount
  };
  const Pool = vi.fn(function Pool(_config: PoolConfig) {
    return pool;
  });
  vi.doMock('pg', () => ({ default: { Pool } }));
  return { client, pool, Pool };
};

describe('createDatabase', () => {
  afterEach(() => {
    vi.doUnmock('pg');
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('sets bounded pools and server-side defaults without changing TLS behavior', async () => {
    const { Pool } = mockPool();
    vi.stubEnv('PGSSLMODE', 'no-verify');

    const { createDatabase } = await import('./db.js');
    createDatabase('postgresql://example', 'interactive');

    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
      connectionString: 'postgresql://example',
      max: 3,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 8_000,
      lock_timeout: 1_000,
      idle_in_transaction_session_timeout: 60_000,
      ssl: { rejectUnauthorized: false }
    }));
  });

  it('keeps conflicting URL settings from overriding the actual PostgreSQL startup limits', async () => {
    const { Pool } = mockPool();
    const pg = (await vi.importActual<typeof import('pg')>('pg')).default;
    vi.stubEnv('PGOPTIONS', '-c search_path=ignored_when_url_options_exist');

    const { createDatabase } = await import('./db.js');
    createDatabase(
      'postgresql://example/db?application_name=example&ssl=no-verify&statement_timeout=0&lock_timeout=0&idle_in_transaction_session_timeout=0&connectionTimeoutMillis=0&options=-c+search_path%3Dcustom+-c+statement_timeout%3D0', 'interactive'
    );

    const client = new pg.Client(Pool.mock.calls[0]?.[0]);
    const startup = (client as unknown as { getStartupConf(): Record<string, string> }).getStartupConf();
    expect(startup).toMatchObject({
      application_name: 'example',
      statement_timeout: '8000',
      lock_timeout: '1000',
      idle_in_transaction_session_timeout: '60000'
    });
    expect(startup.options).toContain('-c search_path=custom');
    expect(startup.options).toMatch(/-c statement_timeout=8000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=60000$/);
    expect(client.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('retains PGOPTIONS when the connection URL has no options', async () => {
    const { Pool } = mockPool();
    vi.stubEnv('PGOPTIONS', '-c search_path=custom');
    const { createDatabase } = await import('./db.js');
    createDatabase('postgresql://example', 'interactive');

    expect(Pool.mock.calls[0]?.[0].options).toContain('-c search_path=custom');
  });

  it('rejects overload before adding work to the pool queue', async () => {
    const { pool } = mockPool(6);
    const { createDatabase } = await import('./db.js');
    const database = createDatabase('postgresql://example', 'interactive');

    await expect(database.query('select 1')).rejects.toMatchObject({ code: 'LUDORA_DB_BUSY' });
    expect(pool.query).not.toHaveBeenCalled();
    await expect(database.withSession(async () => {})).rejects.toMatchObject({ code: 'LUDORA_DB_BUSY' });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('bounds CLI maintenance queries without applying the interactive statement limit', async () => {
    const { Pool } = mockPool();
    const { createDatabase } = await import('./db.js');
    createDatabase('postgresql://example');

    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
      max: 1,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 60_000
    }));
  });

  it('destroys a checked-out client when the session is marked unusable', async () => {
    const { client } = mockPool();
    const { createDatabase } = await import('./db.js');
    const database = createDatabase('postgresql://example');
    await database.withSession(async (session) => {
      await session.close?.();
    });

    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('handles a checked-out client error and discards the connection on release', async () => {
    const { client } = mockPool();
    const { createDatabase } = await import('./db.js');
    const database = createDatabase('postgresql://example');

    await database.withSession(async () => {
      client.emit('error', Object.assign(new Error('idle in transaction timeout'), { code: '25P03' }));
    });

    expect(client.listenerCount('error')).toBe(0);
    expect(client.release).toHaveBeenCalledWith(true);
  });
});
