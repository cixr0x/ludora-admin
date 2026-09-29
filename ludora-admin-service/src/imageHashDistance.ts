import { isCatalogImageHash } from './catalogImageHash.js';

export function imageHashDistance(left: string, right: string): number {
  if (!isCatalogImageHash(left) || !isCatalogImageHash(right)) throw new Error('Invalid canonical image hash');
  let different = BigInt(`0x${left}`) ^ BigInt(`0x${right}`), count = 0;
  while (different !== 0n) { different &= different - 1n; count++; }
  return count;
}
