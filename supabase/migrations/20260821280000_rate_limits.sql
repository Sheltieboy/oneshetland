-- Step 15 (M3) — a durable, atomic rate-limit primitive.
--
-- WHY THIS EXISTS
--
-- Nothing in the system limited how often an account could trigger an
-- expensive action. One free account could ask for a hub broadcast, a driver
-- fan-out or a transcription in a loop, and every one of those costs money or
-- sends real notifications to real people.
--
-- SHAPE
--
-- Deliberately the same shape as claim_ai_request (Step 7), which has been
-- correct in production: ensure the row, take it FOR UPDATE, read the counters
-- under that lock, decide, then increment. Two callers cannot both read "9 of
-- 10" and both proceed. It is NOT coupled to ai_usage — AI keeps its own
-- route/hour/day model, and mixing an eight-route AI quota with general
-- endpoint throttling would make both harder to reason about.
--
-- LIMITS LIVE IN THE DATABASE, NOT AT THE CALL SITE
--
-- A caller names an action; the ceiling for that action is looked up here. A
-- call site cannot ask for a larger allowance, and every limit in the product
-- is readable in one table. An action with no policy row is DENIED, not
-- allowed: adding a new expensive endpoint without classifying it fails
-- closed, which is the whole point of the exercise.
--
-- SUBJECT
--
-- An opaque string chosen by the trusted server-side caller:
--   user:<uuid>    an account, resolved from the JWT by requireCaller
--   email:<sha256> a hashed address, for the password-reset path where there
--                  is no account yet — never the address itself
--   global         a whole-endpoint ceiling where no trustworthy per-caller
--                  identity exists
-- claim_rate_limits is service_role-only, so "the caller" is our own Edge
-- Function, never a browser. No client can name someone else's subject,
-- inspect a bucket, or reset one.

begin;

create table if not exists public.rate_limit_policies (
  action         text primary key,
  window_seconds integer not null check (window_seconds between 1 and 86400),
  max_count      integer not null check (max_count > 0),
  note           text    not null
);

create table if not exists public.rate_limits (
  subject    text        not null check (length(subject) between 1 and 128),
  action     text        not null references public.rate_limit_policies(action) on delete cascade,
  bucket     timestamptz not null,
  count      integer     not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (subject, action, bucket)
);

-- Purging scans by age, and nothing else ever does.
create index if not exists rate_limits_bucket_idx on public.rate_limits (bucket);

-- No client role touches either table directly. RLS is on with no policy, so
-- even if a grant is added by accident later, PostgREST still returns nothing.
alter table public.rate_limits          enable row level security;
alter table public.rate_limit_policies  enable row level security;
revoke all on public.rate_limits         from public, anon, authenticated;
revoke all on public.rate_limit_policies from public, anon, authenticated;

-- ── The policies ───────────────────────────────────────────────────────────
-- Numbers are chosen from what the product action actually is: a broadcast to
-- a whole hub is a handful a day, an intent retry after a dropped connection
-- is several a minute. Raise them here, in one place, if real use outgrows them.
insert into public.rate_limit_policies (action, window_seconds, max_count, note) values
  -- Email. A person triggering mail to others.
  ('email_send',            3600,  20, 'user-triggered email through send-email'),
  ('password_reset_email',  3600,   4, 'reset mail per hashed address — Supabase admin.generateLink bypasses provider throttling'),
  ('password_reset_global', 3600, 200, 'whole-endpoint ceiling: no account exists yet, so no per-caller identity is trustworthy'),

  -- Paid provider work.
  ('transcribe',            3600,  12, 'speech-to-text is billed per request'),
  ('transcribe_day',       86400,  60, 'daily ceiling so an hourly limit cannot be farmed round the clock'),

  -- Notification fan-outs. One action reaches many people.
  ('notify_broadcast',      3600,   6, 'hub-broadcast and notify-drivers reach an entire audience'),
  ('notify_fanout',         3600,  20, 'per-resource fan-outs: event update, hub content, job, shift, claim, engagement'),
  ('notify_direct',         3600,  60, 'single-recipient notices: booking, business claim, hub membership'),
  ('notify_any',            3600,  60, 'aggregate across every notification route. Deliberately BELOW the sum of the per-route ceilings (6+20+60=86), otherwise rotating between routes could never reach it and the aggregate would be decorative'),

  -- Stripe. Idempotency already prevents double charging; this is about
  -- spamming Stripe itself and creating clutter objects.
  ('stripe_intent',         3600,  40, 'payment/setup intent creation — high enough for legitimate checkout retries'),
  ('stripe_account',        3600,   6, 'Connect account and onboarding link creation'),
  ('stripe_any',            3600,  45, 'aggregate across every Stripe-calling route. Below the sum of the per-route ceilings (40+6=46) for the same reason as notify_any'),

  -- Loyalty redemption: cheap individually, but a redemption storm is abuse.
  ('redeem_start',          3600,  30, 'starting a reward/offer redemption'),

  -- Public, unauthenticated read that does real database work.
  ('public_feed_global',      60, 600, 'whole-endpoint ceiling for the anonymous feed')
