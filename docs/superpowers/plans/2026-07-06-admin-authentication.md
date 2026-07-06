# Admin Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add simple administrator authentication to the Ludora admin service and UI before deployment.

**Architecture:** The Express admin service owns authentication through environment-backed credentials and an HttpOnly signed session cookie. The React admin UI checks the current session on load, renders a MUI login screen when unauthenticated, and sends cookies with all API calls.

**Tech Stack:** Node.js, Express 5, Vitest, Supertest, React 19, Vite, MUI, Testing Library.

---

## File Structure

- Create `ludora-admin-service/src/auth/adminAuth.ts` for credential checks, signed cookie creation, session verification, and auth middleware.
- Create `ludora-admin-service/src/routes/auth.ts` for `/admin/auth/login`, `/admin/auth/me`, and `/admin/auth/logout`.
- Modify `ludora-admin-service/src/config.ts` to load `adminAuth` settings from environment variables.
- Modify `ludora-admin-service/src/server.ts` to pass `config.adminAuth` into `createApp`.
- Modify `ludora-admin-service/src/app.ts` to enable credentialed CORS, mount auth routes, and protect existing feature routers.
- Modify `ludora-admin-service/src/app.test.ts` for service auth integration tests.
- Modify `ludora-admin-service/src/config.test.ts` for auth config tests.
- Modify `ludora-admin-ui/src/api/client.ts` to add auth methods, include credentials, and expose unauthorized callbacks.
- Create `ludora-admin-ui/src/components/LoginPage.tsx` for the login screen.
- Modify `ludora-admin-ui/src/components/AdminLayout.tsx` to add a logout button in the top bar.
- Modify `ludora-admin-ui/src/App.tsx` to manage session checking, login, logout, and unauthorized transitions.
- Modify `ludora-admin-ui/src/App.test.tsx` for login/session UI behavior.
- Modify `ludora-admin-ui/src/api/client.test.ts` for credentialed fetch behavior.

No database files are created or changed.

### Task 1: Service Auth Core

**Files:**
- Create: `ludora-admin-service/src/auth/adminAuth.ts`
- Test: `ludora-admin-service/src/app.test.ts`

- [ ] **Step 1: Write failing tests for protected route access and login cookie issuance**

Add these tests near the top of `describe('ludora admin service', ...)` after the health/CORS tests:

```ts
  const authOptions = {
    cookieName: 'ludora_admin_session',
    cookieSameSite: 'lax' as const,
    cookieSecure: false,
    password: 'secret-password',
    sessionSecret: 'test-session-secret-with-enough-length',
    sessionTtlHours: 12,
    username: 'admin'
  };

  it('requires authentication for admin data routes', async () => {
    const response = await request(createApp({ database: idleDatabase(), adminAuth: authOptions })).get('/stores');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { message: 'Authentication required' } });
  });

  it('sets an HttpOnly session cookie after a successful login', async () => {
    const app = createApp({ database: idleDatabase(), adminAuth: authOptions });

    const loginResponse = await request(app).post('/admin/auth/login').send({
      password: 'secret-password',
      username: 'admin'
    });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body).toEqual({ data: { username: 'admin' } });
    expect(loginResponse.headers['set-cookie']?.[0]).toContain('ludora_admin_session=');
    expect(loginResponse.headers['set-cookie']?.[0]).toContain('HttpOnly');

    const protectedResponse = await request(app).get('/stores').set('Cookie', loginResponse.headers['set-cookie']);

    expect(protectedResponse.status).toBe(200);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/app.test.ts -t "requires authentication|sets an HttpOnly session cookie"` from `ludora-admin-service/`.

Expected: FAIL because `CreateAppOptions` has no `adminAuth` property and `/admin/auth/login` does not exist.

- [ ] **Step 3: Create the auth module**

Create `ludora-admin-service/src/auth/adminAuth.ts` with:

