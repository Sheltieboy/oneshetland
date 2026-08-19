-- ============================================================================
-- Two RPCs let the caller choose whose identifier they got back.
--
--   ensure_member_code(p_user uuid)
--   ensure_referral_code(p_user uuid)
--
-- Both are SECURITY DEFINER, both are granted to PUBLIC/anon/authenticated, and
-- neither reads auth.uid(). They select the code from profiles WHERE id =
-- p_user and return it — so p_user, which the caller supplies, decides whose
-- code comes back. Every one of the six call sites across both repositories
-- already passes the current user's own id; the parameter buys nothing and
-- costs this.
--
-- member_code is not a cosmetic identifier. It is the ONE permanent code a
-- customer's QR encodes, and it is how the counter finds a person:
--   loyalty-till           resolves a customer by member_code, then can stamp,
--                          award points, or REDEEM their earned reward/offer
--   wallet-charge-request  resolves a customer by member_code and raises a
--                          payment request against them
-- Both of those require the caller to own an active business, so this was not
-- reachable by any signed-in stranger. But profiles RLS otherwise keeps
-- member_code private (SELECT is limited to your own row), and this function
-- walked straight past that: anyone holding a user's UUID could read their
-- permanent code. Business owners' UUIDs are public — local_businesses.owner_id
-- is world-readable — so at minimum every business owner's code was obtainable.
--
-- Money was never reachable this way. wallet-charge-approve rejects anyone but
-- the targeted customer (customer_id must equal auth.uid()) and debits the
-- approver's own wallet, so a code alone cannot spend a balance. What it could
-- do is disclose a person's name and let a business burn their loyalty reward
-- without them present.
--
-- HOW THIS IS FIXED WITHOUT A DEPLOY WINDOW.
-- The obvious move — drop the parameter and revoke the old signature — breaks
-- the live website between the migration and the next Netlify deploy, because
-- the site is the caller. Instead:
--
--   1. the uuid signatures keep their grant to `authenticated` but gain a guard
--      that pins p_user to auth.uid(), so an authenticated caller can only ever
--      reach their own row. Existing clients, which already pass their own id,
--      carry on working unchanged;
--   2. anon loses execute entirely — an unauthenticated caller has no identity
--      to be pinned to, so there is nothing legitimate for it to do here;
--   3. service_role keeps unrestricted access, because auth.uid() is NULL under
--      the service key (it reads the JWT `sub` claim, which that key has none
--      of) and two edge functions legitimately mint a code for a given user:
--        supabase/functions/apple-wallet-pass/index.ts:110
--        supabase/functions/google-wallet-pass/index.ts:72
--      Both pass user.id taken from a JWT they verified themselves;
--   4. new no-argument versions become the API clients should use. They read
--      auth.uid(), refuse when it is null, and delegate to the guarded uuid
--      version so there is one implementation rather than two that can drift.
--
-- The result: there is no argument a client can pass that selects another user,
-- and there is no window in which the site is broken.
--
-- NOT CHANGED HERE: analytics_emit. It has the same shape — a caller-supplied
-- p_user — but binding it to auth.uid() would be wrong. Its only callers are
-- the twelve tg_ae_* triggers, which pass the ROW's owner (new.buyer_id,
-- new.customer_id, new.donor_user_id …), and many fire from the Stripe webhook
-- on the service role where auth.uid() is NULL. It needs its triggers made
-- SECURITY DEFINER and then a revoke, which is a different change.
-- ============================================================================

-- ── 1. Guard the uuid signatures ────────────────────────────────────────────
-- `p_user is distinct from auth.uid()` rather than `<>` so a NULL p_user from
-- an authenticated caller is rejected too, instead of comparing to NULL and
-- silently passing.

create or replace function public.ensure_member_code(p_user uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_code text;
begin
  -- A signed-in caller may only ever ask for their own code. auth.uid() is
  -- NULL for the service role, which is trusted and may name a user.
  if auth.uid() is not null and p_user is distinct from auth.uid() then
    raise exception 'ensure_member_code: you can only request your own member code'
      using errcode = '42501';
  end if;

  select member_code into v_code from public.profiles where id = p_user;
  if v_code is not null then return v_code; end if;
  loop
    -- 8 chars, unambiguous-ish; fine for a QR + occasional manual entry.
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    begin
      update public.profiles set member_code = v_code where id = p_user;
      return v_code;
    exception when unique_violation then
      -- clash, try again
    end;
  end loop;
end;
$$;

create or replace function public.ensure_referral_code(p_user uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_code text;
begin
  if auth.uid() is not null and p_user is distinct from auth.uid() then
    raise exception 'ensure_referral_code: you can only request your own referral code'
      using errcode = '42501';
  end if;

  select referral_code into v_code from public.profiles where id = p_user;
  if v_code is not null then return v_code; end if;
  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    begin
      update public.profiles set referral_code = v_code where id = p_user;
      return v_code;
    exception when unique_violation then
      -- code clash — loop and try another
    end;
  end loop;
end;
$$;

-- ── 2. The API clients should use: no argument to get wrong ─────────────────

create or replace function public.ensure_member_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'ensure_member_code: sign in required' using errcode = '42501';
  end if;
  -- Delegates so the generation/retry logic lives in exactly one place. The
  -- guard above passes because p_user is auth.uid() by construction.
  return public.ensure_member_code(v_uid);
end;
$$;

create or replace function public.ensure_referral_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'ensure_referral_code: sign in required' using errcode = '42501';
  end if;
  return public.ensure_referral_code(v_uid);
end;
$$;

-- ── 3. Grants ───────────────────────────────────────────────────────────────
-- Naming all three roles on every revoke, because naming fewer is what left the
-- wallet mintable for two months (see 20260819140000).

-- uuid versions: no anon, guarded for authenticated, unrestricted for service_role.
revoke all on function public.ensure_member_code(uuid) from public;
revoke all on function public.ensure_member_code(uuid) from anon;
grant execute on function public.ensure_member_code(uuid) to authenticated;
grant execute on function public.ensure_member_code(uuid) to service_role;

revoke all on function public.ensure_referral_code(uuid) from public;
revoke all on function public.ensure_referral_code(uuid) from anon;
grant execute on function public.ensure_referral_code(uuid) to authenticated;
grant execute on function public.ensure_referral_code(uuid) to service_role;

-- no-arg versions: signed-in users only. anon has no identity to resolve.
revoke all on function public.ensure_member_code() from public;
revoke all on function public.ensure_member_code() from anon;
grant execute on function public.ensure_member_code() to authenticated;
grant execute on function public.ensure_member_code() to service_role;

revoke all on function public.ensure_referral_code() from public;
revoke all on function public.ensure_referral_code() from anon;
grant execute on function public.ensure_referral_code() to authenticated;
grant execute on function public.ensure_referral_code() to service_role;

-- ── 4. Record the intent ────────────────────────────────────────────────────

comment on function public.ensure_member_code() is
  'Returns the CALLER''S permanent member code, minting one on first use. Identity comes from auth.uid() — there is no parameter to get wrong. Use this from client code.';
comment on function public.ensure_member_code(uuid) is
  'Server-side variant: mints/returns a member code for a named user. An authenticated caller is pinned to their own id; only the service role (auth.uid() NULL) may name someone else. Used by apple-wallet-pass and google-wallet-pass.';
comment on function public.ensure_referral_code() is
  'Returns the CALLER''S referral code, minting one on first use. Identity comes from auth.uid(). Use this from client code.';
comment on function public.ensure_referral_code(uuid) is
  'Server-side variant: an authenticated caller is pinned to their own id; only the service role may name someone else.';
