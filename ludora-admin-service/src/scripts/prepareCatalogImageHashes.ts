import { mkdir, readFile, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeCatalogImageHasher } from '../catalogImageHash.js';
import { loadCatalogImageHashRows, prepareCatalogImageHashBackfill, type CatalogImageHashRow } from '../catalogImageHashBackfill.js';
import { createDatabase } from '../db.js';
import { downloadImageWithLimit } from '../externalCoverImageOptimizer.js';

dotenv.config({ quiet: true });

// There is deliberately no apply mode. All database access is the SELECT snapshot loader.
const options: { input?: string; output?: string; limit?: number; refresh?: boolean } = {};
for (const argument of process.argv.slice(2)) {
  const separator = argument.indexOf('=');
  const key = separator < 0 ? argument : argument.slice(0, separator);
  const value = separator < 0 ? '' : argument.slice(separator + 1);
  if (key === '--refresh' && !value) options.refresh = true;
  else if ((key === '--input' || key === '--output') && value) options[key.slice(2) as 'input' | 'output'] = value;
  else if (key === '--limit' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))) options.limit = Number(value);
  else throw new Error(`Unsupported or invalid argument: ${argument}. Use --output=patch.sql [--input=snapshot.json] [--limit=N] [--refresh]; no apply mode exists.`);
}
if (!options.output) throw new Error('--output=patch.sql is required');
const databaseUrl = process.env.LUDORA_DATABASE_URL?.trim();
let rows: CatalogImageHashRow[];
if (options.input) {
  const input: unknown = JSON.parse(await readFile(options.input, 'utf8'));
  if (!Array.isArray(input)) throw new Error('Offline input must be an array of catalog snapshots');
  rows = options.limit === undefined ? input : input.slice(0, options.limit);
} else {
  if (!databaseUrl) throw new Error('LUDORA_DATABASE_URL is required for SELECT preparation, or provide --input');
  const database = createDatabase(databaseUrl);
  try { rows = await loadCatalogImageHashRows(database, options); }
  finally { await database.close?.(); }
}
const hasher = createNodeCatalogImageHasher({
  downloadImage: downloadImageWithLimit,
  packageDir: process.env.LUDORA_DISCOVERY_PACKAGE_DIR?.trim() || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ludora-discovery'),
  pythonExecutable: process.env.LUDORA_DISCOVERY_PYTHON?.trim() || 'python'
});
const result = await prepareCatalogImageHashBackfill(rows, hasher, {
  refresh: options.refresh,
  readImageFile: (filename) => readFile(options.input ? path.resolve(path.dirname(options.input), filename) : filename)
});
await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
await writeFile(options.output, result.sql, 'utf8');
await writeFile(`${options.output}.json`, `${JSON.stringify({ itemsScanned: rows.length, failures: result.failures }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ sqlFile: options.output, reportFile: `${options.output}.json`, itemsScanned: rows.length, failures: result.failures }, null, 2));
if (result.failures.length) process.exitCode = 1;