on conflict (action) do update
  set window_seconds = excluded.window_seconds,
      max_count      = excluded.max_count,
      note           = excluded.note;

-- ── The claim ──────────────────────────────────────────────────────────────
-- All requested actions are decided together: every one must have room, and
-- only then is every one incremented. A caller that trips its aggregate does
-- not silently burn its per-route allowance as well.
create or replace function public.claim_rate_limits(p_subject text, p_actions text[])
returns table (allowed boolean, blocked_action text, retry_after_secs integer, used integer, max_allowed integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action  text;
  v_pol     public.rate_limit_policies%rowtype;
  v_bucket  timestamptz;
  v_row     public.rate_limits%rowtype;
  v_sorted  text[];
  v_buckets timestamptz[] := '{}';
  v_i       integer;
begin
  if p_subject is null or btrim(p_subject) = '' or length(p_subject) > 128 then
    raise exception 'claim_rate_limits: a subject is required' using errcode = '22023';
  end if;
  if p_actions is null or array_length(p_actions, 1) is null then
    raise exception 'claim_rate_limits: at least one action is required' using errcode = '22023';
  end if;

  -- Locked in a stable order. Two callers claiming {a,b} and {b,a} at the same
  -- instant would otherwise be able to deadlock each other.
  select array_agg(distinct a order by a) into v_sorted from unnest(p_actions) a;

  foreach v_action in array v_sorted loop
    select * into v_pol from public.rate_limit_policies where action = v_action;

    -- Unknown action: deny. A new expensive endpoint that nobody classified
    -- must not quietly get an unlimited allowance.
    if not found then
      return query select false, v_action, 3600, 0, 0;
      return;
    end if;

    -- now() is the transaction timestamp, so every action in this claim is
    -- measured from one instant; the bucket is kept rather than re-derived so
    -- the increment below cannot target a different row from the one checked.
    v_bucket := to_timestamp(floor(extract(epoch from now()) / v_pol.window_seconds) * v_pol.window_seconds);
    v_buckets := v_buckets || v_bucket;

    insert into public.rate_limits (subject, action, bucket)
    values (p_subject, v_action, v_bucket)
    on conflict (subject, action, bucket) do nothing;

    select * into v_row from public.rate_limits
     where subject = p_subject and action = v_action and bucket = v_bucket
     for update;

    -- The row was just ensured, so this cannot normally miss. If it somehow
    -- does, deny: an unexplained limiter state must not mean "allow".
    if not found then
      return query select false, v_action, 60, 0, v_pol.max_count;
      return;
    end if;

    if v_row.count >= v_pol.max_count then
      return query select
        false,
        v_action,
        greatest(1, ceil(extract(epoch from ((v_bucket + make_interval(secs => v_pol.window_seconds)) - now())))::integer),
        v_row.count,
        v_pol.max_count;
      return;
    end if;
  end loop;

  -- Every action had room, and every one of those rows is still locked by this
  -- transaction, so the headroom cannot have been taken in between.
  for v_i in 1 .. array_length(v_sorted, 1) loop
    update public.rate_limits
       set count = public.rate_limits.count + 1, updated_at = now()
     where subject = p_subject
       and action  = v_sorted[v_i]
       and bucket  = v_buckets[v_i];
  end loop;

  return query select true, null::text, 0, 0, 0;
end;
$$;

-- Buckets are evidence for as long as the window is open and noise afterwards.
create or replace function public.purge_rate_limits()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n integer;
begin
  delete from public.rate_limits where bucket < now() - interval '2 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Only our own server-side code may claim, and nothing may read a bucket.
revoke all on function public.claim_rate_limits(text, text[]) from public, anon, authenticated;
revoke all on function public.purge_rate_limits()             from public, anon, authenticated;
grant execute on function public.claim_rate_limits(text, text[]) to service_role;
grant execute on function public.purge_rate_limits()             to service_role;

commit;

-- Scheduled outside the transaction, in the shape Step 10 made canonical.
select cron.schedule('purge-rate-limits', '17 4 * * *', $cron$select public.purge_rate_limits();$cron$)
where not exists (select 1 from cron.job where jobname = 'purge-rate-limits');
