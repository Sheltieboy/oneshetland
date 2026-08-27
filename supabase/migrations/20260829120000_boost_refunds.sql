-- Paygate 9 — business boost refunds.
--
-- A boost refund already worked in Stripe and did nothing here. charge.refunded
-- knows about wallet top-ups, memberships, deliveries and event tickets, and
-- nothing bound a refund to a boost — so the money went back, the purchase
-- stayed 'succeeded', and the business kept its Pro access for the full period
-- it had stopped paying for.
--
-- Two product decisions shape this:
--   * A partial refund is RECORDED AND SHOWN and changes no entitlement at all.
--     Only when the cumulative amount reaches the full original price does the
--     boost stop contributing to Pro.
--   * Only a OneShetland platform admin may execute one. A boost is platform
--     revenue: there is no Connect transfer, no application fee and no business
--     payout, so there is no connected account with standing to reverse it.
--     This is deliberately NARROWER than membership refunds, where the hub
--     owner may refund because the money came out of their own account.
--
-- Entitlement is never adjusted by arithmetic on subscription_until.
-- "current expiry minus the refunded weeks" is wrong the moment boosts stack:
-- refunding the FIRST of two purchases must leave the second running from its
-- own purchase date, not from the date the first one had extended it to. So
-- entitlement is REPLAYED from the purchases that still stand, using the same
-- rule the webhook grants with, and the answer is a function of durable facts
-- rather than of the order refund events happened to arrive in.

begin;

-- ── 1. Refund state on the durable purchase fact ────────────────────────────
-- The original purchase is never rewritten. status stays 'succeeded' because
-- the payment DID succeed; that is history and it remains true. A refund is an
-- additional financial fact recorded alongside it, not a correction of it.

alter table public.local_boost_purchases
  add column if not exists refunded_pence integer not null default 0,
  add column if not exists refund_state   text    not null default 'none',
  add column if not exists refunded_at    timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'local_boost_purchases_refunded_pence_check') then
    alter table public.local_boost_purchases
      add constraint local_boost_purchases_refunded_pence_check check (refunded_pence >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'local_boost_purchases_refund_state_check') then
    alter table public.local_boost_purchases
      add constraint local_boost_purchases_refund_state_check
      check (refund_state in ('none', 'partial', 'full'));
  end if;
end $$;

comment on column public.local_boost_purchases.refunded_pence is
  'Cumulative amount refunded, a high-water mark. Stripe reports amount_refunded as a running total, so this is greatest(existing, reported) clamped to the original price — never a sum of refund events.';
comment on column public.local_boost_purchases.refund_state is
  'none | partial | full. Only ''full'' stops the purchase contributing to Pro entitlement.';

-- ── 2. What the surviving purchases add up to ───────────────────────────────
--
-- The grant rule in the webhook is: start from whichever is later, now or the
-- expiry the business already had, then add N weeks. Replaying that over the
-- purchases that still stand reproduces it exactly, and is order-independent:
-- the result depends on WHICH purchases survive, never on the sequence the
-- refunds arrived in.
--
-- Ordered by created_at with the id as a stable tie-breaker, so two purchases
-- written in the same instant still replay the same way every time.

create or replace function public.boost_entitlement(p_business uuid)
returns table (
  entitled     boolean,      -- is there boost-bought time covering this moment?
  pro_until    timestamptz,  -- null when nothing survives
  purchases_left integer     -- purchases still standing (not fully refunded)
)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  r       record;
  v_run   timestamptz := null;
  v_count integer := 0;
begin
  for r in
    select * from public.local_boost_purchases
     where business_id = p_business
       and status = 'succeeded'
       and refund_state <> 'full'
     order by created_at, id
  loop
    v_count := v_count + 1;
    -- greatest() is the stacking rule: a boost bought while another is running
    -- starts where that one ends, and a boost bought after a gap starts now.
    v_run := greatest(r.created_at, coalesce(v_run, r.created_at))
             + (r.weeks * interval '7 days');
  end loop;

  return query select
    (v_run is not null and v_run > now()),
    v_run,
    v_count;
end;
$function$;

comment on function public.boost_entitlement(uuid) is
  'Replays the boost-bought Pro expiry from the purchases that still stand. Pure reconstruction: never reads subscription_until, never subtracts refunded weeks.';

-- ── 3. Applying it, without ever downgrading a stronger right ───────────────
--
-- A refund may only lower entitlement that boost purchases can prove they
-- granted. Two authoritative checks stand in front of the write:
--
--   * A live Stripe subscription outranks everything. A business that boosted
--     in August and subscribed in September is a paying subscriber; refunding
--     the old boost must return the money and touch nothing. Keyed on
--     stripe_subscription_id, which is the signal the fulfilment path itself
--     uses to tell a boost apart from a subscription — not on the tier label.
--
--   * Otherwise the current expiry must be one the boosts can ACCOUNT FOR.
--     Replaying every succeeded purchase as if nothing had been refunded gives
--     the furthest date boosts could ever have granted. An expiry beyond that
--     came from somewhere else — a manual grant, an admin change — and is not
--     this refund's business to overwrite.
--
--     An earlier attempt compared the expiry against the LAST purchase's
--     recorded expires_at. It looked authoritative and was wrong: the first
--     refund rewrites subscription_until, so the second refund no longer
--     matched anything and silently did nothing. Refunding A then B left a
--     different answer from B then A, which is exactly the order-dependence
--     this whole design exists to prevent. The ceiling test survives repeated
--     refunds because it does not assume the expiry is still untouched.
--
--   * And the write may only ever REDUCE entitlement. A refund is not a route
--     to extending anyone's Pro access, whatever the arithmetic says.

