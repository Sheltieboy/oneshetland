-- Read-only post-check for the Launch / Showcase rate card and promotions: migrations 20270104000000 and 20270104010000. Every row must say ok = true. One assertion per row.

-- ── catalogue ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
select 'the six rate-card rows exist with the contract codes, kinds and prices, and are INACTIVE until an administrator switches them on' as check,
       (select string_agg(code || ':' || kind || ':' || price_pence || ':' || active::text, ',' order by sort) from public.edition_packages
         where code in ('launch', 'showcase', 'promo_discovery_2w', 'promo_discovery_6w', 'promo_homepage_7d', 'promo_campaign_full'))
       = 'launch:package:24900:false,showcase:package:49900:false,promo_discovery_2w:promotion:7900:false,promo_discovery_6w:promotion:17900:false,promo_homepage_7d:promotion:14900:false,promo_campaign_full:promotion:24900:false' as ok
union all
select 'Launch and Showcase carry all five features, no member cap and the same publishing period; Showcase adds only the campaign grant',
       (select count(*) from public.edition_packages where code in ('launch', 'showcase') and duration_days = 365 and max_members is null and audience = 'any'
           and features @> '["collect_payments","memberships","participation_fees","offline_records","csv_export"]'::jsonb and jsonb_array_length(features) = 5) = 2
       and (select grants from public.edition_packages where code = 'launch') = '{}'::jsonb
       and (select grants from public.edition_packages where code = 'showcase') = '{"discovery_days":42,"homepage_days":7,"grouped":true}'::jsonb
union all
select 'promotions have no publishing period, no features and no cap (they can never extend publishing)',
       (select count(*) from public.edition_packages where kind = 'promotion' and (duration_days is not null or features <> '[]'::jsonb or max_members is not null)) = 0
union all
select 'the five earlier rows are retired (inactive and stamped, never deleted) and no retired row is active',
       (select count(*) from public.edition_packages where code in ('publish_single', 'publish_collect', 'publish_full', 'community_publish', 'community_collect') and not active and retired_at is not null) = 5
       and (select count(*) from public.edition_packages where retired_at is not null and active) = 0
union all
select 'the catalogue constraints exist and are validated (kind, grants, duration by kind, promotion shape, retired is inactive)',
       (select count(*) from pg_constraint where conrelid = 'public.edition_packages'::regclass and convalidated
          and conname in ('edition_packages_kind_check', 'edition_packages_grants_ok', 'edition_packages_duration_by_kind', 'edition_packages_promotion_shape', 'edition_packages_retired_inactive')) = 5
union all
select 'the packages table read policy shows active rows to signed-in users and no longer filters by audience',
       (select qual from pg_policies where tablename = 'edition_packages' and policyname = 'edition_packages read') not like '%audience%'
       and not has_table_privilege('anon', 'public.edition_packages', 'select')
union all
select 'the new configuration keys are accepted by the validator (and the function is administrator-only)',
       (select prosrc like '%editions.promo.homepage_capacity%' and prosrc like '%editions.commerce.vat_note%' and prosrc like '%editions.app.handoff_ios%' and prosrc like '%is_admin%' from pg_proc where oid = 'public.admin_set_edition_commerce_config(text,text)'::regprocedure)

-- ── tables ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
union all
select 'every promotion table has RLS on, no write grant for anon or signed-in users, no anon grant at all, and only SELECT policies (no FOR ALL)',
       (select count(*) from pg_class c where c.oid in ('public.edition_promo_rights'::regclass, 'public.edition_promo_bookings'::regclass, 'public.edition_promo_daily'::regclass, 'public.edition_promo_track_rate'::regclass) and c.relrowsecurity) = 4
       and (select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name in ('edition_promo_rights', 'edition_promo_bookings', 'edition_promo_daily', 'edition_promo_track_rate')
              and grantee in ('anon', 'authenticated', 'public') and privilege_type <> 'SELECT') = 0
       and (select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name in ('edition_promo_rights', 'edition_promo_bookings', 'edition_promo_daily', 'edition_promo_track_rate') and grantee in ('anon', 'public')) = 0
       and (select count(*) from pg_policies where schemaname = 'public' and tablename like 'edition_promo_%' and cmd <> 'SELECT') = 0
union all
select 'the rate-limit table has no policy and no grant for anyone (only the definer functions touch it)',
       (select count(*) from pg_policies where tablename = 'edition_promo_track_rate') = 0
       and (select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'edition_promo_track_rate' and grantee in ('anon', 'authenticated', 'public')) = 0
