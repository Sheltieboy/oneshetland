-- ============================================================================
-- A signed-in account stops being an unlimited Anthropic-spend credential.
--
-- WHAT WAS WRONG
--
-- Eight billable AI routes live on the website. Six of them had no
-- authentication of any kind: anyone on the internet could POST to them and
-- spend the OneShetland Anthropic key. The two that were gated (draft-product,
-- draft-social) had no usage ceiling, so one signed-in account could call them
-- in a loop for ever.
--
-- None of the eight had a rate limit, and none had a bound on how much text
-- could be sent.
--
-- WHY THE LIMITER LIVES HERE AND NOT IN THE WEBSITE
--
-- Netlify restarts and scales its instances, so anything held in process memory
-- or a JavaScript Map is reset by a deploy and bypassed by a second instance. A
-- cost control that a scale-out event silently removes is not a cost control.
--
-- The website must also NOT gain the service-role key — that boundary has held
-- through every step so far and is worth keeping. So this is a SECURITY DEFINER
-- function granted to `authenticated`, which derives the user from auth.uid()
-- and never from an argument. The website calls it with the caller's own
-- session; there is nothing to forge, because the caller cannot choose who they
-- are.
--
-- THE LIMITS, AND WHY THESE NUMBERS
--
-- Every one of these routes is a human authoring action: drafting a product,
-- parsing a typed job advert, planning a day out. A person does this a handful
-- of times in a sitting, re-running one or two when the first draft is not
-- quite right.
--
--   15 per route per hour   generous for "draft it, tweak it, draft it again"
--                           on one feature, and caps the most expensive route
--                           (plan-day, whose candidate list is caller-supplied)
--                           at fifteen calls rather than thousands.
--
--   30 per hour in total    covers a merchant drafting a batch of listings AND
--                           posting a job AND planning a day, all in one
--                           sitting, while stopping a script from cycling
--                           through routes to multiply its allowance.
--
--   150 per day in total    the hourly cap alone still permits 720 calls a day
--                           of slow, patient abuse. This is the backstop for
--                           that, and is still five times a heavy real day.
--
-- They are deliberately conservative-but-usable and easy to raise: they are
-- plain constants in one function, not scattered through eight routes.
-- ============================================================================


-- ── One row per user per hour ───────────────────────────────────────────────
--
-- Bucketed rather than one row per request, so the table stays small and the
-- hot path is a single upsert on a primary key. Per-route counts live in a
-- jsonb map on the same row, which means the aggregate ceiling and the
-- per-route ceiling are read under ONE lock and cannot disagree with each other.
--
-- PRIVACY: no prompt, no input, no output, no response body. A user id, a
-- route name, an hour, and counts. Rate limiting does not need to know what
-- anybody typed, and storing it would create a privacy problem in order to
-- solve a billing one.
create table if not exists public.ai_usage (
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  bucket     timestamptz not null,
  total      integer     not null default 0,
  per_route  jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, bucket)
);

comment on table public.ai_usage is
  'Per-user, per-hour AI request counters. Holds counts only — never prompts, inputs or outputs. Written exclusively by claim_ai_request().';

-- Supports the rolling 24-hour sum without touching other users' rows.
create index if not exists ai_usage_user_recent_idx
  on public.ai_usage (user_id, bucket desc);

-- Nobody but the definer function goes near this. RLS on with no policies, and
-- no grants to anon or authenticated: the only route in is the RPC below, which
-- runs as its owner.
alter table public.ai_usage enable row level security;
revoke all on table public.ai_usage from public;
revoke all on table public.ai_usage from anon;
revoke all on table public.ai_usage from authenticated;
grant all on table public.ai_usage to service_role;