create or replace function public.apply_boost_entitlement(p_business uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  b        public.local_businesses%rowtype;
  r        record;
  v_ceil   timestamptz := null;   -- furthest date the boosts could have granted
  v_until  timestamptz;
  v_left   integer;
  v_tier   text;
begin
  select * into b from public.local_businesses where id = p_business for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'no_business');
  end if;

  if b.stripe_subscription_id is not null then
    return jsonb_build_object('applied', false, 'reason', 'live_subscription',
                              'subscription_until', b.subscription_until);
  end if;

  if b.subscription_until is null then
    return jsonb_build_object('applied', false, 'reason', 'nothing_to_reduce');
  end if;

  -- The ceiling: replay ignoring refunds entirely.
  for r in
    select * from public.local_boost_purchases
     where business_id = p_business and status = 'succeeded'
     order by created_at, id
  loop
    v_ceil := greatest(r.created_at, coalesce(v_ceil, r.created_at))
              + (r.weeks * interval '7 days');
  end loop;

  if v_ceil is null or b.subscription_until > v_ceil then
    return jsonb_build_object('applied', false, 'reason', 'entitlement_not_boost_derived',
                              'subscription_until', b.subscription_until);
  end if;

  select pro_until, purchases_left into v_until, v_left
    from public.boost_entitlement(p_business);

  -- An expired boost refunded weeks later replays to the value the business
  -- already holds. Writing it again would be a no-op that still fires the
  -- column-lock trigger and moves updated_at, so don't.
  if b.subscription_until is not distinct from v_until then
    return jsonb_build_object('applied', false, 'reason', 'no_change',
                              'subscription_until', v_until, 'purchases_left', v_left);
  end if;

  if v_until is not null and v_until > b.subscription_until then
    return jsonb_build_object('applied', false, 'reason', 'would_extend',
                              'subscription_until', b.subscription_until);
  end if;

  v_tier := case when v_until is not null and v_until > now() then 'pro' else 'free' end;

  update public.local_businesses set
    subscription_tier                 = v_tier,
    subscription_until                = v_until,
    subscription_cancel_at_period_end = false
  where id = p_business;

  return jsonb_build_object('applied', true, 'tier', v_tier,
                            'subscription_until', v_until, 'purchases_left', v_left);
end;
$function$;

-- ── 4. Recording one Stripe refund ──────────────────────────────────────────
--
-- Bound through the UNIQUE stripe_payment_intent_id and nothing else. The
-- business, the owner, the weeks and the price all come from the purchase row.
-- Webhook metadata and anything a client sent are not read here at all, so
-- none of them can be substituted.
--
-- p_cumulative is Stripe's RUNNING TOTAL (charge.amount_refunded), not this
-- refund's slice. Taking the high-water mark is what makes a redelivered event,
-- an out-of-order delivery, and a partial followed by a larger one all settle
-- to exactly one outcome.

create or replace function public.record_boost_refund(p_pi text, p_cumulative integer)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  p       public.local_boost_purchases%rowtype;
  v_new   integer;
  v_state text;
  v_was   text;
  v_ent   jsonb := null;
begin
  if p_pi is null then
    return jsonb_build_object('matched', false, 'reason', 'no_payment_intent');
  end if;
  if p_cumulative is null or p_cumulative < 0 then
    raise exception 'record_boost_refund: cumulative amount must be non-negative'
      using errcode = '22023';
  end if;

  select * into p from public.local_boost_purchases
   where stripe_payment_intent_id = p_pi for update;
  if not found then
    -- Not a boost payment. Memberships, deliveries, tickets, wallet top-ups
    -- and every other rail carry on untouched.
    return jsonb_build_object('matched', false, 'reason', 'not_a_boost');
  end if;

  v_was := p.refund_state;
  v_new := least(greatest(p.refunded_pence, p_cumulative), p.amount_pence);
  v_state := case
               when v_new <= 0                then 'none'
               when v_new >= p.amount_pence   then 'full'
               else                                'partial'
             end;

  update public.local_boost_purchases set
    refunded_pence = v_new,
    refund_state   = v_state,
    refunded_at    = case when v_new > 0 then coalesce(refunded_at, now()) else null end
  where id = p.id;

  -- Only a full refund touches entitlement, and only on the transition into
  -- it. Money coming back is not by itself a reason to take Pro away, and a
  -- second delivery of the same event must not replay a second time.
  if v_state = 'full' and v_was <> 'full' then
    v_ent := public.apply_boost_entitlement(p.business_id);
  end if;

  return jsonb_build_object(
    'matched',        true,
    'purchase_id',    p.id,
    'business_id',    p.business_id,
    'owner_id',       p.owner_id,
    'weeks',          p.weeks,
    'amount_pence',   p.amount_pence,
    'refunded_pence', v_new,
    'refund_state',   v_state,
    'changed',        (v_state is distinct from v_was),
    'revoked',        (v_state = 'full' and v_was <> 'full'),
    'entitlement',    v_ent
  );
end;
$function$;

-- ── 5. Trusted backend only ─────────────────────────────────────────────────
-- These move money state and entitlement. Nothing holding an anon key or a
-- signed-in user's token may call them, admin included: refunds go through
-- refund-payment, which checks who is asking.

revoke execute on function public.record_boost_refund(text, integer)  from anon, authenticated, public;
revoke execute on function public.apply_boost_entitlement(uuid)       from anon, authenticated, public;
revoke execute on function public.boost_entitlement(uuid)             from anon, authenticated, public;
grant  execute on function public.record_boost_refund(text, integer)  to service_role;
grant  execute on function public.apply_boost_entitlement(uuid)       to service_role;
grant  execute on function public.boost_entitlement(uuid)             to service_role;

commit;
