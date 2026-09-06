-- ============================================================================
-- A gift you own, that you cannot see until you claim it.
--
-- WHAT IS WRONG
--
-- /account/gifts promises "When someone sends you a gift through OneShetland,
-- it'll appear here ready to claim". It cannot. Two reasons, both real:
--
--   1. fetchMyGiftsReceived filters on claimed_by_user_id = auth.uid() and
--      status in ('claimed','used'), so an unclaimed gift can never match.
--   2. book_gifts has three SELECT policies — business owner, purchaser and
--      CLAIMER. There is no recipient policy, so even the right query would
--      return nothing. A recipient becomes visible to themselves only by
--      claiming, which is the thing they came to the page to do.
--
-- The link in the email works, so a recipient who keeps the email is fine. One
-- who deletes it has no route to their gift at all.
--
-- WHY AN RPC AND NOT A POLICY
--
-- A policy would have to widen table-level visibility of book_gifts, and the
-- table carries payment_intent_id, purchaser_id and the raw claim code. Two
-- SECURITY DEFINER functions return only what each job needs, and the table
-- stays exactly as locked as it is today.
--
-- WHY NO CODE REACHES THE CLIENT
--
-- claim_gift takes a code, so the obvious listing would hand the browser the
-- one secret that lets anybody holding it reach the claim gate. Instead
-- claim_gift_by_id resolves the code server-side and DELEGATES to claim_gift.
-- The authorisation rule is not reimplemented — gift_recipient_ok stays the
-- single gate, and it still runs. Guessing a gift id gets you nothing: the id
-- only names the gift, it never authorises the claim.
-- ============================================================================

begin;

-- ── 1. What the recipient may see before claiming ───────────────────────────
--
-- The same identity rule as gift_recipient_ok's first branch: the CONFIRMED
-- address on the auth record, normalised with lower(btrim(...)). An
-- unconfirmed address proves nothing and returns nothing.
--
-- Deliberately the first branch only. Listing is identity-based; a gift claimed
-- through an email challenge to some other address stays a link-driven flow,
-- because "gifts sent to you" should not quietly mean "addresses you once
-- proved".
create or replace function public.my_unclaimed_gifts()
returns table (
  gift_id       uuid,
  kind          text,
  product_name  text,
  business_name text,
  sender_name   text,
  message       text,
  expires_at    timestamptz,
  created_at    timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select g.id,
         g.kind,
         coalesce(u.name, s.name),
         b.name,
         g.purchaser_name,
         g.message,
         g.expires_at,
         g.created_at
    from public.book_gifts g
    left join public.local_businesses b on b.id = g.business_id
    left join public.book_unit_items   u on u.id = g.unit_item_id
    left join public.book_services     s on s.id = g.service_id
   where auth.uid() is not null
     and g.status = 'sent'
     and g.claimed_by_user_id is null
     and (g.expires_at is null or g.expires_at > now())
     and lower(btrim(g.recipient_email)) = (
           select lower(btrim(au.email))
             from auth.users au
            where au.id = auth.uid()
              and au.email_confirmed_at is not null)
   order by g.created_at desc;
$$;

comment on function public.my_unclaimed_gifts() is
  'Gifts addressed to the caller''s CONFIRMED auth email that are sent, unclaimed and unexpired. Display fields only — never the claim code, payment_intent_id, purchaser_id or recipient verification records. Same normalisation as gift_recipient_ok.';

revoke all on function public.my_unclaimed_gifts() from public, anon;
grant execute on function public.my_unclaimed_gifts() to authenticated, service_role;

-- ── 2. Claiming one of them, without ever seeing its code ───────────────────
--
-- Resolves the code and hands straight to claim_gift, which re-checks
-- gift_recipient_ok, takes its FOR UPDATE, and spawns the unit purchase
-- idempotently. Every refusal claim_gift raises still applies, unchanged:
-- gift_not_found, gift_not_paid, gift_cancelled, gift_expired,
-- gift_already_claimed, gift_recipient_verification_required.
--
-- auth.uid() is a GUC, not the executing role, so it survives the delegation
-- and claim_gift authorises the SAME person who called this.
create or replace function public.claim_gift_by_id(p_gift_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'auth_required';
  end if;

  select code into v_code from public.book_gifts where id = p_gift_id;
  if v_code is null then
    -- Same answer for "no such gift" and "not yours", so an id cannot be used
    -- to probe which gifts exist.
    raise exception 'gift_not_found';
  end if;

  return public.claim_gift(v_code);
end;
$$;

comment on function public.claim_gift_by_id(uuid) is
  'Claim a gift by id without the caller ever holding its code. Resolves the code server-side and delegates to claim_gift, so gift_recipient_ok remains the single authorisation gate. A gift id names a gift; it never authorises claiming one.';

revoke all on function public.claim_gift_by_id(uuid) from public, anon;
grant execute on function public.claim_gift_by_id(uuid) to authenticated, service_role;

commit;
