import { Router } from 'express';

import type { BggItemImporter } from '../bgg/bggItemImporter.js';
import type { Database } from '../db.js';
import type { ItemMatchingService } from '../itemMatching/itemMatchingService.js';

type StoreCandidateInput = {
  canonical_domain: string;
  city: string;
  confidence: number;
  country: string;
  evidence: string[];
  facebook_url: string;
  instagram_url: string;
  state: string;
  store_logo: string;
  store_name: string;
  website_url: string;
};

type StoreInput = {
  canonical_domain: string;
  city: string;
  country: string;
  facebook_url: string;
  instagram_url: string;
  logo_url: string;
  name: string;
  state: string;
  status: string;
  website_url: string;
};

type FrontPageCategoryInput = {
  category_id: number;
  category_type: 'category' | 'family' | 'mechanic';
  order: number;
  title: string;
};

type ItemCandidateInput = {
  availability: string;
  availability_source: string;
  category_confidence: number | null;
  classification_reasons: string;
  currency: string;
  description: string;
  image_url: string;
  is_boardgame: boolean;
  is_boardgame_confirmed: boolean;
  item_id: number | null;
  item_type: string;
  language: string;
  language_evidence: string;
  language_source: string;
  match_payload: string;
  match_reasons: string;
  match_score: number | null;
  match_source: string;
  matched_bgg_id: number | null;
  matched_name: string;
  max_minutes: number | null;
  max_players: number | null;
  min_age: number | null;
  min_minutes: number | null;
  min_players: number | null;
  price: number | null;
  price_source: string;
  processing_error: string;
  publisher: string;
  raw_payload: string;
  raw_price: string;
  source_listing_url: string;
  source_url: string;
  listing_status: string;
  store_id: number | null;
  store_sku: string;
  title: string;
};

type ItemInput = {
  bgg_id: number | null;
  bgg_url: string;
  canonical_name: string;
  canonical_name_es: string;
  complexity: number | null;
  description: string;
  description_es: string;
  image_url: string;
  image_url_es: string;
  item_type: string;
  max_minutes: number | null;
  max_players: number | null;
  min_age: number | null;
  min_minutes: number | null;
  min_players: number | null;
  normalized_name: string;
  normalized_name_es: string;
  parent_item_id: number | null;
  rating: number | null;
  status: string;
  weight: number | null;
  year_published: number | null;
};

type SortDirection = 'asc' | 'desc';

type TableColumnConfig = {
  filterSql: string;
  sortSql: string;
};

type TableQueryConfig = {
  columns: Record<string, TableColumnConfig>;
  defaultSortColumnId: string;
  defaultSortDirection: SortDirection;
  fromSql: string;
  selectSql: string;
  whereSql?: string;
};

const storeCandidateSelect = `
  id, store_name, canonical_domain, website_url, instagram_url,
  facebook_url, city, state, country, store_logo, status, confidence,
  source_queries, evidence, first_seen_at, last_seen_at
`;

const storeSelect = `
  id, name, canonical_domain, website_url, instagram_url,
  facebook_url, city, state, country, logo_url, status, created_at, updated_at
`;

const itemCandidateSelect = `
  id, store_id, source_url, source_listing_url, title, publisher, description,
  item_id, item_type, min_players, max_players, min_minutes, max_minutes,
  min_age, language, language_source, language_evidence, image_url, listing_status,
  raw_price, price, price_source, currency, availability, availability_source,
  store_sku, raw_payload, is_boardgame, is_boardgame_confirmed, category_confidence,
  classification_reasons, match_source,
  matched_bgg_id, matched_name, match_score, match_reasons, match_payload,
  matched_at, processed_at, processing_error, last_seen_at, last_updated
`;

const itemSelect = `
  id, canonical_name, normalized_name, canonical_name_es, normalized_name_es,
  item_type, parent_item_id, bgg_id, bgg_url, bgg_last_sync_at,
  year_published, rating, weight, description, description_es, min_players, max_players,
  min_minutes, max_minutes, complexity, min_age, image_url, image_url_es, status,
  created_at, updated_at
`;

const itemLinkedCandidateSelect = `
  dic.id, dic.store_id, s.name as store_name, s.canonical_domain as store_domain,
  dic.source_url, dic.source_listing_url, dic.title, dic.publisher,
  dic.description, dic.item_id, dic.item_type, dic.min_players, dic.max_players,
  dic.language, dic.listing_status, dic.raw_price, dic.price, dic.currency,
  dic.availability, dic.match_source, dic.match_score,
  dic.last_seen_at, dic.last_updated
`;

const frontPageCategorySelect = `
  fpc.id, fpc.category_type, fpc.category_id, fpc.title, fpc."order",
  coalesce(bc.name, bf.name, bm.name, '') as category_name,
  coalesce(bc.name_es, bf.name_es, bm.name_es, '') as category_name_es,
  fpc.created_at, fpc.updated_at
`;

const frontPageCategoryFromSql = `
  from front_page_categories fpc
  left join boardgame_categories bc on fpc.category_type = 'category' and bc.id = fpc.category_id
  left join boardgame_families bf on fpc.category_type = 'family' and bf.id = fpc.category_id
  left join boardgame_mechanics bm on fpc.category_type = 'mechanic' and bm.id = fpc.category_id
`;

const frontPageCategoryAssignmentCandidatePredicateSql = `
  (
    (
      oc.category_type = 'category'
      and exists (
        select 1
        from item_categories ic
        where ic.item_id = ai.id
          and ic.category_id = oc.category_id
      )
    )
    or (
      oc.category_type = 'family'
      and exists (
        select 1
        from item_families ifa
        where ifa.item_id = ai.id
          and ifa.family_id = oc.category_id
      )
    )
    or (
      oc.category_type = 'mechanic'
      and exists (
        select 1
        from item_mechanics im
        where im.item_id = ai.id
          and im.mechanic_id = oc.category_id
      )
    )
  )
`;

const randomFrontPageCategoryAssignmentsSql = `
  with recursive
  existing_count as (
    select count(*)::int as replaced_count
    from front_page_category_items
  ),
  ordered_categories as (
    select
      fpc.id as front_page_category_id,
      fpc.category_type,
      fpc.category_id,
      row_number() over (order by fpc."order" asc, fpc.id asc) as category_position
    from front_page_categories fpc
  ),
  category_cycles as (
    select
      oc.front_page_category_id,
      oc.category_type,
      oc.category_id,
      oc.category_position,
      cycle_number.cycle_number
    from ordered_categories oc
    cross join generate_series(1, 20) as cycle_number(cycle_number)
  ),
  assignment_slots as (
    select
      front_page_category_id,
      category_type,
      category_id,
      category_position,
      cycle_number,
      row_number() over (order by cycle_number asc, category_position asc) as position
    from category_cycles
  ),
  assignments(position, front_page_category_id, item_id, item_order, assigned_item_ids) as (
    select
      oc.position,
      oc.front_page_category_id,
      candidate.item_id,
      oc.cycle_number as item_order,
      case
        when candidate.item_id is null then array[]::bigint[]
        else array[candidate.item_id]::bigint[]
      end as assigned_item_ids
    from assignment_slots oc
    left join lateral (
      select ai.id as item_id
      from active_item ai
      where ${frontPageCategoryAssignmentCandidatePredicateSql}
      order by random()
      limit 1
    ) candidate on true
    where oc.position = 1

    union all

    select
      oc.position,
      oc.front_page_category_id,
      candidate.item_id,
      oc.cycle_number as item_order,
      previous.assigned_item_ids ||
        case
          when candidate.item_id is null then array[]::bigint[]
          else array[candidate.item_id]::bigint[]
        end as assigned_item_ids
    from assignments previous
    join assignment_slots oc on oc.position = previous.position + 1
    left join lateral (
      select ai.id as item_id
      from active_item ai
      where ${frontPageCategoryAssignmentCandidatePredicateSql}
        and not (ai.id = any(previous.assigned_item_ids))
      order by random()
      limit 1
    ) candidate on true
  ),
  upserted as (
    insert into front_page_category_items (front_page_category_id, item_id, item_order)
    select front_page_category_id, item_id, item_order
    from assignments
    where item_id is not null
    on conflict (item_id) do update
    set front_page_category_id = excluded.front_page_category_id,
        item_order = excluded.item_order,
        updated_at = now()
    returning front_page_category_id, item_id, item_order
  ),
  deleted as (
    delete from front_page_category_items fpci
    where not exists (
      select 1
      from assignments assigned
      where assigned.item_id is not null
        and assigned.item_id = fpci.item_id
    )
    returning item_id
  ),
  deleted_count as (
    select count(*)::int as removed_count
    from deleted
  )
  select
    count(upserted.item_id)::int as assigned_count,
    ((select count(*) from assignment_slots) - count(upserted.item_id))::int as skipped_count,
    (select replaced_count from existing_count)::int as replaced_count,
    (select removed_count from deleted_count)::int as removed_count
  from upserted
`;

