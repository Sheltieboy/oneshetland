-- Paygate 5 — a shift boost becomes eligible before it is sold, and atomic when
-- it is granted.
--
-- TWO DEFECTS, ONE MIGRATION
--
-- (C) Eligibility lived only in the browser. Both web CTAs gate on
--     `status === "open" && !isBoosted`, but create-boost-intent selected
--     `id, title, employer_id` and looked at nothing else, and the wallet path
--     read `id, employer_id`. Neither refused a cancelled, filled, completed or
--     already-finished shift. £2.99 bought promotion for something no consumer
--     query can return — and, worse, a push blast advertising a cancelled shift
--     to every matching worker.
--
--     The rule is not invented here. It is exactly what makes a shift visible,
--     read off the two consumer queries that already agree with each other:
--
--       lib/jobs-data.ts   getOpenShifts:    status='open' AND end_at >= now()
--       lib/shifts-api.ts  fetchOpenShifts:  status='open' AND end_at >= now()
--
--     plus one active boost at a time. That last part is the intended product
--     rule, and the code says so twice: both CTAs hide while `isBoosted`, and
--     the write REPLACES boosted_until with now()+24h rather than extending it.
--     Compare local_boost, whose webhook comment states the opposite intent
--     outright — "it stacks on purpose so a customer can buy consecutive
--     boosts". Shift boost was never built to stack.
--
--     Putting the rule in SQL is what makes card and wallet agree: both call
--     this one function, and both get the DATABASE's clock rather than the
--     caller's.
--
-- (B2) Fulfilment was two statements. confirm-boost claimed the PaymentIntent
--     in consumed_payment_intents and THEN updated the shift. A failure in
--     between left the payment permanently claimed and the shift never boosted:
--     every retry hits the unique violation, reports `already: true`, and grants
--     nothing. Paid, unboosted, unrecoverable.
--
--     Exactly the defect wallet_topup fixed for top-ups, so this is the same
--     answer: one function, one transaction. The claim and the boost stand or
--     fall together.
--
-- WHAT IS DELIBERATELY *NOT* ENFORCED AT FULFILMENT
--
-- Eligibility is a PRE-PAYMENT gate. Once Stripe has the money, refusing to
-- boost because the employer cancelled their own shift in the intervening
-- seconds would be the one outcome worse than boosting a dead shift: charged,
-- and granted nothing. So fulfilment REPORTS eligibility and grants anyway,
-- returning `reason = 'boosted_ineligible'` so the outcome is visible in logs
-- rather than silent. Ownership and payment validity are still absolute.

begin;

-- ── The rule ────────────────────────────────────────────────────────────────
--
-- One definition, called by create-boost-intent, wallet-checkout and the
-- fulfilment function below. Returns the shift fields the callers need too, so
-- a caller does not re-read the row and risk asking a different question.

create or replace function public.shift_boost_eligibility(p_shift uuid)
returns table (
  eligible      boolean,
  reason        text,
  shift_id      uuid,
  employer_id   uuid,
  title         text,
  status        text,
  end_at        timestamptz,
  boosted_until timestamptz
)
  language plpgsql
  stable
  security definer
  set search_path to 'public'
as $$
declare
  s public.shifts%rowtype;
begin
  if p_shift is null then
    return query select false, 'shift_not_found', null::uuid, null::uuid, null::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select * into s from public.shifts where id = p_shift;
  if not found then
    return query select false, 'shift_not_found', p_shift, null::uuid, null::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Ordered so the reason returned is the most useful one to show a person.
  return query select
    case
      when s.status <> 'open'                                  then false
      when s.end_at <= now()                                   then false
      when s.boosted_until is not null and s.boosted_until > now() then false
      else true
    end,
    case
      when s.status = 'cancelled'                              then 'cancelled'
      when s.status = 'completed'                              then 'completed'
      when s.status = 'filled'                                 then 'filled'
      when s.status = 'draft'                                  then 'draft'
      when s.status <> 'open'                                  then 'not_open'
      when s.end_at <= now()                                   then 'ended'
      when s.boosted_until is not null and s.boosted_until > now() then 'already_boosted'
      else 'ok'
    end,
    s.id, s.employer_id, s.title, s.status, s.end_at, s.boosted_until;
end;
$$;

comment on function public.shift_boost_eligibility(uuid) is
  'The one definition of whether a shift may be boosted: open, not yet ended, and not already boosted — judged against the database clock. Called by create-boost-intent, wallet-checkout and fulfil_shift_boost so card and wallet cannot disagree. Returns (eligible, reason, shift fields).';

