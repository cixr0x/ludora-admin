import type { DescriptionGenerationService } from '../descriptionGeneration/descriptionGenerationService.js';
import type { Database } from '../db.js';

type StoreItemTranslationSource = {
  boardgame_name: string;
  description_es: string;
  item_description: string;
  item_id: number;
  listing_status: string;
  store_item_description: string;
};

export type StoreItemTranslateAndApproveStartResult = {
  candidateId: number;
  status: 'ALREADY_PROCESSING' | 'PROCESSING';
};

export type StoreItemTranslateAndApproveWorkflow = {
  start(candidateId: number): Promise<StoreItemTranslateAndApproveStartResult>;
};

type WorkflowLogger = {
  error(message: string, error: unknown): void;
};

export function createStoreItemTranslateAndApproveWorkflow(
  database: Database,
  descriptionGenerationService: DescriptionGenerationService,
  logger: WorkflowLogger = console
): StoreItemTranslateAndApproveWorkflow {
  const inFlightCandidateIds = new Set<number>();

  return {
    async start(candidateId: number): Promise<StoreItemTranslateAndApproveStartResult> {
      if (inFlightCandidateIds.has(candidateId)) {
        return { candidateId, status: 'ALREADY_PROCESSING' };
      }

      const source = await loadTranslationSource(database, candidateId);
      validateTranslationSource(source);

      inFlightCandidateIds.add(candidateId);
      void translateAndApprove(database, descriptionGenerationService, candidateId, source)
        .catch((error) => {
          logger.error(`Translate-and-approve job failed for store item ${candidateId}`, error);
        })
        .finally(() => {
          inFlightCandidateIds.delete(candidateId);
        });

      return { candidateId, status: 'PROCESSING' };
    }
  };
}

async function loadTranslationSource(
  database: Database,
  candidateId: number
): Promise<StoreItemTranslationSource | undefined> {
  const result = await database.query(
    `
    select
      coalesce(nullif(trim(i.canonical_name_es), ''), trim(i.canonical_name)) as boardgame_name,
      coalesce(i.description, '') as item_description,
      coalesce(i.description_es, '') as description_es,
      i.id as item_id,
      si.listing_status,
      coalesce(si.description, '') as store_item_description
    from store_items si
    join items i on i.id = si.item_id
    where si.id = $1
    `,
    [candidateId]
  );

  return result.rows[0] as StoreItemTranslationSource | undefined;
}

function validateTranslationSource(source: StoreItemTranslationSource | undefined): asserts source is StoreItemTranslationSource {
  if (!source) {
    throw workflowError(404, 'Store item must have a linked catalog item');
  }
  if (source.listing_status !== 'PENDING') {
    throw workflowError(409, 'Store item must be pending');
  }
  if (source.description_es.trim()) {
    throw workflowError(409, 'Translation has already been generated');
  }
  if (!source.boardgame_name.trim() || (!source.item_description.trim() && !source.store_item_description.trim())) {
    throw workflowError(400, 'An item name and at least one source description are required');
  }
}

async function translateAndApprove(
  database: Database,
  descriptionGenerationService: DescriptionGenerationService,
  candidateId: number,
  source: StoreItemTranslationSource
): Promise<void> {
  const generated = await descriptionGenerationService.generate({
    boardgameName: source.boardgame_name,
    description1: source.item_description,
    description2: source.store_item_description
  });
  const descriptionEs = generated.descriptionEs.trim();
  if (!descriptionEs) {
    throw new Error('Description generation returned an empty Spanish description');
  }

  const result = await database.query(
    `
    with updated_item as (
      update items
      set description_es = $1,
          updated_at = now()
      where id = $2
      returning id
    )
    update store_items si
    set listing_status = 'LISTED',
        last_updated = now()
    from updated_item
    where si.id = $3
      and si.item_id = updated_item.id
      and si.listing_status = 'PENDING'
    returning si.id
    `,
    [descriptionEs, source.item_id, candidateId]
  );

  if (!result.rows[0]) {
    throw new Error('Store item was no longer pending when translation completed');
  }
}

function workflowError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
