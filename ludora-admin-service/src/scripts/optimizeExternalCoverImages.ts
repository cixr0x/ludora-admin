import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createExternalCoverImageReport } from '../externalCoverImageReport.js';
import { createNodeExternalCoverImageOptimizerDependencies, optimizeExternalCoverImages } from '../externalCoverImageOptimizer.js';
import { loadConfig } from '../config.js';
import { createDatabase } from '../db.js';

const config = loadConfig();

if (!config.databaseUrl) {
  throw new Error('LUDORA_DATABASE_URL is required');
}

const options = parseOptions(process.argv.slice(2));
const sampleSize = options.sampleSize;
const database = createDatabase(config.databaseUrl);
const dependencies = createNodeExternalCoverImageOptimizerDependencies(config.localCoverWorkflow);

try {
  const result = await optimizeExternalCoverImages(database, dependencies, options);
  const generatedAt = new Date().toISOString();
  const reportFile = options.reportFile ?? (options.apply ? defaultReportFile(generatedAt) : undefined);
  const report = createExternalCoverImageReport(result, {
    applied: options.apply === true,
    generatedAt
  });
  if (reportFile) {
    await mkdir(dirname(reportFile), { recursive: true });
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  console.log(
    JSON.stringify(
      {
        applied: options.apply === true,
        reportFile: reportFile ?? null,
        summary: result.summary,
        samples: {
          failures: result.failures.slice(0, sampleSize),
          optimized: result.optimized.slice(0, sampleSize),
          skipped: result.skipped.slice(0, sampleSize)
        }
      },
      null,
      2
    )
  );

  if (result.failures.length > 0) {
    process.exitCode = 1;
  }
} finally {
  await database.close?.();
}

function parseOptions(args: string[]): {
  apply: boolean;
  limit?: number;
  maxBytes?: number;
  maxDimension?: number;
  offset?: number;
  reportFile?: string;
  sampleSize: number;
} {
  const options: {
    apply: boolean;
    limit?: number;
    maxBytes?: number;
    maxDimension?: number;
    offset?: number;
    reportFile?: string;
    sampleSize: number;
  } = {
    apply: args.includes('--apply'),
    sampleSize: 20
  };

  for (const arg of args) {
    const [key, value] = arg.split('=', 2);
    if (key === '--limit') {
      options.limit = positiveInteger(value, 'limit');
    }
    if (key === '--max-bytes') {
      options.maxBytes = positiveInteger(value, 'max-bytes');
    }
    if (key === '--max-dimension') {
      options.maxDimension = positiveInteger(value, 'max-dimension');
    }
    if (key === '--offset') {
      options.offset = nonNegativeInteger(value, 'offset');
    }
    if (key === '--report-file') {
      options.reportFile = requiredValue(value, 'report-file');
    }
    if (key === '--sample-size') {
      options.sampleSize = nonNegativeInteger(value, 'sample-size');
    }
  }

  return options;
}

function defaultReportFile(generatedAt: string): string {
  return `artifacts/external-cover-optimization-${generatedAt.replace(/[:.]/g, '-')}.json`;
}

function requiredValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`--${name} must include a value`);
  }
  return value;
}

function nonNegativeInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}