revoke all on function public.shift_boost_eligibility(uuid) from public, anon, authenticated;
grant execute on function public.shift_boost_eligibility(uuid) to service_role;

-- ── The grant ───────────────────────────────────────────────────────────────
--
-- Claims the PaymentIntent and writes the boost in ONE transaction. The caller
-- has already verified with Stripe that this PI succeeded and carries this
-- shift and this employer; what this function owns is that the claim and the
-- write cannot come apart, and that two callers racing produce one boost.

create or replace function public.fulfil_shift_boost(
  p_pi       text,
  p_shift    uuid,
  p_employer uuid
)
returns table (
  granted       boolean,
  already       boolean,
  boosted_until timestamptz,
  eligible      boolean,
  reason        text
)
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  s        public.shifts%rowtype;
  v_elig   boolean;
  v_reason text;
  v_until  timestamptz;
begin
  if p_pi is null or btrim(p_pi) = '' then
    raise exception 'fulfil_shift_boost: payment intent id is required';
  end if;
  if p_shift is null or p_employer is null then
    raise exception 'fulfil_shift_boost: shift and employer are required';
  end if;

  -- Lock the shift first. Two deliveries of the same event, or a webhook and a
  -- client confirm arriving together, serialise here rather than interleaving
  -- between the claim and the write.
  select * into s from public.shifts where id = p_shift for update;
  if not found then
    return query select false, false, null::timestamptz, false, 'shift_not_found';
    return;
  end if;

  -- The payment is for THIS employer's shift or it is not fulfilled. Metadata
  -- alone is not enough: the row is the authority on who owns the shift.
  if s.employer_id <> p_employer then
    return query select false, false, s.boosted_until, false, 'not_owner';
    return;
  end if;

  -- Claim. In this transaction, so a failure below takes the claim with it and
  -- the next delivery can try again.
  insert into public.consumed_payment_intents (payment_intent_id, purpose, user_id)
  values (p_pi, 'shift_boost', p_employer)
  on conflict (payment_intent_id) do nothing;

  if not found then
    -- Someone else already fulfilled this payment — and because that was one
    -- transaction too, they also wrote the boost. Report the state, extend
    -- nothing. This is what stops webhook + client confirm being 48 hours.
    return query select false, true, s.boosted_until, true, 'already_fulfilled';
    return;
  end if;

  select e.eligible, e.reason into v_elig, v_reason
    from public.shift_boost_eligibility(p_shift) e;

  -- Ineligible now means the shift changed after the customer paid. Grant it
  -- anyway and say so; the alternative is taking £2.99 and giving nothing.
  update public.shifts
     set boosted_until = now() + interval '24 hours'
   where id = p_shift
  returning shifts.boosted_until into v_until;

  return query select true, false, v_until, coalesce(v_elig, false),
                      case when coalesce(v_elig, false) then 'boosted' else 'boosted_ineligible' end;
end;
$$;

comment on function public.fulfil_shift_boost(text, uuid, uuid) is
  'Atomic shift-boost fulfilment: locks the shift, verifies ownership, claims the PaymentIntent in consumed_payment_intents and sets boosted_until = now() + 24h in ONE transaction, so a failure cannot leave a paid-but-unboosted shift permanently claimed. Idempotent on payment_intent_id — the second caller (webhook or client confirm, either order) extends nothing. Returns (granted, already, boosted_until, eligible, reason).';

revoke all on function public.fulfil_shift_boost(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fulfil_shift_boost(text, uuid, uuid) to service_role;

-- ── The trap this migration must not fall into ──────────────────────────────
--
-- Both functions are SECURITY DEFINER on purpose — that is what carries them
-- past the F2 column lock on shifts.boosted_until. That lock is the only thing
-- standing between an employer and a free boost, so assert it is still there
-- and still INVOKER before this migration is allowed to commit.
do $$
begin
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'shifts' and t.tgname = 'lock_shift_columns' and not t.tgisinternal
  ) then
    raise exception 'Paygate 5: the F2 lock on shifts is missing — boosted_until would be client-writable';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'tg_lock_shift_columns' and p.prosecdef
  ) then
    raise exception 'Paygate 5: the F2 shift lock is SECURITY DEFINER, so it protects nothing';
  end if;
end $$;

commit;