```ts
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export type AdminSameSite = 'lax' | 'none' | 'strict';

export type AdminAuthOptions = {
  cookieName: string;
  cookieSameSite: AdminSameSite;
  cookieSecure: boolean;
  password: string;
  sessionSecret: string;
  sessionTtlHours: number;
  username: string;
};

export type AdminIdentity = {
  username: string;
};

type SessionPayload = {
  expires_at: number;
  username: string;
};

const encoder = new TextEncoder();

export function createSessionCookie(identity: AdminIdentity, options: AdminAuthOptions, now = Date.now()): string {
  const payload: SessionPayload = {
    expires_at: now + options.sessionTtlHours * 60 * 60 * 1000,
    username: identity.username
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signValue(encodedPayload, options.sessionSecret);
  return `${encodedPayload}.${signature}`;
}

export function verifySessionCookie(cookieValue: string | undefined, options: AdminAuthOptions, now = Date.now()): AdminIdentity | null {
  if (!cookieValue) {
    return null;
  }
  const [encodedPayload, signature, extra] = cookieValue.split('.');
  if (!encodedPayload || !signature || extra !== undefined) {
    return null;
  }
  if (!timingSafeEqual(signature, signValue(encodedPayload, options.sessionSecret))) {
    return null;
  }
  const payload = parsePayload(encodedPayload);
  if (!payload || payload.expires_at <= now || payload.username !== options.username) {
    return null;
  }
  return { username: payload.username };
}

export function validateAdminCredentials(input: { password: string; username: string }, options: AdminAuthOptions): boolean {
  return timingSafeEqual(input.username, options.username) && timingSafeEqual(input.password, options.password);
}

export function serializeSessionCookie(value: string, options: AdminAuthOptions): string {
  return serializeCookie(options.cookieName, value, {
    httpOnly: true,
    maxAge: Math.round(options.sessionTtlHours * 60 * 60),
    sameSite: options.cookieSameSite,
    secure: options.cookieSecure
  });
}

export function serializeExpiredSessionCookie(options: AdminAuthOptions): string {
  return serializeCookie(options.cookieName, '', {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    sameSite: options.cookieSameSite,
    secure: options.cookieSecure
  });
}

export function requireAdminAuth(options: AdminAuthOptions) {
  return (request: Request, response: Response, next: NextFunction) => {
    const identity = verifySessionCookie(readCookie(request.headers.cookie, options.cookieName), options);
    if (!identity) {
      response.status(401).json({ error: { message: 'Authentication required' } });
      return;
    }
    response.locals.admin = identity;
    next();
  };
}

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) {
      return rawValue.join('=');
    }
  }
  return undefined;
}

function parsePayload(encodedPayload: string): SessionPayload | null {
  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as Partial<SessionPayload>;
    if (typeof payload.username !== 'string' || typeof payload.expires_at !== 'number') {
      return null;
    }
    return { expires_at: payload.expires_at, username: payload.username };
  } catch {
    return null;
  }
}

function signValue(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBuffer = encoder.encode(left);
  const rightBuffer = encoder.encode(right);
  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function serializeCookie(
  name: string,
  value: string,
  attributes: {
    expires?: Date;
    httpOnly: boolean;
    maxAge: number;
    sameSite: AdminSameSite;
    secure: boolean;
  }
): string {
  const parts = [`${name}=${value}`, 'Path=/'];
  if (attributes.maxAge >= 0) {
    parts.push(`Max-Age=${attributes.maxAge}`);
  }
  if (attributes.expires) {
    parts.push(`Expires=${attributes.expires.toUTCString()}`);
  }
  if (attributes.httpOnly) {
    parts.push('HttpOnly');
  }
  if (attributes.secure) {
    parts.push('Secure');
  }
  parts.push(`SameSite=${attributes.sameSite}`);
  return parts.join('; ');
}
```

- [ ] **Step 4: Wire auth into app routing**

Modify `ludora-admin-service/src/app.ts`:

```ts
import type { AdminAuthOptions } from './auth/adminAuth.js';
import { requireAdminAuth } from './auth/adminAuth.js';
import { createAuthRouter } from './routes/auth.js';
```

Add `adminAuth?: AdminAuthOptions;` to `CreateAppOptions`.

Change CORS and router mounting to:

```ts
  app.use(cors({ credentials: Boolean(adminAuth), origin: corsOrigin }));
  app.use(express.json());
  app.use(createHealthRouter());
  if (adminAuth) {
    app.use(createAuthRouter(adminAuth));
    app.use(requireAdminAuth(adminAuth));
  }
  app.use(createDiscoveryRouter(database, itemMatchingService, bggItemImporter, productDetailsEnrichmentService));
```

- [ ] **Step 5: Create a temporary auth router shell**

Create `ludora-admin-service/src/routes/auth.ts`:

