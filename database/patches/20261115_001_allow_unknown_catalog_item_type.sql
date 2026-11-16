begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.items
    drop constraint items_item_type_check,
    add constraint items_item_type_check
        check (item_type in ('base_game', 'expansion', 'unknown'));

commit;
