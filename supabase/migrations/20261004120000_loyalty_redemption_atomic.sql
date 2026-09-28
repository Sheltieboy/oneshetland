-- ── One reward, one redemption ──────────────────────────────────────────────
--
-- Redeeming a loyalty reward was a read-then-write in TypeScript. Every entry
-- point read the card, decided in the client, then issued
-- UPDATE local_loyalty_cards ... WHERE id = $card, holding no lock. The
-- code-based path then flipped its redemption row to 'consumed'
-- UNCONDITIONALLY — no `status = 'pending'` guard — AFTER the effect, with the
-- result unchecked. Nothing serialised anything.
--
-- Reproduced by execution against this schema, two concurrent callers each:
--
--   reward code   two verifies of ONE pending code   -> 2 free coffees,
--                                                       total_redeemed = 1
--   points code   two verifies of ONE pending code   -> 2 redemptions,
--                                                       balance debited once
--   till          two operators, ONE full card       -> 2 rewards,
--                                                       total_redeemed = 1
--
-- The same defect was already found and fixed here once: redeem_pass_atomic
-- exists, and the comment beside it records "six concurrent verifies succeed
-- against three credits". That fix was applied to the `pass` kind only. The
-- other kinds, and the till, kept the shape it replaced.
--
-- WHAT REPLACES IT
--
-- The database becomes authoritative for the whole decision. Two entry points,
-- one invariant, because protecting this in one caller while another can still
-- bypass it protects nothing:
--
--   loyalty_redeem_code_atomic   the code backbone (kinds 'reward','points')
--   loyalty_redeem_card_atomic   the till, and the customer redeeming their own
--                                card — no code row exists in either case
--
-- Both take the card row FOR UPDATE before reading anything they will act on,
-- so a second caller waits and then sees the first one's committed result. The
-- code path additionally locks the redemption row and refuses anything not
-- still 'pending', so the status transition cannot race and the effect cannot
-- commit while consumption is lost.
--
-- No Stripe, no external call, nothing held across a network. Product
-- semantics are unchanged: same thresholds, same tier ladder, same reset rules,
-- same reminder re-arming, same points prices, same expiry, same authority
-- model. Offers and passes are untouched.

-- ── The shared effect. Callers MUST already hold the card row lock ──────────
create or replace function public._loyalty_apply_reward(p_card uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_card  public.local_loyalty_cards%rowtype;
  v_prog  public.local_loyalty_programs%rowtype;
  v_tiers jsonb;
  v_ready record;
  v_top   integer;
begin
  select * into v_card from public.local_loyalty_cards where id = p_card;
  if not found then return jsonb_build_object('ok', false, 'error', 'card_not_found'); end if;
  select * into v_prog from public.local_loyalty_programs where id = v_card.program_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'program_not_found'); end if;

  -- Same normalisation the clients do: finite stamp counts above zero, ascending.
  select coalesce(jsonb_agg(t order by (t->>'stamps')::numeric), '[]'::jsonb) into v_tiers
    from jsonb_array_elements(case when jsonb_typeof(v_prog.reward_tiers) = 'array'
                                   then v_prog.reward_tiers else '[]'::jsonb end) t
   where (t->>'stamps') ~ '^[0-9]+(\.[0-9]+)?$' and (t->>'stamps')::numeric > 0;

  if jsonb_array_length(v_tiers) > 0 then
    -- Ladder: claim the lowest tier not yet claimed that the card has reached.
    select (e->>'stamps')::int as stamps, coalesce(e->>'reward', '') as reward
      into v_ready
      from jsonb_array_elements(v_tiers) e
     where (e->>'stamps')::int > coalesce(v_card.tiers_redeemed_upto, 0)
       and (e->>'stamps')::int <= coalesce(v_card.stamps_collected, 0)
     order by (e->>'stamps')::int
     limit 1;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_ready'); end if;

    select max((e->>'stamps')::int) into v_top from jsonb_array_elements(v_tiers) e;

    if v_ready.stamps = v_top then
      update public.local_loyalty_cards
         set stamps_collected = 0, tiers_redeemed_upto = 0,
             total_redeemed = coalesce(total_redeemed, 0) + 1,
             reward_reminded_at = null, nudge_reminded_at = null
       where id = p_card;
    else
      update public.local_loyalty_cards
         set tiers_redeemed_upto = v_ready.stamps,
             total_redeemed = coalesce(total_redeemed, 0) + 1
       where id = p_card;
    end if;

    insert into public.local_loyalty_transactions (card_id, user_id, business_id, type, amount)
    values (p_card, v_card.user_id, v_card.business_id, 'reward', v_ready.stamps);

    return jsonb_build_object('ok', true, 'reward', v_ready.reward, 'stamps', v_ready.stamps);
  end if;

  -- Legacy single reward.
  if coalesce(v_card.stamps_collected, 0) < coalesce(v_prog.stamps_required, 999) then
    return jsonb_build_object('ok', false, 'error', 'not_ready');
  end if;
  update public.local_loyalty_cards
     set stamps_collected = 0,
         total_redeemed = coalesce(total_redeemed, 0) + 1,
         reward_reminded_at = null
   where id = p_card;
  insert into public.local_loyalty_transactions (card_id, user_id, business_id, type, amount)
  values (p_card, v_card.user_id, v_card.business_id, 'reward', v_prog.stamps_required);

  return jsonb_build_object('ok', true, 'reward', coalesce(v_prog.stamp_reward, 'reward'),
                            'stamps', v_prog.stamps_required);
