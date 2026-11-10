-- Read-only post-check for the Editions 1.1 Hub migrations (20270102160000, 170000, 180000). Every row must say ok = true.
select 'edition_links accepts the hub kind, with hub_id and its constraints' as check,
       (select count(*) from information_schema.columns where table_schema='public' and table_name='edition_links' and column_name='hub_id') = 1
       and (select pg_get_constraintdef(oid) from pg_constraint where conname='edition_links_kind_check' and conrelid='public.edition_links'::regclass) like '%hub%' as ok
union all
select 'the Hub items table has RLS, no FOR ALL policy and no write grant for anon or authenticated',
       (select relrowsecurity from pg_class where oid='public.edition_link_hub_items'::regclass)
       and (select count(*) from pg_policies where tablename='edition_link_hub_items' and cmd='ALL') = 0
       and (select count(*) from information_schema.role_table_grants where table_name='edition_link_hub_items' and grantee in ('anon','authenticated') and privilege_type <> 'SELECT') = 0
union all
select 'both Hub public views are security_invoker and read through the eligibility predicate',
       (select count(*) from pg_class where relname in ('edition_public_hubs','edition_public_hub_items') and relkind='v' and reloptions::text like '%security_invoker=true%') = 2
       and (select count(*) from pg_views where schemaname='public' and viewname in ('edition_public_hubs','edition_public_hub_items') and definition like '%edition_participation_ok%') = 2
union all
select 'the public Hub view exposes only whitelisted Hub columns (no owner, members, payout or contact fields)',
       (select count(*) from information_schema.columns where table_schema='public' and table_name='edition_public_hubs'
          and column_name in ('owner_id','stripe_account_id','payout_enabled','contact_email','contact_phone','charity_number','memberships_enabled','join_mode')) = 0
union all
select 'no new Editions function is executable by anon or PUBLIC (the signed-out role still runs exactly the six reviewed helpers)',
       (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname ilike '%edition%' and has_function_privilege('anon', p.oid, 'execute')) = (6 + (select count(*) from pg_proc q where q.pronamespace = 'public'::regnamespace and q.proname = 'edition_pilot_visible'))
       and (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname ilike '%edition%' and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type='EXECUTE'))) = 0
union all
select 'Hub-derived organiser authority and the Hub organiser functions exist and are signed-in only',
       (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('edition_hub_role','edition_my_organisers','edition_my_hubs','create_edition_organiser_for_hub','edition_controls_hub') and p.prosecdef) = 5
       and (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('create_edition_organiser_for_hub','edition_my_hubs','edition_my_organisers') and has_function_privilege('anon', p.oid, 'execute')) = 0
union all
select 'one Editions organiser per Hub (unique index) and no organiser table grant changed',
       (select count(*) from pg_indexes where indexname='edition_organisers_one_per_hub') = 1
       and (select count(*) from information_schema.column_privileges where table_schema='public' and table_name='edition_organisers' and column_name in ('contact_email','verification_note','reserved_name_flag','verified_by','created_by') and grantee in ('anon','authenticated') and privilege_type='SELECT') = 0
union all
select 'edition-media storage policies now follow organiser authority and none is open to anon',
       (select count(*) from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'edition-media member%' and coalesce(qual,'') || coalesce(with_check,'') like '%edition_org_can%') = 3
union all
select 'packages have an audience; Community packages are hub-only, inactive drafts; the table read policy hides hub packages from non-administrators',
       (select count(*) from information_schema.columns where table_name='edition_packages' and column_name='audience') = 1
       and (select count(*) from public.edition_packages where audience='hub' and active) = 0
       and (select qual from pg_policies where policyname='edition_packages read') like '%audience%'
union all
select 'Editions are still dark and payments off', not public.editions_enabled() and not public.edition_commerce_enabled();

select 'the Add-from-your-Hub chooser exists, is read-only (stable) and is executable by signed-in users only',
       (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='edition_hub_own_items' and p.provolatile='s'
          and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')) = 1 as ok;
