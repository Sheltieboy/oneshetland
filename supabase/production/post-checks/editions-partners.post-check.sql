-- Read-only post-check for 20270102010000_editions_partners.sql. Every row should say ok = true.
select 'rls on link tables' as check, count(*) = 3 as ok from pg_class where relname in ('edition_links','edition_link_notes','edition_link_offers') and relrowsecurity;
select 'no FOR ALL policy' as check, count(*) = 0 as ok from pg_policies where tablename like 'edition_link%' and cmd = 'ALL';
select 'no write grants to anon/authenticated' as check, count(*) = 0 as ok from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_name like 'edition_link%' and privilege_type <> 'SELECT';
select 'views are security_invoker' as check, count(*) = 4 as ok from pg_class where relname like 'edition_public_%' and relkind = 'v' and reloptions::text like '%security_invoker=true%';
select 'anon cannot run partnership functions' as check, count(*) = 0 as ok from pg_proc p where p.pronamespace = 'public'::regnamespace
  and (p.proname like 'edition_link%' or p.proname like 'edition_partner%' or p.proname like 'edition_find%' or p.proname like 'edition_my_%'
       or p.proname in ('edition_invite_partner','edition_request_to_join','edition_offer_options','edition_set_link_offers','edition_controls_subject','edition_joinable'))
  and has_function_privilege('anon', p.oid, 'execute');
select 'no edition column on shared tables' as check, count(*) = 0 as ok from information_schema.columns where table_schema = 'public' and table_name in ('local_businesses','local_offers','events','regular_activities','hubs') and column_name like '%edition%';
select 'no pending link without a live subject' as check, count(*) = 0 as ok from public.edition_links where state in ('pending','approved') and coalesce(business_id, event_id, activity_id) is null;
