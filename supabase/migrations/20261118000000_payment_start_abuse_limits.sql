-- ═══════════════════════════════════════════════════════════════════════════
-- Payment creation: close the card-testing surface
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THE AUDIT FOUND
--
-- Ten of the routes that create a PaymentIntent / SetupIntent already ran the shared limiter (stripe_intent 40/h, stripe_any 45/h).
-- Four that create the SAME kind of object did not:
--
--     local-subscription-intent   a new incomplete Subscription (and so an Invoice + PaymentIntent) per client_request_id
--     local-boost-checkout        a new PaymentIntent per client_request_id
--     local-subscription-checkout a new hosted Checkout Session per call (legacy; no client uses it, but it is deployed)
--     local-subscription-change   a proration charge / upcoming-invoice call per request
--
-- Any confirmed account can own a business for free, and client_request_id is minted by the caller, so each of these could be
-- called in a loop. And even where the limiter exists it only counts how many intents are CREATED: a PaymentIntent's client secret
-- can be confirmed with a different card as often as Stripe allows, from the browser straight to Stripe, and nothing on our side
-- saw or counted a failed attempt. The limiter was a speed bump on creation, not a control on card testing.
--
-- WHAT THIS ADDS (policies only — the limiter itself, its table and its fail-closed behaviour are unchanged)
--
--   stripe_intent_burst  10 / 60 s      a script is stopped in seconds; a person retrying a declined card never reaches it
--   stripe_intent_day    120 / 24 h     the hourly 40 could be farmed round the clock (the same reason fetch has *_day ceilings)
--   payment_failed       10 / 1 h       failed card attempts attributed to one account, counted by stripe-webhook
--   payment_failed_day   30 / 24 h
--   pi_failed            6 / 24 h       failed confirmations of ONE PaymentIntent; the next one cancels it so its secret is dead
--
-- and rate_limit_blocked(subject, actions): a READ-ONLY answer to "is this subject already at its ceiling?", used to refuse a new
-- payment start for an account that has just failed too many payments, without consuming any allowance. service_role only.
--
-- ORDER OF DEPLOYMENT MATTERS: an action nobody classified is DENIED by claim_rate_limits. These rows must exist before any Edge
-- Function that names them is deployed — this migration is applied first, and refuses to commit if they are missing.

begin;

set local lock_timeout = '5s';

insert into public.rate_limit_policies (action, window_seconds, max_count, note) values
  ('stripe_intent_burst', 60,    10,  'payment/setup intent creation — short window, stops a scripted loop within seconds; far above a person retrying a declined card'),
  ('stripe_intent_day',   86400, 120, 'payment/setup intent creation — daily ceiling so the hourly limit cannot be farmed round the clock'),
  ('payment_failed',      3600,  10,  'failed card attempts attributed to one account, counted by stripe-webhook; at the ceiling, new payment starts are refused until the window turns'),
  ('payment_failed_day',  86400, 30,  'failed card attempts attributed to one account, per day'),
  ('pi_failed',           86400, 6,   'failed confirmations of ONE PaymentIntent, counted by stripe-webhook; the next failure cancels the intent so its client secret can no longer be tried')
on conflict (action) do nothing;

-- A read-only twin of claim_rate_limits: same buckets, same policies, same "unknown action is denied", but it never increments.
create or replace function public.rate_limit_blocked(p_subject text, p_actions text[])
returns table (blocked boolean, blocked_action text, retry_after_secs integer)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_action text;
  v_pol    public.rate_limit_policies%rowtype;
  v_bucket timestamptz;
  v_count  integer;
  v_sorted text[];
begin
  if p_subject is null or btrim(p_subject) = '' or length(p_subject) > 128 then
    raise exception 'rate_limit_blocked: a subject is required' using errcode = '22023';
  end if;
  if p_actions is null or array_length(p_actions, 1) is null then
    raise exception 'rate_limit_blocked: at least one action is required' using errcode = '22023';
  end if;

  select array_agg(distinct a order by a) into v_sorted from unnest(p_actions) a;

  foreach v_action in array v_sorted loop
    select * into v_pol from public.rate_limit_policies where action = v_action;
    if not found then
      return query select true, v_action, 3600;     -- unclassified: blocked, exactly as the claim treats it
      return;
    end if;

    v_bucket := to_timestamp(floor(extract(epoch from now()) / v_pol.window_seconds) * v_pol.window_seconds);
    select r.count into v_count from public.rate_limits r
     where r.subject = p_subject and r.action = v_action and r.bucket = v_bucket;

    if coalesce(v_count, 0) >= v_pol.max_count then
      return query select true, v_action,
        greatest(1, ceil(extract(epoch from ((v_bucket + make_interval(secs => v_pol.window_seconds)) - now())))::integer);
      return;
    end if;
  end loop;

  return query select false, null::text, 0;
end;
$$;

comment on function public.rate_limit_blocked(text, text[]) is
  'Read-only: is this subject already at the ceiling of any of these actions in the current window? Never increments. service_role only.';

revoke all on function public.rate_limit_blocked(text, text[]) from public, anon, authenticated;
grant execute on function public.rate_limit_blocked(text, text[]) to service_role;

-- Self-check: refuse to commit unless every row the new code names exists, and nothing client-reachable was opened.
do $check$
declare
  v_missing text;
begin
  select string_agg(a, ', ') into v_missing
    from unnest(array['stripe_intent', 'stripe_any', 'stripe_intent_burst', 'stripe_intent_day',
                      'payment_failed', 'payment_failed_day', 'pi_failed']) a
   where not exists (select 1 from public.rate_limit_policies p where p.action = a);
  if v_missing is not null then raise exception 'rate_limit_policies is missing: %', v_missing; end if;

  if has_function_privilege('anon', 'public.rate_limit_blocked(text, text[])', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rate_limit_blocked(text, text[])', 'EXECUTE') then
    raise exception 'rate_limit_blocked must be service_role only';
  end if;
  if has_table_privilege('anon', 'public.rate_limits', 'SELECT') or has_table_privilege('authenticated', 'public.rate_limits', 'INSERT')
     or has_table_privilege('authenticated', 'public.rate_limit_policies', 'UPDATE') then
    raise exception 'the rate-limit tables must not be client-reachable';
  end if;
end
$check$;

commit;
