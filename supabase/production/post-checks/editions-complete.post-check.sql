-- Read-only post-check for the finished Editions service: migrations 20270103000000 (Business and Hub identity), 010000 (Hub events switch), 020000 (review), 030000 (packages and notifications)
-- and 040000 (retire the pilot and the independent-organiser route). Every row must say ok = true. One assertion per row so a failure cannot hide inside a wide line.

-- ── identity: only a Business or a Hub can run Editions ────────────────────────────────────────────────────────────────────────────────────
select 'every organiser has exactly one parent (the rule is validated, not just declared) and no organiser breaks it' as check,
       (select convalidated from pg_constraint where conname = 'edition_organisers_one_parent' and conrelid = 'public.edition_organisers'::regclass) is true
       and (select count(*) from public.edition_organisers where num_nonnulls(hub_id, business_id) <> 1) = 0 as ok
union all
select 'the Hub and Business foreign keys RESTRICT deletion (a parent with an Editions profile can never be deleted and orphan its organiser)',
       (select confdeltype from pg_constraint where conname = 'edition_organisers_hub_id_fkey' and conrelid = 'public.edition_organisers'::regclass) = 'r'
       and (select confdeltype from pg_constraint where conname = 'edition_organisers_business_id_fkey' and conrelid = 'public.edition_organisers'::regclass) = 'r'
union all
select 'one live Editions profile per Hub and per Business (unique indexes)',
       (select count(*) from pg_indexes where schemaname = 'public' and indexname in ('edition_organisers_one_per_hub', 'edition_organisers_one_per_business')) = 2
union all
select 'business_id is readable like hub_id, but neither parent column is writable by a signed-in user and the organiser name is no longer client-writable',
       has_column_privilege('authenticated', 'public.edition_organisers', 'business_id', 'select') and has_column_privilege('anon', 'public.edition_organisers', 'business_id', 'select')
       and not has_column_privilege('authenticated', 'public.edition_organisers', 'business_id', 'insert') and not has_column_privilege('authenticated', 'public.edition_organisers', 'business_id', 'update')
       and not has_column_privilege('authenticated', 'public.edition_organisers', 'hub_id', 'update') and not has_column_privilege('authenticated', 'public.edition_organisers', 'name', 'update')
       and not has_column_privilege('authenticated', 'public.edition_organisers', 'name', 'insert')
union all
select 'the role and identity functions are signed-in only: callable by authenticated, never by anon or PUBLIC',
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('edition_ensure_organiser', 'edition_my_businesses', 'edition_my_hubs', 'edition_my_organisers', 'edition_org_role', 'edition_org_can', 'edition_can', 'edition_org_team')
          and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
          and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')) = 8
union all
select 'internal helpers (slug generator, Hub role, parent triggers, readiness items, notification triggers) cannot be executed by anon or signed-in users at all',
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('edition_slugify', 'edition_hub_role', 'edition_members_no_owner', 'edition_sync_parent_name', 'edition_readiness_items', 'edition_material_change', 'edition_reviews_append_only', 'edition_entitlement_notify')
          and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) = 0
       and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('edition_slugify', 'edition_hub_role', 'edition_members_no_owner', 'edition_sync_parent_name', 'edition_readiness_items', 'edition_material_change', 'edition_reviews_append_only', 'edition_entitlement_notify')) = 8
union all
select 'a helper can never be an owner (trigger present) and the organiser name follows its Hub / Business (two sync triggers present)',
       (select count(*) from pg_trigger where tgname = 'edition_members_no_owner' and not tgisinternal) = 1
       and (select count(*) from pg_trigger where tgname in ('edition_sync_hub_name', 'edition_sync_business_name') and not tgisinternal) = 2
union all
select 'no independent-organiser or verification-request function exists any more',
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('create_edition_organiser', 'create_edition_organiser_for_hub', 'admin_create_edition_organiser_for_hub', 'admin_link_edition_organiser_hub', 'request_edition_organiser_verification')) = 0

