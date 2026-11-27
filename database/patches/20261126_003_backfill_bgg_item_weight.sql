with cached_weights as (
    select i.id as item_id, i.bgg_id, c.id as cache_id, c.fetched_at,
        case when pg_input_is_valid(item.weight_text, 'numeric')
            then item.weight_text::numeric end as weight
    from public.items i
    join public.bgg_thing_cache c on c.bgg_id = i.bgg_id
    cross join lateral xmltable(
        '/items/item'
        passing case when xml_is_well_formed_document(c.raw_xml)
            then xmlparse(document c.raw_xml) end
        columns
            bgg_id text path '@id',
            weight_text text path '(statistics/ratings/averageweight/@value)[1]',
            weight_votes text path '(statistics/ratings/numweights/@value)[1]'
    ) item
    where not i.is_version
        and i.weight is null
        and item.bgg_id = i.bgg_id::text
        and item.weight_votes ~ '^[0-9]*[1-9][0-9]*$'
        and c.request_type in (
            'boardgame,boardgameexpansion,boardgameaccessory,rpgitem',
            'boardgame,boardgameexpansion,boardgameaccessory',
            'boardgame,boardgameexpansion'
        )
), latest_valid_weight as (
    select distinct on (item_id) item_id, bgg_id, weight
    from cached_weights
    where weight between 1 and 5
    order by item_id, fetched_at desc nulls last, cache_id desc
)
update public.items i
set weight = source.weight
from latest_valid_weight source
where i.id = source.item_id and i.bgg_id = source.bgg_id
    and not i.is_version and i.weight is null;
