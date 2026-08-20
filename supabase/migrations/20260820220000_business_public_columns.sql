-- ============================================================================
-- The business directory stops handing out Stripe identifiers.
--
-- WHAT WAS WRONG
--
-- local_businesses granted arwdDxtm to anon and authenticated, and its RLS
-- policy filters ROWS ("is_active = true OR owner_id = auth.uid()") and nothing
-- else. RLS has no column dimension, so every column of every active business
-- was readable by anybody with the public anon key.
--
-- Verified against production before this migration. An anonymous caller could
-- list, by column:
--
--   owner_id                  2 rows   real account uuids, business → person
--   stripe_account_id         1 row    a live Connect account id (acct_1…)
--   stripe_customer_id        1 row
--   stripe_subscription_id    1 row
--   nfc_token                 1 row    the token behind a physical tile
--
-- Small today because only two businesses are claimed. That is the point: the
-- mechanism is fully open and the exposure grows with every business that
-- signs up.
--
-- WHY COLUMN GRANTS AND NOT A VIEW
--
-- Both were considered. A view would leave the underlying table readable unless
-- its grants were removed anyway, so the grant work is unavoidable either way —
-- and once the columns are governed, a view adds a second surface to keep in
-- step rather than a boundary.
--
-- Column privileges are also a WHITELIST, which is the property that matters
-- most here. A column added to local_businesses next month is not in any GRANT,
-- so it is private until somebody deliberately publishes it. A view or a
-- blacklist has the opposite default, and the failure is silent.
--
-- Verified empirically before committing to it: under column-level grants,
-- `select id, name` succeeds as anon, `select secret` is denied, and — this is
-- the part that decides how much client work there is — `select *` is DENIED.
-- Every caller must therefore name its columns, which is also how a new
-- sensitive column stays unpublished.
--
-- APPLIED IN TWO PARTS, ON PURPOSE
--
-- This migration is additive only: functions and indexes, no grant changes. It
-- can land while the current site is still running, because nothing it does
-- takes anything away.
--
-- The revoke lives in the NEXT migration, which is applied only once the
-- clients that name their columns are deployed and verified live. Doing both
-- at once would break the business directory for however long the deploy took.
--
-- THE TWO BOUNDARIES, BOTH KEPT
--
--   RLS               which ROWS      unchanged: active businesses, plus your own
--   column grants     which COLUMNS   new: the safe directory set
--
-- Neither is sufficient alone. `authenticated` is every signed-in user, not the
-- owner, so column privileges cannot be the ownership boundary either — which
-- is why the private fields come back through an owner-checked function rather
-- than a wider grant.
-- ============================================================================


-- ── Deterministic identifier lookups ────────────────────────────────────────
--
-- stripe-webhook resolves a business by Stripe account id and expects exactly
-- one row. Those columns carried ORDINARY indexes, so nothing prevented two
-- businesses sharing an identifier and a webhook silently updating whichever
-- came back first.
--
-- Checked before adding: zero duplicates in any of the four, live. Partial, so
-- the 533 rows with no Stripe relationship do not collide on NULL.
create unique index if not exists local_businesses_stripe_account_uniq
  on public.local_businesses (stripe_account_id) where stripe_account_id is not null;

create unique index if not exists local_businesses_biz_stripe_account_uniq
  on public.local_businesses (business_stripe_account_id) where business_stripe_account_id is not null;

create unique index if not exists local_businesses_stripe_subscription_uniq
  on public.local_businesses (stripe_subscription_id) where stripe_subscription_id is not null;

create unique index if not exists local_businesses_stripe_customer_uniq
  on public.local_businesses (stripe_customer_id) where stripe_customer_id is not null;

-- nfc_token was already UNIQUE (local_businesses_nfc_token_key), so tile lookup
-- is already deterministic. Left exactly as it is — no token is regenerated.