```ts
import express from 'express';

import {
  createSessionCookie,
  readCookie,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
  validateAdminCredentials,
  verifySessionCookie,
  type AdminAuthOptions
} from '../auth/adminAuth.js';

export function createAuthRouter(options: AdminAuthOptions) {
  const router = express.Router();

  router.post('/admin/auth/login', (request, response) => {
    const body = request.body as { password?: unknown; username?: unknown };
    if (typeof body.username !== 'string' || typeof body.password !== 'string') {
      response.status(400).json({ error: { message: 'username and password are required' } });
      return;
    }
    if (!validateAdminCredentials({ password: body.password, username: body.username }, options)) {
      response.status(401).json({ error: { message: 'Invalid username or password' } });
      return;
    }
    const session = createSessionCookie({ username: options.username }, options);
    response.setHeader('Set-Cookie', serializeSessionCookie(session, options));
    response.json({ data: { username: options.username } });
  });

  router.get('/admin/auth/me', (request, response) => {
    const identity = verifySessionCookie(readCookie(request.headers.cookie, options.cookieName), options);
    if (!identity) {
      response.status(401).json({ error: { message: 'Authentication required' } });
      return;
    }
    response.json({ data: identity });
  });

  router.post('/admin/auth/logout', (_request, response) => {
    response.setHeader('Set-Cookie', serializeExpiredSessionCookie(options));
    response.json({ data: { ok: true } });
  });

  return router;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- src/app.test.ts -t "requires authentication|sets an HttpOnly session cookie"` from `ludora-admin-service/`.

Expected: PASS for both auth tests.

- [ ] **Step 7: Commit**

```bash
git add ludora-admin-service/src/app.ts ludora-admin-service/src/app.test.ts ludora-admin-service/src/auth/adminAuth.ts ludora-admin-service/src/routes/auth.ts
git commit -m "feat: add admin session authentication"
```

### Task 2: Service Auth Edge Cases and Config

**Files:**
- Modify: `ludora-admin-service/src/config.ts`
- Modify: `ludora-admin-service/src/server.ts`
- Test: `ludora-admin-service/src/app.test.ts`
- Test: `ludora-admin-service/src/config.test.ts`

- [ ] **Step 1: Write failing auth edge-case tests**

Add tests to `ludora-admin-service/src/app.test.ts`:

```ts
  it('rejects missing and wrong login credentials', async () => {
    const app = createApp({ database: idleDatabase(), adminAuth: authOptions });

    const missingResponse = await request(app).post('/admin/auth/login').send({ username: 'admin' });
    const wrongResponse = await request(app).post('/admin/auth/login').send({
      password: 'wrong-password',
      username: 'admin'
    });

    expect(missingResponse.status).toBe(400);
    expect(missingResponse.body).toEqual({ error: { message: 'username and password are required' } });
    expect(wrongResponse.status).toBe(401);
    expect(wrongResponse.body).toEqual({ error: { message: 'Invalid username or password' } });
  });

  it('rejects tampered admin session cookies', async () => {
    const app = createApp({ database: idleDatabase(), adminAuth: authOptions });
    const loginResponse = await request(app).post('/admin/auth/login').send({
      password: 'secret-password',
      username: 'admin'
    });
    const cookie = loginResponse.headers['set-cookie'][0].replace('admin', 'other-admin');

    const response = await request(app).get('/stores').set('Cookie', cookie);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { message: 'Authentication required' } });
  });

  it('clears admin session cookies on logout', async () => {
    const app = createApp({ database: idleDatabase(), adminAuth: authOptions });
    const loginResponse = await request(app).post('/admin/auth/login').send({
      password: 'secret-password',
      username: 'admin'
    });

    const logoutResponse = await request(app).post('/admin/auth/logout').set('Cookie', loginResponse.headers['set-cookie']);

    expect(logoutResponse.status).toBe(200);
    expect(logoutResponse.body).toEqual({ data: { ok: true } });
    expect(logoutResponse.headers['set-cookie'][0]).toContain('Max-Age=0');
  });
```

- [ ] **Step 2: Write failing config tests**

