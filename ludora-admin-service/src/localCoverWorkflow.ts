import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';

import type { Database } from './db.js';

export type LocalCoverWorkflowStatus = 'waiting_for_edit' | 'uploading' | 'completed' | 'failed';
export type LocalCoverWorkflowTargetField = 'image_url' | 'image_url_es';

export type LocalCoverWorkflowState = {
  error: string | null;
  expected_path: string;
  expected_paths: string[];
  filename: string;
  item_id: number;
  public_url: string;
  source_path: string;
  status: LocalCoverWorkflowStatus;
  store_item_id: number | null;
  target_field: LocalCoverWorkflowTargetField | null;
  workflow_id: string;
};

export type CoverItemNames = {
  canonical_name?: string | null;
  canonical_name_es?: string | null;
  normalized_name?: string | null;
  normalized_name_es?: string | null;
};

export type LocalCoverWorkflowConfig = {
  publicBaseUrl: string;
  s3Bucket: string;
  s3Prefix: string;
  s3Region: string;
  workDir: string;
};

export type LocalCoverWorkflowRuntimeConfig = LocalCoverWorkflowConfig & {
  gimpPath: string;
  pollIntervalMs?: number;
};

export type LocalCoverWorkflowUpload = {
  bucket: string;
  contentType: string;
  key: string;
};

export type LocalCoverWorkflowDependencies = {
  config?: Partial<LocalCoverWorkflowConfig>;
  downloadFile(sourceUrl: string, destinationPath: string): Promise<void>;
  openEditor(sourcePath: string): Promise<void> | void;
  uploadFile(filePath: string, upload: LocalCoverWorkflowUpload): Promise<void>;
  waitForFile(expectedPaths: string[]): Promise<string>;
};

type CoverWorkflowSourceRow = CoverItemNames & {
  image_url_es?: string | null;
  item_id?: number | string | null;
  source_image_url?: string | null;
  store_item_id?: number | string | null;
};

const defaultConfig: LocalCoverWorkflowConfig = {
  publicBaseUrl: 'https://ludora.s3.us-east-2.amazonaws.com',
  s3Bucket: 'ludora',
  s3Prefix: 'boardgame',
  s3Region: 'us-east-2',
  workDir: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame'
};

export class LocalCoverWorkflowError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export type LocalCoverWorkflowManager = {
  getCurrent(): LocalCoverWorkflowState | null;
  start(storeItemId: number): Promise<LocalCoverWorkflowState>;
  startFromItem(itemId: number): Promise<LocalCoverWorkflowState>;
  waitForIdle(): Promise<void>;
};

export function createLocalCoverWorkflowManager(
  database: Database,
  dependencies: LocalCoverWorkflowDependencies
): LocalCoverWorkflowManager {
  const config = { ...defaultConfig, ...dependencies.config };
  let current: LocalCoverWorkflowState | null = null;
  let activeCompletion: Promise<void> | null = null;

  function assertIdle(): void {
    if (current && current.status !== 'completed' && current.status !== 'failed') {
      throw new LocalCoverWorkflowError('A local cover workflow is already active.', 409);
    }
  }

  async function start(storeItemId: number): Promise<LocalCoverWorkflowState> {
    assertIdle();
    const row = await loadStoreItemCoverRow(database, storeItemId);
    validateStoreItemCoverRow(row);

    return startFromSource({
      itemId: Number(row.item_id),
      sourceImageUrl: row.source_image_url,
      storeItemId,
      workflowId: `cover-${storeItemId}-${Number(row.item_id)}`,
      row
    });
  }

  async function startFromItem(itemId: number): Promise<LocalCoverWorkflowState> {
    assertIdle();
    const row = await loadItemCoverRow(database, itemId);
    validateItemCoverRow(row);

    return startFromSource({
      itemId: Number(row.item_id),
      sourceImageUrl: row.source_image_url,
      storeItemId: null,
      workflowId: `cover-item-${Number(row.item_id)}`,
      row
    });
  }

  async function startFromSource({
    itemId,
    row,
    sourceImageUrl,
    storeItemId,
    workflowId
  }: {
    itemId: number;
    row: CoverItemNames;
    sourceImageUrl: string;
    storeItemId: number | null;
    workflowId: string;
  }): Promise<LocalCoverWorkflowState> {
    assertIdle();

    const baseFilename = normalizeCoverFilename(row).replace(/\.webp$/i, '');
    const englishFilename = `${baseFilename}.en.webp`;
    const spanishFilename = `${baseFilename}.es.webp`;
    const sourceExtension = imageExtensionFromUrl(sourceImageUrl);
    const workPath = configuredPathApi(config.workDir);
    const sourcePath = workPath.join(config.workDir, `${baseFilename}.source${sourceExtension}`);
    const expectedPaths = [
      workPath.join(config.workDir, englishFilename),
      workPath.join(config.workDir, spanishFilename)
    ];
    const expectedPath = expectedPaths[1];
    const s3Key = keyFor(config.s3Prefix, spanishFilename);
    const publicUrl = publicUrlFor(config.publicBaseUrl, s3Key);

    await dependencies.downloadFile(sourceImageUrl, sourcePath);
    await dependencies.openEditor(sourcePath);

    current = {
      error: null,
      expected_path: expectedPath,
      expected_paths: expectedPaths,
      filename: spanishFilename,
      item_id: itemId,
      public_url: publicUrl,
      source_path: sourcePath,
      status: 'waiting_for_edit',
      store_item_id: storeItemId,
      target_field: null,
      workflow_id: workflowId
    };

    activeCompletion = completeWhenEditedFileExists(database, dependencies, config, current);
    return current;
  }

  return {
    getCurrent: () => current,
    start,
    startFromItem,
    waitForIdle: async () => {
      await activeCompletion;
    }
  };
}

