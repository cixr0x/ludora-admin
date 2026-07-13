import { Router } from 'express';

import type { Database } from '../db.js';
import type { StoreProfileDetectionService } from '../storeProfileDetection/storeProfileDetectionService.js';

type StoreInput = {
  canonical_domain: string;
  city: string;
  country: string;
  facebook_url: string;
  instagram_url: string;
  logo_url: string;
  name: string;
  platform: string;
  state: string;
  status: string;
  website_url: string;
};

const storeSelect = `
  id, name, canonical_domain, website_url, platform, instagram_url,
  facebook_url, city, state, country, logo_url, status, created_at, updated_at
`;

export function createStoresRouter(
  database: Database,
  storeProfileDetectionService?: StoreProfileDetectionService
): Router {
  const router = Router();

  router.post('/admin/store-profile-detections', async (request, response, next) => {
    try {
      if (!storeProfileDetectionService) {
        throw httpError(503, 'Store profile detection service is not configured');
      }
      const websiteUrl = stringField((request.body ?? {}) as Record<string, unknown>, 'website_url');
      if (!websiteUrl) {
        throw httpError(400, 'website_url is required');
      }
      response.json({ data: await storeProfileDetectionService.detect(websiteUrl) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/stores', async (request, response, next) => {
    try {
      const input = parseStoreInput(request.body);
      const result = await database.query(
        `
        insert into stores (
          name,
          canonical_domain,
          website_url,
          platform,
          instagram_url,
          facebook_url,
          city,
          state,
          country,
          logo_url,
          status,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
        returning ${storeSelect}
        `,
        storeParams(input)
      );
      response.status(201).json({ data: result.rows[0] });
    } catch (error) {
      if (isUniqueViolation(error)) {
        next(httpError(409, 'A store with this canonical domain already exists'));
        return;
      }
      next(error);
    }
  });

  return router;
}

function parseStoreInput(body: unknown): StoreInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const input: StoreInput = {
    canonical_domain: stringField(value, 'canonical_domain').toLowerCase().replace(/^www\./, ''),
    city: stringField(value, 'city'),
    country: stringField(value, 'country') || 'Mexico',
    facebook_url: stringField(value, 'facebook_url'),
    instagram_url: stringField(value, 'instagram_url'),
    logo_url: stringField(value, 'logo_url'),
    name: stringField(value, 'name'),
    platform: stringField(value, 'platform'),
    state: stringField(value, 'state'),
    status: stringField(value, 'status') || 'active',
    website_url: stringField(value, 'website_url')
  };
  if (!input.name || !input.canonical_domain || !input.website_url) {
    throw httpError(400, 'name, canonical_domain, and website_url are required');
  }
  return input;
}

function storeParams(input: StoreInput): unknown[] {
  return [
    input.name,
    input.canonical_domain,
    input.website_url,
    input.platform,
    input.instagram_url,
    input.facebook_url,
    input.city,
    input.state,
    input.country,
    input.logo_url,
    input.status
  ];
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' || typeof field === 'number' ? String(field).trim() : '';
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === '23505');
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