Add tests to `ludora-admin-service/src/config.test.ts`:

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/app.test.ts -t "rejects missing|rejects tampered|clears admin" && npm test -- src/config.test.ts -t "admin auth|ADMIN_SESSION_TTL"` from `ludora-admin-service/`.

Expected: app tests may pass after Task 1, but config tests fail because `loadConfig().adminAuth` is not implemented.

- [ ] **Step 4: Implement config loading**

Modify `ludora-admin-service/src/config.ts`:

```ts
import type { AdminAuthOptions, AdminSameSite } from './auth/adminAuth.js';
```

Add `adminAuth: AdminAuthOptions;` to `Config`.

Add `adminAuth: readAdminAuthConfig(),` in `loadConfig()`.

Add:

```ts
function readAdminAuthConfig(): AdminAuthOptions {
  return {
    cookieName: readEnvWithDefault('ADMIN_SESSION_COOKIE_NAME', 'ludora_admin_session'),
    cookieSameSite: readAdminCookieSameSite(),
    cookieSecure: readAdminCookieSecure(),
    password: readRequiredEnv('ADMIN_PASSWORD'),
    sessionSecret: readRequiredEnv('ADMIN_SESSION_SECRET'),
    sessionTtlHours: readAdminSessionTtlHours(),
    username: readRequiredEnv('ADMIN_USERNAME')
  };
}

function readRequiredEnv(key: string): string {
  const value = readOptionalEnv(key);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function readAdminSessionTtlHours(): number {
  const rawValue = readEnvWithDefault('ADMIN_SESSION_TTL_HOURS', '12');
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('ADMIN_SESSION_TTL_HOURS must be a positive number');
  }
  return value;
}

function readAdminCookieSecure(): boolean {
  const rawValue = readOptionalEnv('ADMIN_SESSION_COOKIE_SECURE');
  if (!rawValue) {
    return process.env.NODE_ENV === 'production';
  }
  if (rawValue === 'true') {
    return true;
  }
  if (rawValue === 'false') {
    return false;
  }
  throw new Error('ADMIN_SESSION_COOKIE_SECURE must be true or false');
}

function readAdminCookieSameSite(): AdminSameSite {
  const value = readEnvWithDefault('ADMIN_SESSION_COOKIE_SAMESITE', 'lax').toLowerCase();
  if (value === 'lax' || value === 'none' || value === 'strict') {
    return value;
  }
  throw new Error('ADMIN_SESSION_COOKIE_SAMESITE must be lax, none, or strict');
}
```

- [ ] **Step 5: Pass auth config from server**

Modify `ludora-admin-service/src/server.ts` in the `createApp` call:

```ts
  adminAuth: config.adminAuth,
```

- [ ] **Step 6: Run service tests**

Run: `npm test -- src/app.test.ts src/config.test.ts` from `ludora-admin-service/`.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ludora-admin-service/src/app.test.ts ludora-admin-service/src/config.test.ts ludora-admin-service/src/config.ts ludora-admin-service/src/server.ts
git commit -m "feat: load admin auth configuration"
```

### Task 3: UI API Auth Client

**Files:**
- Modify: `ludora-admin-ui/src/api/client.ts`
- Test: `ludora-admin-ui/src/api/client.test.ts`

- [ ] **Step 1: Write failing API client tests**

Add tests to `ludora-admin-ui/src/api/client.test.ts`:

```ts
  it('sends credentials with admin API requests', async () => {
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await adminApi.getStores();

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/stores', { credentials: 'include' });
  });

  it('logs in with credentials included', async () => {
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { username: 'admin' } }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.login({ password: 'secret-password', username: 'admin' })).resolves.toEqual({ username: 'admin' });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/auth/login', {
      body: JSON.stringify({ password: 'secret-password', username: 'admin' }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/api/client.test.ts -t "credentials|logs in"` from `ludora-admin-ui/`.

Expected: FAIL because fetch calls do not include credentials, default URL is `http://localhost:4001`, and `adminApi.login` does not exist.

- [ ] **Step 3: Implement API auth support**

Modify `ludora-admin-ui/src/api/client.ts`:

```ts
const API_URL = import.meta.env.VITE_ADMIN_API_URL ?? 'http://127.0.0.1:4001';
```

Add types:

```ts
export type AdminIdentity = {
  username: string;
};

export type LoginInput = {
  password: string;
  username: string;
};
```

Add:

```ts
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}
```

Update `fetchEnvelope`:

```ts
  const response = await fetch(url, {
    credentials: 'include',
    ...(init ?? {})
  });

  if (response.status === 401) {
    unauthorizedHandler?.();
  }
```

Add auth methods at the start of `adminApi`:

```ts
  getCurrentAdmin: () => fetchData<AdminIdentity>('/admin/auth/me'),
  login: (input: LoginInput) => sendJson<AdminIdentity>('/admin/auth/login', 'POST', input),
  logout: () =>
    fetchData<{ ok: true }>('/admin/auth/logout', {
      credentials: 'include',
      method: 'POST'
    }),
```

