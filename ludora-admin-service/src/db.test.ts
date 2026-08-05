import { afterEach, describe, expect, it, vi } from 'vitest';

describe('createDatabase', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('honors PGSSLMODE=no-verify for hosted Postgres certificates', async () => {
    const pool = {
      end: vi.fn(),
      query: vi.fn()
    };
    const Pool = vi.fn(function Pool() {
      return pool;
    });
    vi.doMock('pg', () => ({
      default: { Pool }
    }));
    vi.stubEnv('PGSSLMODE', 'no-verify');

    const { createDatabase } = await import('./db.js');
    createDatabase('postgresql://example');

    expect(Pool).toHaveBeenCalledWith({
      connectionString: 'postgresql://example',
      ssl: {
        rejectUnauthorized: false
      }
    });
  });

  it('destroys a checked-out client when the session is marked unusable', async () => {
    const client = {
      query: vi.fn(),
      release: vi.fn()
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      end: vi.fn(),
      query: vi.fn()
    };
    const Pool = vi.fn(function Pool() {
      return pool;
    });
    vi.doMock('pg', () => ({
      default: { Pool }
    }));

    const { createDatabase } = await import('./db.js');
    const database = createDatabase('postgresql://example');

    await database.withSession(async (session) => {
      await session.close?.();
    });

    expect(client.release).toHaveBeenCalledWith(true);
  });
});
