import { Router } from 'express';

import type { Database } from '../db.js';

type TikTokVideoIdentity = {
  user: string;
  videoId: string;
};

type TutorialLinkInput = {
  title: string;
  url: string;
};

const TIKTOK_SOURCE = 'tiktok';
const TUTORIAL_LANGUAGE = 'es';
const TUTORIAL_STATUS = 'published';

const tutorialLinkSelect = 'id, item_id, url, title, language, source, status, created_at';

export function createTutorialCurationRouter(database: Database): Router {
  const router = Router();

  router.get('/admin/tutorial-curation/next', async (request, response, next) => {
    try {
      const excludedItemIds = parseExcludedItemIds(request.query.exclude_item_ids);
      const result = await database.query(
        `
        select
          i.id,
          i.canonical_name,
          i.canonical_name_es,
          i.description,
          i.description_es,
          i.image_url,
          i.image_url_es,
          i.item_type
        from active_item i
        where i.is_expansion = false
          and i.id <> all($2::bigint[])
          and not exists (
            select 1
            from tutorial_links tl
            where tl.item_id = i.id
              and tl.source = $1
              and tl.status in ('candidate', 'published')
          )
        order by coalesce(nullif(i.canonical_name_es, ''), i.canonical_name) asc, i.id asc
        limit 1
        `,
        [TIKTOK_SOURCE, excludedItemIds]
      );

      response.json({ data: result.rows[0] ?? null });
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/tutorial-curation/items/:id/tutorial-links', async (request, response, next) => {
    try {
      const itemId = parsePositiveInteger(request.params.id, 'item_id');
      const input = parseTutorialLinkInput(request.body);

      const itemResult = await database.query('select id from items where id = $1', [itemId]);
      if (!itemResult.rows[0]) {
        throw httpError(404, 'Item not found');
      }

      const existingResult = await database.query(
        `
        select id
        from tutorial_links
        where item_id = $1
          and url = $2
        limit 1
        `,
        [itemId, input.url]
      );

      const existingId = rowId(existingResult.rows[0]);
      if (existingId !== null) {
        const updateResult = await database.query(
          `
          update tutorial_links
          set title = $1,
              language = $2,
              source = $3,
              status = $4
          where id = $5
          returning ${tutorialLinkSelect}
          `,
          [input.title, TUTORIAL_LANGUAGE, TIKTOK_SOURCE, TUTORIAL_STATUS, existingId]
        );
        response.json({ data: updateResult.rows[0] });
        return;
      }

      const insertResult = await database.query(
        `
        insert into tutorial_links (
          item_id,
          url,
          title,
          language,
          source,
          status
        )
        values ($1, $2, $3, $4, $5, $6)
        returning ${tutorialLinkSelect}
        `,
        [itemId, input.url, input.title, TUTORIAL_LANGUAGE, TIKTOK_SOURCE, TUTORIAL_STATUS]
      );

      response.status(201).json({ data: insertResult.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function parseExcludedItemIds(value: unknown): number[] {
  const rawValues = Array.isArray(value) ? value : [value];
  const ids = new Set<number>();
  for (const rawValue of rawValues) {
    if (rawValue === undefined) {
      continue;
    }
    for (const rawPart of String(rawValue).split(',')) {
      const trimmed = rawPart.trim();
      if (!trimmed) {
        continue;
      }
      ids.add(parsePositiveInteger(trimmed, 'exclude_item_ids'));
    }
  }
  return [...ids];
}

function parseTutorialLinkInput(body: unknown): TutorialLinkInput {
  if (!isRecord(body)) {
    throw httpError(400, 'Request body must be an object');
  }

  const url = textValue(body.url);
  const identity = tiktokVideoIdentityFromUrl(url);
  if (!identity) {
    throw httpError(400, 'url must be a TikTok video URL');
  }

  return {
    title: textValue(body.title) || textValue(body.caption) || `Video de TikTok por @${identity.user}`,
    url: `https://www.tiktok.com/@${identity.user}/video/${identity.videoId}`
  };
}

function tiktokVideoIdentityFromUrl(value: string): TikTokVideoIdentity | null {
  try {
    const parsed = new URL(value);
    if (!parsed.hostname.toLowerCase().endsWith('tiktok.com')) {
      return null;
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    const userIndex = parts.findIndex((part) => part.startsWith('@'));
    if (userIndex < 0 || parts[userIndex + 1] !== 'video') {
      return null;
    }

    const videoId = parts[userIndex + 2] ?? '';
    if (!/^\d+$/.test(videoId)) {
      return null;
    }

    return {
      user: parts[userIndex].replace(/^@/, ''),
      videoId
    };
  } catch {
    return null;
  }
}

function parsePositiveInteger(value: unknown, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw httpError(400, `${key} must be a positive integer`);
  }
  return parsed;
}

function rowId(row: unknown): number | null {
  if (!isRecord(row)) {
    return null;
  }

  const parsed = Number(row.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