-- ── review and approval ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
union all
select 'the review history table has RLS on, exactly one policy (a read policy), no FOR ALL policy, no write grant for anon or authenticated, and an append-only trigger',
       (select relrowsecurity from pg_class where oid = 'public.edition_reviews'::regclass)
       and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'edition_reviews') = 1
       and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'edition_reviews' and cmd = 'SELECT') = 1
       and (select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'edition_reviews' and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT') = 0
       and (select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'edition_reviews' and grantee = 'anon') = 0
       and (select count(*) from pg_trigger where tgrelid = 'public.edition_reviews'::regclass and tgname = 'edition_reviews_no_update' and not tgisinternal) = 1
union all
select 'the review columns on editions are readable but not client-writable (review_state, submitted_at, approved_at: no insert, no update for anon or authenticated); status is not client-writable either',
       (select count(*) from unnest(array['review_state', 'submitted_at', 'approved_at']) c where has_column_privilege('authenticated', 'public.editions', c, 'select')) = 3
       and (select count(*) from unnest(array['review_state', 'submitted_at', 'approved_at', 'status']) c
             where has_column_privilege('authenticated', 'public.editions', c, 'insert') or has_column_privilege('authenticated', 'public.editions', c, 'update')
                or has_column_privilege('anon', 'public.editions', c, 'insert') or has_column_privilege('anon', 'public.editions', c, 'update')) = 0
union all
select 'review_state is constrained to the five lifecycle states and every existing Edition has one',
       (select pg_get_constraintdef(oid) from pg_constraint where conname = 'editions_review_state_check' and conrelid = 'public.editions'::regclass) like '%not_submitted%submitted%changes_requested%approved%rejected%'
       and (select count(*) from public.editions where review_state not in ('not_submitted', 'submitted', 'changes_requested', 'approved', 'rejected')) = 0
union all
select 'the one public rule requires approval, a live parent, a verified organiser and a package, and no longer mentions the pilot',
       (select prosrc like '%review_state = ''approved''%' and prosrc like '%edition_parent_live%' and prosrc like '%o.status = ''verified''%' and prosrc like '%edition_entitled%' and prosrc like '%editions_enabled%' and prosrc not ilike '%pilot%'
          from pg_proc where oid = 'public.edition_is_public(uuid)'::regprocedure)
union all
select 'publishing is refused by the database unless the Edition is approved and its parent is live (publish gate), and the organiser public-read policy requires a live parent',
       (select prosrc like '%review_state%approved%' and prosrc like '%edition_parent_live%' and prosrc like '%edition_entitled%' from pg_proc where oid = 'public.editions_publish_gate()'::regprocedure)
       and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'edition_organisers' and policyname = 'edition_organisers public read' and qual like '%edition_parent_live%' and qual not ilike '%pilot%') = 1
union all
select 'no Edition is published or public without approval: every published real Edition is approved, and every publicly visible Edition is approved',
       (select count(*) from public.editions e where e.status = 'published' and not e.is_test and e.review_state <> 'approved') = 0
       and (select count(*) from public.editions e where public.edition_is_public(e.id) and e.review_state <> 'approved') = 0
union all
select 'the reviewer and owner functions are signed-in only (the administrator functions refuse everyone else themselves)',
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('edition_readiness', 'edition_submit_for_review', 'edition_withdraw_submission', 'edition_review_status', 'admin_review_edition', 'admin_edition_review_queue', 'admin_edition_review_counts', 'admin_edition_review_detail')
          and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
          and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')) = 8
       and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'admin\_%edition%review%' and prosrc not like '%is_admin%') = 0
union all
select 'a material change to an approved Edition sends it back to review (trigger present)',
       (select count(*) from pg_trigger where tgrelid = 'public.editions'::regclass and tgname = 'ac_editions_material_change' and not tgisinternal) = 1

-- ── no pilot ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
union all
select 'no pilot object remains: no function, no table, no policy, no config key',
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname ilike '%pilot%' or prosrc ilike '%edition_pilot_visible%' or prosrc ilike '%editions_pilot%')) = 0
       and to_regclass('public.edition_pilot_approvals') is null
       and (select count(*) from pg_policies where schemaname = 'public' and (coalesce(qual, '') || coalesce(with_check, '')) ilike '%pilot%') = 0
       and (select count(*) from public.admin_config where key = 'editions.pilot') = 0

-- ── Hub verification and event moderation are separate ─────────────────────────────────────────────────────────────────────────────────────
union all
select 'hubs.events_auto_approve exists, is NOT NULL, defaults to false and is readable by signed-in users; its protection is the Hub column-lock trigger (the table-level write grant is the same as for is_verified)',
       (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.hubs'::regclass and a.attname = 'events_auto_approve') = 'false'
       and (select attnotnull from pg_attribute where attrelid = 'public.hubs'::regclass and attname = 'events_auto_approve')
       and has_column_privilege('authenticated', 'public.hubs', 'events_auto_approve', 'select')
       and (select count(*) from pg_trigger where tgrelid = 'public.hubs'::regclass and tgfoid = 'public.tg_lock_hub_columns()'::regprocedure and not tgisinternal and tgenabled = 'O' and (tgtype & 4) <> 0 and (tgtype & 16) <> 0) = 1
union all
select 'the Hub column lock resets events_auto_approve (insert and update, for every client write) like is_verified, and the three event-moderation functions read the new switch, never the verification badge',
       (select prosrc like '%events_auto_approve%' and prosrc like '%is_verified%' from pg_proc where oid = 'public.tg_lock_hub_columns()'::regprocedure)
       and (select prosrc like '%events_auto_approve%' and prosrc not like '%is_verified%' from pg_proc where oid = 'public.tg_events_sync_hidden()'::regprocedure)
       and (select prosrc like '%events_auto_approve%' and prosrc not like '%is_verified%' from pg_proc where oid = 'public.tg_ra_guard()'::regprocedure)
union all
select 'turning the switch on is an administrator-only audited function, signed-in only, never anon; no Editions function touches is_verified or the switch',
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_set_hub_events_auto_approve' and prosecdef and prosrc like '%is_admin%' and prosrc like '%edition_audit%'
          and has_function_privilege('authenticated', oid, 'execute') and not has_function_privilege('anon', oid, 'execute')) = 1
       and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname ilike '%edition%' and proname <> 'admin_set_hub_events_auto_approve'
             and (prosrc ilike '%set is_verified%' or prosrc ilike '%set events_auto_approve%')) = 0

