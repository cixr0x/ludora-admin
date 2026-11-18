import { Router } from 'express';

import { requireAdminAuth, type AdminAuthOptions } from '../auth/adminAuth.js';
import type { Database } from '../db.js';
import { parsePagination } from './pagination.js';

export function createFeedbackRouter(database: Database, adminAuth: AdminAuthOptions): Router {
  const router = Router();

  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.use(requireAdminAuth({ ...adminAuth, internalApiToken: undefined }));
  router.get('/', async (request, response, next) => {
    try {
      const { page, pageSize } = parsePagination(request.query);
      const result = await database.query(
        `select submission.id::text as id, submission.created_at, submission.name, submission.email, submission.message
         from contact_form_submissions as submission
         order by submission.created_at desc, submission.id desc
         limit $1 offset $2`,
        [pageSize, page * pageSize]
      );
      const count = await database.query('select count(*) as total from contact_form_submissions');
      const countRow = count.rows[0] as { total: string | number } | undefined;
      response.json({ data: result.rows, meta: { page, page_size: pageSize, total: Number(countRow?.total ?? 0) } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