const frontPagePreviewSql = `
  select
    fpc.id,
    fpc.category_type,
    fpc.category_id,
    fpc.title,
    fpc."order",
    coalesce(bc.name, bf.name, bm.name, '') as category_name,
    coalesce(bc.name_es, bf.name_es, bm.name_es, '') as category_name_es,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', i.id,
          'canonical_name', i.canonical_name,
          'canonical_name_es', i.canonical_name_es,
          'image_url', i.image_url,
          'image_url_es', i.image_url_es,
          'item_type', i.item_type,
          'year_published', i.year_published
        )
        order by fpci.item_order asc, i.canonical_name asc, i.id asc
      ) filter (where i.id is not null),
      '[]'::jsonb
    ) as products
  from front_page_categories fpc
  left join boardgame_categories bc on fpc.category_type = 'category' and bc.id = fpc.category_id
  left join boardgame_families bf on fpc.category_type = 'family' and bf.id = fpc.category_id
  left join boardgame_mechanics bm on fpc.category_type = 'mechanic' and bm.id = fpc.category_id
  left join front_page_category_items fpci on fpci.front_page_category_id = fpc.id
  left join active_item i on i.id = fpci.item_id
  group by fpc.id, bc.name, bc.name_es, bf.name, bf.name_es, bm.name, bm.name_es
  order by fpc."order" asc, fpc.id asc
`;

const offerReviewSelect = `
  dic.id as candidate_id,
  dic.title as candidate_name,
  dic.description as candidate_description,
  dic.image_url as candidate_image_url,
  dic.source_url as candidate_url,
  dic.publisher as candidate_publisher,
  dic.language as candidate_language,
  dic.price as candidate_price,
  dic.availability as candidate_availability,
  dic.match_source,
  dic.match_score,
  dic.matched_name,
  dic.last_updated as candidate_last_updated,
  dic.id as store_item_id,
  dic.price as store_item_price,
  dic.availability as store_item_availability,
  dic.listing_status as store_item_listing_status,
  dic.last_seen_at as store_item_last_seen_at,
  i.id as item_id,
  i.canonical_name as item_name,
  i.canonical_name_es as item_name_es,
  i.description as item_description,
  i.description_es as item_description_es,
  i.image_url as item_image_url,
  i.image_url_es as item_image_url_es,
  i.bgg_id as item_bgg_id,
  i.item_type,
  i.year_published as item_year_published,
  s.name as store_name,
  s.canonical_domain as store_domain
`;

const cleanStoresTableConfig: TableQueryConfig = {
  columns: {
    canonical_domain: columnSql('canonical_domain'),
    city: columnSql('city'),
    country: columnSql('country'),
    facebook_url: columnSql('facebook_url'),
    instagram_url: columnSql('instagram_url'),
    logo_url: columnSql('logo_url'),
    name: columnSql('name'),
    state: columnSql('state'),
    status: columnSql('status'),
    updated_at: columnSql('updated_at'),
    website_url: columnSql('website_url')
  },
  defaultSortColumnId: 'canonical_domain',
  defaultSortDirection: 'asc',
  fromSql: 'from stores',
  selectSql: storeSelect
};

const frontPageCategoriesTableConfig: TableQueryConfig = {
  columns: {
    category_id: columnSql('fpc.category_id'),
    category_name: {
      filterSql: textSql("coalesce(bc.name, bf.name, bm.name, '')"),
      sortSql: "coalesce(bc.name, bf.name, bm.name, '')"
    },
    category_type: columnSql('fpc.category_type'),
    order: columnSql('fpc."order"'),
    title: columnSql('fpc.title'),
    updated_at: columnSql('fpc.updated_at')
  },
  defaultSortColumnId: 'order',
  defaultSortDirection: 'asc',
  fromSql: frontPageCategoryFromSql,
  selectSql: frontPageCategorySelect
};

const storeCandidatesTableConfig: TableQueryConfig = {
  columns: {
    canonical_domain: columnSql('canonical_domain'),
    city: columnSql('city'),
    confidence: columnSql('confidence'),
    country: columnSql('country'),
    evidence: columnSql('evidence'),
    facebook_url: columnSql('facebook_url'),
    first_seen_at: columnSql('first_seen_at'),
    instagram_url: columnSql('instagram_url'),
    last_seen_at: columnSql('last_seen_at'),
    state: columnSql('state'),
    status: columnSql('status'),
    store_logo: columnSql('store_logo'),
    store_name: columnSql('store_name'),
    website_url: columnSql('website_url')
  },
  defaultSortColumnId: 'canonical_domain',
  defaultSortDirection: 'asc',
  fromSql: 'from discovery_store_candidates',
  selectSql: storeCandidateSelect
};

const itemCandidatesTableConfig: TableQueryConfig = {
  columns: {
    availability: columnSql('availability'),
    availability_source: columnSql('availability_source'),
    category_confidence: columnSql('category_confidence'),
    classification_reasons: columnSql('classification_reasons'),
    currency: columnSql('currency'),
    image_url: columnSql('image_url'),
    is_boardgame: columnSql('is_boardgame'),
    is_boardgame_confirmed: columnSql('is_boardgame_confirmed'),
    item_type: columnSql('item_type'),
    language: columnSql('language'),
    language_evidence: columnSql('language_evidence'),
    language_source: columnSql('language_source'),
    last_seen_at: columnSql('last_seen_at'),
    last_updated: columnSql('last_updated'),
    max_minutes: columnSql('max_minutes'),
    match_score: columnSql('match_score'),
    match_source: columnSql('match_source'),
    matched_name: columnSql('matched_name'),
    min_age: columnSql('min_age'),
    min_minutes: columnSql('min_minutes'),
    players: {
      filterSql: textSql("concat_ws(' ', min_players, max_players)"),
      sortSql: 'min_players'
    },
    price: {
      filterSql: textSql("concat_ws(' ', price, raw_price)"),
      sortSql: 'price'
    },
    price_source: columnSql('price_source'),
    processing_error: columnSql('processing_error'),
    publisher: columnSql('publisher'),
    raw_payload: columnSql('raw_payload'),
    source_listing_url: columnSql('source_listing_url'),
    source_url: columnSql('source_url'),
    listing_status: columnSql('listing_status'),
    store: columnSql('store_id'),
    store_sku: columnSql('store_sku'),
    title: columnSql('title')
  },
  defaultSortColumnId: 'title',
  defaultSortDirection: 'asc',
  fromSql: 'from store_items',
  selectSql: itemCandidateSelect
};

