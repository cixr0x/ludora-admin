import { describe, expect, it } from 'vitest';

import type { Database, QueryResult, SessionDatabase } from '../db.js';
import {
  BGG_AI_MATCH_SEARCH_TYPE,
  BGG_SEARCH_TYPE,
  createBggMatchCache
} from './bggMatchCache.js';

const warOfTheRing = {
  bggId: 115746,
  name: 'War of the Ring: Second Edition',
  type: 'boardgame',
  yearPublished: 2011
};

const warCoverUrl = 'https://store.mx/war-ring.jpg';
const coffeeRushCoverUrl = 'https://store.mx/coffee-rush.jpg';
const warCoverDiscriminator = 'image-sha256:aff8c6e9bbc77474954a0972c9c82f63c944990dabb25ee3f4febccdfbf71966';
const spanishWarImageKey = `la guerra del anillo::cover-context:${warCoverDiscriminator}`;
const canonicalWarImageKey = `war of the ring second edition::cover-context:${warCoverDiscriminator}`;
const spanishWarNameOnlyKey = 'la guerra del anillo::cover-context:name-only';

describe('BGG match cache', () => {
  it('reads a legacy Thing-cache name with the accessory request identity', async () => {
    const queriedThingCacheParams: unknown[][] = [];
    const database: Database = {
      query: async (sql, params) => {
        const normalized = normalizeSql(sql);
        if (normalized.includes('from bgg_thing_cache')) {
          queriedThingCacheParams.push(params ?? []);
          return { rows: [{ bgg_id: 337190, item_type: 'boardgameaccessory', name: 'Catan Accessory', year_published: 2022 }] };
        }
        return { rows: [] };
      }
    };

    await expect(createBggMatchCache(database).lookup('Catan Accessory')).resolves.toEqual({
      cacheHit: true,
      matches: [{ item: { bggId: 337190, name: 'Catan Accessory', type: 'boardgameaccessory', yearPublished: 2022 }, verifiedByAi: false }]
    });
    expect(queriedThingCacheParams).toEqual([['boardgame,boardgameexpansion,boardgameaccessory', 'boardgame,boardgameexpansion', '%catan%accessory%', 'Catan Accessory']]);
  });

  it('prefers the new Thing-cache row over a legacy duplicate', async () => {
    const thingCacheSql: string[] = [];
    const database: Database = {
      query: async (sql) => {
        if (normalizeSql(sql).includes('from bgg_thing_cache')) {
          thingCacheSql.push(normalizeSql(sql));
          return { rows: [
            { bgg_id: 337190, item_type: 'boardgameaccessory', name: 'New Catan Accessory', year_published: 2022 },
            { bgg_id: 337190, item_type: 'boardgameaccessory', name: 'Legacy Catan Accessory', year_published: 2021 }
          ] };
        }
        return { rows: [] };
      }
    };

    await expect(createBggMatchCache(database).lookup('Catan Accessory')).resolves.toEqual({
      cacheHit: true,
      matches: [{ item: { bggId: 337190, name: 'New Catan Accessory', type: 'boardgameaccessory', yearPublished: 2022 }, verifiedByAi: false }]
    });
    expect(thingCacheSql[0]).toContain('select distinct on (bgg_id)');
    expect(thingCacheSql[0]).toContain('case when request_type = $1 then 0 else 1 end');
  });
  it('uses an accessory-aware cache identity', () => {
    expect(BGG_SEARCH_TYPE).toBe('boardgame,boardgameexpansion,boardgameaccessory');
  });
  it('marks AI query associations as verified', async () => {
    const cache = createBggMatchCache(databaseForAiQueryRow({
      bgg_id: 115746,
      name: 'War of the Ring: Second Edition',
      item_type: 'boardgame',
      year_published: 2011
    }, spanishWarImageKey));

    await expect(cache.lookup('La Guerra del Anillo', { imageUrl: warCoverUrl })).resolves.toEqual({
      cacheHit: true,
      matches: [{ item: warOfTheRing, verifiedByAi: true }]
    });
  });

  it('reuses AI trust for the same normalized title and canonical cover URL', async () => {
    const cache = createBggMatchCache(databaseForAiQueryRow(
      toCacheRow(warOfTheRing),
      spanishWarImageKey
    ));

    await expect(cache.lookup('  LA GUERRA DEL ANILLO! ', {
      imageUrl: ' HTTPS://STORE.MX:443/covers/../war-ring.jpg '
    })).resolves.toEqual({
      cacheHit: true,
      matches: [{ item: warOfTheRing, verifiedByAi: true }]
    });
  });

  it('keeps a different-cover AI association available only as an unverified cache candidate', async () => {
    const cache = createBggMatchCache(databaseForLookup({
      aiAssociationKeys: [spanishWarImageKey],
      aiRows: [toCacheRow(warOfTheRing)]
    }));

    await expect(cache.lookup('La Guerra del Anillo', { imageUrl: coffeeRushCoverUrl })).resolves.toEqual({
      cacheHit: true,
      matches: [{ item: warOfTheRing, verifiedByAi: false }]
    });
  });

  it('does not reuse image-backed AI trust for a candidate without an image', async () => {
    const cache = createBggMatchCache(databaseForLookup({
      aiAssociationKeys: [spanishWarImageKey],
      aiRows: [toCacheRow(warOfTheRing)]
    }));

    await expect(cache.lookup('La Guerra del Anillo', { imageUrl: null })).resolves.toEqual({
      cacheHit: true,
      matches: [{ item: warOfTheRing, verifiedByAi: false }]
    });
  });

  it('reuses name-only AI trust only for another missing-image candidate', async () => {
    const database = databaseForLookup({
      aiAssociationKeys: [spanishWarNameOnlyKey],
      aiRows: [toCacheRow(warOfTheRing)]
    });
    const cache = createBggMatchCache(database);

    await expect(cache.lookup('La Guerra del Anillo', { imageUrl: null })).resolves.toEqual({
      cacheHit: true,
      matches: [{ item: warOfTheRing, verifiedByAi: true }]
    });
    await expect(cache.lookup('La Guerra del Anillo', { imageUrl: warCoverUrl })).resolves.toEqual({
      cacheHit: true,
      matches: [{ item: warOfTheRing, verifiedByAi: false }]
    });
  });

  it('keeps a legacy title-only AI association as an unverified scoring candidate', async () => {
    const cache = createBggMatchCache(databaseForLookup({
      aiAssociationKeys: ['la guerra del anillo'],
      aiRows: [toCacheRow(warOfTheRing)]
    }));

    await expect(cache.lookup('La Guerra del Anillo', { imageUrl: coffeeRushCoverUrl })).resolves.toEqual({
      cacheHit: true,
      matches: [{ item: warOfTheRing, verifiedByAi: false }]
    });
  });

  it('marks ordinary query associations as unverified', async () => {
    const cache = createBggMatchCache(databaseForOrdinaryQueryRow({
      bgg_id: 377061,
      name: 'Coffee Rush',
      item_type: 'boardgame',
      year_published: 2023
    }));

    await expect(cache.lookup('Coffee Rush')).resolves.toEqual({
      cacheHit: true,
      matches: [{
        item: { bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 },
        verifiedByAi: false
      }]
    });
  });

  it('returns direct BGG cache-name matches as unverified', async () => {
    const cache = createBggMatchCache(databaseForDirectCacheRow({
      bgg_id: 13,
      name: 'Catan',
      item_type: 'boardgame',
      year_published: 1995
    }));

    await expect(cache.lookup('Catan')).resolves.toEqual({
      cacheHit: true,
      matches: [{
        item: { bggId: 13, name: 'Catan', type: 'boardgame', yearPublished: 1995 },
        verifiedByAi: false
      }]
    });
  });

  it('returns thing-cache name matches as unverified', async () => {
    const cache = createBggMatchCache(databaseForThingCacheRow({
      bgg_id: 174430,
      name: 'Gloomhaven',
      item_type: 'boardgame',
      year_published: 2017
    }));

    await expect(cache.lookup('Gloomhaven')).resolves.toEqual({
      cacheHit: true,
      matches: [{
        item: { bggId: 174430, name: 'Gloomhaven', type: 'boardgame', yearPublished: 2017 },
        verifiedByAi: false
      }]
    });
  });

  it('deduplicates by BGG id without losing AI verification', async () => {
    const cache = createBggMatchCache(databaseForDuplicateAiAndOrdinaryRows());

    await expect(cache.lookup('La Guerra del Anillo', { imageUrl: warCoverUrl })).resolves.toEqual({
      cacheHit: true,
      matches: [{ item: warOfTheRing, verifiedByAi: true }]
    });
  });

  it('returns a complete miss without an upstream dependency', async () => {
    const cache = createBggMatchCache(databaseWithEmptyRows());

    await expect(cache.lookup('Juego desconocido')).resolves.toEqual({ cacheHit: false, matches: [] });
  });

  it('writes each trusted AI query once and links it to the result at rank zero', async () => {
    const { database, executedParams, executedSql } = recordingDatabase();
    const cache = createBggMatchCache(database);

    await cache.recordAiMatch(
      ['War of the Ring: Second Edition', 'La Guerra del Anillo', '  LA GUERRA DEL ANILLO  '],
      warOfTheRing,
      { imageUrl: warCoverUrl }
    );

    expect(executedSql).toContainEqual(expect.stringContaining('insert into bgg_search_cache'));
    expect(executedParams).toContainEqual(expect.arrayContaining([BGG_AI_MATCH_SEARCH_TYPE]));
    expect(executedParams.filter((params) => params[2] === BGG_AI_MATCH_SEARCH_TYPE)).toEqual([
      ['La Guerra del Anillo', spanishWarImageKey, BGG_AI_MATCH_SEARCH_TYPE],
      ['War of the Ring: Second Edition', canonicalWarImageKey, BGG_AI_MATCH_SEARCH_TYPE]
    ]);
    expect(executedParams.filter((params) => params.length === 3 && params[2] === 0)).toEqual([
      [201, 101, 0],
      [202, 101, 0]
    ]);
    expect(executedSql).toEqual([
      'begin',
      'select pg_advisory_xact_lock($1, $2)',
      'select pg_advisory_xact_lock($1, $2)',
      expect.stringContaining('insert into bgg_search_cache'),
      expect.stringContaining('insert into bgg_search_queries'),
      'delete from bgg_search_query_results where query_id = $1;',
      expect.stringContaining('insert into bgg_search_query_results'),
      expect.stringContaining('insert into bgg_search_queries'),
      'delete from bgg_search_query_results where query_id = $1;',
      expect.stringContaining('insert into bgg_search_query_results'),
      'commit'
    ]);
    expect(executedParams.slice(0, 3)).toEqual([
      [],
      [671560477, 1605536950],
      [1641227100, 226602472]
    ]);
    expect(database.connectCalls).toBe(1);
    expect(database.releaseCalls).toBe(1);
    expect(database.poolQueryCalls).toBe(0);
    expect(new Set(database.clientIds)).toEqual(new Set([1]));
  });

  it('rolls back and releases the session when association insertion fails after deletion', async () => {
    const database = new TransactionalRecordingDatabase({
      failAfterDeletion: true,
      initialAssociations: [[spanishWarImageKey, 999]]
    });
    const cache = createBggMatchCache(database);

    await expect(cache.recordAiMatch(['La Guerra del Anillo'], warOfTheRing, {
      imageUrl: warCoverUrl
    })).rejects.toThrow('injected association insert failure');

    expect(database.normalizedSql()).toContain('rollback');
    expect(database.normalizedSql()).not.toContain('commit');
    expect(database.connectCalls).toBe(1);
    expect(database.releaseCalls).toBe(1);
    expect(database.poolQueryCalls).toBe(0);
    expect(database.visibleTrustedBggIds(spanishWarImageKey)).toEqual([999]);
  });

  it('serializes concurrent replacement for the same trust key without exposing a partial set', async () => {
    const database = new TransactionalRecordingDatabase({
      initialAssociations: [[spanishWarImageKey, 999]],
      pauseAfterFirstDeletion: true
    });
    const cache = createBggMatchCache(database);
    const replacementOne = { ...warOfTheRing, bggId: 115746 };
    const replacementTwo = { ...warOfTheRing, bggId: 411111, name: 'War of the Ring Ultimate Edition' };

    const firstWrite = cache.recordAiMatch(['La Guerra del Anillo'], replacementOne, { imageUrl: warCoverUrl });
    await Promise.race([
      database.waitForFirstDeletion(),
      firstWrite.then(() => {
        throw new Error('First replacement completed before the controlled deletion pause');
      })
    ]);
    const secondWrite = cache.recordAiMatch(['La Guerra del Anillo'], replacementTwo, { imageUrl: warCoverUrl });
    await Promise.race([
      database.waitForSecondLockAttempt(),
      secondWrite.then(() => {
        throw new Error('Second replacement completed without waiting on the shared trust-key lock');
      })
    ]);

    expect(database.lockAcquisitions).toBe(1);
    expect(database.deletionCount).toBe(1);
    expect(database.visibleTrustedBggIds(spanishWarImageKey)).toEqual([999]);

    database.continueFirstReplacement();
    await Promise.all([firstWrite, secondWrite]);

    expect(database.lockAcquisitions).toBe(2);
    expect(database.visibleTrustedBggIds(spanishWarImageKey)).toEqual([411111]);
    expect(database.commitSnapshots).toEqual([[115746], [411111]]);
    expect(database.connectCalls).toBe(2);
    expect(database.releaseCalls).toBe(2);
  });

  it('keeps standard search entries under the ordinary search type', async () => {
    const { database, executedParams } = recordingDatabase();
    const cache = createBggMatchCache(database);

    await cache.recordSearch('Catan', [{ bggId: 13, name: 'Catan', type: 'boardgame', yearPublished: 1995 }]);

    expect(executedParams).toContainEqual(['Catan', 'catan', BGG_SEARCH_TYPE, 1]);
  });
});

