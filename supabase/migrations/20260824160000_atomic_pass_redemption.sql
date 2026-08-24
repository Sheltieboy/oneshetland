-- One pass code, one use.
--
-- WHAT WAS WRONG
--
-- local-redeem-verify spent a pass by reading, subtracting and writing back:
--
--     select * from book_unit_purchases where id = red.ref_id;
--     if uses_remaining <= 0 -> refuse
--     update book_unit_purchases set uses_remaining = uses_remaining - 1 ...
--
-- and only afterwards flipped local_redemptions pending -> consumed, with no
-- guard on that either. Every check was a read that nothing held.
--
-- Reproduced against production on disposable fixtures before writing this —
-- five trials, six concurrent verifies of the SAME redemption code, a pass
-- holding five uses:
--
--     trial 1: successes=4  credits_spent=2
--     trial 2: successes=4  credits_spent=2
--     trial 3: successes=6  credits_spent=3
--     trial 4: successes=4  credits_spent=3
--     trial 5: successes=3  credits_spent=2
--
-- Five out of five. Not merely a double-tap at the till: one code, presented
-- repeatedly, is honoured again and again while the balance falls by less than
-- the number of services handed over. A five-use pass could be walked well past
-- five.
--
-- THE FIX
--
-- The whole redemption becomes one function holding real locks. The redemption
-- row is taken FOR UPDATE first, so every concurrent caller for that code
-- queues behind the first; the loser then finds status <> 'pending' and is told
-- so. The purchase row is locked next, its balance re-read under that lock, and
-- decremented once.
--
-- It is deliberately NOT a decrement API. It takes a CODE, not a purchase id,
-- and derives the purchase, the business and the balance from the row it
-- locked. The verifier's ownership of that business is re-checked inside the
-- transaction against local_businesses, so a caller cannot spend a pass at a
-- business they do not own even if they somehow reach the function.
--
-- SCOPE. The pass branch only. Stamps, points and the redemption-row flip for
-- those kinds have the same read-then-write shape and are reported separately
-- rather than remediated here; offers are already protected by a UNIQUE
-- constraint on local_offer_redemptions.

begin;

create or replace function public.redeem_pass_atomic(
  p_verifier uuid,
  p_code     text default null,
  p_token    text default null
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
begin
  if p_verifier is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if coalesce(p_code, p_token) is null then
    raise exception 'code_required' using errcode = '22023';
  end if;

  -- Serialise on the redemption itself. Everyone presenting this code queues
  -- here; only the first finds it pending.
  select * into v_red
    from public.local_redemptions
   where (p_token is not null and token = p_token)
      or (p_token is null and code = upper(btrim(p_code)))
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_red.kind <> 'pass' then
    return jsonb_build_object('ok', false, 'error', 'wrong_kind');
  end if;
  if v_red.status <> 'pending' then
    -- The loser of the race lands here, having changed nothing.
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;
  if v_red.expires_at is not null and v_red.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  -- Ownership re-checked inside the transaction, against the database rather
  -- than anything the caller said.
  if not exists (
    select 1 from public.local_businesses b
     where b.id = v_red.business_id and b.owner_id = p_verifier
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_your_business');
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
         -- Stamped once, on the transition to zero. Never cleared by a later
         -- redemption, which the old code did by writing null every time.
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

-- Only the server calls this. It trusts p_verifier, so the caller must be the
-- edge function that derived it from a verified JWT — never a client.
revoke all on function public.redeem_pass_atomic(uuid, text, text) from public, anon, authenticated;
grant execute on function public.redeem_pass_atomic(uuid, text, text) to service_role;

comment on function public.redeem_pass_atomic(uuid, text, text) is
  'Spends exactly one use of a pass, in one transaction, holding the redemption row FOR UPDATE so concurrent presentations of the same code serialise and only the first succeeds. Replaces a read-then-write that allowed six successes for three credits under load. Takes a code, not a purchase id, and re-checks the verifier owns the business.';

commit;
