begin;

set local lock_timeout = '2s';

alter table public.event_stats
    add column impression bigint not null default 0
    constraint event_stats_impression_check check (impression >= 0);

grant select (impression), insert (impression), update (impression)
    on table public.event_stats to ludora_public_api;

commit;
