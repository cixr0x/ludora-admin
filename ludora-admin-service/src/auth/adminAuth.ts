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

export function verifySessionCookie(
  cookieValue: string | undefined,
  options: AdminAuthOptions,
  now = Date.now()
): AdminIdentity | null {
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