function databaseForAiQueryRow(row: Record<string, unknown>, aiAssociationKey: string): Database {
  return databaseForLookup({ aiAssociationKeys: [aiAssociationKey], aiRows: [row] });
}

function databaseForOrdinaryQueryRow(row: Record<string, unknown>): Database {
  return databaseForLookup({ ordinaryRows: [row] });
}

function databaseForDirectCacheRow(row: Record<string, unknown>): Database {
  return databaseForLookup({ directRows: [row] });
}

function databaseForThingCacheRow(row: Record<string, unknown>): Database {
  return databaseForLookup({ thingRows: [row] });
}

function databaseForDuplicateAiAndOrdinaryRows(): Database {
  return databaseForLookup({
    aiAssociationKeys: [spanishWarImageKey],
    aiRows: [toCacheRow(warOfTheRing)],
    ordinaryRows: [toCacheRow(warOfTheRing)]
  });
}

function databaseWithEmptyRows(): Database {
  return databaseForLookup({});
}

function databaseForLookup(options: {
  aiAssociationKeys?: string[];
  aiRows?: unknown[];
  directRows?: unknown[];
  ordinaryRows?: unknown[];
  thingRows?: unknown[];
}): Database {
  return {
    query: async (sql, params) => {
      const normalized = normalizeSql(sql);
      if (normalized.includes('from bgg_search_queries q')) {
        const pattern = String(params?.[1] ?? '');
        const associationPrefix = pattern.endsWith('%') ? pattern.slice(0, -1) : pattern;
        const exactAssociationKey = String(params?.[2] ?? '');
        const hasOtherContext = options.aiAssociationKeys?.some((key) =>
          key.startsWith(associationPrefix) && key !== exactAssociationKey
        );
        return { rows: hasOtherContext ? (options.aiRows ?? []) : [] };
      }
      if (normalized.startsWith('select id from bgg_search_queries')) {
        const searchType = params?.[1];
        if (
          searchType === BGG_AI_MATCH_SEARCH_TYPE &&
          options.aiRows !== undefined &&
          options.aiAssociationKeys?.includes(String(params?.[0]))
        ) {
          return { rows: [{ id: 11 }] };
        }
        if (searchType === BGG_SEARCH_TYPE && options.ordinaryRows !== undefined) {
          return { rows: [{ id: 12 }] };
        }
        return { rows: [] };
      }
      if (normalized.includes('from bgg_search_query_results')) {
        return { rows: params?.[0] === 11 ? (options.aiRows ?? []) : (options.ordinaryRows ?? []) };
      }
      if (normalized.includes('from bgg_search_cache')) {
        return { rows: options.directRows ?? [] };
      }
      if (normalized.includes('from bgg_thing_cache')) {
        return { rows: options.thingRows ?? [] };
      }
      throw new Error(`Unexpected lookup SQL: ${normalized}`);
    }
  };
}

