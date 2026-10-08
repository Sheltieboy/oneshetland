-- ── The business you are standing in is the business you redeem for ─────────
--
-- WHAT WAS WRONG
--
-- Three functions decide whether a merchant may redeem a customer's code, and
-- all three asked the same question:
--
--     exists (select 1 from local_businesses b
--              where b.id = v_red.business_id and b.owner_id = p_verifier)
--
-- "Do you own the business this code belongs to?" — not "are you operating that
-- business right now?". Nothing in the contract could express the second
-- question, because no caller could say which business it was acting as.
--
-- For an owner of one business the two questions have the same answer. For an
-- owner of two they do not. A merchant with Anderson & Co open on screen could
-- scan a reward issued by their OTHER business and it would preview, and then
-- redeem, with nothing on screen or in the database disagreeing. The reward was
-- consumed against the right card and the right ledger — the accounting was
-- never wrong — but the merchant was told a reward for a different business was
-- theirs to give away, and the product rule everywhere else in OneShetland is
-- that the business on screen is the business an action operates against.
--
-- WHAT REPLACES IT
--
-- One optional parameter, p_business, on each of the three. It is the business
-- the CALLER claims to be operating, and when it is supplied the server proves
-- two things instead of one:
--
--   1  the caller owns p_business            else not_your_business
--   2  the code belongs to p_business        else other_business
--
-- Check 1 comes first and costs nothing, so a caller naming a business they do
-- not own learns nothing about any code. Check 2 comes AFTER the existing
-- ownership test on the code's own business, so a code belonging to a stranger
-- still answers exactly what it answered before — 'not_found' from the preview,
-- 'not_your_business' from the spenders. other_business is therefore only ever
-- returned for a code at a business the caller genuinely owns, and reveals
-- nothing about anyone else's programmes.
--
-- WHY THE PARAMETER IS OPTIONAL, AND WHY THE OLD SIGNATURE IS DROPPED
--
-- p_business null means "no business context supplied", and every check behaves
-- exactly as it does today. That is what makes this backward-safe: a caller
-- that has not been updated keeps working rather than breaking closed on a
-- merchant mid-shift.
--
-- But optional is not the same as absent. The three-argument forms are DROPPED,
-- not left alongside, because a surviving overload is a route back to the
-- unscoped behaviour that nothing would ever flag. The reason is the one
-- already recorded beside loyalty_redeem_code_atomic: protecting this in one
-- caller while another can still bypass it protects nothing.
--
-- WHAT IS NOT TOUCHED
--
-- Every lock, every FOR UPDATE, every status/expiry/kind/uses test, every
-- effect and every ledger write is carried across unchanged. The scope test is
-- an additional refusal and can only ever turn a success into a refusal; it
-- cannot let anything through that the old function refused. No Stripe, no
-- money, no loyalty earning, no wallet.

begin;

-- ── 1. Look, don't spend — now within one business ──────────────────────────
drop function if exists public.preview_redemption(uuid, text, text);

create or replace function public.preview_redemption(
  p_verifier uuid,
  p_code     text default null,
  p_token    text default null,
  p_business uuid default null
)
returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_red      public.local_redemptions%rowtype;
  v_purchase public.book_unit_purchases%rowtype;
  v_item     public.book_unit_items%rowtype;
  v_token    uuid;
