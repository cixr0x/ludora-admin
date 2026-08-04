import { readFileSync } from 'node:fs';

import {
  HTTP_MESSAGE_SIGNATURES_DIRECTORY,
  MediaType,
  directoryResponseHeaders,
  signatureHeaders
} from 'web-bot-auth';
import { signerFromJWK } from 'web-bot-auth/crypto';

const REQUEST_SIGNATURE_TTL_MS = 60_000;
const DIRECTORY_SIGNATURE_TTL_MS = 10 * 60_000;
const DIRECTORY_CACHE_SECONDS = 5 * 60;

export type WebBotAuthRequestHeaders = {
  'Signature-Agent': string;
  'Signature-Input': string;
  Signature: string;
};

export type WebBotAuthDirectoryResponse = {
  body: { keys: JsonWebKey[] };
  headers: {
    'Cache-Control': string;
    'Content-Type': string;
    'Signature-Input': string;
    Signature: string;
  };
};

export type WebBotAuthService = {
  contactEmail: string;
  identityOrigin: string;
  createDirectoryResponse(now?: Date): Promise<WebBotAuthDirectoryResponse>;
  createRequestHeaders(targetUrl: string, method?: string, now?: Date): Promise<WebBotAuthRequestHeaders>;
};

export async function createWebBotAuthService(options: {
  contactEmail: string;
  identityOrigin: string;
  privateJwkPath: string;
}): Promise<WebBotAuthService> {
  const identityOrigin = normalizeIdentityOrigin(options.identityOrigin);
  const contactEmail = options.contactEmail.trim();
  if (!contactEmail || !contactEmail.includes('@')) {
    throw new Error('LUDORA_WEB_BOT_AUTH_CONTACT_EMAIL must be a valid contact email');
  }

  const privateJwk = readPrivateJwk(options.privateJwkPath);
  const signer = await signerFromJWK(privateJwk);
  if (signer.alg !== 'ed25519') {
    throw new Error('LUDORA Web Bot Auth requires an Ed25519 private key');
  }
  const publicJwk = publicJwkFromPrivate(privateJwk);
  const signatureAgent = `"${identityOrigin}"`;

  return {
    contactEmail,
    identityOrigin,
    async createDirectoryResponse(now = new Date()): Promise<WebBotAuthDirectoryResponse> {
      const body = { keys: [publicJwk] };
      const contentType = MediaType.HTTP_MESSAGE_SIGNATURES_DIRECTORY;
      const request = new Request(`${identityOrigin}${HTTP_MESSAGE_SIGNATURES_DIRECTORY}`, {
        headers: { Accept: contentType },
        method: 'GET'
      });
      const response = new Response(JSON.stringify(body), {
        headers: { 'Content-Type': contentType },
        status: 200
      });
      const signedHeaders = await directoryResponseHeaders(
        { request, response },
        [signer],
        {
          created: now,
          expires: new Date(now.getTime() + DIRECTORY_SIGNATURE_TTL_MS)
        }
      );

      return {
        body,
        headers: {
          'Cache-Control': `public, max-age=${DIRECTORY_CACHE_SECONDS}`,
          'Content-Type': contentType,
          'Signature-Input': signedHeaders['Signature-Input'],
          Signature: signedHeaders.Signature
        }
      };
    },
    async createRequestHeaders(targetUrl: string, method = 'GET', now = new Date()): Promise<WebBotAuthRequestHeaders> {
      const url = validateTargetUrl(targetUrl);
      const request = new Request(url, {
        headers: { 'Signature-Agent': signatureAgent },
        method: validateMethod(method)
      });
      const signedHeaders = await signatureHeaders(request, signer, {
        created: now,
        expires: new Date(now.getTime() + REQUEST_SIGNATURE_TTL_MS)
      });

      return {
        'Signature-Agent': signatureAgent,
        'Signature-Input': signedHeaders['Signature-Input'],
        Signature: signedHeaders.Signature
      };
    }
  };
}

function readPrivateJwk(privateJwkPath: string): JsonWebKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(privateJwkPath, 'utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Web Bot Auth private JWK: ${detail}`);
  }
  if (!isJsonWebKey(parsed) || !parsed.d) {
    throw new Error('Web Bot Auth private JWK must contain Ed25519 kty, crv, x, and d values');
  }
  return parsed;
}

function isJsonWebKey(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const jwk = value as JsonWebKey;
  return jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && typeof jwk.x === 'string' && typeof jwk.d === 'string';
}

function publicJwkFromPrivate(privateJwk: JsonWebKey): JsonWebKey {
  return {
    crv: 'Ed25519',
    kty: 'OKP',
    x: privateJwk.x
  };
}

function normalizeIdentityOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('LUDORA_WEB_BOT_AUTH_IDENTITY_ORIGIN must be a valid HTTPS origin');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('LUDORA_WEB_BOT_AUTH_IDENTITY_ORIGIN must be an HTTPS origin without path, query, or credentials');
  }
  return parsed.origin;
}

function validateTargetUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Web Bot Auth target URL is invalid');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Web Bot Auth target URL must use HTTPS without credentials');
  }
  return parsed.toString();
}

function validateMethod(value: string): string {
  const method = value.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(method)) {
    throw new Error('Web Bot Auth request method is invalid');
  }
  return method;
}
