import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

import type { Database } from './db.js';
import {
  createNodeExternalCoverImageOptimizerDependencies,
  type CoverImageField,
  type CoverImageOptimizationUpload
} from './externalCoverImageOptimizer.js';
import { normalizeCoverFilename, type LocalCoverWorkflowConfig } from './localCoverWorkflow.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 100 * 1024;
const MAX_OUTPUT_DIMENSION = 800;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const MANUAL_CANDIDATE_INDEX = 3;

export type CoverFlatteningSourceField = CoverImageField;
export type CoverFlatteningTargetField = CoverImageField;

export type NormalizedCoverPoint = {
  x: number;
  y: number;
};

export type CoverFlatteningCandidate = {
  aspect_ratio: number;
  aspect_ratio_method: 'edge_average' | 'near_square' | 'vanishing_points';
  construction: string;
  height: number;
  index: number;
  square_snapped: boolean;
  vanishing_confidence: number;
  width: number;
};

export type CoverFlatteningWorkflow = {
  automatic_error: string | null;
  candidates: CoverFlatteningCandidate[];
  created_at: string;
  expires_at: string;
  item_id: number;
  perspective: 'two_faces' | 'three_faces' | null;
  source_field: CoverFlatteningSourceField | 'store_item_image';
  store_item_id: number | null;
  workflow_id: string;
};

export type AcceptedCoverFlattening = {
  item_id: number;
  optimized_size_bytes: number;
  output_aspect_ratio: number;
  public_url: string;
  s3_key: string;
  target_field: CoverFlatteningTargetField;
  trim_fraction: number;
};

type FlatteningCandidateFile = CoverFlatteningCandidate & {
  path: string;
};

type ManagedCoverFlatteningWorkflow = Omit<CoverFlatteningWorkflow, 'candidates'> & {
  candidates: FlatteningCandidateFile[];
  itemNames: CoverItemNames;
  outputDir: string;
  sourcePath: string;
};

type CoverItemNames = {
  canonical_name?: string | null;
  canonical_name_es?: string | null;
  normalized_name?: string | null;
  normalized_name_es?: string | null;
};

type StoreItemSourceRow = CoverItemNames & {
  item_id?: number | string | null;
  source_url?: string | null;
  store_item_id?: number | string | null;
};

type ItemSourceRow = CoverItemNames & {
  image_url?: string | null;
  image_url_es?: string | null;
  item_id?: number | string | null;
};

type FlatteningMetadata = {
  detection?: {
    perspective?: {
      kind?: string;
      mode?: string;
    };
  };
  flattened_covers?: Array<{
    candidate_index?: number;
    construction?: string;
    geometry?: {
      aspect_ratio?: number;
      aspect_ratio_method?: string;
      height?: number;
      square_snapped?: boolean;
      vanishing_confidence?: number;
      width?: number;
    };
    output_path?: string;
  }>;
};

export type CoverFlatteningWorkflowDependencies = {
  config: LocalCoverWorkflowConfig;
  cropImage(
    image: Buffer,
    dimensions: { height: number; left: number; top: number; width: number }
  ): Promise<Buffer>;
  createId?(): string;
  downloadImage(url: string): Promise<Buffer>;
  now?(): Date;
  optimizeImage(image: Buffer, options: { maxBytes: number; maxDimension: number }): Promise<Buffer>;
  resizeImage(image: Buffer, dimensions: { height: number; width: number }): Promise<Buffer>;
  removeDirectory(directory: string): Promise<void>;
  runManualFlattening(
    sourcePath: string,
    outputDir: string,
    points: NormalizedCoverPoint[]
  ): Promise<FlatteningMetadata>;
  runFlattening(sourcePath: string, outputDir: string): Promise<FlatteningMetadata>;
  uploadImage(image: Buffer, upload: CoverImageOptimizationUpload): Promise<void>;
  writeSource(path: string, image: Buffer): Promise<void>;
  ttlMs?: number;
};

export type CoverFlatteningWorkflowManager = {
  accept(
    workflowId: string,
    candidateIndex: number,
    targetField: CoverFlatteningTargetField,
    aspectRatio?: number | null,
    trimFraction?: number
  ): Promise<AcceptedCoverFlattening>;
  cancel(workflowId: string): Promise<void>;
  createManualCandidate(workflowId: string, points: NormalizedCoverPoint[]): Promise<CoverFlatteningWorkflow>;
  getCandidateFile(workflowId: string, candidateIndex: number): Promise<string>;
  getSourceFile(workflowId: string): Promise<string>;
  startFromItem(itemId: number, sourceField: CoverFlatteningSourceField): Promise<CoverFlatteningWorkflow>;
  startFromStoreItem(storeItemId: number): Promise<CoverFlatteningWorkflow>;
};

