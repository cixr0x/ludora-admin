begin;

create table if not exists store_item_update_platform_cooldown (
    worker_name text not null
        references store_item_update_worker_state(worker_name) on delete cascade,
    platform text not null
        check (platform in ('shopify', 'woocommerce')),
    blocked_until timestamptz,
    consecutive_429s integer not null default 0
        check (consecutive_429s >= 0),
    updated_at timestamptz not null default now(),
    primary key (worker_name, platform)
);

insert into store_item_update_platform_cooldown (
    worker_name,
    platform,
    blocked_until,
    consecutive_429s,
    updated_at
)
select
    worker_name,
    'shopify',
    shopify_blocked_until,
    shopify_consecutive_429s,
    now()
from store_item_update_worker_state
where shopify_blocked_until is not null
   or shopify_consecutive_429s > 0
on conflict (worker_name, platform) do nothing;

commit;