- [ ] **Step 4: Run API client tests**

Run: `npm test -- src/api/client.test.ts -t "credentials|logs in"` from `ludora-admin-ui/`.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ludora-admin-ui/src/api/client.ts ludora-admin-ui/src/api/client.test.ts
git commit -m "feat: add admin auth API client"
```

### Task 4: UI Login Flow

**Files:**
- Create: `ludora-admin-ui/src/components/LoginPage.tsx`
- Modify: `ludora-admin-ui/src/components/AdminLayout.tsx`
- Modify: `ludora-admin-ui/src/App.tsx`
- Test: `ludora-admin-ui/src/App.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Add tests to `ludora-admin-ui/src/App.test.tsx`:

```tsx
  it('renders login when the admin session is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Authentication required' } }), {
        headers: { 'Content-Type': 'application/json' },
        status: 401
      })
    );

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Ludora Admin' })).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Store Candidates/i })).not.toBeInTheDocument();
  });

  it('logs in and renders the admin shell', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return new Response(JSON.stringify({ error: { message: 'Authentication required' } }), {
          headers: { 'Content-Type': 'application/json' },
          status: 401
        });
      }
      if (url.pathname === '/admin/auth/login' && init?.method === 'POST') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/discovery/stores') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('link', { name: /Store Candidates/i })).toBeInTheDocument();
  });

  it('logs out and returns to login', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/admin/auth/me') {
        return jsonResponse({ username: 'admin' });
      }
      if (url.pathname === '/discovery/stores') {
        return jsonResponse([]);
      }
      if (url.pathname === '/admin/auth/logout' && init?.method === 'POST') {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/App.test.tsx -t "login|logs in|logs out"` from `ludora-admin-ui/`.

Expected: FAIL because there is no login screen or logout button.

- [ ] **Step 3: Add login screen component**

Create `ludora-admin-ui/src/components/LoginPage.tsx`:

```tsx
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { type FormEvent, useState } from 'react';

type LoginPageProps = {
  error: string | null;
  isSubmitting: boolean;
  onSubmit: (input: { password: string; username: string }) => Promise<void>;
};

export function LoginPage({ error, isSubmitting, onSubmit }: LoginPageProps) {
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit({ password, username });
  }

  return (
    <Box sx={{ alignItems: 'center', bgcolor: 'grey.100', display: 'flex', minHeight: '100vh', px: 2 }}>
      <Paper component="form" elevation={0} onSubmit={handleSubmit} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, mx: 'auto', p: 4, width: '100%', maxWidth: 420 }}>
        <Stack spacing={2.5}>
          <Box sx={{ alignItems: 'center', display: 'flex', gap: 1.5 }}>
            <LockOutlinedIcon color="primary" />
            <Typography component="h1" variant="h5" sx={{ fontSize: '1.35rem', fontWeight: 700 }}>
              Ludora Admin
            </Typography>
          </Box>
          {error ? <Alert severity="error">{error}</Alert> : null}
          <TextField autoComplete="username" autoFocus fullWidth label="Username" name="username" value={username} onChange={(event) => setUsername(event.target.value)} />
          <TextField autoComplete="current-password" fullWidth label="Password" name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          <Button disabled={isSubmitting} fullWidth type="submit" variant="contained">
            Sign in
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
}
```

- [ ] **Step 4: Add logout support to AdminLayout**

Modify `ludora-admin-ui/src/components/AdminLayout.tsx`:

```tsx
import LogoutIcon from '@mui/icons-material/Logout';
import { AppBar, Box, Button, Divider, Drawer, List, ListItemButton, ListItemIcon, ListItemText, Toolbar, Typography } from '@mui/material';
```

Add `onLogout: () => void;` to `AdminLayoutProps`.

Change the component signature:

```tsx
export function AdminLayout({ activeSection, children, onLogout, onNavigate }: AdminLayoutProps) {
```

Add inside the top `Toolbar` after the title:

```tsx
          <Box sx={{ flexGrow: 1 }} />
          <Button color="inherit" size="small" startIcon={<LogoutIcon fontSize="small" />} onClick={onLogout}>
            Sign out
          </Button>
```

- [ ] **Step 5: Wire auth state in App**

Modify `ludora-admin-ui/src/App.tsx`:

