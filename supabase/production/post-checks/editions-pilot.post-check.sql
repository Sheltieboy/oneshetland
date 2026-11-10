-- Read-only post-check for the Editions pilot migration (20270102200000). Every row must say ok = true.
select 'the pilot approvals table has RLS, one admin-only read policy, and no write grant for anon or authenticated' as check,
       (select relrowsecurity from pg_class where oid = 'public.edition_pilot_approvals'::regclass)
       and (select count(*) from pg_policies where tablename = 'edition_pilot_approvals' and cmd = 'SELECT' and qual like '%is_admin%') = 1
       and (select count(*) from pg_policies where tablename = 'edition_pilot_approvals') = 1
       and (select count(*) from information_schema.role_table_grants where table_name = 'edition_pilot_approvals' and grantee = 'anon') = 0
       and (select count(*) from information_schema.role_table_grants where table_name = 'edition_pilot_approvals' and grantee = 'authenticated' and privilege_type <> 'SELECT') = 0 as ok
union all
select 'one live approval per organiser (unique partial index) and approvals are append-only (guard trigger)',
       (select count(*) from pg_indexes where indexname = 'edition_pilot_one_live_approval') = 1
       and (select count(*) from pg_trigger where tgname = 'edition_pilot_approvals_guard' and not tgisinternal) = 1
union all
select 'the pilot predicate is referenced by exactly one function (edition_is_public) and one policy (organisers public read); creation, commerce and membership predicates do not mention it',
       (select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc like '%edition_pilot_visible%' and p.proname not like 'admin_%') = 'edition_is_public'
       and (select string_agg(policyname, ',') from pg_policies where schemaname = 'public' and (coalesce(qual, '') || coalesce(with_check, '')) like '%edition_pilot_visible%') = 'edition_organisers public read'
       and (select count(*) from pg_proc where proname in ('edition_dark_launch_guard', 'edition_commerce_enabled', 'edition_tier_public', 'create_edition_organiser', 'create_edition_organiser_for_hub', 'edition_create_order') and prosrc like '%pilot%') = 0
union all
select 'the five administrator pilot functions are signed-in only, and the internal switch reader is not executable by anon or authenticated',
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('admin_set_editions_pilot', 'admin_create_edition_organiser_for_hub', 'admin_approve_edition_pilot', 'admin_revoke_edition_pilot', 'admin_grant_edition_pilot_publish')
          and has_function_privilege('authenticated', oid, 'execute') and not has_function_privilege('anon', oid, 'execute')) = 5
       and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'editions_pilot' and (has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute'))) = 0
union all
select 'Hub verification is administrator-only: admin_set_hub_verified is signed-in only, never anon, and is the only function that writes hubs.is_verified in the Editions code',
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_set_hub_verified' and has_function_privilege('authenticated', oid, 'execute') and not has_function_privilege('anon', oid, 'execute') and prosecdef and prosrc like '%is_admin%') = 1
       and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname ilike '%edition%' and prosrc ilike '%set is_verified%') = 0
union all
select 'edition_pilot_visible is the only new function the signed-out role can run',
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname ilike '%pilot%' and has_function_privilege('anon', oid, 'execute')) = 1
union all
select 'the pilot switch alone exposes nothing: every Edition public while editions.enabled is off belongs to an organiser with a live approval',
       public.editions_enabled() or (select count(*) from public.editions e where public.edition_is_public(e.id)
         and not exists (select 1 from public.edition_pilot_approvals a where a.organiser_id = e.organiser_id and a.revoked_at is null)) = 0
union all
select 'every live approval is for a verified, non-test organiser whose Hub (if any) is active and verified',
       (select count(*) from public.edition_pilot_approvals a join public.edition_organisers o on o.id = a.organiser_id left join public.hubs h on h.id = o.hub_id
         where a.revoked_at is null and (o.status <> 'verified' or o.is_test or (o.hub_id is not null and not (h.is_active and coalesce(h.is_verified, false))))) = 0
union all
select 'payments are still impossible (commerce disabled, no orders, no active package)',
       not public.edition_commerce_enabled() and (select count(*) from public.edition_orders) = 0 and (select count(*) from public.edition_packages where active) = 0;