-- ── packages, free claims, orders ──────────────────────────────────────────────────────────────────────────────────────────────────────────
union all
select 'package constraints hold: a free package costs nothing, and an ACTIVE package is priced or explicitly free (no pound-zero placeholder), validated, with no violating row',
       (select count(*) from pg_constraint where conrelid = 'public.edition_packages'::regclass and conname in ('edition_packages_free_is_zero', 'edition_packages_active_is_priced_or_free') and convalidated) = 2
       and (select count(*) from public.edition_packages where (is_free and price_pence <> 0) or (active and not (price_pence > 0 or is_free))) = 0
union all
select 'the free-claim, order and package functions are signed-in only (never anon, never PUBLIC) and refuse unapproved Editions',
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('edition_claim_free_package', 'edition_create_order', 'edition_available_packages', 'admin_upsert_edition_package')
          and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
          and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')) = 4
       and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('edition_claim_free_package', 'edition_create_order') and prosrc like '%not_approved%' and prosrc like '%parent_live%') = 2
union all
select 'a paid order needs payments switched on and refuses free packages; a free claim never creates a payment',
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'edition_create_order' and prosrc like '%edition_commerce_enabled%' and prosrc like '%free_package%') = 1
       and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'edition_claim_free_package' and prosrc not ilike '%stripe%' and prosrc like '%is_free%') = 1
union all
select 'payments are still impossible while commerce is off: commerce disabled, no order exists, no active priced package',
       not public.edition_commerce_enabled() and (select count(*) from public.edition_orders) = 0 and (select count(*) from public.edition_packages where active and price_pence > 0) = 0

-- ── notifications ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
union all
select 'the outbox needs a recipient (a member or an invitation), stores no address, and only the service role can read addresses through the sender function',
       (select count(*) from pg_constraint where conname = 'edition_email_outbox_recipient' and conrelid = 'public.edition_email_outbox'::regclass and convalidated) = 1
       and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'edition_email_outbox' and column_name ~* '(email|address|body|html|text)') = 0
       and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'edition_email_next' and (has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute'))) = 0
       and (select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'edition_email_outbox' and grantee in ('anon', 'authenticated')) = 0

-- ── the signed-out surface ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
union all
select 'the signed-out role can execute only the eleven reviewed Editions read helpers (nothing from the review, package, order, entry or notification functions)',
       coalesce((select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text collate "C")
                   from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname ilike '%edition%' or p.proname in ('organiser_memberships_email', 'organisers_audit_status'))
                    and has_function_privilege('anon', p.oid, 'execute')), '')
       = 'edition_business_role(uuid),edition_controls_business(uuid),edition_entitled(uuid,text,timestamp with time zone),edition_featured(text),edition_is_public(uuid),edition_parent_live(uuid),edition_participation_ok(uuid),edition_promo_track(uuid,text,text),edition_public_tiers(text),edition_role_rank(text),editions_enabled()'
union all
select 'no Editions function carries a PUBLIC execute grant or a default ACL, and every Editions SECURITY DEFINER function pins its search_path',
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname ilike '%edition%' or p.proname in ('organiser_memberships_email', 'organisers_audit_status'))
          and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))) = 0
       and (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ilike '%edition%' and p.prosecdef and not coalesce(p.proconfig::text ilike '%search_path%', false)) = 0
union all
select 'package refunds and order listing: administrator-only, signed-in only, never anon; a refund request targets exactly one of a payment or an order',
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('admin_request_edition_order_refund', 'admin_edition_order_refunds', 'admin_edition_orders')
          and prosecdef and prosrc like '%is_admin%' and has_function_privilege('authenticated', oid, 'execute') and not has_function_privilege('anon', oid, 'execute')) = 3
       and (select count(*) from pg_constraint where conname = 'edition_refund_requests_one_target' and conrelid = 'public.edition_refund_requests'::regclass) = 1
       and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'edition_refund_requests' and column_name = 'order_id') = 1;