function recordingDatabase(): {
  database: TransactionalRecordingDatabase;
  executedParams: unknown[][];
  executedSql: string[];
} {
  const database = new TransactionalRecordingDatabase();
  return {
    database,
    executedParams: database.executedParams,
    executedSql: database.executedSql
  };
}

type TransactionalDatabaseOptions = {
  failAfterDeletion?: boolean;
  initialAssociations?: Array<[string, number]>;
  pauseAfterFirstDeletion?: boolean;
};

type TransactionState = {
  cacheBggIds: Map<number, number>;
  heldLocks: Array<() => void>;
  queryKeys: Map<number, string>;
  stagedAssociations: Map<string, number | null>;
};

class TransactionalRecordingDatabase implements SessionDatabase {
  readonly clientIds: number[] = [];
  readonly commitSnapshots: number[][] = [];
  readonly executedParams: unknown[][] = [];
  readonly executedSql: string[] = [];
  connectCalls = 0;
  deletionCount = 0;
  lockAcquisitions = 0;
  poolQueryCalls = 0;
  releaseCalls = 0;

  private readonly committedAssociations = new Map<string, number>();
  private readonly firstDeletion = deferred<void>();
  private readonly firstReplacementMayContinue = deferred<void>();
  private readonly lockTails = new Map<string, Promise<void>>();
  private readonly secondLockAttempt = deferred<void>();
  private nextCacheId = 101;
  private nextClientId = 1;
  private nextQueryId = 201;