-- ── Claiming one AI request ─────────────────────────────────────────────────
--
-- Atomic by construction. The row for (this user, this hour) is created if
-- absent and then locked FOR UPDATE, so ten concurrent requests at the final
-- available slot queue behind each other and read each other's increments
-- rather than all seeing the same stale count. Only the first gets it.
--
-- The identity comes from auth.uid() and there is NO user parameter. A caller
-- cannot spend someone else's allowance or reset their own, because there is
-- nothing to pass.
--
-- Counts only ALLOWED requests. A refusal does not increment, so a user who
-- hits the ceiling is not punished with an ever-extending lockout for retrying.
create or replace function public.claim_ai_request(p_route text)
returns table (
  allowed          boolean,
  reason           text,
  retry_after_secs integer,
  used_this_hour   integer,
  used_this_route  integer,
  used_today       integer
)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  -- Raise these if real usage outgrows them; they are here, together, on purpose.
  c_route_hour constant integer := 15;
  c_total_hour constant integer := 30;
  c_total_day  constant integer := 150;

  v_user   uuid := auth.uid();
  v_bucket timestamptz := date_trunc('hour', now());
  v_row    public.ai_usage%rowtype;
  v_route  integer;
  v_day    integer;
  v_retry  integer;
begin
  -- No session, no allowance. The website checks this too; this is the layer
  -- that cannot be forgotten when a ninth route is added.
  if v_user is null then
    return query select false, 'not_authenticated'::text, 0, 0, 0, 0;
    return;
  end if;

  if p_route is null or btrim(p_route) = '' or length(p_route) > 64 then
    raise exception 'claim_ai_request: a route name is required' using errcode = '22023';
  end if;

  insert into public.ai_usage (user_id, bucket)
  values (v_user, v_bucket)
  on conflict (user_id, bucket) do nothing;

  -- Everything below happens under this lock, so the two ceilings are read from
  -- the same instant and a concurrent caller cannot slip between them.
  select * into v_row from public.ai_usage
   where user_id = v_user and bucket = v_bucket
     for update;

  v_route := coalesce((v_row.per_route ->> p_route)::integer, 0);

  select coalesce(sum(u.total), 0)::integer into v_day
    from public.ai_usage u
   where u.user_id = v_user
     and u.bucket > now() - interval '24 hours';

  -- Seconds until the current hour rolls over. Safe to hand back: it says when
  -- to come back, and nothing about anybody else.
  v_retry := greatest(1, ceil(extract(epoch from ((v_bucket + interval '1 hour') - now())))::integer);

  if v_row.total >= c_total_hour then
    return query select false, 'hourly_total'::text, v_retry, v_row.total, v_route, v_day;
    return;
  end if;
  if v_route >= c_route_hour then
    return query select false, 'hourly_route'::text, v_retry, v_row.total, v_route, v_day;
    return;
  end if;
  if v_day >= c_total_day then
    -- A day ceiling needs a day-ish retry hint, not the end of this hour.
    return query select false, 'daily_total'::text, greatest(v_retry, 3600), v_row.total, v_route, v_day;
    return;
  end if;

  update public.ai_usage
     set total      = public.ai_usage.total + 1,
         per_route  = jsonb_set(public.ai_usage.per_route, array[p_route], to_jsonb(v_route + 1), true),
         updated_at = now()
   where user_id = v_user and bucket = v_bucket
  returning * into v_row;

  return query select true, 'ok'::text, 0, v_row.total, v_route + 1, v_day + 1;
end;
$$;

comment on function public.claim_ai_request(text) is
  'Claims one billable AI request for the CALLING user, derived from auth.uid() — there is no user parameter to forge. Enforces 15/route/hour, 30/hour and 150/day, all read under one row lock so concurrent requests cannot exceed the ceiling. Counts only allowed requests. Stores no prompt or content.';


-- ── Privileges ──────────────────────────────────────────────────────────────
--
-- Postgres re-grants EXECUTE to PUBLIC at CREATE time, and a revoke naming
-- fewer than {public, anon, authenticated} is a no-op in one direction or the
-- other — the lesson from Steps 1 and 1B. All three are named explicitly.
--
-- `authenticated` genuinely needs EXECUTE here: the website has no service-role
-- key and calls this with the end user's own session. That is the whole point —
-- the function is safe to expose precisely because it takes no identity.
revoke all on function public.claim_ai_request(text) from public;
revoke all on function public.claim_ai_request(text) from anon;
revoke all on function public.claim_ai_request(text) from authenticated;
grant execute on function public.claim_ai_request(text) to authenticated;
grant execute on function public.claim_ai_request(text) to service_role;