export class CoverFlatteningWorkflowError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export function createCoverFlatteningWorkflowManager(
  database: Database,
  dependencies: CoverFlatteningWorkflowDependencies
): CoverFlatteningWorkflowManager {
  const workflows = new Map<string, ManagedCoverFlatteningWorkflow>();
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const ttlMs = dependencies.ttlMs ?? DEFAULT_TTL_MS;

  async function startFromStoreItem(storeItemId: number): Promise<CoverFlatteningWorkflow> {
    await cleanupExpired();
    const row = await loadStoreItemSource(database, storeItemId);
    if (!row) {
      throw new CoverFlatteningWorkflowError('Store item not found.', 404);
    }
    if (!row.item_id) {
      throw new CoverFlatteningWorkflowError('Store item must be linked to an item before flattening its cover.', 400);
    }
    const sourceUrl = text(row.source_url);
    if (!sourceUrl) {
      throw new CoverFlatteningWorkflowError('Store item must have an image URL before flattening its cover.', 400);
    }
    return start({
      itemId: Number(row.item_id),
      itemNames: row,
      sourceField: 'store_item_image',
      sourceUrl,
      storeItemId
    });
  }

  async function startFromItem(
    itemId: number,
    sourceField: CoverFlatteningSourceField
  ): Promise<CoverFlatteningWorkflow> {
    await cleanupExpired();
    const row = await loadItemSource(database, itemId);
    if (!row) {
      throw new CoverFlatteningWorkflowError('Item not found.', 404);
    }
    const sourceUrl = text(row[sourceField]);
    if (!sourceUrl) {
      throw new CoverFlatteningWorkflowError(`Item ${sourceField} must have an image URL before flattening.`, 400);
    }
    return start({
      itemId,
      itemNames: row,
      sourceField,
      sourceUrl,
      storeItemId: null
    });
  }

  async function start({
    itemId,
    itemNames,
    sourceField,
    sourceUrl,
    storeItemId
  }: {
    itemId: number;
    itemNames: CoverItemNames;
    sourceField: CoverFlatteningWorkflow['source_field'];
    sourceUrl: string;
    storeItemId: number | null;
  }): Promise<CoverFlatteningWorkflow> {
    const workflowId = createId();
    const outputDir = configuredPathApi(dependencies.config.workDir).join(
      dependencies.config.workDir,
      workflowId
    );
    const sourcePath = configuredPathApi(outputDir).join(outputDir, `source${imageExtensionFromUrl(sourceUrl)}`);

    try {
      const sourceImage = await dependencies.downloadImage(sourceUrl);
      await dependencies.writeSource(sourcePath, sourceImage);
    } catch (error) {
      await dependencies.removeDirectory(outputDir);
      if (error instanceof CoverFlatteningWorkflowError) {
        throw error;
      }
      throw new CoverFlatteningWorkflowError(
        error instanceof Error ? error.message : 'Cover source image could not be stored.',
        422
      );
    }

    let automaticError: string | null = null;
    let candidates: FlatteningCandidateFile[] = [];
    let perspective: CoverFlatteningWorkflow['perspective'] = null;
    try {
      const metadata = await dependencies.runFlattening(sourcePath, outputDir);
      const parsedCandidates = parseCandidates(metadata);
      const parsedPerspective = parsePerspective(metadata);
      candidates = parsedCandidates;
      perspective = parsedPerspective;
    } catch (error) {
      automaticError = automaticFailureMessage(error);
    }

    const createdAt = now();
    const workflow: ManagedCoverFlatteningWorkflow = {
      automatic_error: automaticError,
      candidates,
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + ttlMs).toISOString(),
      item_id: itemId,
      itemNames,
      outputDir,
      perspective,
      source_field: sourceField,
      sourcePath,
      store_item_id: storeItemId,
      workflow_id: workflowId
    };
    workflows.set(workflowId, workflow);
    return publicWorkflow(workflow);
  }

  async function getCandidateFile(workflowId: string, candidateIndex: number): Promise<string> {
    await cleanupExpired();
    return candidateFor(workflowId, candidateIndex).path;
  }

  async function getSourceFile(workflowId: string): Promise<string> {
    await cleanupExpired();
    return workflowFor(workflowId).sourcePath;
  }

  async function createManualCandidate(
    workflowId: string,
    points: NormalizedCoverPoint[]
  ): Promise<CoverFlatteningWorkflow> {
    await cleanupExpired();
    const workflow = workflowFor(workflowId);
    const validatedPoints = validateNormalizedCoverPoints(points);
    try {
      const metadata = await dependencies.runManualFlattening(
        workflow.sourcePath,
        workflow.outputDir,
        validatedPoints
      );
      const candidates = parseCandidates(metadata);
      if (candidates.length !== 1 || candidates[0]?.index !== MANUAL_CANDIDATE_INDEX) {
        throw new CoverFlatteningWorkflowError('Manual flattening returned malformed candidate metadata.', 422);
      }
      workflow.candidates = [
        ...workflow.candidates.filter((candidate) => candidate.index !== MANUAL_CANDIDATE_INDEX),
        candidates[0]
      ].sort((first, second) => first.index - second.index);
      return publicWorkflow(workflow);
    } catch (error) {
      if (error instanceof CoverFlatteningWorkflowError) {
        throw error;
      }
      throw new CoverFlatteningWorkflowError(
        error instanceof Error ? error.message : 'Manual cover flattening failed.',
        422
      );
    }
  }

  async function accept(
    workflowId: string,
    candidateIndex: number,
    targetField: CoverFlatteningTargetField,
    aspectRatio: number | null = null,
    trimFraction = 0
  ): Promise<AcceptedCoverFlattening> {
    await cleanupExpired();
    const workflow = workflowFor(workflowId);
    const candidate = candidateFor(workflowId, candidateIndex);
    if (aspectRatio !== null && (!Number.isFinite(aspectRatio) || aspectRatio < 0.2 || aspectRatio > 5)) {
      throw new CoverFlatteningWorkflowError('Output aspect ratio must be between 0.2 and 5.', 400);
    }
    if (!Number.isFinite(trimFraction) || trimFraction < 0 || trimFraction >= 0.5) {
      throw new CoverFlatteningWorkflowError('Cover trim fraction must be between 0 and less than 0.5.', 400);
    }
    const candidateImage = await readFile(candidate.path);
    const trimX = trimPixels(candidate.width, trimFraction);
    const trimY = trimPixels(candidate.height, trimFraction);
    const trimmedWidth = candidate.width - (2 * trimX);
    const trimmedHeight = candidate.height - (2 * trimY);
    const trimmedImage = trimX || trimY
      ? await dependencies.cropImage(candidateImage, {
          height: trimmedHeight,
          left: trimX,
          top: trimY,
          width: trimmedWidth
        })
      : candidateImage;
    const outputAspectRatio = aspectRatio ?? (trimmedWidth / trimmedHeight);
    const sizedImage = aspectRatio === null
      ? trimmedImage
      : await dependencies.resizeImage(trimmedImage, {
          height: trimmedHeight,
          width: Math.max(2, Math.round(trimmedHeight * aspectRatio))
        });
    const optimized = await dependencies.optimizeImage(sizedImage, {
      maxBytes: MAX_OUTPUT_BYTES,
      maxDimension: MAX_OUTPUT_DIMENSION
    });
    if (optimized.length >= MAX_OUTPUT_BYTES) {
      throw new CoverFlatteningWorkflowError('Flattened cover could not be reduced below 100 KB.', 422);
    }

    const hash = createHash('sha256').update(optimized).digest('hex').slice(0, 12);
    const baseFilename = normalizeCoverFilename(workflow.itemNames).replace(/\.webp$/i, '');
    const language = targetField === 'image_url' ? 'en' : 'es';
    const filename = `${workflow.item_id}-${baseFilename}.${language}.${hash}.webp`;
    const s3Key = keyFor(dependencies.config.s3Prefix, filename);
    const publicUrl = publicUrlFor(dependencies.config.publicBaseUrl, s3Key);

    await dependencies.uploadImage(optimized, {
      bucket: dependencies.config.s3Bucket,
      cacheControl: CACHE_CONTROL,
      contentType: 'image/webp',
      key: s3Key
    });
    await updateItemImage(database, workflow.item_id, targetField, publicUrl);
    workflows.delete(workflowId);
    await dependencies.removeDirectory(workflow.outputDir);

    return {
      item_id: workflow.item_id,
      optimized_size_bytes: optimized.length,
      output_aspect_ratio: outputAspectRatio,
      public_url: publicUrl,
      s3_key: s3Key,
      target_field: targetField,
      trim_fraction: trimFraction
    };
  }

  async function cancel(workflowId: string): Promise<void> {
    await cleanupExpired();
    const workflow = workflowFor(workflowId);
    workflows.delete(workflowId);
    await dependencies.removeDirectory(workflow.outputDir);
  }

  async function cleanupExpired(): Promise<void> {
    const currentTime = now().getTime();
    const expired = [...workflows.values()].filter(
      (workflow) => new Date(workflow.expires_at).getTime() <= currentTime
    );
    for (const workflow of expired) {
      workflows.delete(workflow.workflow_id);
      await dependencies.removeDirectory(workflow.outputDir);
    }
  }

  return {
    accept,
    cancel,
    createManualCandidate,
    getCandidateFile,
    getSourceFile,
    startFromItem,
    startFromStoreItem
  };

  function workflowFor(workflowId: string): ManagedCoverFlatteningWorkflow {
    const workflow = workflows.get(workflowId);
    if (!workflow) {
      throw new CoverFlatteningWorkflowError('Cover flattening workflow not found or expired.', 404);
    }
    return workflow;
  }

  function candidateFor(workflowId: string, candidateIndex: number): FlatteningCandidateFile {
    const workflow = workflowFor(workflowId);
    const candidate = workflow.candidates.find((entry) => entry.index === candidateIndex);
    if (!candidate) {
      throw new CoverFlatteningWorkflowError('Cover candidate not found.', 404);
    }
    return candidate;
  }
}

