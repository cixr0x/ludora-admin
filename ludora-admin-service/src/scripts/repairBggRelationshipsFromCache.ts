import 'dotenv/config';

import { applyBggRelationshipRepair, loadBggRelationshipRepairPlan } from '../bgg/bggRelationshipRepair.js';
import { createDatabase } from '../db.js';

const databaseUrl = process.env.LUDORA_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('LUDORA_DATABASE_URL is required');
}

const apply = process.argv.includes('--apply');
const database = createDatabase(databaseUrl);

try {
  if (apply) {
    const result = await applyBggRelationshipRepair(database);
    console.log(
      JSON.stringify(
        {
          applied: true,
          deletedRelationshipRows: result.deletedRelationshipRows,
          parentRowsUpdated: result.parentRowsUpdated,
          plan: reportPayload(result.plan),
          upsertedRelationshipRows: result.upsertedRelationshipRows
        },
        null,
        2
      )
    );
  } else {
    const plan = await loadBggRelationshipRepairPlan(database);
    console.log(JSON.stringify({ applied: false, ...reportPayload(plan) }, null, 2));
  }
} finally {
  await database.close?.();
}

function reportPayload(plan: Awaited<ReturnType<typeof loadBggRelationshipRepairPlan>>) {
  return {
    summary: plan.summary,
    samples: {
      missingRelationships: plan.missingRelationships.slice(0, 10),
      missingTargets: plan.missingTargets.slice(0, 10),
      parentUpdates: plan.parentUpdates.slice(0, 10),
      preservedNonBggRelationshipIds: plan.preservedNonBggRelationshipIds.slice(0, 10),
      relationshipIdsToDelete: plan.relationshipIdsToDelete.slice(0, 10)
    }
  };
}