-- ── The private fields, for the people entitled to them ─────────────────────
--
-- The owner's own dashboard genuinely needs these: whether Stripe onboarding
-- finished, whether a payout account is connected, which tier renews, and the
-- NFC token so the tile URL can be shown.
--
-- It returns them only to the business's owner or a platform admin, which is
-- the ownership boundary column grants cannot express — `authenticated` is
-- every signed-in user, not this business's owner.
--
-- The Stripe identifiers are deliberately NOT returned. The dashboard shows
-- "Connected", not an account id, and there is no screen that needs the raw
-- value. Anything that genuinely does — the webhook, Connect onboarding,
-- payment routing — runs as service_role and reads the table directly.
create or replace function public.business_private_fields(p_business_id uuid)
returns table (
  business_id                         uuid,
  nfc_token                           text,
  nfc_status                          text,
  nfc_dispatched_at                   timestamptz,
  nfc_activated_at                    timestamptz,
  subscription_cancel_at_period_end   boolean,
  use_business_payment                boolean,
  has_business_payment_method         boolean,
  use_business_payout                 boolean,
  business_stripe_onboarding_complete boolean,
  business_stripe_payouts_enabled     boolean,
  stripe_connected                    boolean,
  business_stripe_connected           boolean,
  subscription_connected              boolean
)
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
declare
  v_owner uuid;
begin
  if p_business_id is null then
    return;
  end if;

  select b.owner_id into v_owner from public.local_businesses b where b.id = p_business_id;
  if not found then
    return;
  end if;

  if auth.uid() is null or (v_owner is distinct from auth.uid() and not public.is_admin()) then
    raise exception 'Not allowed to read private fields for this business'
      using errcode = '42501';
  end if;

  return query
    select b.id,
           b.nfc_token, b.nfc_status, b.nfc_dispatched_at, b.nfc_activated_at,
           b.subscription_cancel_at_period_end,
           b.use_business_payment, b.has_business_payment_method, b.use_business_payout,
           b.business_stripe_onboarding_complete, b.business_stripe_payouts_enabled,
           -- Derived state instead of the identifier. "Connected" is what the
           -- UI actually shows; the account id is not needed to show it.
           (b.stripe_account_id is not null),
           (b.business_stripe_account_id is not null),
           (b.stripe_subscription_id is not null)
      from public.local_businesses b
     where b.id = p_business_id;
end;
$$;

comment on function public.business_private_fields(uuid) is
  'Private business-management fields, for that business''s owner or a platform admin only. Returns booleans for Stripe state rather than the identifiers themselves — the dashboard shows "Connected", not an account id.';


-- ── The NFC dispatch queue, for admins ──────────────────────────────────────
--
-- The admin NFC page reads tokens across many businesses to print and post the
-- tiles. It runs on the admin's own session (the website holds no service-role
-- key), so it needs a route to a column no client role can select.
create or replace function public.admin_nfc_queue(p_status text default 'all')
returns table (
  id                uuid,
  name              text,
  slug              text,
  address           text,
  phone             text,
  email             text,
  subscription_tier text,
  subscription_until timestamptz,
  nfc_status        text,
  nfc_token         text
)
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  return query
    select b.id, b.name, b.slug, b.address, b.phone, b.email,
           b.subscription_tier, b.subscription_until, b.nfc_status, b.nfc_token
      from public.local_businesses b
     where b.nfc_status is distinct from 'none'
       and (p_status = 'all' or b.nfc_status = p_status)
     order by b.name;
end;
$$;

comment on function public.admin_nfc_queue(text) is
  'The NFC tile dispatch queue. Platform admins only — nfc_token is not selectable by any client role, so this is the only way in short of service_role.';


-- ── Privileges ──────────────────────────────────────────────────────────────
--
-- Postgres re-grants EXECUTE to PUBLIC at CREATE time, and a revoke naming
-- fewer than {public, anon, authenticated} is a no-op in one direction or the
-- other — the lesson from Steps 1 and 1B. All three are named.
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.business_private_fields(uuid)',
    'public.admin_nfc_queue(text)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    -- authenticated is correct: both functions check WHO you are internally and
    -- refuse anyone who is not the owner or an admin.
    execute format('grant execute on function %s to authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
