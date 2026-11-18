-- Read-only post-check for 20270102090000_editions_update_images.sql. Every row should say ok = true.
select 'image_url exists on edition_updates' as check, count(*) = 1 as ok from information_schema.columns where table_schema = 'public' and table_name = 'edition_updates' and column_name = 'image_url';
select 'image_url has a check constraint' as check, count(*) >= 1 as ok from pg_constraint where conrelid = 'public.edition_updates'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%image_url%';
select 'anon may read image_url but not write it' as check,
  count(*) filter (where privilege_type = 'SELECT') >= 1 and count(*) filter (where privilege_type in ('INSERT','UPDATE')) = 0 as ok
  from information_schema.column_privileges where table_schema = 'public' and table_name = 'edition_updates' and column_name = 'image_url' and grantee = 'anon';
