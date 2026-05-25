import { Router } from 'express';

import type { Database } from '../db.js';

export function createDiscoveryRouter(database: Database): Router {
  const router = Router();

  router.get('/discovery/stores', async (_request, response, next) => {
    try {
      const result = await database.query(
        'select * from discovery_store_candidates order by last_seen_at desc limit 200'
      );
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get('/discovery/listings', async (_request, response, next) => {
    try {
      const result = await database.query(
        'select * from discovery_listing_candidates order by last_seen_at desc limit 200'
      );
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/review-tasks', async (_request, response, next) => {
    try {
      const result = await database.query('select * from admin_review_tasks order by updated_at desc limit 200');
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