  constructor(private readonly options: TransactionalDatabaseOptions = {}) {
    for (const [key, bggId] of options.initialAssociations ?? []) {
      this.committedAssociations.set(key, bggId);
    }
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.poolQueryCalls += 1;
    const normalized = normalizeSql(sql);
    this.executedSql.push(normalized);
    this.executedParams.push(params);
    if (normalized.startsWith('insert into bgg_search_cache')) {
      return { rows: [{ id: this.nextCacheId++ }] };
    }
    if (normalized.startsWith('insert into bgg_search_queries')) {
      return { rows: [{ id: this.nextQueryId++ }] };
    }
    if (
      normalized === 'delete from bgg_search_query_results where query_id = $1;' ||
      normalized.startsWith('insert into bgg_search_query_results')
    ) {
      return { rows: [] };
    }
    throw new Error(`Unexpected pool SQL: ${normalized}`);
  }

  async withSession<T>(operation: (session: Database) => Promise<T>): Promise<T> {
    const clientId = this.nextClientId++;
    this.connectCalls += 1;
    const transaction: TransactionState = {
      cacheBggIds: new Map(),
      heldLocks: [],
      queryKeys: new Map(),
      stagedAssociations: new Map()
    };
    try {
      return await operation({
        query: (sql, params = []) => this.sessionQuery(clientId, transaction, sql, params)
      });
    } finally {
      this.releaseLocks(transaction);
      this.releaseCalls += 1;
    }
  }

