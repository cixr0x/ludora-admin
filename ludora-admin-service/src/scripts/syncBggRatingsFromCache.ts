import 'dotenv/config';

import { applyBggRatingSync, loadBggRatingSyncPlan } from '../bgg/bggRatingSync.js';
import { createDatabase } from '../db.js';

const databaseUrl = process.env.LUDORA_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('LUDORA_DATABASE_URL is required');
}

const apply = process.argv.includes('--apply');
const database = createDatabase(databaseUrl);

try {
  if (apply) {
    const result = await applyBggRatingSync(database);
    console.log(
      JSON.stringify(
        {
          applied: true,
          updatedRatingRows: result.updatedRatingRows,
          plan: reportPayload(result.plan)
        },
        null,
        2
      )
    );
  } else {
    const plan = await loadBggRatingSyncPlan(database);
    console.log(JSON.stringify({ applied: false, ...reportPayload(plan) }, null, 2));
  }
} finally {
  await database.close?.();
}

function reportPayload(plan: Awaited<ReturnType<typeof loadBggRatingSyncPlan>>) {
  return {
    summary: plan.summary,
    samples: {
      malformedCacheBggIds: plan.malformedCacheBggIds.slice(0, 10),
      missingCacheBggIds: plan.missingCacheBggIds.slice(0, 10),
      missingRatingBggIds: plan.missingRatingBggIds.slice(0, 10),
      ratingUpdates: plan.ratingUpdates.slice(0, 10)
    }
  };
}
