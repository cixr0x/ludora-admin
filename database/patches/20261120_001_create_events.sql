begin;

create table public.events (
    id bigserial primary key,
    name text not null,
    description text not null,
    starts_at timestamptz not null,
    ends_at timestamptz not null,
    min_price numeric(12, 2),
    max_price numeric(12, 2),
    country text not null,
    city text not null,
    venue text not null,
    link text not null,
    time_zone text not null default 'America/Mexico_City',
    constraint events_dates_check check (ends_at > starts_at),
    constraint events_prices_check check (
        (min_price is null or min_price >= 0)
        and (max_price is null or max_price >= 0)
        and (min_price is null or max_price is null or min_price <= max_price)
    ),
    constraint events_link_check check (link ~* '^https?://[^[:space:]]+$')
);

create index events_starts_at_id_idx on public.events (starts_at, id);

commit;
