import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ImageSimilarityDiagnostics = {
  reference_dimensions: { width: number; height: number };
  candidate_dimensions: { width: number; height: number };
  reference_keypoints: number;
  candidate_keypoints: number;
  tentative_matches: number;
  inliers: number;
  inlier_ratio: number;
  reference_hull_coverage: number;
  reference_grid_coverage: number;
  median_reprojection_error: number | null;
  projected_area_ratio: number | null;
  homography_valid: boolean;
};

export type ImageSimilarityResult = {
  score: number;
  method: 'sift_homography_v1';
  matched_region: Array<{ x: number; y: number }> | null;
  diagnostics: ImageSimilarityDiagnostics;
};

export type ImageSimilarityService = {
  estimate(referenceImageUrl: string, candidateImageUrl: string): Promise<ImageSimilarityResult>;
};

export type ImageSimilarityDependencies = {
  compareImages(reference: Buffer, candidate: Buffer): Promise<ImageSimilarityResult>;
  downloadImage(url: string): Promise<Buffer>;
};

export class ImageSimilarityServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export function createImageSimilarityService(dependencies: ImageSimilarityDependencies): ImageSimilarityService {
  return {
    async estimate(referenceImageUrl, candidateImageUrl) {
      const [referenceDownload, candidateDownload] = await Promise.allSettled([
        dependencies.downloadImage(referenceImageUrl),
        dependencies.downloadImage(candidateImageUrl)
      ]);
      if (referenceDownload.status === 'rejected') {
        throw new ImageSimilarityServiceError(
          `Reference image could not be downloaded: ${errorMessage(referenceDownload.reason)}`,
          422
        );
      }
      if (candidateDownload.status === 'rejected') {
        throw new ImageSimilarityServiceError(
          `Candidate image could not be downloaded: ${errorMessage(candidateDownload.reason)}`,
          422
        );
      }

      try {
        return await dependencies.compareImages(referenceDownload.value, candidateDownload.value);
      } catch (error) {
        throw new ImageSimilarityServiceError(`Images could not be compared: ${errorMessage(error)}`, 422);
      }
    }
  };
}

export function createNodeImageSimilarityDependencies({
  downloadImage,
  packageDir,
  pythonExecutable
}: {
  downloadImage(url: string): Promise<Buffer>;
  packageDir: string;
  pythonExecutable: string;
}): ImageSimilarityDependencies {
  return {
    downloadImage,
    compareImages: async (reference, candidate) => {
      const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'ludora-image-similarity-'));
      const referencePath = path.join(temporaryDirectory, 'reference.image');
      const candidatePath = path.join(temporaryDirectory, 'candidate.image');
      try {
        await Promise.all([
          writeFile(referencePath, reference),
          writeFile(candidatePath, candidate)
        ]);
        const { stdout } = await execFileAsync(
          pythonExecutable,
          ['-m', 'ludora.image_similarity', referencePath, candidatePath],
          {
            cwd: packageDir,
            env: {
              ...process.env,
              PYTHONPATH: path.join(packageDir, 'src')
            },
            maxBuffer: 1024 * 1024
          }
        );
        return parseImageSimilarityResult(stdout);
      } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
      }
    }
  };
}

function parseImageSimilarityResult(rawValue: string): ImageSimilarityResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error('Image similarity process returned invalid JSON.');
  }
  if (!isRecord(parsed) || !isScore(parsed.score) || parsed.method !== 'sift_homography_v1') {
    throw new Error('Image similarity process returned an invalid result.');
  }
  return parsed as ImageSimilarityResult;
}

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  const stderr = isRecord(error) && typeof error.stderr === 'string' ? error.stderr.trim() : '';
  if (stderr) {
    return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}
