begin;

alter table public.items
    add column short_description text
        constraint items_short_description_single_line check (
            short_description !~ U&'[\000A\000D\2028\2029]'
        ),
    add column owned integer
        constraint items_owned_nonnegative check (owned >= 0),
    add column language_dependence smallint
        constraint items_language_dependence_range check (language_dependence between 1 and 5);

commit;