end;
$$;

-- ── Points, same contract ───────────────────────────────────────────────────
create or replace function public._loyalty_spend_points(p_card uuid, p_amount integer)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare v_card public.local_loyalty_cards%rowtype;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_amount');
  end if;
  select * into v_card from public.local_loyalty_cards where id = p_card;
  if not found then return jsonb_build_object('ok', false, 'error', 'card_not_found'); end if;
  if coalesce(v_card.points_balance, 0) < p_amount then
    return jsonb_build_object('ok', false, 'error', 'insufficient_points');
  end if;

  update public.local_loyalty_cards
     set points_balance = coalesce(points_balance, 0) - p_amount,
         total_redeemed = coalesce(total_redeemed, 0) + 1
   where id = p_card;
  insert into public.local_loyalty_transactions (card_id, user_id, business_id, type, amount)
  values (p_card, v_card.user_id, v_card.business_id, 'redeem', p_amount);

  return jsonb_build_object('ok', true, 'spent', p_amount);
end;
$$;

-- ── The code backbone: redemption row and card effect, one transaction ──────
create or replace function public.loyalty_redeem_code_atomic(
  p_verifier uuid,
  p_code     text default null,
  p_token    uuid default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_red  public.local_redemptions%rowtype;
  v_res  jsonb;
begin
  if p_verifier is null or (p_code is null and p_token is null) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- The redemption row first, and locked: everything after this is decided
  -- while no other caller can be looking at the same code.
  select * into v_red from public.local_redemptions
   where (p_token is not null and token = p_token)
      or (p_token is null and code = upper(btrim(p_code)))
   limit 1
   for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if v_red.kind not in ('reward', 'points') then
    return jsonb_build_object('ok', false, 'error', 'wrong_kind');
  end if;
  if v_red.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;
  if v_red.expires_at is not null and v_red.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if not exists (select 1 from public.local_businesses b
                  where b.id = v_red.business_id and b.owner_id = p_verifier) then
    return jsonb_build_object('ok', false, 'error', 'not_your_business');
  end if;

  -- Then the card, also locked, so the till cannot spend it underneath us.
  perform 1 from public.local_loyalty_cards where id = v_red.ref_id for update;

  if v_red.kind = 'reward' then
    v_res := public._loyalty_apply_reward(v_red.ref_id);
  else
    v_res := public._loyalty_spend_points(v_red.ref_id, v_red.amount);
  end if;
  if not (v_res->>'ok')::boolean then return v_res; end if;

  update public.local_redemptions
     set status = 'consumed', consumed_at = now(), consumed_by = p_verifier
   where id = v_red.id;

  return v_res || jsonb_build_object('kind', v_red.kind);
end;
$$;

-- ── No code row: the till, and a customer redeeming their own card ──────────
--
-- One function for both because the invariant is identical and the authority
-- test is a single predicate: you may redeem a card if it is yours, or if you
-- own the business whose programme issued it. Nobody else, and the caller does
-- not get to say which they are.
create or replace function public.loyalty_redeem_card_atomic(
  p_actor uuid,
  p_card  uuid
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare v_card public.local_loyalty_cards%rowtype;
begin
  if p_actor is null or p_card is null then
    return jsonb_build_object('ok', false, 'error', 'card_not_found');
  end if;

  select * into v_card from public.local_loyalty_cards where id = p_card for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'card_not_found'); end if;

  if v_card.user_id <> p_actor
     and not exists (select 1 from public.local_businesses b
                      where b.id = v_card.business_id and b.owner_id = p_actor) then
    return jsonb_build_object('ok', false, 'error', 'not_yours');
  end if;

  return public._loyalty_apply_reward(p_card);
end;
$$;

comment on function public._loyalty_apply_reward(uuid) is
  'Applies one loyalty reward to a card and writes its ledger row. INTERNAL: the caller must already hold the card row lock. service_role only.';
comment on function public._loyalty_spend_points(uuid, integer) is
  'Spends points from a card and writes its ledger row, refusing to go below zero. INTERNAL: the caller must already hold the card row lock. service_role only.';
comment on function public.loyalty_redeem_code_atomic(uuid, text, uuid) is
  'Redeems one pending reward/points code: locks the redemption row and the card, checks pending status, expiry and business ownership, applies the effect and marks the code consumed — all in one transaction, so the same code cannot apply twice. service_role only.';
comment on function public.loyalty_redeem_card_atomic(uuid, uuid) is
  'Redeems a loyalty reward directly from a card, for the till and for a customer redeeming their own card. Locks the card, so two concurrent redemptions cannot both succeed. service_role only.';

-- ── Privileges ──────────────────────────────────────────────────────────────
do $$
declare fn text;
begin
  foreach fn in array array[
    'public._loyalty_apply_reward(uuid)',
    'public._loyalty_spend_points(uuid, integer)',
    'public.loyalty_redeem_code_atomic(uuid, text, uuid)',
    'public.loyalty_redeem_card_atomic(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
