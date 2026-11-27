with cached_items as (
    select distinct on (i.id)
        i.id as item_id, i.bgg_id, item.owned_text, item.language_poll
    from public.items i
    join public.bgg_thing_cache c on c.bgg_id = i.bgg_id
    cross join lateral xmltable(
        '/items/item'
        passing case when xml_is_well_formed_document(c.raw_xml)
            then xmlparse(document c.raw_xml) end
        columns
            bgg_id text path '@id',
            owned_text text path '(statistics/ratings/owned/@value)[1]',
            language_poll xml path '(poll[@name="language_dependence"])[1]'
    ) item
    where not i.is_version
        and (i.owned is null or i.language_dependence is null)
        and item.bgg_id = i.bgg_id::text
        and c.request_type in (
            'boardgame,boardgameexpansion,boardgameaccessory,rpgitem',
            'boardgame,boardgameexpansion,boardgameaccessory',
            'boardgame,boardgameexpansion'
        )
    order by i.id, case c.request_type
        when 'boardgame,boardgameexpansion,boardgameaccessory,rpgitem' then 1
        when 'boardgame,boardgameexpansion,boardgameaccessory' then 2
        else 3 end, c.fetched_at desc, c.id desc
), parsed as (
    select c.item_id, c.bgg_id,
        case when c.owned_text ~ '^[0-9]{1,10}$' then
            case when c.owned_text::bigint <= 2147483647 then c.owned_text::integer end
        end as owned,
        language.level as language_dependence
    from cached_items c
    left join lateral (
        select min(level) filter (where votes = highest_votes) as level
        from (
            select level, votes, max(votes) over () as highest_votes
            from (
                select
                    case when level_text ~ '^[1-5]$' then level_text::smallint end as level,
                    case when votes_text ~ '^[0-9]{1,10}$' then
                        case when votes_text::bigint <= 2147483647 then votes_text::integer end
                    end as votes
                from xmltable('/poll/results/result' passing c.language_poll
                    columns level_text text path '@level', votes_text text path '@numvotes')
            ) valid_votes
        ) ranked_votes
        having count(distinct level) = count(*) and count(votes) = count(*)
            and max(highest_votes) > 0 and count(*) filter (where votes = highest_votes) = 1
    ) language on true
)
update public.items i
set owned = coalesce(i.owned, p.owned),
    language_dependence = coalesce(i.language_dependence, p.language_dependence)
from parsed p
where i.id = p.item_id and i.bgg_id = p.bgg_id and not i.is_version
    and ((i.owned is null and p.owned is not null)
        or (i.language_dependence is null and p.language_dependence is not null));
