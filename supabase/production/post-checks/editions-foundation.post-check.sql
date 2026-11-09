-- Read-only post-check for 20270102000000_editions_foundation.sql. Expect every flag true and the counts shown.
select
  (select count(*) from information_schema.tables where table_schema='public' and table_name like 'edition%' or table_name = 'editions') as tables_expected_14,
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and (c.relname like 'edition%') and not c.relrowsecurity) = 0 as all_rls_on,
  (select count(*) from pg_policies where schemaname='public' and tablename like 'edition%' and cmd='ALL') = 0 as no_for_all_policies,
  (select count(*) from information_schema.role_table_grants where grantee='anon' and table_name like 'edition%' and privilege_type <> 'SELECT') = 0 as anon_read_only,
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and p.proname like '%edition%' and has_function_privilege('anon', p.oid, 'execute')) = 'edition_entitled,edition_is_public,editions_enabled' as anon_exec_only_public_helpers,
  (select count(*) from storage.buckets where id='edition-media') = 1 as bucket_exists,
  (select count(*) from public.edition_organisers) = 0 as no_organisers_yet,
  (select count(*) from public.edition_reserved_names) = 4 as reserved_names_4,
  not public.editions_enabled() as flag_still_off;
