-- Incremental patch: add contact form submission storage.
begin;

create table if not exists contact_form_submissions (
    id bigserial primary key,
    name text not null,
    email text not null,
    message text not null,
    created_at timestamptz not null default now()
);

create index if not exists contact_form_submissions_created_at_idx
on contact_form_submissions (created_at desc);

commit;
