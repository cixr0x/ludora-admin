begin;

update store_items
set next_update_at = now() + (random() * interval '24 hours')
where listing_status = 'LISTED';

commit;