  normalizedSql(): string[] {
    return [...this.executedSql];
  }

  visibleTrustedBggIds(key: string): number[] {
    const bggId = this.committedAssociations.get(key);
    return bggId === undefined ? [] : [bggId];
  }

  waitForFirstDeletion(): Promise<void> {
    return this.firstDeletion.promise;
  }

  waitForSecondLockAttempt(): Promise<void> {
    return this.secondLockAttempt.promise;
  }

  continueFirstReplacement(): void {
    this.firstReplacementMayContinue.resolve();
  }

  private async sessionQuery(
    clientId: number,
    transaction: TransactionState,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult> {
    const normalized = normalizeSql(sql);
    this.clientIds.push(clientId);
    this.executedSql.push(normalized);
    this.executedParams.push(params);

    if (normalized === 'begin') {
      return { rows: [] };
    }
    if (normalized === 'commit') {
      for (const [key, bggId] of transaction.stagedAssociations) {
        if (bggId === null) {
          this.committedAssociations.delete(key);
        } else {
          this.committedAssociations.set(key, bggId);
        }
      }
      const committedKey = transaction.stagedAssociations.keys().next().value as string | undefined;
      if (committedKey) {
        this.commitSnapshots.push(this.visibleTrustedBggIds(committedKey));
      }
      this.releaseLocks(transaction);
      return { rows: [] };
    }
    if (normalized === 'rollback') {
      transaction.stagedAssociations.clear();
      this.releaseLocks(transaction);
      return { rows: [] };
    }
    if (normalized === 'select pg_advisory_xact_lock($1, $2)') {
      await this.acquireLock(params, transaction);
      return { rows: [] };
    }
    if (normalized.startsWith('insert into bgg_search_cache')) {
      const cacheId = this.nextCacheId++;
      transaction.cacheBggIds.set(cacheId, Number(params[0]));
      return { rows: [{ id: cacheId }] };
    }
    if (normalized.startsWith('insert into bgg_search_queries')) {
      const queryId = this.nextQueryId++;
      transaction.queryKeys.set(queryId, String(params[1]));
      return { rows: [{ id: queryId }] };
    }
    if (normalized === 'delete from bgg_search_query_results where query_id = $1;') {
      const key = transaction.queryKeys.get(Number(params[0]));
      if (!key) {
        throw new Error('Fake transaction could not resolve query key');
      }
      transaction.stagedAssociations.set(key, null);
      this.deletionCount += 1;
      if (this.options.pauseAfterFirstDeletion && this.deletionCount === 1) {
        this.firstDeletion.resolve();
        await this.firstReplacementMayContinue.promise;
      }
      return { rows: [] };
    }
    if (normalized.startsWith('insert into bgg_search_query_results')) {
      if (this.options.failAfterDeletion) {
        throw new Error('injected association insert failure');
      }
      const queryId = Number(params[0]);
      const cacheId = Number(params[1]);
      const key = transaction.queryKeys.get(queryId);
      const bggId = transaction.cacheBggIds.get(cacheId);
      if (!key || bggId === undefined) {
        throw new Error('Fake transaction could not resolve association');
      }
      transaction.stagedAssociations.set(key, bggId);
      return { rows: [] };
    }
    throw new Error(`Unexpected transactional SQL: ${normalized}`);
  }

  private async acquireLock(params: unknown[], transaction: TransactionState): Promise<void> {
    const key = params.map(String).join(':');
    const previous = this.lockTails.get(key) ?? Promise.resolve();
    let release = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.lockTails.set(key, tail);
    if (this.connectCalls >= 2) {
      this.secondLockAttempt.resolve();
    }
    await previous;
    this.lockAcquisitions += 1;
    transaction.heldLocks.push(() => {
      release();
      if (this.lockTails.get(key) === tail) {
        this.lockTails.delete(key);
      }
    });
  }

  private releaseLocks(transaction: TransactionState): void {
    for (const release of transaction.heldLocks.splice(0)) {
      release();
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T) => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function toCacheRow(item: typeof warOfTheRing): Record<string, unknown> {
  return {
    bgg_id: item.bggId,
    item_type: item.type,
    name: item.name,
    year_published: item.yearPublished
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
