import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { createBggItemImporter } from './bggItemImporter.js';
import { parseBggThingResponse, parseBggVersionsResponse } from './bggParser.js';

const parentBggId = 220368;
const versionBggId = 350656;
const xml = `<items><item type="boardgame" id="220368"><versions>
  <item type="boardgameversion" id="350656">
    <canonicalname value="Sword of Fellows Deluxe Edition"/>
    <name type="primary" value="English deluxe edition"/>
    <thumbnail>https://cf.geekdo-images.com/small.jpg</thumbnail>
    <image>https://cf.geekdo-images.com/large.jpg</image>
    <link type="boardgameversion" id="220368" inbound="true"/>
  </item>
  <item type="boardgameversion" id="343409"><name type="primary" value="Japanese edition"/>
    <link type="boardgameversion" id="20" inbound="true"/></item>
</versions></item></items>`;
const edition = {
  bggId: versionBggId,
  type: 'boardgameversion' as const,
  name: 'Sword of Fellows Deluxe Edition',
  nickname: 'English deluxe edition',
  thumbnail: 'https://cf.geekdo-images.com/small.jpg',
  image: 'https://cf.geekdo-images.com/large.jpg'
};

const accessoryBggId = 427113;
const accessoryVersionBggId = 725124;
const accessoryXml = `<items><item type="boardgameaccessory" id="427113"><versions>
  <item type="bgaccessoryversion" id="725124"><canonicalname value="Crane Car"/>
    <image>https://cf.geekdo-images.com/accessory.jpg</image><thumbnail>https://cf.geekdo-images.com/small.jpg</thumbnail>
  </item>
  <item type="bgaccessoryversion" id="725445"><canonicalname value="Crane Car"/>
    <link type="bgaccessoryversion" id="42" inbound="true"/>
  </item>
  <item type="boardgameversion" id="725444"><canonicalname value="Unverified board game version"/>
  </item>
  <item type="boardgameversion" id="725399"><canonicalname value="Verified board game version"/>
    <link type="boardgameversion" id="427113" inbound="true"/>
  </item>
</versions></item></items>`;
const accessoryEdition = {
  bggId: accessoryVersionBggId, type: 'bgaccessoryversion' as const, name: 'Crane Car', nickname: '',
  thumbnail: 'https://cf.geekdo-images.com/small.jpg', image: 'https://cf.geekdo-images.com/accessory.jpg'
};

