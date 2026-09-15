update stores
set
    platform = 'shopify',
    updated_at = now()
where id = 9
  and name = 'FOUR KINGDOMS'
  and nullif(trim(platform), '') is null;
