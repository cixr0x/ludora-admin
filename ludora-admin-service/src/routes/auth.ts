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
