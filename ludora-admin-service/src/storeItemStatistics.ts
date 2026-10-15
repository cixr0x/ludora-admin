export const storeItemStatisticsFields = [
  'total_items',
  'boardgame_true_confirmed_true',
  'boardgame_true_confirmed_false',
  'boardgame_false_confirmed_true',
  'boardgame_false_confirmed_false',
  'confirmed_boardgame_listed',
  'confirmed_boardgame_pending',
  'confirmed_boardgame_rejected'
] as const;

export const storeItemStatisticsAggregateSql = `
  count(si.id)::integer as total_items,
  count(si.id) filter (
    where si.is_boardgame = true and si.is_boardgame_confirmed = true
  )::integer as boardgame_true_confirmed_true,
  count(si.id) filter (
    where si.is_boardgame = true and si.is_boardgame_confirmed = false
  )::integer as boardgame_true_confirmed_false,
  count(si.id) filter (
    where si.is_boardgame = false and si.is_boardgame_confirmed = true
  )::integer as boardgame_false_confirmed_true,
  count(si.id) filter (
    where si.is_boardgame = false and si.is_boardgame_confirmed = false
  )::integer as boardgame_false_confirmed_false,
  count(si.id) filter (
    where si.is_boardgame = true and si.is_boardgame_confirmed = true and si.listing_status = 'LISTED'
  )::integer as confirmed_boardgame_listed,
  count(si.id) filter (
    where si.is_boardgame = true and si.is_boardgame_confirmed = true and si.listing_status = 'PENDING'
  )::integer as confirmed_boardgame_pending,
  count(si.id) filter (
    where si.is_boardgame = true and si.is_boardgame_confirmed = true and si.listing_status = 'REJECTED'
  )::integer as confirmed_boardgame_rejected
`;
