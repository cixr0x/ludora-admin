import { readFile } from 'node:fs/promises';
import { CATALOG_IMAGE_HASH_METHOD, isCatalogImageHash, prepareCatalogImageHash, type CatalogImageHasher } from './catalogImageHash.js';
import type { Database } from './db.js';

export type CatalogImageHashRow = {
  id: string; image_url: string; image_url_es: string;
  image_phash: string | null; image_phash_es: string | null;
  updated_at: string; row_version?: string; image_path?: string; image_path_es?: string;
};
export async function loadCatalogImageHashRows(database: Database, options: { limit?: number; refresh?: boolean } = {}): Promise<CatalogImageHashRow[]> {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new Error('limit must be a positive integer');
  const result = await database.query(`
    SELECT id::text AS id, image_url, image_url_es, image_phash, image_phash_es,
           updated_at::text AS updated_at, xmin::text AS row_version
    FROM items
    ${options.refresh ? '' : `WHERE (trim(image_url) <> '' AND image_phash IS NULL)
      OR (trim(image_url_es) <> '' AND image_phash_es IS NULL)
      OR (trim(image_url) = '' AND image_phash IS NOT NULL)
      OR (trim(image_url_es) = '' AND image_phash_es IS NOT NULL)`}
    ORDER BY id
    ${options.limit === undefined ? '' : 'LIMIT $1'}
  `, options.limit === undefined ? undefined : [options.limit]);
  return result.rows as CatalogImageHashRow[];
}
export async function prepareCatalogImageHashBackfill(
  rows: CatalogImageHashRow[], hasher: CatalogImageHasher,
  options: { refresh?: boolean; readImageFile?(filename: string): Promise<Buffer> } = {}
): Promise<{ sql: string; failures: Array<{ itemId: string; field: string; error: string }> }> {
  // Validate every guard before starting any IO or emitting a partial patch.
  for (const row of rows) validateRow(row);
  const failures: Array<{ itemId: string; field: string; error: string }> = [];
  const statements: string[] = [];
  for (const row of rows) {
    const assignments: string[] = [];
    for (const field of ['image_url', 'image_url_es'] as const) {
      const hashField = field === 'image_url' ? 'image_phash' : 'image_phash_es';
      const imagePath = field === 'image_url' ? row.image_path : row.image_path_es;
      if (!options.refresh && row[field].trim() && row[hashField] !== null) continue;
      let hash: string | null = null;
      const report = (error: string) => failures.push({ itemId: row.id, field, error });
      if (row[field].trim()) {
        try {
          const source = imagePath ? await (options.readImageFile ?? readFile)(imagePath) : row[field];
          hash = await prepareCatalogImageHash(hasher, source, report);
        } catch (error) {
          report(`Catalog image hash failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (hash !== row[hashField]) assignments.push(`${hashField} = ${hash === null ? 'NULL' : `'${hash}'`}`);
    }
    if (!assignments.length) continue;
    statements.push(`UPDATE items\nSET ${assignments.join(', ')}, updated_at = now()\nWHERE id = ${row.id}
  AND image_url IS NOT DISTINCT FROM ${sqlLiteral(row.image_url)}
  AND image_url_es IS NOT DISTINCT FROM ${sqlLiteral(row.image_url_es)}
  AND image_phash IS NOT DISTINCT FROM ${sqlLiteral(row.image_phash)}
  AND image_phash_es IS NOT DISTINCT FROM ${sqlLiteral(row.image_phash_es)}
  AND updated_at IS NOT DISTINCT FROM ${sqlLiteral(row.updated_at)}::timestamptz${row.row_version ? `\n  AND xmin::text = '${row.row_version}'` : ''}
RETURNING id;`);
  }
  return {
    sql: `-- Prepared catalog image hashes: ${CATALOG_IMAGE_HASH_METHOD}\n-- Review and approve before executing; this tool executes no DML.\nBEGIN;\n\n${statements.join('\n\n')}\n\nCOMMIT;\n`,
    failures
  };
}

function sqlLiteral(value: string | null): string {
  return value === null ? 'NULL' : `E'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function validateRow(row: CatalogImageHashRow): void {
  if (typeof row.id !== 'string' || !/^[1-9][0-9]*$/.test(row.id)) throw new Error('Each snapshot id must be a positive decimal string');
  if (typeof row.updated_at !== 'string' || !row.updated_at.trim() || !Number.isFinite(Date.parse(row.updated_at))) throw new Error(`Item ${row.id}: updated_at is required as an exact timestamp string`);
  if (row.row_version !== undefined && !/^[0-9]+$/.test(row.row_version)) throw new Error(`Item ${row.id}: invalid row_version`);
  for (const field of ['image_url', 'image_url_es'] as const) {
    if (typeof row[field] !== 'string' || row[field].includes('\0')) throw new Error(`Item ${row.id}: ${field} must be a string without NUL`);
  }
  for (const field of ['image_phash', 'image_phash_es'] as const) {
    if (row[field] !== null && !isCatalogImageHash(row[field])) throw new Error(`Item ${row.id}: invalid ${field}`);
  }
}