describe('BGG edition imports', () => {
  it('uses canonical names and rejects editions linked to a different parent', () => {
    expect(parseBggVersionsResponse(xml, parentBggId)).toEqual([edition]);
    expect(parseBggVersionsResponse(xml, 42)).toBeNull();
  });

  it('accepts accessory editions nested under the exact accessory parent and drops contradictory types and links', () => {
    expect(parseBggVersionsResponse(accessoryXml, accessoryBggId)).toEqual([
      accessoryEdition,
      { bggId: 725399, type: 'boardgameversion', name: 'Verified board game version', nickname: '', image: '', thumbnail: '' }
    ]);
    expect(parseBggVersionsResponse(accessoryXml, 42)).toBeNull();
  });

  it.each([
    ['', 'Crane Car (Yellow Crane Car)'],
    ['XML nickname', 'Crane Car (XML nickname)']
  ])('uses the version-page nickname only when the XML nickname %j is empty', async (xmlNickname, expectedTitle) => {
    const database = { query: vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('insert into items')) return { rows: [{ id: 99 }] };
      if (sql.includes('and not is_version')) return { rows: [{ id: 42, item_type: 'expansion', parent_item_id: 18 }] };
      return { rows: [] };
    }) };
    const importer = createBggItemImporter(database, {
      fetchThing: vi.fn(),
      fetchVersions: vi.fn().mockResolvedValue([{ ...accessoryEdition, nickname: xmlNickname }]),
      search: vi.fn()
    });
    expect(await importer.importBggVersion!(accessoryBggId, accessoryVersionBggId, '', 'Yellow Crane Car')).toBe(99);
    const params = database.query.mock.calls.find(([sql]) => sql.includes('insert into items'))?.[1];
    expect(params?.[2]).toBe(expectedTitle);
    expect(params?.[4]).toBe('https://boardgamegeek.com/bgaccessoryversion/725124');
  });

  it('uses the regular parent namespace, inherits both parent descriptions, and copies taxonomy', async () => {
    const database = { query: vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('insert into items')) return { rows: [{ id: 99 }] };
      if (/where bgg_id = \$1 and not is_version/.test(sql)) return { rows: [{ id: 42 }] };
      return { rows: [] };
    }) };
    const importer = createBggItemImporter(database, {
      fetchThing: vi.fn(),
      fetchVersions: vi.fn().mockResolvedValue([edition]),
      search: vi.fn()
    });

    expect(await importer.importBggVersion!(parentBggId, versionBggId)).toBe(99);
    const insert = database.query.mock.calls.find(([sql]) => sql.includes('insert into items'));
    expect(insert?.[0]).toContain("coalesce(nullif($7, ''), parent.description)");
    expect(insert?.[0]).toContain('parent.description_es');
    expect(insert?.[0]).toMatch(/insert into item_categories[\s\S]*insert into item_mechanics[\s\S]*insert into item_families/);
    expect(insert?.[1]).toContain('');
  });

  it.each([
    [edition.name, edition.nickname, 'Sword of Fellows Deluxe Edition (English deluxe edition)', 'sword of fellows deluxe edition english deluxe edition'],
    [edition.name, '', edition.name, 'sword of fellows deluxe edition'],
    [edition.name, 'Sword of Fellows deluxe edition', edition.name, 'sword of fellows deluxe edition'],
    ['Sword of Fellows Deluxe Edition (ENGLISH DELUXE EDITION)', edition.nickname,
      'Sword of Fellows Deluxe Edition (ENGLISH DELUXE EDITION)', 'sword of fellows deluxe edition english deluxe edition']
  ])('writes and normalizes the import title for %s and nickname %s', async (name, nickname, expectedName, expectedNormalizedName) => {
    const database = { query: vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('insert into items')) return { rows: [{ id: 99 }] };
      if (sql.includes('and not is_version')) return { rows: [{ id: 42, item_type: 'base_game' }] };
      return { rows: [] };
    }) };
    const importer = createBggItemImporter(database, {
      fetchThing: vi.fn(),
      fetchVersions: vi.fn().mockResolvedValue([{ ...edition, name, nickname }]),
      search: vi.fn()
    });

    expect(await importer.importBggVersion!(parentBggId, versionBggId)).toBe(99);
    const insert = database.query.mock.calls.find(([sql]) => sql.includes('insert into items'));
    expect(insert?.[1]?.slice(2, 4)).toEqual([expectedName, expectedNormalizedName]);
  });

  it('returns a repeat import without changing the existing edition', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [{ id: '99', version_of: String(parentBggId) }] }) };
    const fetchVersions = vi.fn();
    const importer = createBggItemImporter(database, { fetchThing: vi.fn(), fetchVersions, search: vi.fn() });
    expect(await importer.importBggVersion!(parentBggId, versionBggId, 'New description')).toBe(99);
    expect(fetchVersions).not.toHaveBeenCalled();
    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('validates edition membership before importing a missing parent', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const fetchThing = vi.fn();
    const importer = createBggItemImporter(database, { fetchThing, fetchVersions: vi.fn().mockResolvedValue([]), search: vi.fn() });
    expect(await importer.importBggVersion!(parentBggId, versionBggId)).toBeNull();
    expect(fetchThing).not.toHaveBeenCalled();
  });

  it('finishes the first parent metadata transaction before inserting the version', async () => {
    const rawXml = '<items><item type="boardgame" id="220368"><name type="primary" value="Parent"/></item></items>';
    const details = parseBggThingResponse(rawXml)!;
    let parentId: number | null = null;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('with parent as')) {
        expect(parentId).toBe(42);
        return { rows: [{ id: 99 }] };
      }
      if (sql.includes('and not is_version') && parentId !== null) {
        return { rows: [{ id: parentId, item_type: 'base_game', parent_item_id: null }] };
      }
      return { rows: [] };
    });
    const sessionQuery = vi.fn(async (sql: string) => {
      if (sql.includes('insert into items')) return { rows: [{ id: 42 }] };
      if (sql === 'commit') parentId = 42;
      return { rows: [] };
    });
    const database = { query, withSession: (operation: (session: { query: typeof query }) => Promise<number>) => operation({ query: sessionQuery }) };
    const importer = createBggItemImporter(database, {
      fetchThing: vi.fn().mockResolvedValue({ rawXml, details }),
      fetchVersions: vi.fn().mockResolvedValue([edition]), search: vi.fn()
    });

    expect(await importer.importBggVersion!(parentBggId, versionBggId, 'Edition text')).toBe(99);
    expect(sessionQuery.mock.calls.at(0)?.[0]).toBe('begin');
    expect(sessionQuery.mock.calls.at(-1)?.[0]).toBe('commit');
    const editionInsert = query.mock.calls.find(([sql]) => sql.includes('with parent as'));
    expect(editionInsert).toBeDefined();
  });

  it('resolves the base game before copying an expansion with a missing local pointer', async () => {
    const rawXml = '<items><item type="boardgameexpansion" id="220368"><name type="primary" value="Expansion"/><link type="boardgameexpansion" id="13" value="Base game" inbound="true"/></item></items>';
    const database = { query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('with parent as')) return { rows: [{ id: 99 }] };
      if (sql.includes('and not is_version') && params?.[0] === parentBggId) {
        return { rows: [{ id: 42, item_type: 'expansion', parent_item_id: null }] };
      }
      if (sql.includes('and not is_version') && params?.[0] === 13) {
        return { rows: [{ id: 18, item_type: 'base_game', parent_item_id: null }] };
      }
      return { rows: [] };
    }) };
    const fetchThing = vi.fn().mockResolvedValue({ rawXml, details: parseBggThingResponse(rawXml) });
    const importer = createBggItemImporter(database, {
      fetchThing, fetchVersions: vi.fn().mockResolvedValue([edition]), search: vi.fn()
    });

    expect(await importer.importBggVersion!(parentBggId, versionBggId)).toBe(99);
    expect(fetchThing).toHaveBeenCalledWith(parentBggId);
    expect(database.query.mock.calls.find(([sql]) => sql.includes('with parent as'))).toEqual([
      expect.stringContaining('coalesce(parent.parent_item_id, $10)'), expect.arrayContaining([18])
    ]);
  });

  it.each(['55P03', '40P01'])('rolls back and retries a regular item metadata transaction after %s', async (code) => {
    const rawXml = '<items><item type="boardgame" id="220368"><name type="primary" value="Parent"/></item></items>';
    const transactionLog: string[] = [];
    let insertAttempts = 0;
    const database = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      withSession: async <T>(operation: (session: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => Promise<T>) =>
        operation({ query: async (sql) => {
          if (sql.includes('insert into items')) {
            insertAttempts += 1;
            if (insertAttempts === 1) throw Object.assign(new Error('Contention'), { code });
            return { rows: [{ id: 42 }] };
          }
          transactionLog.push(sql);
          return { rows: [] };
        } })
    };
    const importer = createBggItemImporter(database, {
      fetchThing: vi.fn().mockResolvedValue({ rawXml, details: parseBggThingResponse(rawXml) }), search: vi.fn()
    });

    expect(await importer.importBggId(parentBggId)).toBe(42);
    expect(transactionLog.filter((sql) => ['begin', 'rollback', 'commit'].includes(sql)))
      .toEqual(['begin', 'rollback', 'begin', 'commit']);
  });

  it('rejects an existing edition paired with a different parent', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [{ id: 99, version_of: 42 }] }) };
    const fetchVersions = vi.fn();
    const importer = createBggItemImporter(database, { fetchThing: vi.fn(), fetchVersions, search: vi.fn() });

    await expect(importer.importBggVersion!(parentBggId, versionBggId)).rejects.toMatchObject({ status: 409 });
    expect(fetchVersions).not.toHaveBeenCalled();
  });

  it('pairs listed editions with the matching local version and leaves missing ones importable', async () => {
    const database = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ bgg_id: String(parentBggId) }] })
      .mockResolvedValueOnce({ rows: [{ id: '99', bgg_id: String(versionBggId) }] })
    };
    const importer = createBggItemImporter(database, {
      fetchThing: vi.fn(),
      fetchVersions: vi.fn().mockResolvedValue([edition, { ...edition, bggId: 343409 }]),
      search: vi.fn()
    });
    const response = await request(createApp({ database, bggItemImporter: importer })).get('/items/42/bgg-versions');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      { bgg_id: versionBggId, bgg_type: 'boardgameversion', item_id: '99', name: edition.name, nickname: edition.nickname, image_url: edition.image, thumbnail_url: edition.thumbnail },
      { bgg_id: 343409, bgg_type: 'boardgameversion', item_id: null, name: edition.name, nickname: edition.nickname, image_url: edition.image, thumbnail_url: edition.thumbnail }
    ]);
    expect(database.query.mock.calls[1]?.[0]).toContain('where is_version and version_of');
  });

  it('passes trimmed plain text and typed IDs to the shared importer', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [{ id: 99, bgg_id: versionBggId, is_version: true, version_of: parentBggId }] }) };
    const importBggVersion = vi.fn().mockResolvedValue(99);
    const response = await request(createApp({ database, bggItemImporter: { importBggId: vi.fn(), importBggVersion } }))
      .post('/items/import-bgg-version').send({ parent_bgg_id: parentBggId, version_bgg_id: versionBggId, description: ' Foil cards. ', nickname: '  Deluxe  ' });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ id: 99, is_version: true, version_of: parentBggId });
    expect(importBggVersion).toHaveBeenCalledWith(parentBggId, versionBggId, 'Foil cards.', 'Deluxe');
  });
  it.each([23, 'x'.repeat(201), 'One\u0000Two'])('rejects an invalid edition nickname', async nickname => {
    const database = { query: vi.fn() };
    const importBggVersion = vi.fn();
    const response = await request(createApp({ database, bggItemImporter: { importBggId: vi.fn(), importBggVersion } }))
      .post('/items/import-bgg-version').send({ parent_bgg_id: accessoryBggId, version_bgg_id: accessoryVersionBggId, nickname });

    expect(response.status).toBe(400);
    expect(importBggVersion).not.toHaveBeenCalled();
  });

});
