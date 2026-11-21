begin;

create table public.event_stats (
    event_id bigint not null references public.events(id) on delete cascade,
    date date not null,
    click bigint not null default 0,
    positive bigint not null default 0,
    negative bigint not null default 0,
    dismiss bigint not null default 0,
    primary key (event_id, date),
    constraint event_stats_counts_check check (
        click >= 0 and positive >= 0 and negative >= 0 and dismiss >= 0
    )
);

commit;