export function createNodeLocalCoverWorkflowDependencies(
  runtimeConfig: LocalCoverWorkflowRuntimeConfig
): LocalCoverWorkflowDependencies {
  const s3Client = new S3Client({ region: runtimeConfig.s3Region });
  return {
    config: runtimeConfig,
    downloadFile: (sourceUrl, destinationPath) => downloadFile(sourceUrl, destinationPath),
    openEditor: (sourcePath) => openGimp(runtimeConfig.gimpPath, sourcePath),
    uploadFile: async (filePath, upload) => {
      await s3Client.send(
        new PutObjectCommand({
          Body: createReadStream(filePath),
          Bucket: upload.bucket,
          ContentType: upload.contentType,
          Key: upload.key
        })
      );
    },
    waitForFile: (expectedPaths) => waitForStableFile(expectedPaths, runtimeConfig.pollIntervalMs ?? 1000)
  };
}

export function normalizeCoverFilename(names: CoverItemNames): string {
  const source =
    firstNonEmpty(names.normalized_name_es, names.normalized_name, names.canonical_name_es, names.canonical_name) ?? 'cover';
  const compact = source
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase();
  return `${compact || 'cover'}.webp`;
}

async function loadStoreItemCoverRow(database: Database, storeItemId: number): Promise<CoverWorkflowSourceRow | null> {
  const result = await database.query(
    `
    select
      si.id as store_item_id,
      si.image_url as source_image_url,
      si.item_id,
      i.canonical_name,
      i.normalized_name,
      i.canonical_name_es,
      i.normalized_name_es,
      i.image_url_es
    from store_items si
    left join items i on i.id = si.item_id
    where si.id = $1
    `,
    [storeItemId]
  );
  return (result.rows[0] as CoverWorkflowSourceRow | undefined) ?? null;
}

async function loadItemCoverRow(database: Database, itemId: number): Promise<CoverWorkflowSourceRow | null> {
  const result = await database.query(
    `
    select
      i.id as item_id,
      i.image_url as source_image_url,
      i.canonical_name,
      i.normalized_name,
      i.canonical_name_es,
      i.normalized_name_es,
      i.image_url_es
    from items i
    where i.id = $1
    `,
    [itemId]
  );
  return (result.rows[0] as CoverWorkflowSourceRow | undefined) ?? null;
}

function validateStoreItemCoverRow(row: CoverWorkflowSourceRow | null): asserts row is CoverWorkflowSourceRow & {
  item_id: number | string;
  source_image_url: string;
} {
  if (!row) {
    throw new LocalCoverWorkflowError('Store item not found.', 404);
  }
  if (!row.item_id) {
    throw new LocalCoverWorkflowError('Store item must be linked to an item before starting a cover workflow.', 400);
  }
  if (!row.source_image_url?.trim()) {
    throw new LocalCoverWorkflowError('Store item must have an image URL before starting a cover workflow.', 400);
  }
}

