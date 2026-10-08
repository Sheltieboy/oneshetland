-- Security re-audit, 25 Sep 2026.
--
-- 1. THREE ANON-CALLABLE FUNCTIONS THAT FAIL OPEN
--
--    accept_image_pin_suggestion, business_analytics and accept_alert_policy
--    guard on   IF v_owner <> auth.uid() THEN RAISE ...
--    For an UNAUTHENTICATED caller auth.uid() is NULL, so the comparison is NULL,
--    not true — the IF does not fire and the guard is skipped. Each was executable
--    by anon (a leading PUBLIC grant plus default privileges), so with only the
--    public anon key:
--
--      accept_image_pin_suggestion  resolved any memory pin       (proven in a rolled-back
--                                   transaction: "anon accept  SUCCEEDED")
--      business_analytics           read any business's views, viewers, followers,
--                                   contacts and — with the add-on — full analytics
--      accept_alert_policy          activated a business's alert access when it was
--                                   Premium + approved, recording no accepting user
--
--    None has any anonymous use; every caller is a signed-in owner/author. So the
--    fix is at the boundary — revoke from PUBLIC and anon, keep authenticated —
--    rather than a body rewrite that could change behaviour for real users. A
--    signed-in caller always has a non-NULL auth.uid(), so the existing guard is
--    correct for them. Revoke names ALL of public, anon (see rpc-exposure.node.test.ts:
--    revoking only some roles leaves the rest reachable through PUBLIC).
--
-- 2. SIX SECURITY DEFINER FUNCTIONS WITH NO FIXED search_path
--
--    Pinned to public, pg_temp. Bodies are unchanged; get_spik_stats referenced an
--    unqualified table and now resolves it deterministically.
--
-- 3. RATE-LIMIT POLICIES for ai-cover-letter and calculate-fee. claim_rate_limits
--    DENIES an unknown action, so these must exist before the functions that use
--    them are deployed.

-- ── 1 ────────────────────────────────────────────────────────────────────────
revoke execute on function public.accept_image_pin_suggestion(uuid)  from public, anon;
revoke execute on function public.business_analytics(uuid, integer)  from public, anon;
revoke execute on function public.accept_alert_policy(uuid)          from public, anon;

grant execute on function public.accept_image_pin_suggestion(uuid)   to authenticated, service_role;
grant execute on function public.business_analytics(uuid, integer)   to authenticated, service_role;
grant execute on function public.accept_alert_policy(uuid)           to authenticated, service_role;

-- ── 2 ────────────────────────────────────────────────────────────────────────
alter function public.accept_image_pin_suggestion(uuid)              set search_path = public, pg_temp;
alter function public.count_lk_vessels()                             set search_path = public, pg_temp;
alter function public.get_spik_stats()                               set search_path = public, pg_temp;
alter function public.mark_notifications_read(uuid[])                set search_path = public, pg_temp;
alter function public.should_notify(uuid, text, boolean)             set search_path = public, pg_temp;
alter function public.unread_notification_count()                    set search_path = public, pg_temp;

-- ── 3 ────────────────────────────────────────────────────────────────────────
insert into public.rate_limit_policies (action, max_count, window_seconds, note) values
  ('ai_cover_letter',     10,  3600,  'ai-cover-letter: paid model call per signed-in account, per hour'),
  ('ai_cover_letter_day', 30,  86400, 'ai-cover-letter: paid model call per signed-in account, per day'),
  ('calculate_fee_global', 600, 60,   'calculate-fee: whole-endpoint ceiling (public, anon-key callers); each call makes two postcodes.io requests')
on conflict (action) do update
  set max_count = excluded.max_count, window_seconds = excluded.window_seconds, note = excluded.note;
