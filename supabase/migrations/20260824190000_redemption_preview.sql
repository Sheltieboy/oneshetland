-- Look before you spend.
--
-- WHAT WAS WRONG
--
-- Counter mode called local-redeem-verify — the MUTATING one — the instant
-- staff typed the code. The credit was gone before anything was shown, and the
-- panel that then appeared was headed "Confirm a redemption" with a Next
-- button, so it read as though the redemption had not happened yet.
--
-- Nothing was double-spent: Next only resets the form, and re-scanning a
-- consumed code is refused by redeem_pass_atomic. The database was right
-- throughout — the first real pass went 3 -> 2, exactly once. But a member of
-- staff reading "Confirm a redemption / 2 uses left / [Next]" cannot tell
-- whether they have taken the use or are about to, which is not a state to
-- leave a till in.
--
-- THIS ADDS THE MISSING HALF: a read-only look-up, so the flow becomes
--
--     scan/type  ->  preview (nothing consumed)  ->  Confirm  ->  success
--
-- It is STABLE and writes nothing. It answers the same authorisation questions
-- as the mutating path — the caller must own the business the code belongs to —
-- so a preview cannot be used to probe other businesses' codes.
--
-- It deliberately reports the CURRENT balance. The success screen afterwards
-- shows the balance redeem_pass_atomic returns, so neither screen ever
-- subtracts one for itself.

begin;

create or replace function public.preview_redemption(
  p_verifier uuid,
  p_code     text default null,
  p_token    text default null
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
    'title', coalesce(v_red.detail->>'title', initcap(v_red.kind)),
    'subtitle', v_red.detail->>'subtitle'
  );
end;
$$;

revoke all on function public.preview_redemption(uuid, text, text) from public, anon, authenticated;
grant execute on function public.preview_redemption(uuid, text, text) to service_role;

comment on function public.preview_redemption(uuid, text, text) is
  'Read-only look-up of a pending redemption for the business that owns it, so Counter mode can show staff what they are about to redeem BEFORE anything is consumed. Writes nothing. Unknown code and another business''s code answer identically.';

commit;
