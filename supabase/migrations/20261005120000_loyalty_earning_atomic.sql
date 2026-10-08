-- ── Two taps, one stamp ─────────────────────────────────────────────────────
--
-- Earning was a read-then-write in TypeScript, in all four live paths:
--
--   local-nfc-stamp        customer, NFC tile, 4-hour gap
--   local-stamp-collect    customer, rotating business code, 4-hour gap
--   loyalty-till 'stamp'   operator, 60-second gap
--   loyalty-till 'points'  operator, no gap — two awards are both legitimate
--
-- Each read the card, decided in the client, UPDATEd by id holding no lock,
-- then INSERTed a ledger row as a separate, unchecked commit. Three things
-- follow, and all three were reproduced by execution before this was written:
--
--   the gap check is evaluated against a value another request has already
--   superseded, so both callers pass a rule meant to admit one;
--
--   the increment is computed in the client, so simultaneous awards write the
--   same number and one is silently lost;
--
--   the ledger row is a separate commit, so it records awards the card does
--   not carry.
--
-- Reproduced on a clean fixture, two concurrent callers each:
--
--   NFC / QR stamp   2 awarded, card +1, ledger 2 rows
--   till stamp       2 awarded, card +1, ledger 2 rows
--   till points      2 legitimate awards, balance +5 of the +10 earned
--   first card       unique constraint holds, but the loser's award is lost
--                    to a raw insert failure
--
-- Production carries that signature already: the one live loyalty card holds
-- 2 stamps against 3 ledger rows and 0 redemptions. This migration does not
-- touch that row.
--
-- WHAT REPLACES IT
--
-- Two primitives, one transaction each. The card is created-or-locked in a
-- single upsert, the gap is evaluated while that lock is held, the increment
-- is self-referential so it cannot be lost, and the ledger row is written in
-- the same transaction — all or none.
--
-- The gap values stay in the CALLER, because they are product semantics that
-- genuinely differ per path: four hours for a customer, sixty seconds at the
-- till, none at all for points. The database enforces whatever it is given,
-- under the lock. It does not invent a rule for points, and it does not
-- relax the one the till already has.
--
-- Everything the edge functions are actually good at stays there:
-- authentication, business ownership, NFC proximity, rotating-code checks,
-- rate limiting and the owner self-stamp block are untouched.

-- ── One stamp ───────────────────────────────────────────────────────────────
create or replace function public.loyalty_earn_stamp(
  p_user             uuid,
  p_business         uuid,
  p_min_gap_seconds  integer default 0
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_prog  public.local_loyalty_programs%rowtype;
  v_card  public.local_loyalty_cards%rowtype;
  v_since numeric;
  v_new   integer;
begin
  if p_user is null or p_business is null then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;

  -- A stamp belongs to a stamp programme. The customer paths never checked
  -- this and would put a stamp on a points card; the till always did.
  select * into v_prog from public.local_loyalty_programs
   where business_id = p_business and is_active = true and type = 'stamps'
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_stamp_program');
  end if;

  -- Create-or-lock in one statement. The plain SELECT-then-INSERT this
  -- replaces gave one of two simultaneous first-time awards a raw unique
  -- violation instead of a stamp.
  insert into public.local_loyalty_cards (user_id, program_id, business_id, stamps_collected, points_balance)
  values (p_user, v_prog.id, p_business, 0, 0)
  on conflict (user_id, program_id)
    do update set business_id = public.local_loyalty_cards.business_id
  returning * into v_card;

  -- The gap, evaluated while the row is held. Checked in the client it was
  -- read before the other caller's write, so both passed.
  if p_min_gap_seconds > 0 and v_card.last_stamp_at is not null then
    v_since := extract(epoch from (now() - v_card.last_stamp_at));
    if v_since < p_min_gap_seconds then
      return jsonb_build_object('ok', false, 'error', 'too_soon',
                                'wait_seconds', ceil(p_min_gap_seconds - v_since)::int);
    end if;
  end if;

  -- Self-referential, so it cannot be lost to a concurrent writer.
  update public.local_loyalty_cards
     set stamps_collected = coalesce(stamps_collected, 0) + 1,
         last_stamp_at = now(),
         nudge_reminded_at = null
   where id = v_card.id
   returning stamps_collected into v_new;

  insert into public.local_loyalty_transactions (card_id, user_id, business_id, type, amount, note)
  values (v_card.id, p_user, p_business, 'stamp', 1, null);

  return jsonb_build_object(
    'ok', true,
    'card_id', v_card.id,
    'stamps_collected', v_new,
    'stamps_required', v_prog.stamps_required,
    -- The till decides tier readiness itself and needs to know which tiers the
    -- card has already claimed; returning it here saves a second round trip
    -- and stops the caller assuming zero.
    'tiers_redeemed_upto', coalesce(v_card.tiers_redeemed_upto, 0),
    'reward_ready', v_new >= coalesce(v_prog.stamps_required, 999999)
  );
end;
$$;

-- ── Points ──────────────────────────────────────────────────────────────────
--
-- No gap rule exists on this path and none is added: two operator awards are
-- two awards. What was wrong is that only one of them was kept.
create or replace function public.loyalty_earn_points(
  p_user     uuid,
  p_business uuid,
  p_points   integer
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_prog public.local_loyalty_programs%rowtype;
  v_card public.local_loyalty_cards%rowtype;
  v_new  integer;
begin
  if p_user is null or p_business is null then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  if p_points is null or p_points <= 0 then
    return jsonb_build_object('ok', false, 'error', 'no_points');
  end if;

  select * into v_prog from public.local_loyalty_programs
   where business_id = p_business and is_active = true and type = 'points'
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_points_program');
  end if;

  insert into public.local_loyalty_cards (user_id, program_id, business_id, stamps_collected, points_balance)
  values (p_user, v_prog.id, p_business, 0, 0)
  on conflict (user_id, program_id)
    do update set business_id = public.local_loyalty_cards.business_id
  returning * into v_card;

  update public.local_loyalty_cards
     set points_balance = coalesce(points_balance, 0) + p_points,
         last_stamp_at = now()
   where id = v_card.id
   returning points_balance into v_new;

  insert into public.local_loyalty_transactions (card_id, user_id, business_id, type, amount, note)
  values (v_card.id, p_user, p_business, 'points_earn', p_points, 'Earned at till');

  return jsonb_build_object('ok', true, 'card_id', v_card.id, 'points_balance', v_new, 'points_added', p_points);
end;
$$;

comment on function public.loyalty_earn_stamp(uuid, uuid, integer) is
  'Adds one stamp to a customer''s card for a business, atomically: creates or locks the card, evaluates the caller''s minimum gap under that lock, increments self-referentially, and writes the matching ledger row in the same transaction. The gap is the caller''s to set — four hours for a customer, sixty seconds at the till. service_role only.';
comment on function public.loyalty_earn_points(uuid, uuid, integer) is
  'Adds points to a customer''s card for a business, atomically: creates or locks the card, increments self-referentially, and writes the matching ledger row in the same transaction. No gap rule — two operator awards are two awards, and both are kept. service_role only.';

-- ── Privileges ──────────────────────────────────────────────────────────────
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.loyalty_earn_stamp(uuid, uuid, integer)',
    'public.loyalty_earn_points(uuid, uuid, integer)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