const itemsTableConfig: TableQueryConfig = {
  columns: {
    bgg_id: columnSql('bgg_id'),
    bgg_last_sync_at: columnSql('bgg_last_sync_at'),
    bgg_url: columnSql('bgg_url'),
    canonical_name: columnSql('canonical_name'),
    canonical_name_es: columnSql('canonical_name_es'),
    complexity: columnSql('complexity'),
    created_at: columnSql('created_at'),
    description: columnSql('description'),
    description_es: columnSql('description_es'),
    image_url: columnSql('image_url'),
    image_url_es: columnSql('image_url_es'),
    item_type: columnSql('item_type'),
    max_minutes: columnSql('max_minutes'),
    max_players: columnSql('max_players'),
    min_age: columnSql('min_age'),
    min_minutes: columnSql('min_minutes'),
    min_players: columnSql('min_players'),
    normalized_name: columnSql('normalized_name'),
    normalized_name_es: columnSql('normalized_name_es'),
    parent_item_id: columnSql('parent_item_id'),
    players: {
      filterSql: textSql("concat_ws(' ', min_players, max_players)"),
      sortSql: 'min_players'
    },
    rating: columnSql('rating'),
    status: columnSql('status'),
    updated_at: columnSql('updated_at'),
    weight: columnSql('weight'),
    year_published: columnSql('year_published')
  },
  defaultSortColumnId: 'canonical_name',
  defaultSortDirection: 'asc',
  fromSql: 'from active_item',
  selectSql: itemSelect
};

const offerReviewsTableConfig: TableQueryConfig = {
  columns: {
    bgg: {
      filterSql: textSql('i.bgg_id'),
      sortSql: 'i.bgg_id'
    },
    candidate_availability: {
      filterSql: textSql('dic.availability'),
      sortSql: 'dic.availability'
    },
    candidate_image: {
      filterSql: textSql('dic.image_url'),
      sortSql: 'dic.image_url'
    },
    candidate_language: {
      filterSql: textSql('dic.language'),
      sortSql: 'dic.language'
    },
    candidate_name: {
      filterSql: textSql('dic.title'),
      sortSql: 'dic.title'
    },
    candidate_price: {
      filterSql: textSql('dic.price'),
      sortSql: 'dic.price'
    },
    candidate_url: {
      filterSql: textSql('dic.source_url'),
      sortSql: 'dic.source_url'
    },
    item_image: {
      filterSql: textSql('i.image_url'),
      sortSql: 'i.image_url'
    },
    item_name: {
      filterSql: textSql("concat_ws(' ', i.canonical_name, i.canonical_name_es)"),
      sortSql: 'i.canonical_name'
    },
    item_type: {
      filterSql: textSql('i.item_type'),
      sortSql: 'i.item_type'
    },
    match_score: {
      filterSql: textSql('dic.match_score'),
      sortSql: 'dic.match_score'
    },
    match_source: {
      filterSql: textSql('dic.match_source'),
      sortSql: 'dic.match_source'
    },
    store_item_availability: {
      filterSql: textSql('dic.availability'),
      sortSql: 'dic.availability'
    },
    store_item_price: {
      filterSql: textSql('dic.price'),
      sortSql: 'dic.price'
    },
    store: {
      filterSql: textSql("concat_ws(' ', s.name, s.canonical_domain)"),
      sortSql: 's.name'
    },
    store_item_listing_status: {
      filterSql: textSql('dic.listing_status'),
      sortSql: 'dic.listing_status'
    }
  },
  defaultSortColumnId: 'candidate_name',
  defaultSortDirection: 'asc',
  fromSql: `
    from store_items dic
    left join items i on i.id = dic.item_id
    left join stores s on s.id = dic.store_id
  `,
  selectSql: offerReviewSelect,
  whereSql: 'dic.is_boardgame = true and dic.is_boardgame_confirmed = true'
};

const reviewTasksTableConfig: TableQueryConfig = {
  columns: {
    entity: {
      filterSql: textSql("concat_ws(' ', entity_type, entity_id)"),
      sortSql: 'entity_type'
    },
    status: columnSql('status'),
    task: {
      filterSql: textSql("concat_ws(' ', task_type, type, title)"),
      sortSql: 'task_type'
    },
    updated: {
      filterSql: textSql("coalesce(updated_at, created_at)"),
      sortSql: 'updated_at'
    }
  },
  defaultSortColumnId: 'updated',
  defaultSortDirection: 'desc',
  fromSql: 'from admin_review_tasks',
  selectSql: '*'
};

