import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from './config.js';

describe('loadConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults PORT to 4001 when unset', () => {
    vi.stubEnv('PORT', undefined);

    expect(loadConfig().port).toBe(4001);
  });

  it.each(['abc', '0', '-1', '4001.5'])('rejects invalid PORT %s', (port) => {
    vi.stubEnv('PORT', port);

    expect(() => loadConfig()).toThrow('PORT must be a positive integer');
  });
});