union all
select 'rights are append-only (only voiding), a booking must match its right, and a live right can be booked only once (unique index)',
       (select count(*) from pg_trigger where tgname in ('edition_promo_rights_guard', 'edition_promo_bookings_guard') and not tgisinternal) = 2
       and (select count(*) from pg_indexes where indexname = 'edition_promo_bookings_right_live_uq') = 1
       and (select count(*) from pg_indexes where indexname = 'edition_promo_rights_order_kind_uq') = 1

-- ── functions ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
union all
select 'every promotion function is SECURITY DEFINER with a pinned search_path and carries no PUBLIC execute grant',
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'edition_promo_%' or p.proname in ('edition_featured', 'admin_edition_promo_calendar', 'admin_promo_cancel', 'admin_promo_reschedule', 'admin_grant_promo_right', 'edition_my_promo_rights'))
          and p.proname not in ('edition_promo_today', 'edition_promo_rights_guard', 'edition_promo_bookings_guard')
          and (not p.prosecdef or not coalesce(p.proconfig::text ilike '%search_path%', false) or p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))) = 0
union all
select 'the signed-out role may execute exactly edition_featured and edition_promo_track among the promotion functions',
       coalesce((select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text collate "C") from pg_proc p where p.pronamespace = 'public'::regnamespace
                  and (p.proname like '%promo%' or p.proname = 'edition_featured') and has_function_privilege('anon', p.oid, 'execute')), '') = 'edition_featured(text),edition_promo_track(uuid,text,text)'
union all
select 'the internal promotion helpers (lock, validator, cancel and reschedule cores, refund voiding, config reader) cannot be executed by anon or signed-in users',
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('edition_promo_lock', 'edition_promo_validate', 'edition_promo_cancel_core', 'edition_promo_reschedule_core', 'edition_promo_void_order_rights', 'edition_promo_cfg_int')
          and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) = 0
       and (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('edition_promo_lock', 'edition_promo_validate', 'edition_promo_cancel_core', 'edition_promo_reschedule_core', 'edition_promo_void_order_rights', 'edition_promo_cfg_int')) = 6
union all
select 'the booking, cancel, reschedule, report and admin functions are signed-in only (never anon)',
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('edition_my_promo_rights', 'edition_promo_availability', 'edition_promo_book', 'edition_promo_book_campaign', 'edition_promo_cancel', 'edition_promo_reschedule', 'edition_promo_report',
                            'admin_edition_promo_calendar', 'admin_promo_cancel', 'admin_promo_reschedule', 'admin_grant_promo_right', 'edition_promo_settings')
          and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')) = 12
union all
select 'fulfilment and refunds are service-role only; promotion rights are created only from the order snapshot and voided only by a full refund',
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('edition_fulfil_order', 'edition_refund_order')
          and has_function_privilege('service_role', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')) = 2
       and (select prosrc like '%edition_promo_rights%' and prosrc like '%grants%' from pg_proc where proname = 'edition_fulfil_order')
       and (select prosrc like '%edition_promo_void_order_rights%' from pg_proc where proname = 'edition_refund_order')
union all
select 'a promotion order needs an approved Edition with a live publish entitlement, and a promotion never creates a publish entitlement',
       (select prosrc like '%promotion%' and prosrc like '%edition_entitled%' and prosrc like '%not_live%' from pg_proc where proname = 'edition_create_order')
       and (select prosrc like '%v_kind = ''package''%' from pg_proc where proname = 'edition_fulfil_order')
union all
select 'the promotion window rules are in the validator: published and approved, live publish entitlement, publish window end, lead time, horizon, capacity, one per day, homepage fairness',
       (select prosrc like '%not_live%' and prosrc like '%no_entitlement%' and prosrc like '%outside_publish_window%' and prosrc like '%too_early%' and prosrc like '%too_far%' and prosrc like '%full%' and prosrc like '%already_booked%' and prosrc like '%fairness_limit%'
          from pg_proc where proname = 'edition_promo_validate')

-- ── state: nothing is on sale, nothing is booked, Editions and payments are as they were ──────────────────────────────────────────────────────
union all
select 'nothing is on sale and no promotion data exists on a fresh apply (no active priced package, no right, no booking)',
       (select count(*) from public.edition_packages where active and price_pence > 0) = 0
       and (select count(*) from public.edition_promo_rights) = 0 and (select count(*) from public.edition_promo_bookings) = 0;