export function createDiscoveryRouter(
  database: Database,
  itemMatchingService?: ItemMatchingService,
  bggItemImporter?: BggItemImporter
): Router {
  const router = Router();

  router.get('/stores', async (request, response, next) => {
    try {
      if (hasTableQuery(request.query)) {
        response.json(await queryTable(database, cleanStoresTableConfig, request.query));
        return;
      }

      const result = await database.query(
        `select ${storeSelect}
         from stores
         order by canonical_domain asc
         limit 200`
      );
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/stores/:id', async (request, response, next) => {
    try {
      const input = parseStoreInput(request.body);
      const result = await database.query(
        `
        update stores
        set name = $1,
            canonical_domain = $2,
            website_url = $3,
            instagram_url = $4,
            facebook_url = $5,
            city = $6,
            state = $7,
            country = $8,
            logo_url = $9,
            status = $10,
            updated_at = now()
        where id = $11
        returning ${storeSelect}
        `,
        [...storeParams(input), request.params.id]
      );

      if (!result.rows[0]) {
        throw httpError(404, 'Store not found');
      }

      response.json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.get('/front-page-category-options', async (request, response, next) => {
    try {
      const onlyUnlinkedGames = booleanField(request.query as Record<string, unknown>, 'only_unlinked_games');
      const result = await database.query(frontPageCategoryOptionsSql(onlyUnlinkedGames));

      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get('/front-page-category-options/:categoryType/:categoryId/products', async (request, response, next) => {
    try {
      const categoryId = integerPathParam(request.params.categoryId ?? '');
      const result = await database.query(frontPageCategoryProductsSql(request.params.categoryType ?? ''), [categoryId]);

      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get('/front-page-preview', async (_request, response, next) => {
    try {
      const result = await database.query(frontPagePreviewSql);
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get('/front-page-categories', async (request, response, next) => {
    try {
      if (hasTableQuery(request.query)) {
        response.json(await queryTable(database, frontPageCategoriesTableConfig, request.query));
        return;
      }

        const result = await database.query(
          `select ${frontPageCategorySelect}
           ${frontPageCategoryFromSql}
           order by fpc."order" asc, fpc.title asc
           limit 200`
        );
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.post('/front-page-categories', async (request, response, next) => {
    try {
      const input = parseFrontPageCategoryInput(request.body);
      const result = await database.query(
          `
          with saved as (
            insert into front_page_categories (category_type, category_id, title, "order")
            values ($1, $2, $3, $4)
            returning *
          )
        select ${frontPageCategorySelect}
        from saved fpc
        left join boardgame_categories bc on fpc.category_type = 'category' and bc.id = fpc.category_id
        left join boardgame_families bf on fpc.category_type = 'family' and bf.id = fpc.category_id
        left join boardgame_mechanics bm on fpc.category_type = 'mechanic' and bm.id = fpc.category_id
        `,
        frontPageCategoryParams(input)
      );

      response.status(201).json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.post('/front-page-categories/random-item-assignments', async (_request, response, next) => {
    try {
      const result = await database.query(randomFrontPageCategoryAssignmentsSql);

      response.json({
        data: result.rows[0] ?? {
          assigned_count: 0,
          replaced_count: 0,
          skipped_count: 0
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/front-page-categories/:id', async (request, response, next) => {
    try {
      const input = parseFrontPageCategoryInput(request.body);
      const result = await database.query(
        `
          with saved as (
            update front_page_categories
            set category_type = $1,
                category_id = $2,
                title = $3,
                "order" = $4,
                updated_at = now()
            where id = $5
            returning *
          )
        select ${frontPageCategorySelect}
        from saved fpc
        left join boardgame_categories bc on fpc.category_type = 'category' and bc.id = fpc.category_id
        left join boardgame_families bf on fpc.category_type = 'family' and bf.id = fpc.category_id
        left join boardgame_mechanics bm on fpc.category_type = 'mechanic' and bm.id = fpc.category_id
        `,
        [...frontPageCategoryParams(input), request.params.id]
      );

      if (!result.rows[0]) {
        throw httpError(404, 'Front page category not found');
      }

      response.json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/front-page-categories/:id', async (request, response, next) => {
    try {
      const result = await database.query(
        `
        with deleted as (
          delete from front_page_categories
          where id = $1
          returning *
        )
        select ${frontPageCategorySelect}
        from deleted fpc
        left join boardgame_categories bc on fpc.category_type = 'category' and bc.id = fpc.category_id
        left join boardgame_families bf on fpc.category_type = 'family' and bf.id = fpc.category_id
        left join boardgame_mechanics bm on fpc.category_type = 'mechanic' and bm.id = fpc.category_id
        `,
        [request.params.id]
      );

      if (!result.rows[0]) {
        throw httpError(404, 'Front page category not found');
      }

      response.json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.get('/items', async (request, response, next) => {
    try {
      if (hasTableQuery(request.query)) {
        response.json(await queryTable(database, itemsTableConfig, request.query));
        return;
      }

      const result = await database.query(
        `select ${itemSelect}
         from active_item
         order by canonical_name asc
         limit 200`
      );
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get('/items/:id', async (request, response, next) => {
    try {
      const result = await database.query(
        `select ${itemSelect}
         from items
         where id = $1`,
        [request.params.id]
      );

      if (!result.rows[0]) {
        throw httpError(404, 'Item not found');
      }

      response.json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.get('/items/:id/candidates', async (request, response, next) => {
    try {
      const result = await database.query(
        `select ${itemLinkedCandidateSelect}
         from store_items dic
         left join stores s on s.id = dic.store_id
         where dic.item_id = $1
         order by dic.last_updated desc`,
        [request.params.id]
      );
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get('/items/:id/store-items', async (request, response, next) => {
    try {
      const result = await database.query(
        `select ${itemLinkedCandidateSelect}
         from store_items dic
         left join stores s on s.id = dic.store_id
         where dic.item_id = $1
         order by dic.last_seen_at desc`,
        [request.params.id]
      );
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get('/items/:id/taxonomy', async (request, response, next) => {
    try {
      const [categories, mechanics, families] = await Promise.all([
        database.query(
          `
          select bc.id, bc.bgg_id, bc.name as value, bc.name_es as value_es
          from item_categories ic
          join boardgame_categories bc on bc.id = ic.category_id
          where ic.item_id = $1
          order by bc.name asc
          `,
          [request.params.id]
        ),
        database.query(
          `
          select bm.id, bm.bgg_id, bm.name as value, bm.name_es as value_es
          from item_mechanics im
          join boardgame_mechanics bm on bm.id = im.mechanic_id
          where im.item_id = $1
          order by bm.name asc
          `,
          [request.params.id]
        ),
        database.query(
          `
          select bf.id, bf.bgg_id, bf.name as value, bf.name_es as value_es
          from item_families ifa
          join boardgame_families bf on bf.id = ifa.family_id
          where ifa.item_id = $1
          order by bf.name asc
          `,
          [request.params.id]
        )
      ]);

      response.json({
        data: {
          categories: categories.rows,
          families: families.rows,
          mechanics: mechanics.rows
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/items/:id', async (request, response, next) => {
    try {
      const input = parseItemInput(request.body);
      const result = await database.query(
        `
        update items
        set canonical_name = $1,
            normalized_name = $2,
            canonical_name_es = $3,
            normalized_name_es = $4,
            item_type = $5,
            parent_item_id = $6,
            bgg_id = $7,
            bgg_url = $8,
            year_published = $9,
            description = $10,
            description_es = $11,
            min_players = $12,
            max_players = $13,
            min_minutes = $14,
            max_minutes = $15,
            complexity = $16,
            rating = $17,
            weight = $18,
            min_age = $19,
            image_url = $20,
            image_url_es = $21,
            status = $22,
            updated_at = now()
        where id = $23
        returning ${itemSelect}
        `,
        [...itemParams(input), request.params.id]
      );

      if (!result.rows[0]) {
        throw httpError(404, 'Item not found');
      }

      response.json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.get('/discovery/stores', async (request, response, next) => {
    try {
      if (hasTableQuery(request.query)) {
        response.json(await queryTable(database, storeCandidatesTableConfig, request.query));
        return;
      }

      const result = await database.query(
        `select ${storeCandidateSelect}
         from discovery_store_candidates
         order by last_seen_at desc
         limit 200`
      );
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.post('/discovery/stores', async (request, response, next) => {
    try {
      const input = parseStoreCandidateInput(request.body);
      const result = await database.query(
        `
        insert into discovery_store_candidates (
          store_name,
          canonical_domain,
          website_url,
          instagram_url,
          facebook_url,
          city,
          state,
          country,
          store_logo,
          confidence,
          evidence
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        returning ${storeCandidateSelect}
        `,
        storeCandidateParams(input)
      );
      response.status(201).json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/discovery/stores/:id', async (request, response, next) => {
    try {
      const input = parseStoreCandidateInput(request.body);
      const result = await database.query(
        `
        update discovery_store_candidates
        set store_name = $1,
            canonical_domain = $2,
            website_url = $3,
            instagram_url = $4,
            facebook_url = $5,
            city = $6,
            state = $7,
            country = $8,
            store_logo = $9,
            confidence = $10,
            evidence = $11::jsonb,
            last_seen_at = now()
        where id = $12
        returning ${storeCandidateSelect}
        `,
        [...storeCandidateParams(input), request.params.id]
      );

      if (!result.rows[0]) {
        throw httpError(404, 'Store candidate not found');
      }

      response.json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.post('/discovery/stores/:id/approve', async (request, response, next) => {
    try {
      const result = await database.query(
        `
        with candidate as (
          select *
          from discovery_store_candidates
          where id = $1
            and status = 'PENDING'
        ),
        upserted_store as (
          insert into stores (
            name,
            canonical_domain,
            website_url,
            instagram_url,
            facebook_url,
            city,
            state,
            country,
            logo_url,
            updated_at
          )
          select
            coalesce(nullif(store_name, ''), canonical_domain),
            canonical_domain,
            website_url,
            instagram_url,
            facebook_url,
            city,
            state,
            country,
            store_logo,
            now()
          from candidate
          on conflict (canonical_domain) do update set
            name = excluded.name,
            website_url = excluded.website_url,
            instagram_url = excluded.instagram_url,
            facebook_url = excluded.facebook_url,
            city = excluded.city,
            state = excluded.state,
            country = excluded.country,
            logo_url = excluded.logo_url,
            updated_at = now()
          returning canonical_domain
        )
        update discovery_store_candidates
        set status = 'ACCEPTED',
            last_seen_at = now()
        where id = $1
          and exists (select 1 from upserted_store)
        returning ${storeCandidateSelect}
        `,
        [request.params.id]
      );

      if (!result.rows[0]) {
        throw httpError(404, 'Pending store candidate not found');
      }

      response.json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.post('/discovery/stores/:id/reject', async (request, response, next) => {
    try {
      const result = await database.query(
        `
        update discovery_store_candidates
        set status = 'REJECTED',
            last_seen_at = now()
        where id = $1
          and status = 'PENDING'
        returning ${storeCandidateSelect}
        `,
        [request.params.id]
      );

      if (!result.rows[0]) {
        throw httpError(404, 'Pending store candidate not found');
      }

      response.json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.get('/discovery/listings', async (request, response, next) => {
    try {
      if (hasTableQuery(request.query)) {
        response.json(await queryTable(database, itemCandidatesTableConfig, request.query));
        return;
      }

      const result = await database.query(
        `select ${itemCandidateSelect}
         from store_items
         order by title asc
         limit 200`
      );
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get('/discovery/listings/:id', async (request, response, next) => {
    try {
      const result = await database.query(
        `select ${itemCandidateSelect}
         from store_items
         where id = $1`,
        [request.params.id]
      );

      if (!result.rows[0]) {
        throw httpError(404, 'Item candidate not found');
      }

      response.json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.post('/discovery/listings/:id/create-item', async (request, response, next) => {
    try {
      const createOptions = parseCreateItemFromCandidateOptions(request.body);
      const candidateResult = await database.query(
        `select ${itemCandidateSelect}
         from store_items
         where id = $1`,
        [request.params.id]
      );
      const candidate = candidateResult.rows[0] as Record<string, unknown> | undefined;
      if (!candidate) {
        throw httpError(404, 'Item candidate not found');
      }
      if (!hasRowValue(candidate.store_id)) {
        throw httpError(400, 'Item candidate must have a store before creating an item');
      }

      const title = rowString(candidate, 'title');
      if (!title || !rowString(candidate, 'source_url')) {
        throw httpError(400, 'title and source_url are required');
      }

      let implementedItemId: number | null = null;
      if (createOptions.implementsBggItem) {
        if (!bggItemImporter) {
          throw httpError(503, 'BGG item importer is not configured');
        }
        const implementationBggId = createOptions.bggId;
        if (implementationBggId === null) {
          throw httpError(400, 'bgg_id must be a positive integer');
        }
        implementedItemId = await bggItemImporter.importBggId(implementationBggId);
        if (!implementedItemId) {
          throw httpError(404, 'Implemented BGG item not found');
        }
      }

      const result = await database.query(
        `
        with candidate as (
          select *
          from store_items
          where id = $1
        ),
        created_item as (
          insert into items (
            canonical_name,
            normalized_name,
            item_type,
            parent_item_id,
            bgg_id,
            bgg_url,
            year_published,
            rating,
            description,
            min_players,
            max_players,
            min_minutes,
            max_minutes,
            min_age,
            image_url,
            status,
            updated_at
          )
          select
            candidate.title,
            $2,
            $3,
            null,
            null,
            '',
            null,
            5,
            candidate.description,
            candidate.min_players,
            candidate.max_players,
            candidate.min_minutes,
            candidate.max_minutes,
            candidate.min_age,
            candidate.image_url,
            'active',
            now()
          from candidate
          returning id
        ),
        upserted_publisher as (
          insert into publishers (name, normalized_name, updated_at)
          select trim(candidate.publisher), $4, now()
          from candidate
          where nullif(trim(candidate.publisher), '') is not null
          on conflict (name) do update set
            normalized_name = excluded.normalized_name,
            updated_at = now()
          returning id
        ),
        linked_publisher as (
          insert into item_publishers (item_id, publisher_id)
          select created_item.id, upserted_publisher.id
          from created_item
          cross join upserted_publisher
          on conflict do nothing
        ),
        implementation_relationship as (
          insert into item_relationships (item_a_id, link_type, item_b_id, source, source_ref)
          select created_item.id, 'implementation', $7::bigint, 'admin', $8
          from created_item
          where $7::bigint is not null
          on conflict (item_a_id, link_type, item_b_id) do update set
            source = excluded.source,
            source_ref = excluded.source_ref
        ),
        copied_parent_categories as (
          insert into item_categories (item_id, category_id)
          select created_item.id, parent_categories.category_id
          from created_item
          join item_categories parent_categories on parent_categories.item_id = $7::bigint
          where $7::bigint is not null
          on conflict do nothing
        ),
        copied_parent_families as (
          insert into item_families (item_id, family_id)
          select created_item.id, parent_families.family_id
          from created_item
          join item_families parent_families on parent_families.item_id = $7::bigint
          where $7::bigint is not null
          on conflict do nothing
        ),
        copied_parent_mechanics as (
          insert into item_mechanics (item_id, mechanic_id)
          select created_item.id, parent_mechanics.mechanic_id
          from created_item
          join item_mechanics parent_mechanics on parent_mechanics.item_id = $7::bigint
          where $7::bigint is not null
          on conflict do nothing
        ),
        updated_candidate as (
          update store_items
          set item_id = created_item.id,
              is_boardgame = true,
              is_boardgame_confirmed = true,
              match_source = 'MANUAL',
              matched_bgg_id = null,
              matched_name = candidate.title,
              match_score = 1.0,
              match_reasons = $5::jsonb,
              match_payload = $6::jsonb,
              matched_at = now(),
              processed_at = now(),
              processing_error = '',
              last_updated = now()
          from candidate
          cross join created_item
          where store_items.id = candidate.id
          returning store_items.*
        )
        select ${itemCandidateSelect}
        from updated_candidate
        `,
        [
          request.params.id,
          normalizeItemName(title),
          itemTypeFromCandidate(candidate),
          normalizeItemName(rowString(candidate, 'publisher')),
          JSON.stringify(['Manual item creation from admin candidate form']),
          JSON.stringify(createOptions.matchPayload),
          implementedItemId,
          createOptions.implementsBggItem ? String(createOptions.bggId) : null
        ]
      );

      response.status(201).json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.post('/discovery/listings/:id/create-item-from-bgg', async (request, response, next) => {
    try {
      if (!bggItemImporter) {
        throw httpError(503, 'BGG item importer is not configured');
      }

      const bggId = positiveIntegerBodyField(request.body, 'bgg_id');
      const candidateResult = await database.query(
        `select ${itemCandidateSelect}
         from store_items
         where id = $1`,
        [request.params.id]
      );
      const candidate = candidateResult.rows[0] as Record<string, unknown> | undefined;
      if (!candidate) {
        throw httpError(404, 'Item candidate not found');
      }
      if (!hasRowValue(candidate.store_id)) {
        throw httpError(400, 'Item candidate must have a store before creating an item');
      }
      if (!rowString(candidate, 'title') || !rowString(candidate, 'source_url')) {
        throw httpError(400, 'title and source_url are required');
      }

      const itemId = await bggItemImporter.importBggId(bggId);
      if (!itemId) {
        throw httpError(404, 'BGG item not found');
      }

      const result = await database.query(
        `
        with candidate as (
          select *
          from store_items
          where id = $1
        ),
        linked_item as (
          select id, canonical_name
          from items
          where id = $2
        ),
        updated_candidate as (
          update store_items
          set item_id = linked_item.id,
              is_boardgame = true,
              is_boardgame_confirmed = true,
              match_source = 'BGG_MANUAL',
              matched_bgg_id = $3,
              matched_name = linked_item.canonical_name,
              match_score = 1.0,
              match_reasons = $4::jsonb,
              match_payload = $5::jsonb,
              matched_at = now(),
              processed_at = now(),
              processing_error = '',
              last_updated = now()
          from candidate
          cross join linked_item
          where store_items.id = candidate.id
          returning store_items.*
        )
        select ${itemCandidateSelect}
        from updated_candidate
        `,
        [
          request.params.id,
          itemId,
          bggId,
          JSON.stringify(['Manual BGG ID import from admin candidate form']),
          JSON.stringify({ bgg_id: bggId, source: 'admin_bgg_id_import' })
        ]
      );

      if (!result.rows[0]) {
        throw httpError(404, 'Imported item not found');
      }

      response.status(201).json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.post('/discovery/listings/:id/confirm-boardgame', async (request, response, next) => {
    try {
      if (!itemMatchingService?.confirmBoardgameAndMatch) {
        throw httpError(503, 'Item matching service is not configured');
      }

      const candidateId = integerPathParam(request.params.id);
      await itemMatchingService.confirmBoardgameAndMatch(candidateId, { confirmationSource: 'admin' });

      const result = await database.query(
        `select ${itemCandidateSelect}
         from store_items
         where id = $1`,
        [candidateId]
      );

      if (!result.rows[0]) {
        throw httpError(404, 'Item candidate not found');
      }

      response.json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/discovery/listings/:id/listing-status', async (request, response, next) => {
    try {
      const listingStatus = listingStatusField((request.body ?? {}) as Record<string, unknown>, 'listing_status');
      const result = await database.query(
        `
        update store_items
        set listing_status = $1,
            last_updated = now()
        where id = $2
        returning ${itemCandidateSelect}
        `,
        [listingStatus, request.params.id]
      );

      if (!result.rows[0]) {
        throw httpError(404, 'Item candidate not found');
      }

      response.json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/discovery/listings/:id', async (request, response, next) => {
    try {
      const input = parseItemCandidateInput(request.body);
      const result = await database.query(
        `
        update store_items
        set store_id = $1,
            source_url = $2,
            source_listing_url = $3,
            title = $4,
            publisher = $5,
            description = $6,
            item_id = $7,
            item_type = $8,
            min_players = $9,
            max_players = $10,
            min_minutes = $11,
            max_minutes = $12,
            min_age = $13,
            language = $14,
            language_source = $15,
            language_evidence = $16,
            image_url = $17,
            listing_status = $18,
            raw_price = $19,
            price = $20,
            price_source = $21,
            currency = $22,
            availability = $23,
            availability_source = $24,
            store_sku = $25,
            raw_payload = $26::jsonb,
            is_boardgame = $27,
            is_boardgame_confirmed = $28,
            category_confidence = $29,
            classification_reasons = $30::jsonb,
            match_source = $31,
            matched_bgg_id = $32,
            matched_name = $33,
            match_score = $34,
            match_reasons = $35::jsonb,
            match_payload = $36::jsonb,
            processing_error = $37,
            last_updated = now()
        where id = $38
        returning ${itemCandidateSelect}
        `,
        [...itemCandidateParams(input), request.params.id]
      );

      if (!result.rows[0]) {
        throw httpError(404, 'Item candidate not found');
      }

      response.json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/discovery/offer-reviews', async (request, response, next) => {
    try {
      if (hasTableQuery(request.query)) {
        response.json(await queryTable(database, offerReviewsTableConfig, request.query));
        return;
      }

      const result = await database.query(
        `select ${offerReviewSelect}
         from store_items dic
         left join items i on i.id = dic.item_id
         left join stores s on s.id = dic.store_id
         where dic.is_boardgame = true
           and dic.is_boardgame_confirmed = true
         order by dic.last_updated desc`
      );
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/discovery/item-candidates/:id/match-candidates', async (request, response, next) => {
    try {
      if (!itemMatchingService) {
        throw httpError(503, 'Item matching service is not configured');
      }
      const rows = await itemMatchingService.generateMatchCandidates(integerPathParam(request.params.id));
      response.status(201).json({ data: rows });
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/discovery/item-candidates/:id/match-candidates', async (request, response, next) => {
    try {
      if (!itemMatchingService) {
        throw httpError(503, 'Item matching service is not configured');
      }
      const rows = await itemMatchingService.listMatchCandidates(integerPathParam(request.params.id));
      response.json({ data: rows });
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/review-tasks', async (request, response, next) => {
    try {
      if (hasTableQuery(request.query)) {
        response.json(await queryTable(database, reviewTasksTableConfig, request.query));
        return;
      }

      const result = await database.query('select * from admin_review_tasks order by updated_at desc limit 200');
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

async function queryTable(database: Database, config: TableQueryConfig, query: Record<string, unknown>) {
  const pagination = parsePagination(query);
  const tableQuery = parseTableQuery(query, config);
  const whereClause = buildWhereClause(config, tableQuery.filters);
  const dataParams = [...whereClause.params, pagination.pageSize, pagination.page * pagination.pageSize];
  const limitParam = whereClause.params.length + 1;
  const offsetParam = whereClause.params.length + 2;

  const result = await database.query(
    `select ${config.selectSql}
     ${config.fromSql}
     ${whereClause.sql}
     order by ${tableQuery.sortSql} ${tableQuery.sortDirection}
     limit $${limitParam} offset $${offsetParam}`,
    dataParams
  );
  const countResult = await database.query(
    `select count(*)::int as total
     ${config.fromSql}
     ${whereClause.sql}`,
    whereClause.params
  );
  const total = numberField((countResult.rows[0] ?? {}) as Record<string, unknown>, 'total');

  return {
    data: result.rows,
    meta: {
      page: pagination.page,
      page_size: pagination.pageSize,
      total
    }
  };
}

function parseTableQuery(query: Record<string, unknown>, config: TableQueryConfig) {
  const requestedSort = stringQueryField(query.sort);
  const hasValidRequestedSort = Boolean(requestedSort && config.columns[requestedSort]);
  const sortColumn = hasValidRequestedSort ? config.columns[requestedSort] : config.columns[config.defaultSortColumnId];
  const requestedDirection = stringQueryField(query.sort_direction).toLowerCase();

  return {
    filters: tableFilters(query, config),
    sortDirection: (hasValidRequestedSort
      ? requestedDirection === 'desc'
        ? 'desc'
        : 'asc'
      : config.defaultSortDirection) as SortDirection,
    sortSql: sortColumn.sortSql
  };
}

function tableFilters(query: Record<string, unknown>, config: TableQueryConfig) {
  const filters: Array<{ column: TableColumnConfig; value: string }> = [];
  for (const [columnId, column] of Object.entries(config.columns)) {
    const value = stringQueryField(query[`filter_${columnId}`]).trim();
    if (value) {
      filters.push({ column, value });
    }
  }
  return filters;
}

function buildWhereClause(
  config: TableQueryConfig,
  filters: Array<{ column: TableColumnConfig; value: string }>
): { params: string[]; sql: string } {
  const params: string[] = [];
  const predicates: string[] = [];
  if (config.whereSql) {
    predicates.push(`(${config.whereSql})`);
  }

  for (const filter of filters) {
    params.push(likePattern(filter.value));
    predicates.push(`${filter.column.filterSql} ilike $${params.length} escape '\\'`);
  }

  return {
    params,
    sql: predicates.length ? `where ${predicates.join(' and ')}` : ''
  };
}

function hasTableQuery(query: Record<string, unknown>) {
  return Object.keys(query).some((key) => key === 'page' || key === 'page_size' || key === 'sort' || key.startsWith('filter_'));
}

function columnSql(columnName: string): TableColumnConfig {
  return {
    filterSql: textSql(columnName),
    sortSql: columnName
  };
}

function textSql(expression: string): string {
  return `coalesce((${expression})::text, '')`;
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function parsePagination(query: Record<string, unknown>) {
  return {
    page: integerQueryField(query.page, 0, 0, 100000),
    pageSize: integerQueryField(query.page_size, 25, 1, 200)
  };
}

function stringQueryField(value: unknown): string {
  const rawValue = Array.isArray(value) ? value[0] : value;
  return typeof rawValue === 'string' || typeof rawValue === 'number' ? String(rawValue) : '';
}

function integerQueryField(value: unknown, fallback: number, min: number, max: number): number {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsed = typeof rawValue === 'string' || typeof rawValue === 'number' ? Number(rawValue) : NaN;
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function integerPathParam(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw httpError(400, 'id must be a positive integer');
  }
  return parsed;
}

function positiveIntegerBodyField(body: unknown, key: string): number {
  const value = (body ?? {}) as Record<string, unknown>;
  const rawValue = value[key];
  const parsed = typeof rawValue === 'string' || typeof rawValue === 'number' ? Number(rawValue) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw httpError(400, `${key} must be a positive integer`);
  }
  return parsed;
}

function parseStoreInput(body: unknown): StoreInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const input: StoreInput = {
    canonical_domain: stringField(value, 'canonical_domain'),
    city: stringField(value, 'city'),
    country: stringField(value, 'country') || 'Mexico',
    facebook_url: stringField(value, 'facebook_url'),
    instagram_url: stringField(value, 'instagram_url'),
    logo_url: stringField(value, 'logo_url'),
    name: stringField(value, 'name'),
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
    input.instagram_url,
    input.facebook_url,
    input.city,
    input.state,
    input.country,
    input.logo_url,
    input.status
  ];
}

function parseFrontPageCategoryInput(body: unknown): FrontPageCategoryInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const categoryType = stringField(value, 'category_type').toLowerCase();
  if (categoryType !== 'category' && categoryType !== 'family' && categoryType !== 'mechanic') {
    throw httpError(400, 'category_type must be category, family, or mechanic');
  }

  const input: FrontPageCategoryInput = {
    category_id: positiveIntegerBodyField(body, 'category_id'),
    category_type: categoryType,
    order: numberField(value, 'order'),
    title: stringField(value, 'title')
  };

  if (!input.title) {
    throw httpError(400, 'title is required');
  }

  return input;
}

function frontPageCategoryParams(input: FrontPageCategoryInput): unknown[] {
  return [input.category_type, input.category_id, input.title, input.order];
}

function frontPageCategoryOptionsSql(onlyUnlinkedGames: boolean): string {
  const unlinkedFilterSql = onlyUnlinkedGames
    ? `
      where not exists (
        select 1
        from item_categories existing_ic
        join front_page_categories existing_category_fpc
          on existing_category_fpc.category_type = 'category'
         and existing_category_fpc.category_id = existing_ic.category_id
        where existing_ic.item_id = qi.item_id
      )
      and not exists (
        select 1
        from item_families existing_ifa
        join front_page_categories existing_family_fpc
          on existing_family_fpc.category_type = 'family'
         and existing_family_fpc.category_id = existing_ifa.family_id
        where existing_ifa.item_id = qi.item_id
      )
      and not exists (
        select 1
        from item_mechanics existing_im
        join front_page_categories existing_mechanic_fpc
          on existing_mechanic_fpc.category_type = 'mechanic'
         and existing_mechanic_fpc.category_id = existing_im.mechanic_id
        where existing_im.item_id = qi.item_id
      )
    `
    : '';

  return `
    with qualified_items as (
      select distinct item_id
      from store_items
      where item_id is not null
        and is_boardgame = true
        and is_boardgame_confirmed = true
    ),
    countable_items as (
      select qi.item_id
      from qualified_items qi
      ${unlinkedFilterSql}
    )
    select category_type, category_id, bgg_id, name, name_es, front_page_category_id, game_count
    from (
      select
        'category' as category_type,
        bc.id as category_id,
        bc.bgg_id,
        bc.name,
        bc.name_es,
        fpc.id as front_page_category_id,
        coalesce(ic.game_count, 0) as game_count
      from boardgame_categories bc
      left join (
        select min(id) as id, category_id
        from front_page_categories
        where category_type = 'category'
        group by category_id
      ) fpc on fpc.category_id = bc.id
      left join (
        select ic.category_id, count(*)::int as game_count
        from item_categories ic
        join countable_items ci on ci.item_id = ic.item_id
        group by ic.category_id
      ) ic on ic.category_id = bc.id
      union all
      select
        'family' as category_type,
        bf.id as category_id,
        bf.bgg_id,
        bf.name,
        bf.name_es,
        fpc.id as front_page_category_id,
        coalesce(ifa.game_count, 0) as game_count
      from boardgame_families bf
      left join (
        select min(id) as id, category_id
        from front_page_categories
        where category_type = 'family'
        group by category_id
      ) fpc on fpc.category_id = bf.id
      left join (
        select ifa.family_id as category_id, count(*)::int as game_count
        from item_families ifa
        join countable_items ci on ci.item_id = ifa.item_id
        group by ifa.family_id
      ) ifa on ifa.category_id = bf.id
      union all
      select
        'mechanic' as category_type,
        bm.id as category_id,
        bm.bgg_id,
        bm.name,
        bm.name_es,
        fpc.id as front_page_category_id,
        coalesce(im.game_count, 0) as game_count
      from boardgame_mechanics bm
      left join (
        select min(id) as id, category_id
        from front_page_categories
        where category_type = 'mechanic'
        group by category_id
      ) fpc on fpc.category_id = bm.id
      left join (
        select im.mechanic_id as category_id, count(*)::int as game_count
        from item_mechanics im
        join countable_items ci on ci.item_id = im.item_id
        group by im.mechanic_id
      ) im on im.category_id = bm.id
    ) options
    order by category_type asc, name asc
  `;
}

function frontPageCategoryProductsSql(categoryType: string): string {
  const normalizedType = categoryType.toLowerCase();

  if (normalizedType === 'category') {
    return frontPageCategoryProductsSqlFor('item_categories ic', 'ic.item_id', 'ic.category_id');
  }
  if (normalizedType === 'family') {
    return frontPageCategoryProductsSqlFor('item_families ifa', 'ifa.item_id', 'ifa.family_id');
  }
  if (normalizedType === 'mechanic') {
    return frontPageCategoryProductsSqlFor('item_mechanics im', 'im.item_id', 'im.mechanic_id');
  }

  throw httpError(400, 'category_type must be category, family, or mechanic');
}

function frontPageCategoryProductsSqlFor(relationSql: string, itemIdSql: string, categoryIdSql: string): string {
  return `
    with qualified_items as (
      select distinct item_id
      from store_items
      where item_id is not null
        and is_boardgame = true
        and is_boardgame_confirmed = true
    )
    select
      i.id,
      i.canonical_name,
      i.canonical_name_es,
      i.image_url,
      i.image_url_es,
      i.item_type,
      i.year_published
    from ${relationSql}
    join qualified_items qi on qi.item_id = ${itemIdSql}
    join items i on i.id = ${itemIdSql}
    where ${categoryIdSql} = $1
    order by i.canonical_name asc
    limit 500
  `;
}

function parseStoreCandidateInput(body: unknown): StoreCandidateInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const input: StoreCandidateInput = {
    canonical_domain: stringField(value, 'canonical_domain'),
    city: stringField(value, 'city'),
    confidence: numberField(value, 'confidence'),
    country: stringField(value, 'country') || 'Mexico',
    evidence: listField(value, 'evidence'),
    facebook_url: stringField(value, 'facebook_url'),
    instagram_url: stringField(value, 'instagram_url'),
    state: stringField(value, 'state'),
    store_logo: stringField(value, 'store_logo'),
    store_name: stringField(value, 'store_name'),
    website_url: stringField(value, 'website_url')
  };

  if (!input.store_name || !input.canonical_domain || !input.website_url) {
    throw httpError(400, 'store_name, canonical_domain, and website_url are required');
  }

  return input;
}

function storeCandidateParams(input: StoreCandidateInput): unknown[] {
  return [
    input.store_name,
    input.canonical_domain,
    input.website_url,
    input.instagram_url,
    input.facebook_url,
    input.city,
    input.state,
    input.country,
    input.store_logo,
    input.confidence,
    JSON.stringify(input.evidence)
  ];
}

function parseItemInput(body: unknown): ItemInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const canonicalName = stringField(value, 'canonical_name');
  const normalizedName = stringField(value, 'normalized_name') || normalizeItemName(canonicalName);
  const canonicalNameEs = stringField(value, 'canonical_name_es');
  const normalizedNameEs = stringField(value, 'normalized_name_es') || normalizeItemName(canonicalNameEs);
  const input: ItemInput = {
    bgg_id: nullableIntegerField(value, 'bgg_id'),
    bgg_url: stringField(value, 'bgg_url'),
    canonical_name: canonicalName,
    canonical_name_es: canonicalNameEs,
    complexity: nullableNumberField(value, 'complexity'),
    description: stringField(value, 'description'),
    description_es: stringField(value, 'description_es'),
    image_url: stringField(value, 'image_url'),
    image_url_es: stringField(value, 'image_url_es'),
    item_type: stringField(value, 'item_type') || 'base_game',
    max_minutes: nullableIntegerField(value, 'max_minutes'),
    max_players: nullableIntegerField(value, 'max_players'),
    min_age: nullableIntegerField(value, 'min_age'),
    min_minutes: nullableIntegerField(value, 'min_minutes'),
    min_players: nullableIntegerField(value, 'min_players'),
    normalized_name: normalizedName,
    normalized_name_es: normalizedNameEs,
    parent_item_id: nullableIntegerField(value, 'parent_item_id'),
    rating: nullableNumberField(value, 'rating'),
    status: stringField(value, 'status') || 'draft',
    weight: nullableNumberField(value, 'weight'),
    year_published: nullableIntegerField(value, 'year_published')
  };

  if (!input.canonical_name || !input.normalized_name || !input.item_type) {
    throw httpError(400, 'canonical_name, normalized_name, and item_type are required');
  }

  return input;
}

function itemParams(input: ItemInput): unknown[] {
  return [
    input.canonical_name,
    input.normalized_name,
    input.canonical_name_es,
    input.normalized_name_es,
    input.item_type,
    input.parent_item_id,
    input.bgg_id,
    input.bgg_url,
    input.year_published,
    input.description,
    input.description_es,
    input.min_players,
    input.max_players,
    input.min_minutes,
    input.max_minutes,
    input.complexity,
    input.rating,
    input.weight,
    input.min_age,
    input.image_url,
    input.image_url_es,
    input.status
  ];
}

function parseItemCandidateInput(body: unknown): ItemCandidateInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const input: ItemCandidateInput = {
    availability: stringField(value, 'availability') || 'unknown',
    availability_source: stringField(value, 'availability_source') || 'none',
    category_confidence: nullableNumberField(value, 'category_confidence'),
    classification_reasons: jsonField(value, 'classification_reasons', []),
    currency: stringField(value, 'currency') || 'MXN',
    description: stringField(value, 'description'),
    image_url: stringField(value, 'image_url'),
    is_boardgame: booleanField(value, 'is_boardgame'),
    is_boardgame_confirmed: booleanField(value, 'is_boardgame_confirmed'),
    item_id: nullableIntegerField(value, 'item_id'),
    item_type: stringField(value, 'item_type') || 'unknown',
    language: stringField(value, 'language'),
    language_evidence: stringField(value, 'language_evidence'),
    language_source: stringField(value, 'language_source'),
    match_payload: jsonField(value, 'match_payload', {}),
    match_reasons: jsonField(value, 'match_reasons', []),
    match_score: nullableNumberField(value, 'match_score'),
    match_source: stringField(value, 'match_source'),
    matched_bgg_id: nullableIntegerField(value, 'matched_bgg_id'),
    matched_name: stringField(value, 'matched_name'),
    max_minutes: nullableIntegerField(value, 'max_minutes'),
    max_players: nullableIntegerField(value, 'max_players'),
    min_age: nullableIntegerField(value, 'min_age'),
    min_minutes: nullableIntegerField(value, 'min_minutes'),
    min_players: nullableIntegerField(value, 'min_players'),
    price: nullableNumberField(value, 'price'),
    price_source: stringField(value, 'price_source') || 'none',
    processing_error: stringField(value, 'processing_error'),
    publisher: stringField(value, 'publisher'),
    raw_payload: jsonField(value, 'raw_payload', {}),
    raw_price: stringField(value, 'raw_price'),
    source_listing_url: stringField(value, 'source_listing_url'),
    source_url: stringField(value, 'source_url'),
    listing_status: listingStatusField(value, 'listing_status'),
    store_id: nullableIntegerField(value, 'store_id'),
    store_sku: stringField(value, 'store_sku'),
    title: stringField(value, 'title')
  };

  if (!input.title || !input.source_url) {
    throw httpError(400, 'title and source_url are required');
  }

  return input;
}

function itemCandidateParams(input: ItemCandidateInput): unknown[] {
  return [
    input.store_id,
    input.source_url,
    input.source_listing_url,
    input.title,
    input.publisher,
    input.description,
    input.item_id,
    input.item_type,
    input.min_players,
    input.max_players,
    input.min_minutes,
    input.max_minutes,
    input.min_age,
    input.language,
    input.language_source,
    input.language_evidence,
    input.image_url,
    input.listing_status,
    input.raw_price,
    input.price,
    input.price_source,
    input.currency,
    input.availability,
    input.availability_source,
    input.store_sku,
    input.raw_payload,
    input.is_boardgame,
    input.is_boardgame_confirmed,
    input.category_confidence,
    input.classification_reasons,
    input.match_source,
    input.matched_bgg_id,
    input.matched_name,
    input.match_score,
    input.match_reasons,
    input.match_payload,
    input.processing_error
  ];
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' ? field.trim() : '';
}

function listingStatusField(value: Record<string, unknown>, key: string): string {
  const status = stringField(value, key).toUpperCase() || 'PENDING';
  if (!['PENDING', 'LISTED', 'UNLISTED', 'REJECTED'].includes(status)) {
    throw httpError(400, `${key} must be PENDING, LISTED, UNLISTED, or REJECTED`);
  }
  return status;
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field === 'boolean') {
    return field;
  }
  if (typeof field === 'number') {
    return field !== 0;
  }
  if (typeof field === 'string') {
    const normalized = field.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'on' || normalized === 'yes';
  }
  return false;
}

function rowString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' || typeof field === 'number' ? String(field).trim() : '';
}

function hasRowValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function itemTypeFromCandidate(candidate: Record<string, unknown>): 'base_game' | 'expansion' {
  return rowString(candidate, 'item_type') === 'expansion' ? 'expansion' : 'base_game';
}

function parseCreateItemFromCandidateOptions(body: unknown): {
  bggId: number | null;
  implementsBggItem: boolean;
  matchPayload: Record<string, unknown>;
} {
  const value = (body ?? {}) as Record<string, unknown>;
  const implementsBggItem = booleanField(value, 'implements');
  if (!implementsBggItem) {
    return {
      bggId: null,
      implementsBggItem,
      matchPayload: { source: 'admin_manual_create_item' }
    };
  }

  const bggId = positiveIntegerBodyField(body, 'bgg_id');
  return {
    bggId,
    implementsBggItem,
    matchPayload: {
      bgg_id: bggId,
      implements: true,
      source: 'admin_manual_create_item'
    }
  };
}

function normalizeItemName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (field === '' || field === null || field === undefined) {
    return 0;
  }

  const parsed = typeof field === 'number' ? field : Number(field);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableIntegerField(value: Record<string, unknown>, key: string): number | null {
  const parsed = nullableNumberField(value, key);
  return parsed === null || !Number.isInteger(parsed) ? null : parsed;
}

function nullableNumberField(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  if (field === '' || field === null || field === undefined) {
    return null;
  }

  const parsed = typeof field === 'number' ? field : Number(field);
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonField(value: Record<string, unknown>, key: string, fallback: unknown): string {
  const field = value[key];
  if (field === '' || field === null || field === undefined) {
    return JSON.stringify(fallback);
  }

  if (typeof field === 'string') {
    try {
      return JSON.stringify(JSON.parse(field));
    } catch {
      throw httpError(400, `${key} must be valid JSON`);
    }
  }

  return JSON.stringify(field);
}

function listField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  if (Array.isArray(field)) {
    return field.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof field === 'string') {
    return field
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