begin
  if p_verifier is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if coalesce(p_code, p_token) is null then
    raise exception 'code_required' using errcode = '22023';
  end if;

  -- The claimed context, before any code is looked at.
  if p_business is not null and not exists (
    select 1 from public.local_businesses b
     where b.id = p_business and b.owner_id = p_verifier
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_your_business');
  end if;

  if p_token is not null then
    begin
      v_token := p_token::uuid;
    exception when invalid_text_representation then
      return jsonb_build_object('ok', false, 'error', 'not_found');
    end;
  end if;

  select * into v_red
    from public.local_redemptions
   where (v_token is not null and token = v_token)
      or (v_token is null and code = upper(btrim(p_code)));

  -- One answer for "no such code" and "not yours", so a preview cannot be used
  -- to discover whether a code exists at another business.
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if not exists (
    select 1 from public.local_businesses b
     where b.id = v_red.business_id and b.owner_id = p_verifier
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- Owned, but not the business being operated.
  if p_business is not null and v_red.business_id <> p_business then
    return jsonb_build_object('ok', false, 'error', 'other_business');
  end if;

  if v_red.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;
  if v_red.expires_at is not null and v_red.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  -- Passes carry a balance worth showing before it is spent. Other kinds keep
  -- the detail the challenge was created with.
  if v_red.kind = 'pass' then
    select * into v_purchase from public.book_unit_purchases where id = v_red.ref_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'not_found');
    end if;
    select * into v_item from public.book_unit_items where id = v_purchase.item_id;

    if coalesce(v_purchase.uses_remaining, 0) <= 0 then
      return jsonb_build_object('ok', false, 'error', 'no_uses_left');
    end if;

    return jsonb_build_object(
      'ok', true,
      'kind', 'pass',
      'business_id', v_red.business_id,
      'title', coalesce(v_item.name, 'Pass'),
      'uses_remaining', v_purchase.uses_remaining,
      'subtitle', v_purchase.uses_remaining || ' use'
                  || case when v_purchase.uses_remaining = 1 then '' else 's' end
                  || ' left before this one'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'kind', v_red.kind,
    'business_id', v_red.business_id,
    'title', coalesce(v_red.detail->>'title', initcap(v_red.kind)),
    'subtitle', v_red.detail->>'subtitle'
  );
end;
$$;

-- ── 2. The reward/points spender ────────────────────────────────────────────
drop function if exists public.loyalty_redeem_code_atomic(uuid, text, uuid);

create or replace function public.loyalty_redeem_code_atomic(
  p_verifier uuid,
  p_code     text default null,
  p_token    uuid default null,
  p_business uuid default null
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

  if p_business is not null and not exists (
    select 1 from public.local_businesses b
     where b.id = p_business and b.owner_id = p_verifier
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_your_business');
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
  if p_business is not null and v_red.business_id <> p_business then
    return jsonb_build_object('ok', false, 'error', 'other_business');
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

-- ── 3. The pass spender ─────────────────────────────────────────────────────
drop function if exists public.redeem_pass_atomic(uuid, text, text);

create or replace function public.redeem_pass_atomic(
  p_verifier uuid,
  p_code     text default null,
  p_token    text default null,
  p_business uuid default null
)
returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_red      public.local_redemptions%rowtype;
  v_purchase public.book_unit_purchases%rowtype;
  v_left     integer;
  v_token    uuid;
begin
  if p_verifier is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if coalesce(p_code, p_token) is null then
    raise exception 'code_required' using errcode = '22023';
  end if;

  if p_business is not null and not exists (
    select 1 from public.local_businesses b
     where b.id = p_business and b.owner_id = p_verifier
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_your_business');
  end if;

  -- A malformed token is "no such code", not a crash.
  if p_token is not null then
    begin
      v_token := p_token::uuid;
    exception when invalid_text_representation then
      return jsonb_build_object('ok', false, 'error', 'not_found');
    end;
  end if;

  -- Serialise on the redemption itself. Everyone presenting this code queues
  -- here; only the first finds it pending.
  select * into v_red
    from public.local_redemptions
   where (v_token is not null and token = v_token)
      or (v_token is null and code = upper(btrim(p_code)))
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_red.kind <> 'pass' then
    return jsonb_build_object('ok', false, 'error', 'wrong_kind');
  end if;
  if v_red.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;
  if v_red.expires_at is not null and v_red.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  if not exists (
    select 1 from public.local_businesses b
     where b.id = v_red.business_id and b.owner_id = p_verifier
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_your_business');
  end if;
  if p_business is not null and v_red.business_id <> p_business then
    return jsonb_build_object('ok', false, 'error', 'other_business');
  end if;

  select * into v_purchase
    from public.book_unit_purchases
   where id = v_red.ref_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'pass_not_found');
  end if;
  if v_purchase.business_id <> v_red.business_id then
    return jsonb_build_object('ok', false, 'error', 'wrong_business');
  end if;
  if v_purchase.expires_at is not null and v_purchase.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'pass_expired');
  end if;
  if coalesce(v_purchase.uses_remaining, 0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'no_uses_left');
  end if;

  v_left := v_purchase.uses_remaining - 1;

  update public.book_unit_purchases
     set uses_remaining = v_left,
         fully_used_at  = case when v_left = 0 then now() else fully_used_at end
   where id = v_purchase.id;

  update public.local_redemptions
     set status = 'consumed', consumed_at = now(), consumed_by = p_verifier
   where id = v_red.id;

  return jsonb_build_object(
    'ok', true,
    'uses_remaining', v_left,
    'fully_used', v_left = 0,
    'purchase_id', v_purchase.id
  );
end;
$$;

comment on function public.preview_redemption(uuid, text, text, uuid) is
  'READ-ONLY look-up of a pending redemption code. Writes nothing. When p_business is supplied the caller must own it and the code must belong to it, else other_business. service_role only.';
comment on function public.loyalty_redeem_code_atomic(uuid, text, uuid, uuid) is
  'Redeems one pending reward/points code: locks the redemption row and the card, checks pending status, expiry and business ownership, applies the effect and marks the code consumed — all in one transaction, so the same code cannot apply twice. When p_business is supplied the code must also belong to that business. service_role only.';
comment on function public.redeem_pass_atomic(uuid, text, text, uuid) is
  'Spends one use of a pass against a pending redemption code, locking both rows. When p_business is supplied the code must also belong to that business. service_role only.';

-- ── Privileges: the new signatures, service_role only, as before ────────────
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.preview_redemption(uuid, text, text, uuid)',
    'public.loyalty_redeem_code_atomic(uuid, text, uuid, uuid)',
    'public.redeem_pass_atomic(uuid, text, text, uuid)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

commit;
