-- An administrator can feature an eligible Edition, in one action, from the admin interface.
--
-- WHY. Everything needed to put an Edition on the homepage already exists — rights, bookings, capacity, fairness,
-- a calendar, move and cancel — but no administrator can reach it. edition_promo_book requires
-- edition_org_can(organiser, 'admin'): ORGANISER authority, which a platform administrator does not have for a Hub
-- or Business they do not run. So the admin screen can only grant promotion days and then wait, which is what its
-- own help text says: "The organiser then schedules them."
--
-- For OneShetland that is a dead end. Featuring an Edition today means granting days on the Promotions screen, then
-- leaving the admin area, finding the organiser, opening the Edition, and booking the dates as that organiser —
-- assuming you are a member of it, which for somebody else's festival you are not.
--
-- WHAT THIS ADDS. Two functions, no new concepts:
--
--   admin_edition_promo_candidates() — the Editions an administrator may feature, with what they need to decide
--     (who runs it, when it runs, how long its publishing period has left). This is why no second screen is needed.
--
--   admin_promo_feature(...) — grants the days and books them, in ONE transaction, through the same
--     edition_promo_validate every organiser booking goes through. No rule is relaxed except the organiser notice
--     period, exactly as admin_promo_reschedule and admin_promo_cancel already relax it for staff.
--
-- WHAT IT DOES NOT CHANGE. Capacity per day, one booking per organiser per kind per day, the rolling 90-day
-- homepage fairness limit, the publishing window, and the requirement that the Edition be published and approved
-- with a live publishing period — all unchanged and all still enforced by edition_promo_validate. Organiser
-- booking, cancelling and rescheduling are untouched. Nothing here makes anything public: edition_is_public still
-- decides that, and the public switch still governs it.

-- ── 1. what an administrator may feature, and what they need to know to choose ───────────────────────────────────
--
-- Eligible means exactly what edition_promo_validate will accept: published, approved, with a live publishing
-- entitlement, run by a verified organiser whose Business or Hub is live, and not a test row. The entitlement end is
-- returned because it caps how far a booking may run, and the screen should say so before anyone picks a date.
create or replace function public.admin_edition_promo_candidates()
returns table (edition_id uuid, title text, slug text, organiser_id uuid, organiser_name text, starts_on date, ends_on date, published_at timestamptz, entitlement_ends_at timestamptz, is_public boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  -- Refuse, rather than filter. A WHERE clause on is_admin() would hand a non-administrator an empty list, which
  -- reads as "there is nothing to feature" instead of "this is not for you" — and would make a permissions test
  -- pass while proving nothing.
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  return query
  select e.id, e.title, e.slug, o.id, o.name, e.starts_on, e.ends_on, e.published_at,
         (select max(n.ends_at) from public.edition_entitlements n
           where n.edition_id = e.id and n.feature = 'publish' and n.voided_at is null and n.starts_at <= now() and n.ends_at > now()),
         public.edition_is_public(e.id)
    from public.editions e
    join public.edition_organisers o on o.id = e.organiser_id
   where e.status = 'published' and e.review_state = 'approved'
     and not e.is_test and not o.is_test and o.status = 'verified'
     and public.edition_parent_live(o.id)
     and exists (select 1 from public.edition_entitlements n
                  where n.edition_id = e.id and n.feature = 'publish' and n.voided_at is null and n.starts_at <= now() and n.ends_at > now())
   order by e.starts_on, e.title;
end $$;

revoke all on function public.admin_edition_promo_candidates() from public, anon;
grant execute on function public.admin_edition_promo_candidates() to authenticated;

-- ── 2. grant and book, in one transaction ────────────────────────────────────────────────────────────────────────
--
-- The right is recorded as source 'admin_grant' with its reason, so the audit trail reads the same as any other
-- staff grant and nothing about the ledger changes shape. The booking is made by the same insert the organiser
-- path uses, after the same validation, under the same advisory lock.
create or replace function public.admin_promo_feature(p_edition uuid, p_kind text, p_start date, p_days integer, p_reason text)
returns table (right_id uuid, booking_id uuid, starts_on date, ends_on date)
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; v_right uuid; v_booking uuid; v_end date;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'give a reason of at least 5 characters' using errcode = '23514', hint = 'reason_required'; end if;
  if p_kind not in ('discovery', 'homepage') then raise exception 'kind must be discovery or homepage' using errcode = '22023'; end if;
  if p_days is null or p_days not between 1 and 120 then raise exception 'a booking is for 1 to 120 days' using errcode = '23514', hint = 'bad_days'; end if;
  select * into e from public.editions where id = p_edition;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;

  -- The same lock the organiser path takes, so two administrators (or an administrator and an organiser) cannot
  -- both pass the capacity check and then both insert.
  perform public.edition_promo_lock();

  -- p_timing => false: staff are not held to the organiser lead time or the booking horizon, exactly as
  -- admin_promo_reschedule already does. Every other rule — published and approved, a live publishing period, the
  -- publishing window, per-day capacity, one per organiser per kind per day, the 90-day homepage fairness limit —
  -- is enforced here in full, by the same function the organiser goes through.
  perform public.edition_promo_validate(p_edition, p_kind, p_start, p_days, null, false);

  v_end := p_start + p_days - 1;
  insert into public.edition_promo_rights (edition_id, organiser_id, source, kind, days, granted_by, reason)
    values (e.id, e.organiser_id, 'admin_grant', p_kind, p_days, auth.uid(), btrim(p_reason))
    returning id into v_right;
  insert into public.edition_promo_bookings (edition_id, organiser_id, right_id, kind, starts_on, ends_on, created_by)
    values (e.id, e.organiser_id, v_right, p_kind, p_start, v_end, auth.uid())
    returning id into v_booking;

  perform public.edition_audit(e.organiser_id, e.id, 'promo_featured_by_staff',
    jsonb_build_object('right', v_right, 'booking', v_booking, 'kind', p_kind, 'starts_on', p_start, 'ends_on', v_end, 'reason', btrim(p_reason)));
  return query select v_right, v_booking, p_start, v_end;
end $$;

revoke all on function public.admin_promo_feature(uuid, text, date, integer, text) from public, anon;
grant execute on function public.admin_promo_feature(uuid, text, date, integer, text) to authenticated;

-- ── post-checks ──────────────────────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.edition_promo_validate(uuid,text,date,integer,uuid,boolean)') is null then raise exception 'post-check: edition_promo_validate is missing'; end if;
  if to_regprocedure('public.edition_promo_lock()') is null then raise exception 'post-check: edition_promo_lock is missing'; end if;
  if to_regprocedure('public.edition_featured(text)') is null then raise exception 'post-check: edition_featured is missing — the homepage strip reads it'; end if;
  -- nothing may execute these as anon
  if has_function_privilege('anon', 'public.admin_promo_feature(uuid,text,date,integer,text)', 'execute') then raise exception 'post-check: anon must not execute admin_promo_feature'; end if;
  if has_function_privilege('anon', 'public.admin_edition_promo_candidates()', 'execute') then raise exception 'post-check: anon must not execute admin_edition_promo_candidates'; end if;
end $$;
