import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CoverFlatteningWorkflowError,
  createCoverFlatteningWorkflowManager,
  type CoverFlatteningWorkflowDependencies
} from './coverFlatteningWorkflow.js';
import type { Database } from './db.js';

describe('cover flattening workflow', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  });

  it('flattens a linked store item and accepts a versioned WebP candidate for image_url_es', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ludora-cover-flattening-'));
    temporaryDirectories.push(root);
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const uploads: Array<{ bytes: number; key: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (sql.includes('from store_items')) {
          return {
            rows: [
              {
                canonical_name: 'Coffee Rush',
                item_id: 77,
                normalized_name: 'coffee rush',
                source_url: 'https://store.example/coffee-rush-box.png',
                store_item_id: 3365
              }
            ]
          };
        }
        return { rows: [{ id: 77 }] };
      }
    };
    const dependencies = fakeDependencies(root, {
      optimizeImage: async () => Buffer.alloc(90_000),
      uploadImage: async (image, upload) => {
        uploads.push({ bytes: image.length, key: upload.key });
      }
    });
    const manager = createCoverFlatteningWorkflowManager(database, dependencies);

    const workflow = await manager.startFromStoreItem(3365);

    expect(workflow).toMatchObject({
      item_id: 77,
      perspective: 'three_faces',
      source_field: 'store_item_image',
      store_item_id: 3365,
      workflow_id: 'workflow-test'
    });
    expect(workflow.candidates).toHaveLength(2);
    expect(await readFile(await manager.getCandidateFile(workflow.workflow_id, 1), 'utf8')).toBe('candidate-1');

    const accepted = await manager.accept(workflow.workflow_id, 1, 'image_url_es');

    expect(accepted).toMatchObject({
      item_id: 77,
      optimized_size_bytes: 90_000,
      target_field: 'image_url_es'
    });
    expect(accepted.s3_key).toMatch(/^boardgame\/77-coffeerush\.es\.[a-f0-9]{12}\.webp$/);
    expect(accepted.public_url).toBe(`https://cdn.example/${accepted.s3_key}`);
    expect(uploads).toEqual([{ bytes: 90_000, key: accepted.s3_key }]);
    const update = queries.find((query) => query.sql.includes('update items'));
    expect(normalizeSql(update?.sql ?? '')).toContain('set image_url_es = $1');
    expect(update?.params).toEqual([accepted.public_url, 77]);
    await expect(manager.getCandidateFile(workflow.workflow_id, 1)).rejects.toMatchObject({ status: 404 });
  });

  it('uses the selected item image field as the source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ludora-cover-flattening-'));
    temporaryDirectories.push(root);
    const downloads: string[] = [];
    const database: Database = {
      query: async (sql) => ({
        rows: sql.includes('from items i')
          ? [
              {
                canonical_name: 'Coffee Rush',
                image_url: 'https://example.com/english.jpg',
                image_url_es: 'https://example.com/spanish.jpg',
                item_id: 77
              }
            ]
          : []
      })
    };
    const dependencies = fakeDependencies(root, {
      downloadImage: async (url) => {
        downloads.push(url);
        return Buffer.from('source');
      }
    });
    const manager = createCoverFlatteningWorkflowManager(database, dependencies);

    const workflow = await manager.startFromItem(77, 'image_url_es');

    expect(downloads).toEqual(['https://example.com/spanish.jpg']);
    expect(workflow.source_field).toBe('image_url_es');
    expect(workflow.store_item_id).toBeNull();
  });

  it('rejects an unlinked store item before downloading', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ludora-cover-flattening-'));
    temporaryDirectories.push(root);
    const database: Database = {
      query: async () => ({ rows: [{ item_id: null, source_url: 'https://example.com/box.jpg' }] })
    };
    const manager = createCoverFlatteningWorkflowManager(database, fakeDependencies(root));

    await expect(manager.startFromStoreItem(10)).rejects.toEqual(
      new CoverFlatteningWorkflowError('Store item must be linked to an item before flattening its cover.', 400)
    );
  });

  it('refuses to upload a candidate that is not strictly below 100 KB', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ludora-cover-flattening-'));
    temporaryDirectories.push(root);
    const database: Database = {
      query: async (sql) => ({
        rows: sql.includes('from items i')
          ? [{ canonical_name: 'Square Game', image_url: 'https://example.com/square.jpg', item_id: 8 }]
          : []
      })
    };
    const manager = createCoverFlatteningWorkflowManager(
      database,
      fakeDependencies(root, { optimizeImage: async () => Buffer.alloc(100 * 1024) })
    );
    const workflow = await manager.startFromItem(8, 'image_url');

    await expect(manager.accept(workflow.workflow_id, 1, 'image_url')).rejects.toMatchObject({
      message: 'Flattened cover could not be reduced below 100 KB.',
      status: 422
    });
  });
});

function fakeDependencies(
  root: string,
  overrides: Partial<CoverFlatteningWorkflowDependencies> = {}
): CoverFlatteningWorkflowDependencies {
  const config = {
    publicBaseUrl: 'https://cdn.example',
    s3Bucket: 'ludora',
    s3Prefix: 'boardgame',
    s3Region: 'us-east-2',
    workDir: root
  };
  return {
    config,
    createId: () => 'workflow-test',
    downloadImage: async () => Buffer.from('source'),
    now: () => new Date('2026-07-11T12:00:00.000Z'),
    optimizeImage: async () => Buffer.alloc(80_000),
    removeDirectory: async (directory) => rm(directory, { force: true, recursive: true }),
    runFlattening: async (_sourcePath, outputDir) => {
      const candidate1 = path.join(outputDir, 'flattened-cover-1.png');
      const candidate2 = path.join(outputDir, 'flattened-cover-2.png');
      await writeFile(candidate1, 'candidate-1');
      await writeFile(candidate2, 'candidate-2');
      return {
        detection: { perspective: { kind: 'three_faces' } },
        flattened_covers: [
          {
            candidate_index: 1,
            construction: 'candidate one',
            geometry: { aspect_ratio: 1, height: 500, square_snapped: true, width: 500 },
            output_path: candidate1
          },
          {
            candidate_index: 2,
            construction: 'candidate two',
            geometry: { aspect_ratio: 0.7, height: 700, square_snapped: false, width: 490 },
            output_path: candidate2
          }
        ]
      };
    },
    ttlMs: 30 * 60 * 1000,
    uploadImage: async () => undefined,
    writeSource: async (destination, image) => {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, image);
    },
    ...overrides,
    config: { ...config, ...(overrides.config ?? {}) }
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