export function createNodeCoverFlatteningWorkflowDependencies({
  config,
  packageDir,
  pythonExecutable
}: {
  config: LocalCoverWorkflowConfig;
  packageDir: string;
  pythonExecutable: string;
}): CoverFlatteningWorkflowDependencies {
  const imageDependencies = createNodeExternalCoverImageOptimizerDependencies(config);
  return {
    config,
    cropImage: async (image, dimensions) => Buffer.from(
      await sharp(image, { failOn: 'none' })
        .extract(dimensions)
        .png()
        .toBuffer()
    ),
    downloadImage: imageDependencies.downloadImage,
    optimizeImage: imageDependencies.optimizeImage,
    resizeImage: async (image, dimensions) => Buffer.from(
      await sharp(image, { failOn: 'none' })
        .resize({ fit: 'fill', height: dimensions.height, width: dimensions.width })
        .png()
        .toBuffer()
    ),
    removeDirectory: async (directory) => {
      await rm(directory, { force: true, recursive: true });
    },
    runManualFlattening: async (sourcePath, outputDir, points) => {
      const packagePath = configuredPathApi(packageDir);
      await execFileAsync(
        pythonExecutable,
        [
          '-m',
          'ludora.box_silhouette',
          sourcePath,
          '--output-dir',
          outputDir,
          '--manual-points-json',
          JSON.stringify(points.map(({ x, y }) => [x, y]))
        ],
        {
          cwd: packageDir,
          env: {
            ...process.env,
            PYTHONPATH: packagePath.join(packageDir, 'src')
          },
          maxBuffer: 1024 * 1024
        }
      );
      return JSON.parse(await readFile(packagePath.join(outputDir, 'manual-cover.json'), 'utf8')) as FlatteningMetadata;
    },
    runFlattening: async (sourcePath, outputDir) => {
      const packagePath = configuredPathApi(packageDir);
      await execFileAsync(
        pythonExecutable,
        ['-m', 'ludora.box_silhouette', sourcePath, '--output-dir', outputDir],
        {
          cwd: packageDir,
          env: {
            ...process.env,
            PYTHONPATH: packagePath.join(packageDir, 'src')
          },
          maxBuffer: 1024 * 1024
        }
      );
      return JSON.parse(await readFile(packagePath.join(outputDir, 'silhouette.json'), 'utf8')) as FlatteningMetadata;
    },
    uploadImage: imageDependencies.uploadImage,
    writeSource: async (destination, image) => {
      await mkdir(configuredPathApi(destination).dirname(destination), { recursive: true });
      await writeFile(destination, image);
    }
  };
}

