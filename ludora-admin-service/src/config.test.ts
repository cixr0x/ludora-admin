import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from './config.js';

describe('loadConfig', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_USERNAME', 'admin');
    vi.stubEnv('ADMIN_PASSWORD', 'secret-password');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'test-session-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults PORT to 4001 when unset', () => {
    vi.stubEnv('PORT', undefined);

    expect(loadConfig().port).toBe(4001);
  });

  it('defaults HOST to loopback and accepts an override', () => {
    vi.stubEnv('HOST', undefined);
    expect(loadConfig().host).toBe('127.0.0.1');

    vi.stubEnv('HOST', '0.0.0.0');
    expect(loadConfig().host).toBe('0.0.0.0');
  });

  it.each(['abc', '0', '-1', '4001.5'])('rejects invalid PORT %s', (port) => {
    vi.stubEnv('PORT', port);

    expect(() => loadConfig()).toThrow('PORT must be a positive integer');
  });

  it('defaults discovery runner config to local discovery', () => {
    vi.stubEnv('LUDORA_DISCOVERY_API_URL', undefined);
    vi.stubEnv('LUDORA_DISCOVERY_ENV_FILE', undefined);
    vi.stubEnv('LUDORA_DISCOVERY_PACKAGE_DIR', undefined);
    vi.stubEnv('LUDORA_DISCOVERY_PYTHON', undefined);
    vi.stubEnv('LUDORA_DISCOVERY_RUNNER', undefined);

    const config = loadConfig();

    expect(config.discoveryRunner).toEqual({
      apiUrl: 'http://localhost:8001',
      envFile: path.resolve(process.cwd(), '.env'),
      mode: 'local',
      packageDir: path.resolve(process.cwd(), '..', 'ludora-discovery'),
      pythonExecutable: 'python'
    });
  });

  it('loads discovery runner config from environment overrides', () => {
    vi.stubEnv('LUDORA_DISCOVERY_RUNNER', 'http');
    vi.stubEnv('LUDORA_DISCOVERY_API_URL', 'http://127.0.0.1:9009');
    vi.stubEnv('LUDORA_DISCOVERY_PYTHON', 'py');
    vi.stubEnv('LUDORA_DISCOVERY_PACKAGE_DIR', 'C:\\tmp\\ludora-discovery');
    vi.stubEnv('LUDORA_DISCOVERY_ENV_FILE', 'C:\\tmp\\admin.env');

    const config = loadConfig();

    expect(config.discoveryRunner).toEqual({
      apiUrl: 'http://127.0.0.1:9009',
      envFile: 'C:\\tmp\\admin.env',
      mode: 'http',
      packageDir: 'C:\\tmp\\ludora-discovery',
      pythonExecutable: 'py'
    });
  });

  it('trims discovery runner environment overrides', () => {
    vi.stubEnv('LUDORA_DISCOVERY_RUNNER', ' http ');
    vi.stubEnv('LUDORA_DISCOVERY_API_URL', ' http://127.0.0.1:9009 ');
    vi.stubEnv('LUDORA_DISCOVERY_PYTHON', ' py ');
    vi.stubEnv('LUDORA_DISCOVERY_PACKAGE_DIR', ' C:\\tmp\\ludora-discovery ');
    vi.stubEnv('LUDORA_DISCOVERY_ENV_FILE', ' C:\\tmp\\admin.env ');

    const config = loadConfig();

    expect(config.discoveryRunner).toEqual({
      apiUrl: 'http://127.0.0.1:9009',
      envFile: 'C:\\tmp\\admin.env',
      mode: 'http',
      packageDir: 'C:\\tmp\\ludora-discovery',
      pythonExecutable: 'py'
    });
  });

  it('treats blank discovery runner environment overrides as unset', () => {
    vi.stubEnv('LUDORA_DISCOVERY_RUNNER', '   ');
    vi.stubEnv('LUDORA_DISCOVERY_API_URL', '   ');
    vi.stubEnv('LUDORA_DISCOVERY_PYTHON', '   ');
    vi.stubEnv('LUDORA_DISCOVERY_PACKAGE_DIR', '   ');
    vi.stubEnv('LUDORA_DISCOVERY_ENV_FILE', '   ');

    const config = loadConfig();

    expect(config.discoveryRunner).toEqual({
      apiUrl: 'http://localhost:8001',
      envFile: path.resolve(process.cwd(), '.env'),
      mode: 'local',
      packageDir: path.resolve(process.cwd(), '..', 'ludora-discovery'),
      pythonExecutable: 'python'
    });
  });

  it.each([
    ['LOCAL', 'local'],
    ['Http', 'http'],
    ['   ', 'local']
  ])('normalizes discovery runner mode %j to %s', (runner, mode) => {
    vi.stubEnv('LUDORA_DISCOVERY_RUNNER', runner);

    expect(loadConfig().discoveryRunner.mode).toBe(mode);
  });

  it('rejects invalid discovery runner mode', () => {
    vi.stubEnv('LUDORA_DISCOVERY_RUNNER', 'sidecar');

    expect(() => loadConfig()).toThrow('LUDORA_DISCOVERY_RUNNER must be local or http');
  });

  it('loads admin auth configuration from environment', () => {
    vi.stubEnv('ADMIN_USERNAME', 'admin');
    vi.stubEnv('ADMIN_PASSWORD', 'secret-password');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'test-session-secret');
    vi.stubEnv('ADMIN_SESSION_TTL_HOURS', '8');
    vi.stubEnv('ADMIN_SESSION_COOKIE_NAME', 'custom_admin_session');
    vi.stubEnv('ADMIN_SESSION_COOKIE_SECURE', 'true');
    vi.stubEnv('ADMIN_SESSION_COOKIE_SAMESITE', 'none');

    expect(loadConfig().adminAuth).toEqual({
      cookieName: 'custom_admin_session',
      cookieSameSite: 'none',
      cookieSecure: true,
      password: 'secret-password',
      sessionSecret: 'test-session-secret',
      sessionTtlHours: 8,
      username: 'admin'
    });
  });

  it('requires admin auth credentials', () => {
    vi.stubEnv('ADMIN_USERNAME', undefined);
    vi.stubEnv('ADMIN_PASSWORD', 'secret-password');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'test-session-secret');

    expect(() => loadConfig()).toThrow('ADMIN_USERNAME is required');
  });

  it.each(['0', '-1', 'abc'])('rejects invalid admin session TTL %s', (ttl) => {
    vi.stubEnv('ADMIN_USERNAME', 'admin');
    vi.stubEnv('ADMIN_PASSWORD', 'secret-password');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'test-session-secret');
    vi.stubEnv('ADMIN_SESSION_TTL_HOURS', ttl);

    expect(() => loadConfig()).toThrow('ADMIN_SESSION_TTL_HOURS must be a positive number');
  });

  it('allows both localhost and 127.0.0.1 UI origins by default', () => {
    vi.stubEnv('CORS_ORIGIN', undefined);

    expect(loadConfig().corsOrigin).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it('loads comma-separated CORS origins from env', () => {
    vi.stubEnv('CORS_ORIGIN', 'http://localhost:5173, http://127.0.0.1:5173');

    expect(loadConfig().corsOrigin).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it('loads optional BGG API configuration', () => {
    vi.stubEnv('BGG_API_TOKEN', 'test-token');
    vi.stubEnv('BGG_API_BASE_URL', 'https://example.test/xmlapi2');

    expect(loadConfig()).toMatchObject({
      bggApiBaseUrl: 'https://example.test/xmlapi2',
      bggApiToken: 'test-token'
    });
  });

  it('loads optional OpenAI translation configuration', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:3001/v1');
    vi.stubEnv('OPENAI_TRANSLATION_MODEL', 'gpt-5.4-nano');

    expect(loadConfig()).toMatchObject({
      openAiApiKey: 'test-openai-key',
      openAiBaseUrl: 'http://127.0.0.1:3001/v1',
      openAiTranslationModel: 'gpt-5.4-nano'
    });
  });

  it('loads the optional internal API token', () => {
    vi.stubEnv('LUDORA_INTERNAL_API_TOKEN', 'internal-test-token');

    expect(loadConfig().internalApiToken).toBe('internal-test-token');
  });

  it('loads local cover workflow defaults and overrides', () => {
    vi.stubEnv('LUDORA_COVER_WORK_DIR', 'D:\\covers');
    vi.stubEnv('LUDORA_COVER_S3_BUCKET', 'custom-bucket');
    vi.stubEnv('LUDORA_COVER_S3_PREFIX', 'custom-prefix');
    vi.stubEnv('LUDORA_COVER_S3_REGION', 'us-west-2');
    vi.stubEnv('LUDORA_COVER_PUBLIC_BASE_URL', 'https://cdn.example.test');
    vi.stubEnv('LUDORA_COVER_GIMP_PATH', 'C:\\Program Files\\GIMP\\bin\\gimp.exe');

    expect(loadConfig().localCoverWorkflow).toEqual({
      gimpPath: 'C:\\Program Files\\GIMP\\bin\\gimp.exe',
      publicBaseUrl: 'https://cdn.example.test',
      s3Bucket: 'custom-bucket',
      s3Prefix: 'custom-prefix',
      s3Region: 'us-west-2',
      workDir: 'D:\\covers'
    });
  });

  it('loads the ephemeral cover flattening work directory override', () => {
    vi.stubEnv('LUDORA_COVER_FLATTENING_WORK_DIR', 'D:\\flattened-covers');

    expect(loadConfig().coverFlatteningWorkDir).toBe('D:\\flattened-covers');
  });

  it('defaults local cover S3 region to the Ludora bucket region', () => {
    vi.stubEnv('LUDORA_COVER_S3_REGION', undefined);
    vi.stubEnv('AWS_REGION', undefined);
    vi.stubEnv('AWS_DEFAULT_REGION', undefined);

    expect(loadConfig().localCoverWorkflow.s3Region).toBe('us-east-2');
  });
});
