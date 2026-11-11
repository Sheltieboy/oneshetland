-- Read-only post-check for 20270102150000_editions_admin_contacts.sql. Every row must say ok = true.
select 'the admin contacts function exists, is SECURITY DEFINER with a pinned search_path' as check,
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'admin_edition_org_contacts' and p.prosecdef and coalesce(p.proconfig::text ilike '%search_path%', false)) = 1 as ok
union all
select 'it is executable by signed-in users (it refuses non-administrators itself) and NOT by anon or PUBLIC',
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'admin_edition_org_contacts'
          and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
          and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')) = 1
union all
select 'contact_email is still NOT selectable directly by authenticated or anon (the table grants are unchanged)',
       (select count(*) from information_schema.column_privileges where table_schema = 'public' and table_name = 'edition_organisers' and column_name = 'contact_email' and grantee in ('anon', 'authenticated') and privilege_type = 'SELECT') = 0
union all
select 'the signed-out role still executes exactly the eleven reviewed public helpers (foundation check is authoritative)',
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ilike '%edition%' and has_function_privilege('anon', p.oid, 'execute')) = 11;
