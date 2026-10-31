-- Notices & Alerts — protect the anonymous funeral enquiry form.   NOT APPLIED.
--
-- FIXES (found in privacy acceptance, 31 Oct 2026):
--   1. submit_funeral_enquiry was callable by `anon` directly through PostgREST, so every control on the web page (honeypot, validation) could be skipped.
--   2. Its quotas were SHARED: 3 per announcement per day and 20 per hour for the whole site. Three scripted calls locked a family out of one announcement and
--      twenty locked every family out of the site for an hour.
--
-- NOW: the function is service_role only. The only caller is the submit-funeral-enquiry Edge Function, which verifies a Cloudflare Turnstile token server-side
-- and applies PER-CLIENT limits (a hash of the client address) BEFORE any shared limit is touched. The shared limits that remain are deliberately high
-- circuit-breakers that one client cannot reach. The database repeats a backstop of its own in case the function is ever called by another trusted path.
--
-- REQUIRES 20260821280000_rate_limits (claim_rate_limits, rate_limit_policies, purge_rate_limits job). It refuses to apply without it.
-- The rate-limit buckets hold a keyed hash of the client address and a counter, never the address, message or contact; purge_rate_limits deletes them after 2 days.
-- DEPLOY ORDER: the Edge Function and the website that calls it must be live in the SAME release as this migration (the old page called PostgREST directly and
-- stops working once anon is revoked). Nothing is deployed.

do $$ begin
  if to_regclass('public.rate_limit_policies') is null or to_regprocedure('public.claim_rate_limits(text,text[])') is null then
    raise exception 'Apply 20260821280000_rate_limits first: funeral enquiry limits live in rate_limit_policies';
  end if;
end $$;

-- ── the limits (ceiling, window) and WHY ────────────────────────────────────────────────────────────────────────────────────────────────────────
insert into public.rate_limit_policies (action, window_seconds, max_count, note) values
  ('funeral_enquiry_ip_attempt',      600, 20, 'any request from one client address (incl. failed security checks) — stops unlimited garbage and Cloudflare calls; a shared office or mobile address rarely needs more than a few in 10 minutes'),
  ('funeral_enquiry_ip_hour',        3600,  6, 'verified enquiries per client per hour — a family sending several corrections in a sitting is well under this'),
  ('funeral_enquiry_ip_day',        86400, 12, 'verified enquiries per client per day across ALL announcements — one client can never spend more than this of any shared allowance'),
  ('funeral_enquiry_ip_announcement',86400,  3, 'verified enquiries per client per announcement per day (the previous per-announcement ceiling, now charged to the client that sent them, not shared)'),
  ('funeral_enquiry_announcement',  86400, 15, 'SHARED per announcement per day. Only clients that passed their own limits (and a security check) reach it, and one client can add at most 3, so filling it takes 5+ distinct verified clients'),
  ('funeral_enquiry_global',         3600,300, 'SHARED site-wide circuit breaker, not a family quota. One client adds at most 6 an hour, so tripping it takes 50+ distinct verified clients in an hour')
on conflict (action) do update set window_seconds = excluded.window_seconds, max_count = excluded.max_count, note = excluded.note;

-- ── the database function: same behaviour, service role only, higher backstops ──────────────────────────────────────────────────────────────────
create or replace function public.submit_funeral_enquiry(p_id uuid, p_kind text, p_message text, p_contact text, p_contact_name text default null, p_relationship text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_contact text := nullif(btrim(coalesce(p_contact, '')), '');
begin
  if p_kind not in ('correction', 'takedown', 'enquiry') then raise exception 'Unknown request' using errcode = '22023'; end if;
  if p_message is null or length(btrim(p_message)) < 5 or length(btrim(p_message)) > 1000 then raise exception 'Please say what you need (5 to 1000 characters)' using errcode = '22023'; end if;
  if v_contact is null or length(v_contact) < 5 or length(v_contact) > 200 then raise exception 'Please give a telephone number or email address so we can reach you' using errcode = '22023'; end if;
  if length(coalesce(p_contact_name, '')) > 120 or length(coalesce(p_relationship, '')) > 120 then raise exception 'Too long' using errcode = '22023'; end if;
  if not exists (select 1 from public.funeral_notices where id = p_id and status = 'approved' and display_until > now()) then raise exception 'Unknown notice' using errcode = 'P0002'; end if;
  -- BACKSTOPS only (the per-client allowances are enforced before this is called): the same contact cannot be filed more than 3 times a day, and nothing can
  -- flood a single announcement or the queue even if the Edge Function were bypassed by another trusted caller.
  if (select count(*) from public.funeral_change_requests where source = 'public' and lower(contact) = lower(v_contact) and created_at > now() - interval '24 hours') >= 3
     or (select count(*) from public.funeral_change_requests where funeral_id = p_id and source = 'public' and created_at > now() - interval '24 hours') >= 30
     or (select count(*) from public.funeral_change_requests where source = 'public' and created_at > now() - interval '1 hour') >= 600 then
    raise exception 'Too many requests. Please try again later or call us' using errcode = '54000';
  end if;
  insert into public.funeral_change_requests (funeral_id, kind, source, contact_name, relationship, contact, message)
  values (p_id, p_kind, 'public', nullif(btrim(coalesce(p_contact_name, '')), ''), nullif(btrim(coalesce(p_relationship, '')), ''), v_contact, btrim(p_message)) returning id into v_id;
  perform public.notice_audit('funeral_enquiry_received', null, null, p_id, jsonb_build_object('kind', p_kind, 'source', 'public'));
  return v_id;
end $$;

-- No visitor, signed in or not, can call it. Only the trusted Edge Function (service role) can.
revoke all on function public.submit_funeral_enquiry(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.submit_funeral_enquiry(uuid, text, text, text, text, text) to service_role;
