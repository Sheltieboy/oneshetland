-- Paygate 6 — a donation remembers what the donor chose, and a finished
-- campaign stops taking money.
--
-- (B) THE PRIVACY BUG
--
-- A donor's anonymity, their message and their Gift Aid declaration existed
-- ONLY in the browser's confirm-hub-donation call. The webhook fulfiller had
-- no way to know any of it, so it recorded:
--
--     p_anon = false,  p_message = null
--
-- and confirm-hub-donation returns early once a row exists. The two paths race
-- on every single donation. If the webhook won — a slow page, a closed tab, a
-- refresh after paying — somebody who ticked "Anonymous" was recorded as NOT
-- anonymous and their real name was published on the public donor wall.
--
-- The fix is not to put the choices in Stripe metadata. Gift Aid carries a full
-- name, a home address and a postcode; that is HMRC declarant data and it does
-- not belong in a third party's key-value store just so a webhook can read it
-- back. Instead the server writes an authoritative PENDING ATTEMPT before the
-- PaymentIntent exists, and the intent carries only an opaque reference to it.
-- Whichever path arrives first resolves the same attempt and records the same
-- donation. There is no longer a race to lose.
--
-- (C) THE EXPIRED CAMPAIGN
--
-- Eligibility was `campaign.status <> 'active'` and nothing else, so a campaign
-- whose ends_at had passed still took donations — the production demo campaign
-- ended on 8 August and was still donatable seventeen days later. The rule now
-- includes the end date, judged against the DATABASE clock, and card and wallet
-- read it from the same function so they cannot drift.
--
-- Deliberately a PRE-PAYMENT gate only. Once an attempt has passed it and a
-- PaymentIntent exists, fulfilment never re-checks: a campaign that ends during
-- SCA or webhook latency must not turn a completed payment into a charge with
-- no donation behind it. The attempt row IS the evidence that eligibility was
-- satisfied when the donor committed.

begin;

-- ── The rule ────────────────────────────────────────────────────────────────

create or replace function public.campaign_donation_eligibility(p_campaign uuid)
returns table (
  eligible    boolean,
  reason      text,
  campaign_id uuid,
  hub_id      uuid,
  title       text,
  status      text,
  ends_at     timestamptz
)
  language plpgsql
  stable
  security definer
  set search_path to 'public'
as $$
declare c public.hub_campaigns%rowtype;
begin
  if p_campaign is null then
    return query select false, 'campaign_not_found', null::uuid, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  select * into c from public.hub_campaigns where id = p_campaign;
  if not found then
    return query select false, 'campaign_not_found', p_campaign, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  -- ends_at is the moment the campaign STOPS, so the boundary is exclusive:
  -- eligible while now() < ends_at, matching how the campaign page counts days
  -- remaining. A campaign with no end date runs until it is closed.
  return query select
    (c.status = 'active' and (c.ends_at is null or c.ends_at > now())),
    case
      when c.status = 'closed'                            then 'closed'
      when c.status <> 'active'                           then 'not_active'
      when c.ends_at is not null and c.ends_at <= now()   then 'ended'
      else 'ok'
    end,
    c.id, c.hub_id, c.title, c.status, c.ends_at;
end;
$$;

comment on function public.campaign_donation_eligibility(uuid) is
  'The one definition of whether a campaign may take a new donation: active and not past its end date, judged on the database clock. Called by create-hub-donation-intent and wallet-checkout so card and wallet cannot disagree. A PRE-PAYMENT gate — fulfilment never re-checks it.';

revoke all on function public.campaign_donation_eligibility(uuid) from public, anon, authenticated;
grant execute on function public.campaign_donation_eligibility(uuid) to service_role;

-- ── The pending attempt ─────────────────────────────────────────────────────
--
-- Everything needed to record the donation correctly, written under the
-- authenticated donor's identity BEFORE the PaymentIntent exists. Nothing here
-- is client-authoritative except the donor's own stated choices: the donor is
-- auth.uid() at the edge, the hub comes from the campaign, and the fee comes
-- from the server's own commission calculation.

create table if not exists public.hub_donation_attempts (
  id                uuid primary key default gen_random_uuid(),

  client_request_id text        not null,
  donor_user_id     uuid        not null references auth.users(id) on delete cascade,
  campaign_id       uuid        not null references public.hub_campaigns(id) on delete cascade,
  hub_id            uuid        not null references public.hubs(id) on delete cascade,

  -- face_pence is what the campaign is credited and what the donor calls their
  -- donation. cover_pence is the optional extra they chose to pay so the fee
  -- does not come out of it. fee_pence is what the platform actually retains as
  -- the Stripe application fee — server-computed, never client-supplied.
  face_pence        integer     not null check (face_pence  > 0),
  cover_pence       integer     not null default 0 check (cover_pence >= 0),
  fee_pence         integer     not null default 0 check (fee_pence   >= 0),

  is_anonymous      boolean     not null default false,
  message           text        check (message is null or char_length(message) <= 280),

  gift_aid          boolean     not null default false,
  ga_title          text,
  ga_first_name     text,
  ga_last_name      text,
  ga_address        text,
  ga_postcode       text,

  method            text        not null default 'card' check (method in ('card')),
  payment_intent_id text,
  status            text        not null default 'pending' check (status in ('pending', 'consumed')),

  created_at        timestamptz not null default now(),
  consumed_at       timestamptz
);

