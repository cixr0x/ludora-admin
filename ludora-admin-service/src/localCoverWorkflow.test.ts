import { describe, expect, it } from 'vitest';

import type { Database } from './db.js';
import { createLocalCoverWorkflowManager, LocalCoverWorkflowError, normalizeCoverFilename } from './localCoverWorkflow.js';

describe('local cover workflow', () => {
  it('normalizes cover filenames from Spanish normalized names first', () => {
    expect(
      normalizeCoverFilename({
        canonical_name: 'Don\'t Get Got',
        canonical_name_es: 'No Te Pilles',
        normalized_name: 'dont get got',
        normalized_name_es: 'No Te Pilles: Edicion Espanola'
      })
    ).toBe('notepillesedicionespanola.webp');
  });

  it('starts a workflow, waits for the Spanish edited file, uploads it, and updates image_url_es', async () => {
    const calls: string[] = [];
    let releaseEditedFile: (() => void) | null = null;
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (sql.includes('from store_items')) {
          return {
            rows: [
              {
                canonical_name: 'Don\'t Get Got',
                canonical_name_es: '',
                image_url_es: '',
                item_id: 77,
                normalized_name: 'dont get got',
                normalized_name_es: '',
                store_item_id: 123,
                source_image_url: 'https://store.example/dontgetgot-box.jpg'
              }
            ]
          };
        }
        if (sql.includes('update items')) {
          return {
            rows: [
              {
                id: 77,
                image_url_es: params?.[0]
              }
            ]
          };
        }
        return { rows: [] };
      }
    };
    const manager = createLocalCoverWorkflowManager(database, {
      config: {
        publicBaseUrl: 'https://ludora.s3.us-east-2.amazonaws.com',
        s3Bucket: 'ludora',
        s3Prefix: 'boardgame',
        workDir: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame'
      },
      downloadFile: async (url, destination) => {
        calls.push(`download:${url}:${destination}`);
      },
      openEditor: async (sourcePath) => {
        calls.push(`open:${sourcePath}`);
      },
      uploadFile: async (filePath, upload) => {
        calls.push(`upload:${filePath}:${upload.bucket}:${upload.key}:${upload.contentType}`);
      },
      waitForFile: async (expectedPaths) =>
        new Promise<string>((resolve) => {
          expect(expectedPaths).toEqual([
            'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.en.webp',
            'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.es.webp'
          ]);
          releaseEditedFile = () => {
            resolve(expectedPaths[1]);
          };
        })
    });

    const started = await manager.start(123);

    expect(started).toMatchObject({
      expected_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.es.webp',
      expected_paths: [
        'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.en.webp',
        'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.es.webp'
      ],
      filename: 'dontgetgot.es.webp',
      item_id: 77,
      public_url: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/dontgetgot.es.webp',
      source_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.source.jpg',
      status: 'waiting_for_edit',
      store_item_id: 123
    });
    expect(calls).toEqual([
      'download:https://store.example/dontgetgot-box.jpg:C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.source.jpg',
      'open:C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.source.jpg'
    ]);

    releaseEditedFile?.();
    await manager.waitForIdle();

    expect(manager.getCurrent()).toMatchObject({
      status: 'completed',
      public_url: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/dontgetgot.es.webp',
      target_field: 'image_url_es'
    });
    expect(calls).toContain(
      'upload:C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.es.webp:ludora:boardgame/dontgetgot.es.webp:image/webp'
    );
    expect(
      queries.some(
        (query) =>
          query.sql.includes('update items') &&
          query.sql.includes('image_url_es = $1') &&
          query.params?.[0] === 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/dontgetgot.es.webp'
      )
    ).toBe(true);
  });

  it('updates image_url when the English edited file is saved', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const calls: string[] = [];
    let releaseEditedFile: (() => void) | null = null;
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (sql.includes('from store_items')) {
          return {
            rows: [
              {
                canonical_name: 'Drunk Stoned or Stupid',
                canonical_name_es: '',
                image_url_es: '',
                item_id: 81,
                normalized_name: 'drunkstonedorstupidapartygame',
                normalized_name_es: '',
                store_item_id: 456,
                source_image_url: 'https://store.example/drunkstonedorstupidapartygame.png'
              }
            ]
          };
        }
        return { rows: [{ id: 81, image_url: params?.[0] }] };
      }
    };
    const manager = createLocalCoverWorkflowManager(database, {
      config: {
        publicBaseUrl: 'https://ludora.s3.us-east-2.amazonaws.com',
        s3Bucket: 'ludora',
        s3Prefix: 'boardgame',
        workDir: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame'
      },
      downloadFile: async () => undefined,
      openEditor: async () => undefined,
      uploadFile: async (filePath, upload) => {
        calls.push(`upload:${filePath}:${upload.key}`);
      },
      waitForFile: async (expectedPaths) =>
        new Promise<string>((resolve) => {
          releaseEditedFile = () => {
            resolve(expectedPaths[0]);
          };
        })
    });

    const started = await manager.start(456);

    expect(started).toMatchObject({
      expected_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\drunkstonedorstupidapartygame.es.webp',
      expected_paths: [
        'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\drunkstonedorstupidapartygame.en.webp',
        'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\drunkstonedorstupidapartygame.es.webp'
      ],
      filename: 'drunkstonedorstupidapartygame.es.webp',
      source_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\drunkstonedorstupidapartygame.source.png'
    });
    releaseEditedFile?.();
    await manager.waitForIdle();

    expect(manager.getCurrent()).toMatchObject({
      filename: 'drunkstonedorstupidapartygame.en.webp',
      public_url: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/drunkstonedorstupidapartygame.en.webp',
      status: 'completed',
      target_field: 'image_url'
    });
    expect(calls).toEqual([
      'upload:C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\drunkstonedorstupidapartygame.en.webp:boardgame/drunkstonedorstupidapartygame.en.webp'
    ]);
    expect(
      queries.some(
        (query) =>
          query.sql.includes('update items') &&
          query.sql.includes('image_url = $1') &&
          query.params?.[0] === 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/drunkstonedorstupidapartygame.en.webp'
      )
    ).toBe(true);
  });

  it('starts a workflow from an item image and updates the same item', async () => {
    const calls: string[] = [];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    let releaseEditedFile: (() => void) | null = null;
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (sql.includes('from items')) {
          return {
            rows: [
              {
                canonical_name: 'Coffee Rush',
                canonical_name_es: '',
                image_url_es: '',
                item_id: 77,
                normalized_name: 'coffee rush',
                normalized_name_es: '',
                source_image_url: 'https://cf.geekdo-images.com/coffee-rush.jpg'
              }
            ]
          };
        }
        if (sql.includes('update items')) {
          return { rows: [{ id: 77, image_url_es: params?.[0] }] };
        }
        return { rows: [] };
      }
    };
    const manager = createLocalCoverWorkflowManager(database, {
      config: {
        publicBaseUrl: 'https://ludora.s3.us-east-2.amazonaws.com',
        s3Bucket: 'ludora',
        s3Prefix: 'boardgame',
        workDir: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame'
      },
      downloadFile: async (url, destination) => {
        calls.push(`download:${url}:${destination}`);
      },
      openEditor: async (sourcePath) => {
        calls.push(`open:${sourcePath}`);
      },
      uploadFile: async (filePath, upload) => {
        calls.push(`upload:${filePath}:${upload.key}`);
      },
      waitForFile: async (expectedPaths) =>
        new Promise<string>((resolve) => {
          releaseEditedFile = () => {
            resolve(expectedPaths[1]);
          };
        })
    });

    const started = await manager.startFromItem(77);

    expect(started).toMatchObject({
      expected_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.es.webp',
      expected_paths: [
        'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.en.webp',
        'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.es.webp'
      ],
      filename: 'coffeerush.es.webp',
      item_id: 77,
      source_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.source.jpg',
      status: 'waiting_for_edit',
      store_item_id: null,
      workflow_id: 'cover-item-77'
    });
    expect(calls).toEqual([
      'download:https://cf.geekdo-images.com/coffee-rush.jpg:C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.source.jpg',
      'open:C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.source.jpg'
    ]);

    releaseEditedFile?.();
    await manager.waitForIdle();

    expect(manager.getCurrent()).toMatchObject({
      public_url: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/coffeerush.es.webp',
      status: 'completed',
      target_field: 'image_url_es'
    });
    expect(calls).toContain(
      'upload:C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.es.webp:boardgame/coffeerush.es.webp'
    );
    expect(
      queries.some(
        (query) =>
          query.sql.includes('update items') &&
          query.sql.includes('image_url_es = $1') &&
          query.params?.[0] === 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/coffeerush.es.webp' &&
          query.params?.[1] === 77
      )
    ).toBe(true);
  });

  it('rejects a second workflow while one is active', async () => {
    const database = databaseWithStoreItem({
      canonical_name: 'Azul',
      item_id: 7,
      normalized_name: 'azul',
      store_item_id: 20,
      source_image_url: 'https://store.example/azul.jpg'
    });
    const manager = createLocalCoverWorkflowManager(database, {
      downloadFile: async () => undefined,
      openEditor: async () => undefined,
      uploadFile: async () => undefined,
      waitForFile: async () => new Promise<void>(() => undefined)
    });

    await manager.start(20);

    await expect(manager.start(21)).rejects.toMatchObject({
      status: 409
    });
  });

  it('rejects store items without a linked item', async () => {
    const manager = createLocalCoverWorkflowManager(
      databaseWithStoreItem({
        canonical_name: '',
        item_id: null,
        normalized_name: '',
        store_item_id: 20,
        source_image_url: 'https://store.example/azul.jpg'
      }),
      {
        downloadFile: async () => undefined,
        openEditor: async () => undefined,
        uploadFile: async () => undefined,
        waitForFile: async () => undefined
      }
    );

    await expect(manager.start(20)).rejects.toBeInstanceOf(LocalCoverWorkflowError);
    await expect(manager.start(20)).rejects.toMatchObject({
      message: 'Store item must be linked to an item before starting a cover workflow.',
      status: 400
    });
  });
});

function databaseWithStoreItem(row: Record<string, unknown>): Database {
  return {
    query: async (sql) => {
      if (sql.includes('from store_items')) {
        return { rows: [row] };
      }
      return { rows: [] };
    }
  };
}