function parseCandidates(metadata: FlatteningMetadata): FlatteningCandidateFile[] {
  const candidates = (metadata.flattened_covers ?? []).map((candidate) => {
    const geometry = candidate.geometry;
    const index = Number(candidate.candidate_index);
    const candidatePath = text(candidate.output_path);
    const width = Number(geometry?.width);
    const height = Number(geometry?.height);
    const aspectRatio = Number(geometry?.aspect_ratio);
    if (
      !Number.isInteger(index)
      || index <= 0
      || !candidatePath
      || !Number.isInteger(width)
      || width < 2
      || !Number.isInteger(height)
      || height < 2
      || aspectRatio <= 0
    ) {
      throw new CoverFlatteningWorkflowError('Flattening returned malformed candidate metadata.', 422);
    }
    return {
      aspect_ratio: aspectRatio,
      aspect_ratio_method: parseAspectRatioMethod(geometry?.aspect_ratio_method),
      construction: text(candidate.construction) || `Candidate ${index}`,
      height,
      index,
      path: candidatePath,
      square_snapped: geometry?.square_snapped === true,
      vanishing_confidence: finiteNumber(geometry?.vanishing_confidence, 0),
      width
    };
  });
  if (candidates.length < 1 || candidates.length > 2) {
    throw new CoverFlatteningWorkflowError('Flattening must return one or two cover candidates.', 422);
  }
  return candidates;
}

