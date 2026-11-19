import { readFileSync } from 'node:fs';

const CONFIG_KEY = 'LUDORA_VERIFIED_UPDATE_SITEMAPS';
const MAX_STORE_ID = 9_223_372_036_854_775_807n;
const MAX_PAGE_ENTRIES = 150_000;
const hostLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function readVerifiedSitemapStoreIds(
  envFile: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  let config: unknown;
  try {
    const raw = env[CONFIG_KEY] ?? readDiscoverySitemapEnvValue(envFile);
    config = JSON.parse(raw ?? '{}');
  } catch {
    return [];
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return [];
  }
  return Object.entries(config)
    .filter(([id, value]) => /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= MAX_STORE_ID && isSitemapConfig(value))
    .map(([id]) => id);
}

// Match the discovery worker's dotenv fallback for this single setting.
function readDiscoverySitemapEnvValue(envFile: string): string | undefined {
  let value: string | undefined;
  for (const rawLine of readFileSync(envFile, 'utf8').split(/\r\n|\r|\n/)) {
    let line = rawLine.trim();
    if (line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('export ')) {
      line = line.slice('export '.length).trim();
    }
    const equals = line.indexOf('=');
    if (equals < 0 || line.slice(0, equals).trim() !== CONFIG_KEY) {
      continue;
    }
    value = line.slice(equals + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
  }
  return value;
}

function isSitemapConfig(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { url, min_urls } = value as { url?: unknown; min_urls?: unknown };
  return typeof url === 'string' && isSitemapUrl(url)
    && typeof min_urls === 'number' && Number.isInteger(min_urls)
    && min_urls >= 1 && min_urls <= MAX_PAGE_ENTRIES;
}

function isSitemapUrl(value: string): boolean {
  const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (
    !authority || authority.includes('@') || authority.endsWith(':') || value.length > 2048
    || /[\s\x00-\x1f\x7f\\#]|%(?![a-f0-9]{2})/i.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    decodeURIComponent(url.pathname);
    return url.port === '' && url.hostname.replace(/\.$/, '').split('.').every((label) => hostLabel.test(label));
  } catch {
    return false;
  }
}

export function storeItemUpdateAvailabilitySql(verifiedStoreIdsParameter?: number): string {
  const available = "store_items.availability <> 'unavailable'";
  return verifiedStoreIdsParameter === undefined
    ? available
    : `(${available} or store_items.store_id = any($${verifiedStoreIdsParameter}::bigint[]))`;
}