```tsx
import { Box, CircularProgress, CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { useEffect, useState } from 'react';
import { adminApi, setUnauthorizedHandler, type AdminIdentity, type LoginInput } from './api/client';
import { LoginPage } from './components/LoginPage';
```

Add:

```tsx
type AuthState =
  | { status: 'checking' }
  | { admin: AdminIdentity; status: 'authenticated' }
  | { error: string | null; status: 'unauthenticated' };
```

In `App`, add:

```tsx
  const [authState, setAuthState] = useState<AuthState>({ status: 'checking' });
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  useEffect(() => {
    let isActive = true;
    setUnauthorizedHandler(() => {
      setAuthState({ error: null, status: 'unauthenticated' });
    });
    adminApi
      .getCurrentAdmin()
      .then((admin) => {
        if (isActive) {
          setAuthState({ admin, status: 'authenticated' });
        }
      })
      .catch(() => {
        if (isActive) {
          setAuthState({ error: null, status: 'unauthenticated' });
        }
      });
    return () => {
      isActive = false;
      setUnauthorizedHandler(null);
    };
  }, []);

  async function handleLogin(input: LoginInput) {
    setIsLoggingIn(true);
    try {
      const admin = await adminApi.login(input);
      setAuthState({ admin, status: 'authenticated' });
    } catch (error) {
      setAuthState({
        error: error instanceof Error ? error.message : 'Unable to sign in',
        status: 'unauthenticated'
      });
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function handleLogout() {
    try {
      await adminApi.logout();
    } finally {
      setAuthState({ error: null, status: 'unauthenticated' });
    }
  }
```

Before rendering `AdminLayout`, branch:

```tsx
      {authState.status === 'checking' ? (
        <Box sx={{ alignItems: 'center', display: 'flex', justifyContent: 'center', minHeight: '100vh' }}>
          <CircularProgress aria-label="Checking admin session" />
        </Box>
      ) : authState.status === 'unauthenticated' ? (
        <LoginPage error={authState.error} isSubmitting={isLoggingIn} onSubmit={handleLogin} />
      ) : (
        <AdminLayout activeSection={route.section} onLogout={handleLogout} onNavigate={navigate}>
          {renderSection(route, navigate, navigateToFrontPageCategoryProducts, navigateToItem)}
        </AdminLayout>
      )}
```

- [ ] **Step 6: Run UI tests**

Run: `npm test -- src/App.test.tsx -t "login|logs in|logs out"` from `ludora-admin-ui/`.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ludora-admin-ui/src/App.tsx ludora-admin-ui/src/App.test.tsx ludora-admin-ui/src/components/AdminLayout.tsx ludora-admin-ui/src/components/LoginPage.tsx
git commit -m "feat: add admin login flow"
```

### Task 5: Final Verification and Deployment Notes

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add admin auth environment documentation**

Modify `README.md` to include:

```md
### Admin Authentication

The deployed admin service requires these environment variables:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`

Optional session settings:

- `ADMIN_SESSION_TTL_HOURS`, default `12`
- `ADMIN_SESSION_COOKIE_NAME`, default `ludora_admin_session`
- `ADMIN_SESSION_COOKIE_SECURE`, default `true` when `NODE_ENV=production`, otherwise `false`
- `ADMIN_SESSION_COOKIE_SAMESITE`, default `lax`

For split-domain HTTPS deployments, set `ADMIN_SESSION_COOKIE_SECURE=true`, `ADMIN_SESSION_COOKIE_SAMESITE=none`, and `CORS_ORIGIN` to the exact admin UI origin.
```

- [ ] **Step 2: Run service verification**

Run from `ludora-admin-service/`:

```bash
npm test
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 3: Run UI verification**

Run from `ludora-admin-ui/`:

```bash
npm test
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 4: Commit final docs**

```bash
git add README.md
git commit -m "docs: document admin authentication settings"
```

- [ ] **Step 5: Push implementation**

Run from `ludora-admin/`:

```bash
git push origin main
```

Expected: push succeeds.

## Self-Review Notes

- Spec coverage: service auth, UI auth, cookie/CORS behavior, error handling, tests, and rollout documentation are covered by Tasks 1 through 5.
- Plan scan: every task includes concrete files, commands, and implementation details.
- Type consistency: `AdminAuthOptions`, `AdminIdentity`, `LoginInput`, and route payload names are consistent across service and UI tasks.