function validateItemCoverRow(row: CoverWorkflowSourceRow | null): asserts row is CoverWorkflowSourceRow & {
  item_id: number | string;
  source_image_url: string;
} {
  if (!row) {
    throw new LocalCoverWorkflowError('Item not found.', 404);
  }
  if (!row.item_id) {
    throw new LocalCoverWorkflowError('Item not found.', 404);
  }
  if (!row.source_image_url?.trim()) {
    throw new LocalCoverWorkflowError('Item must have an image URL before starting a cover workflow.', 400);
  }
}

async function completeWhenEditedFileExists(
  database: Database,
  dependencies: LocalCoverWorkflowDependencies,
  config: LocalCoverWorkflowConfig,
  state: LocalCoverWorkflowState
): Promise<void> {
  try {
    const editedPath = await dependencies.waitForFile(state.expected_paths);
    const editedFilename = configuredPathApi(config.workDir).basename(editedPath);
    const targetField = targetFieldForEditedFilename(editedFilename);
    const s3Key = keyFor(config.s3Prefix, editedFilename);
    const publicUrl = publicUrlFor(config.publicBaseUrl, s3Key);

    state.expected_path = editedPath;
    state.filename = editedFilename;
    state.public_url = publicUrl;
    state.target_field = targetField;
    state.status = 'uploading';
    await dependencies.uploadFile(editedPath, {
      bucket: config.s3Bucket,
      contentType: 'image/webp',
      key: s3Key
    });
    await updateItemImageUrl(database, state.item_id, targetField, publicUrl);
    state.status = 'completed';
  } catch (error) {
    state.status = 'failed';
    state.error = error instanceof Error ? error.message : 'Local cover workflow failed.';
  }
}

function targetFieldForEditedFilename(filename: string): LocalCoverWorkflowTargetField {
  if (/\.en\.webp$/i.test(filename)) {
    return 'image_url';
  }
  if (/\.es\.webp$/i.test(filename)) {
    return 'image_url_es';
  }
  throw new Error(`Edited cover filename must end with .en.webp or .es.webp: ${filename}`);
}

async function updateItemImageUrl(
  database: Database,
  itemId: number,
  targetField: LocalCoverWorkflowTargetField,
  publicUrl: string
): Promise<void> {
  const column = targetField === 'image_url' ? 'image_url' : 'image_url_es';
  await database.query(
    `
    update items
    set ${column} = $1,
        updated_at = now()
    where id = $2
    returning id, ${column}
    `,
    [publicUrl, itemId]
  );
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  return values.map((value) => value?.trim()).find(Boolean) ?? null;
}

function imageExtensionFromUrl(imageUrl: string): string {
  try {
    const extension = path.extname(new URL(imageUrl).pathname).toLowerCase();
    return extension || '.jpg';
  } catch {
    return '.jpg';
  }
}

function keyFor(prefix: string, filename: string): string {
  const cleanPrefix = prefix.trim().replace(/^\/+|\/+$/g, '');
  return cleanPrefix ? `${cleanPrefix}/${filename}` : filename;
}

function publicUrlFor(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function configuredPathApi(root: string): path.PlatformPath {
  return /^[A-Za-z]:[\\/]/.test(root) ? path.win32 : path;
}

async function downloadFile(sourceUrl: string, destinationPath: string): Promise<void> {
  const response = await fetch(sourceUrl, {
    headers: {
      'User-Agent': 'LudoraAdminCoverWorkflow/1.0'
    }
  });
  if (!response.ok) {
    throw new Error(`Could not download source image: ${response.status} ${response.statusText}`);
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, Buffer.from(await response.arrayBuffer()));
}

function openGimp(gimpPath: string, sourcePath: string): void {
  const child = execFile(gimpPath, [sourcePath], {
    windowsHide: false
  });
  child.unref();
}

async function waitForStableFile(expectedPaths: string[], pollIntervalMs: number): Promise<string> {
  const lastSizes = new Map<string, number>();
  while (true) {
    for (const expectedPath of expectedPaths) {
      try {
        const fileStat = await stat(expectedPath);
        const lastSize = lastSizes.get(expectedPath) ?? -1;
        if (fileStat.isFile() && fileStat.size > 0 && fileStat.size === lastSize) {
          return expectedPath;
        }
        lastSizes.set(expectedPath, fileStat.size);
      } catch {
        lastSizes.delete(expectedPath);
      }
    }
    await delay(pollIntervalMs);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