function validateNormalizedCoverPoints(points: NormalizedCoverPoint[]): NormalizedCoverPoint[] {
  if (!Array.isArray(points) || points.length !== 4) {
    throw new CoverFlatteningWorkflowError('Manual cover selection requires exactly four points.', 400);
  }
  return points.map((point) => {
    if (
      !point
      || typeof point !== 'object'
      || !Number.isFinite(point.x)
      || !Number.isFinite(point.y)
      || point.x < 0
      || point.x > 1
      || point.y < 0
      || point.y > 1
    ) {
      throw new CoverFlatteningWorkflowError(
        'Manual cover points must have finite x and y coordinates between 0 and 1.',
        400
      );
    }
    return { x: point.x, y: point.y };
  });
}

function parseAspectRatioMethod(value: unknown): CoverFlatteningCandidate['aspect_ratio_method'] {
  if (value === 'near_square' || value === 'vanishing_points') {
    return value;
  }
  return 'edge_average';
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimPixels(dimension: number, trimFraction: number): number {
  if (trimFraction === 0) {
    return 0;
  }
  return Math.min(
    Math.max(1, Math.round(dimension * trimFraction)),
    Math.max(0, Math.floor((dimension - 2) / 2))
  );
}

function parsePerspective(metadata: FlatteningMetadata): CoverFlatteningWorkflow['perspective'] {
  const mode = metadata.detection?.perspective?.kind ?? metadata.detection?.perspective?.mode;
  if (mode === 'two_faces' || mode === 'three_faces') {
    return mode;
  }
  throw new CoverFlatteningWorkflowError('Flattening returned an unknown perspective.', 422);
}

function automaticFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Automatic cover flattening failed.';
}

function publicWorkflow(workflow: ManagedCoverFlatteningWorkflow): CoverFlatteningWorkflow {
  return {
    automatic_error: workflow.automatic_error,
    candidates: workflow.candidates.map(({ path: _path, ...candidate }) => candidate),
    created_at: workflow.created_at,
    expires_at: workflow.expires_at,
    item_id: workflow.item_id,
    perspective: workflow.perspective,
    source_field: workflow.source_field,
    store_item_id: workflow.store_item_id,
    workflow_id: workflow.workflow_id
  };
}

async function loadStoreItemSource(database: Database, storeItemId: number): Promise<StoreItemSourceRow | null> {
  const result = await database.query(
    `
    select
      si.id as store_item_id,
      si.image_url as source_url,
      si.item_id,
      i.canonical_name,
      i.normalized_name,
      i.canonical_name_es,
      i.normalized_name_es
    from store_items si
    left join items i on i.id = si.item_id
    where si.id = $1
    `,
    [storeItemId]
  );
  return (result.rows[0] as StoreItemSourceRow | undefined) ?? null;
}

async function loadItemSource(database: Database, itemId: number): Promise<ItemSourceRow | null> {
  const result = await database.query(
    `
    select
      i.id as item_id,
      i.image_url,
      i.image_url_es,
      i.canonical_name,
      i.normalized_name,
      i.canonical_name_es,
      i.normalized_name_es
    from items i
    where i.id = $1
    `,
    [itemId]
  );
  return (result.rows[0] as ItemSourceRow | undefined) ?? null;
}

async function updateItemImage(
  database: Database,
  itemId: number,
  targetField: CoverFlatteningTargetField,
  publicUrl: string
): Promise<void> {
  const column = targetField === 'image_url' ? 'image_url' : 'image_url_es';
  await database.query(
    `
    update items
    set ${column} = $1,
        updated_at = now()
    where id = $2
    returning id
    `,
    [publicUrl, itemId]
  );
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

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function configuredPathApi(root: string): path.PlatformPath {
  return /^[A-Za-z]:[\\/]/.test(root) ? path.win32 : path;
}
