-- redeem_pass_atomic could never match a token.
--
-- local_redemptions.token is a UUID; the function compared it to a text
-- parameter, so every call died with
--
--     42883: operator does not exist: uuid = text
--
-- The edge function turned that into a 500 and no pass could be redeemed at
-- all — caught immediately by re-running the concurrency fixture, which went
-- from "six successes for three credits" to zero successes for zero credits.
-- Wrong in the safe direction, but wrong.
--
-- The parameter stays text, because that is what arrives over HTTP; it is cast
-- once, and a value that is not a UUID is treated as no match rather than
-- raising. Everything else is unchanged from 20260824160000.

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
  v_token    uuid;
begin
  if p_verifier is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if coalesce(p_code, p_token) is null then
    raise exception 'code_required' using errcode = '22023';
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

revoke all on function public.redeem_pass_atomic(uuid, text, text) from public, anon, authenticated;
grant execute on function public.redeem_pass_atomic(uuid, text, text) to service_role;

commit;