-- One attempt per reference per donor: a retry of the same checkout resolves to
-- the attempt it already made rather than starting a second one.
create unique index if not exists hub_donation_attempts_rid_key
  on public.hub_donation_attempts (donor_user_id, client_request_id);
create unique index if not exists hub_donation_attempts_pi_key
  on public.hub_donation_attempts (payment_intent_id)
  where payment_intent_id is not null;

comment on table public.hub_donation_attempts is
  'Authoritative record of what a donor chose — anonymity, message, Gift Aid — written before the PaymentIntent so the Stripe webhook can fulfil correctly without the browser and without carrying declarant data through Stripe metadata. Consumed exactly once.';

-- RLS on, zero policies: nothing but the service role reaches this. The donor
-- never needs to read it back — every path that uses it runs server-side — and
-- it holds a home address, so the narrowest possible answer is the right one.
alter table public.hub_donation_attempts enable row level security;
revoke all on public.hub_donation_attempts from anon, authenticated;
grant all on public.hub_donation_attempts to service_role;

-- ── Fulfilment, from the attempt ────────────────────────────────────────────
--
-- Whichever arrives first — the webhook or the browser — resolves the same
-- attempt and writes the same donation. The unique constraint on
-- hub_donations.stripe_payment_intent_id remains the duplicate guard; this
-- function adds the donor's actual choices to what gets written.

create or replace function public.fulfil_hub_donation(
  p_pi      text,
  p_attempt uuid,
  p_user    uuid default null
)
returns table (recorded boolean, already boolean, reason text)
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  a public.hub_donation_attempts%rowtype;
  v_before int;
begin
  if p_pi is null or btrim(p_pi) = '' then
    raise exception 'fulfil_hub_donation: payment intent id is required';
  end if;

  -- Already recorded? Say so before touching anything.
  if exists (select 1 from public.hub_donations where stripe_payment_intent_id = p_pi) then
    return query select false, true, 'already_recorded';
    return;
  end if;

  if p_attempt is null then
    return query select false, false, 'no_attempt';
    return;
  end if;

  select * into a from public.hub_donation_attempts where id = p_attempt for update;
  if not found then
    return query select false, false, 'attempt_not_found';
    return;
  end if;

  -- The intent must belong to the attempt it names, and — when the caller knows
  -- who is asking, as confirm-hub-donation does — to that donor.
  if a.payment_intent_id is distinct from p_pi then
    return query select false, false, 'attempt_pi_mismatch';
    return;
  end if;
  if p_user is not null and a.donor_user_id <> p_user then
    return query select false, false, 'not_donor';
    return;
  end if;

  -- Eligibility is NOT re-checked. The attempt passed it before the payment was
  -- taken; a campaign that ended in the meantime must not turn a completed
  -- charge into a donation that never happened.
  insert into public.hub_donations (
    campaign_id, hub_id, donor_user_id, amount_pence, fee_pence, message, is_anonymous,
    stripe_payment_intent_id, gift_aid, ga_title, ga_first_name, ga_last_name, ga_address, ga_postcode
  ) values (
    a.campaign_id, a.hub_id, a.donor_user_id, a.face_pence, a.fee_pence, a.message, a.is_anonymous,
    p_pi, a.gift_aid, a.ga_title, a.ga_first_name, a.ga_last_name, a.ga_address, a.ga_postcode
  )
  on conflict (stripe_payment_intent_id) do nothing;

  if not found then
    return query select false, true, 'already_recorded';
    return;
  end if;

  update public.hub_campaigns
     set raised_pence = raised_pence + a.face_pence,
         donor_count  = donor_count + 1
   where id = a.campaign_id;

  update public.hub_donation_attempts
     set status = 'consumed', consumed_at = now()
   where id = a.id;

  return query select true, false, 'recorded';
end;
$$;

comment on function public.fulfil_hub_donation(text, uuid, uuid) is
  'Records a hub donation from its authoritative pending attempt — the donor''s real anonymity, message and Gift Aid — and credits the campaign, in ONE transaction. Idempotent on the PaymentIntent, so the webhook and the browser produce one donation whichever arrives first. Deliberately does NOT re-check campaign eligibility: that gate belongs before the payment, not after it.';

revoke all on function public.fulfil_hub_donation(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fulfil_hub_donation(text, uuid, uuid) to service_role;

-- ── The traps ───────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='hub_donation_attempts') then
    raise exception 'Paygate 6: hub_donation_attempts has an RLS policy — it holds Gift Aid address data and must be service-role only';
  end if;
  if has_table_privilege('anon', 'public.hub_donation_attempts', 'select')
     or has_table_privilege('authenticated', 'public.hub_donation_attempts', 'select') then
    raise exception 'Paygate 6: a client role can read hub_donation_attempts';
  end if;
  if has_function_privilege('anon', 'public.fulfil_hub_donation(text,uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.fulfil_hub_donation(text,uuid,uuid)', 'execute') then
    raise exception 'Paygate 6: fulfil_hub_donation is client-callable';
  end if;
  if has_function_privilege('anon', 'public.record_hub_donation(uuid,uuid,uuid,integer,integer,text,boolean,text,boolean,text,text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.record_hub_donation(uuid,uuid,uuid,integer,integer,text,boolean,text,boolean,text,text,text,text,text)', 'execute') then
    raise exception 'Paygate 6: record_hub_donation became client-callable again';
  end if;
end $$;

commit;
