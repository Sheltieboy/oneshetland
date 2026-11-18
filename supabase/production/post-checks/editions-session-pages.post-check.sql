-- Read-only post-check for 20270102120000_editions_session_pages.sql. Every row should say ok = true.
select 'image_url and presenters exist on edition_sessions' as check, count(*) = 2 as ok from information_schema.columns where table_schema = 'public' and table_name = 'edition_sessions' and column_name in ('image_url', 'presenters');
select 'session businesses table has RLS' as check, relrowsecurity as ok from pg_class where oid = 'public.edition_session_businesses'::regclass;
select 'anon cannot write session businesses' as check, count(*) = 0 as ok from information_schema.role_table_grants where table_schema = 'public' and table_name = 'edition_session_businesses' and grantee = 'anon' and privilege_type <> 'SELECT';
select 'only the function writes session businesses (no direct write for authenticated)' as check, count(*) = 0 as ok from information_schema.role_table_grants where table_schema = 'public' and table_name = 'edition_session_businesses' and grantee = 'authenticated' and privilege_type <> 'SELECT';
select 'set_businesses is not callable by anon' as check, not has_function_privilege('anon', 'public.edition_session_set_businesses(uuid, uuid[])', 'execute') as ok;
