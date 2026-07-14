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
      automatic_error: null,
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

  it('applies the reviewer-selected aspect ratio before WebP optimization', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ludora-cover-flattening-'));
    temporaryDirectories.push(root);
    const resizeCalls: Array<{ height: number; width: number }> = [];
    const optimizedInputs: string[] = [];
    const database: Database = {
      query: async (sql) => ({
        rows: sql.includes('from items i')
          ? [{ canonical_name: 'Coffee Rush', image_url: 'https://example.com/box.jpg', item_id: 77 }]
          : [{ id: 77 }]
      })
    };
    const manager = createCoverFlatteningWorkflowManager(
      database,
      fakeDependencies(root, {
        optimizeImage: async (image) => {
          optimizedInputs.push(image.toString('utf8'));
          return Buffer.alloc(80_000);
        },
        resizeImage: async (_image, dimensions) => {
          resizeCalls.push(dimensions);
          return Buffer.from('resized-square');
        }
      })
    );
    const workflow = await manager.startFromItem(77, 'image_url');

    const accepted = await manager.accept(workflow.workflow_id, 2, 'image_url', 1);

    expect(resizeCalls).toEqual([{ height: 700, width: 700 }]);
    expect(optimizedInputs).toEqual(['resized-square']);
    expect(accepted.output_aspect_ratio).toBe(1);
  });

  it('creates, replaces, and accepts a manual candidate from normalized source points', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ludora-cover-flattening-'));
    temporaryDirectories.push(root);
    const manualCalls: Array<{ points: Array<{ x: number; y: number }>; sourcePath: string }> = [];
    const optimizedInputs: string[] = [];
    let manualVersion = 0;
    const database: Database = {
      query: async (sql) => ({
        rows: sql.includes('from items i')
          ? [{ canonical_name: 'Manual Game', image_url: 'https://example.com/box.jpg', item_id: 91 }]
          : [{ id: 91 }]
      })
    };
    const manager = createCoverFlatteningWorkflowManager(
      database,
      fakeDependencies(root, {
        optimizeImage: async (image) => {
          optimizedInputs.push(image.toString('utf8'));
          return Buffer.alloc(75_000);
        },
        runManualFlattening: async (sourcePath, outputDir, points) => {
          manualCalls.push({ points, sourcePath });
          manualVersion += 1;
          const candidate = path.join(outputDir, 'flattened-cover-manual.png');
          await writeFile(candidate, `manual-${manualVersion}`);
          return {
            flattened_covers: [
              {
                candidate_index: 3,
                construction: 'manual corner selection',
                geometry: { aspect_ratio: 1.25, height: 400, square_snapped: false, width: 500 },
                output_path: candidate
              }
            ]
          };
        }
      })
    );
    const workflow = await manager.startFromItem(91, 'image_url');
    const points = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 }
    ];

    expect(await readFile(await manager.getSourceFile(workflow.workflow_id), 'utf8')).toBe('source');
    const firstManual = await manager.createManualCandidate(workflow.workflow_id, points);
    const secondManual = await manager.createManualCandidate(workflow.workflow_id, points);

    expect(firstManual.candidates.map((candidate) => candidate.index)).toEqual([1, 2, 3]);
    expect(secondManual.candidates.map((candidate) => candidate.index)).toEqual([1, 2, 3]);
    expect(secondManual.candidates[2]).toMatchObject({
      construction: 'manual corner selection',
      height: 400,
      index: 3,
      width: 500
    });
    expect(manualCalls).toHaveLength(2);
    expect(manualCalls[0]?.points).toEqual(points);
    expect(manualCalls[0]?.sourcePath).toBe(await manager.getSourceFile(workflow.workflow_id));
    expect(await readFile(await manager.getCandidateFile(workflow.workflow_id, 3), 'utf8')).toBe('manual-2');

    const accepted = await manager.accept(workflow.workflow_id, 3, 'image_url');

    expect(accepted).toMatchObject({ item_id: 91, output_aspect_ratio: 1.25, target_field: 'image_url' });
    expect(optimizedInputs).toEqual(['manual-2']);
  });

  it('preserves the source in a manual-only workflow when automatic flattening returns no candidates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ludora-cover-flattening-'));
    temporaryDirectories.push(root);
    const removedDirectories: string[] = [];
    const database: Database = {
      query: async (sql) => ({
        rows: sql.includes('from items i')
          ? [{ canonical_name: 'Manual Fallback', image_url: 'https://example.com/box.jpg', item_id: 92 }]
          : []
      })
    };
    const manager = createCoverFlatteningWorkflowManager(
      database,
      fakeDependencies(root, {
        removeDirectory: async (directory) => {
          removedDirectories.push(directory);
          await rm(directory, { force: true, recursive: true });
        },
        runFlattening: async () => ({
          detection: { perspective: { kind: 'two_faces' } },
          flattened_covers: []
        })
      })
    );

    const workflow = await manager.startFromItem(92, 'image_url');

    expect(workflow).toMatchObject({
      automatic_error: 'Flattening must return one or two cover candidates.',
      candidates: [],
      item_id: 92,
      perspective: null,
      workflow_id: 'workflow-test'
    });
    expect(removedDirectories).toEqual([]);
    expect(await readFile(await manager.getSourceFile(workflow.workflow_id), 'utf8')).toBe('source');
    await expect(manager.getCandidateFile(workflow.workflow_id, 1)).rejects.toMatchObject({ status: 404 });

    const manualWorkflow = await manager.createManualCandidate(workflow.workflow_id, [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 }
    ]);

    expect(manualWorkflow.automatic_error).toBe('Flattening must return one or two cover candidates.');
    expect(manualWorkflow.candidates.map((candidate) => candidate.index)).toEqual([3]);
    await manager.cancel(workflow.workflow_id);
    expect(removedDirectories).toEqual([path.join(root, 'workflow-test')]);
  });

  it('does not expose partially parsed candidates when automatic perspective metadata is invalid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ludora-cover-flattening-'));
    temporaryDirectories.push(root);
    const database: Database = {
      query: async () => ({
        rows: [{ canonical_name: 'Unknown Perspective', image_url: 'https://example.com/box.jpg', item_id: 95 }]
      })
    };
    const manager = createCoverFlatteningWorkflowManager(
      database,
      fakeDependencies(root, {
        runFlattening: async (_sourcePath, outputDir) => {
          const candidate = path.join(outputDir, 'flattened-cover-1.png');
          await writeFile(candidate, 'candidate-1');
          return {
            detection: { perspective: { kind: 'unknown' } },
            flattened_covers: [
              {
                candidate_index: 1,
                construction: 'candidate one',
                geometry: { aspect_ratio: 1, height: 500, square_snapped: true, width: 500 },
                output_path: candidate
              }
            ]
          };
        }
      })
    );

    const workflow = await manager.startFromItem(95, 'image_url');

    expect(workflow).toMatchObject({
      automatic_error: 'Flattening returned an unknown perspective.',
      candidates: [],
      perspective: null
    });
    expect(await readFile(await manager.getSourceFile(workflow.workflow_id), 'utf8')).toBe('source');
    await expect(manager.getCandidateFile(workflow.workflow_id, 1)).rejects.toMatchObject({ status: 404 });
  });

  it('cleans up and fails when the source download fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ludora-cover-flattening-'));
    temporaryDirectories.push(root);
    const removedDirectories: string[] = [];
    let automaticCalls = 0;
    const database: Database = {
      query: async () => ({
        rows: [{ canonical_name: 'Download Failure', image_url: 'https://example.com/box.jpg', item_id: 93 }]
      })
    };
    const manager = createCoverFlatteningWorkflowManager(
      database,
      fakeDependencies(root, {
        downloadImage: async () => {
          throw new Error('Source download failed.');
        },
        removeDirectory: async (directory) => {
          removedDirectories.push(directory);
          await rm(directory, { force: true, recursive: true });
        },
        runFlattening: async () => {
          automaticCalls += 1;
          throw new Error('should not run');
        }
      })
    );

    await expect(manager.startFromItem(93, 'image_url')).rejects.toMatchObject({
      message: 'Source download failed.',
      status: 422
    });
    expect(automaticCalls).toBe(0);
    expect(removedDirectories).toEqual([path.join(root, 'workflow-test')]);
  });

  it('cleans up and fails when storing the source fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ludora-cover-flattening-'));
    temporaryDirectories.push(root);
    const removedDirectories: string[] = [];
    let automaticCalls = 0;
    const database: Database = {
      query: async () => ({
        rows: [{ canonical_name: 'Write Failure', image_url: 'https://example.com/box.jpg', item_id: 94 }]
      })
    };
    const manager = createCoverFlatteningWorkflowManager(
      database,
      fakeDependencies(root, {
        removeDirectory: async (directory) => {
          removedDirectories.push(directory);
          await rm(directory, { force: true, recursive: true });
        },
        runFlattening: async () => {
          automaticCalls += 1;
          throw new Error('should not run');
        },
        writeSource: async (destination, image) => {
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, image);
          throw new Error('Source write failed.');
        }
      })
    );

    await expect(manager.startFromItem(94, 'image_url')).rejects.toMatchObject({
      message: 'Source write failed.',
      status: 422
    });
    expect(automaticCalls).toBe(0);
    expect(removedDirectories).toEqual([path.join(root, 'workflow-test')]);
    await expect(readFile(path.join(root, 'workflow-test', 'source.jpg'))).rejects.toBeDefined();
  });

  it('rejects malformed normalized points before manual flattening and preserves the workflow', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ludora-cover-flattening-'));
    temporaryDirectories.push(root);
    let manualCalls = 0;
    const database: Database = {
      query: async (sql) => ({
        rows: sql.includes('from items i')
          ? [{ canonical_name: 'Manual Game', image_url: 'https://example.com/box.jpg', item_id: 91 }]
          : []
      })
    };
    const manager = createCoverFlatteningWorkflowManager(
      database,
      fakeDependencies(root, {
        runManualFlattening: async () => {
          manualCalls += 1;
          throw new Error('should not run');
        }
      })
    );
    const workflow = await manager.startFromItem(91, 'image_url');

    await expect(
      manager.createManualCandidate(workflow.workflow_id, [
        { x: 0.1, y: 0.1 },
        { x: 1.1, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 }
      ])
    ).rejects.toMatchObject({ status: 400 });

    expect(manualCalls).toBe(0);
    expect(await readFile(await manager.getCandidateFile(workflow.workflow_id, 1), 'utf8')).toBe('candidate-1');
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
    resizeImage: async (image) => image,
    runManualFlattening: async (_sourcePath, outputDir) => {
      const candidate = path.join(outputDir, 'flattened-cover-manual.png');
      await writeFile(candidate, 'manual-candidate');
      return {
        flattened_covers: [
          {
            candidate_index: 3,
            construction: 'manual corner selection',
            geometry: { aspect_ratio: 1.2, height: 500, square_snapped: false, width: 600 },
            output_path: candidate
          }
        ]
      };
    },
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
