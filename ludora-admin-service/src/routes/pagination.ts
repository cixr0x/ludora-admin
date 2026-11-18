export function parsePagination(query: Record<string, unknown>) {
  return {
    page: integerQueryField(query.page, 0, 0, 100000),
    pageSize: integerQueryField(query.page_size, 25, 1, 200)
  };
}

function integerQueryField(value: unknown, fallback: number, min: number, max: number): number {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsed = typeof rawValue === 'string' || typeof rawValue === 'number' ? Number(rawValue) : NaN;
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}
