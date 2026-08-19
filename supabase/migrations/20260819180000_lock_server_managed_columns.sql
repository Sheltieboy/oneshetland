-- ============================================================================
-- RLS decides which ROWS you may write. It never decides which COLUMNS.
--
-- local_businesses, hubs and driver_profiles each let an owner update their own
-- row, and each carries columns only Stripe, a webhook or an administrator is
-- supposed to set. The policy permits the row, so it permits every column of
-- it. Verified against production before writing this, all four succeeded:
--
--   business owner  → subscription_tier='premium', subscription_until='2099-01-01',
--                     is_verified=true, payout_enabled=true,
--                     stripe_customer_id='cus_ATTACKER', nfc_token='ATTACKER'
--   hub owner       → is_verified=true, payout_enabled=true, stripe_account_id='acct_X'
--   hub owner       → owner_id=<somebody else>        (uncontrolled handover)
--   driver          → driver_status='approved', stripe_payouts_enabled=true
--
-- subscription_tier is not a display cache. It is the source of truth for
-- listing richness and manage-screen access (lib/listing-tiers.ts), home-page
-- featuring (lib/home-shelves.ts), directory ordering (lib/local-data.ts) and
-- per-booking metering (meter-bookings excludes premium). Writing one word into
-- that column took the whole paid model for free.
--
-- profiles was fixed the same way in 20260818210000. This is the same class of
-- bug on three tables that never got the treatment.
--
-- WHY current_user AND NOT auth.uid().
-- tg_profiles_lock_sensitive keys on `auth.uid() = old.id`, which works there
-- because a profile row IS a user. It does not generalise: a business row is
-- not its owner, and — more importantly — auth.uid() stays set inside a
-- SECURITY DEFINER function, so that test cannot tell a direct client write
-- from a legitimate server RPC running on the caller's behalf. current_user
-- can. Measured on production:
--
--   direct write as authenticated   → current_user = 'authenticated'   constrain
--   direct write as anon            → current_user = 'anon'            constrain
--   backend / webhook               → current_user = 'service_role'    allow
--   inside any SECURITY DEFINER fn  → current_user = 'postgres'        allow
--
-- So approve_business_claim, request_nfc_tile and every service-role edge
-- function keep working untouched, while a PostgREST call from a browser or a
-- phone cannot reach the protected columns. Platform admins are allowed through
-- explicitly, because two admin screens write these columns from the client:
-- oneshetland-web/components/admin/DriverApprovals.tsx and the app's
-- app/(admin)/driver-approvals.tsx both set driver_status directly.
--
-- INSERT forces the safe default rather than raising. Rejecting would break
-- business signup: oneshetland-web/components/directory/BusinessCreateForm.tsx
-- legitimately sends subscription_tier:'free' in its insert. Normalising is
-- silent, cannot break a caller sending a correct value, and fails safe for one
-- sending a dishonest one. UPDATE restores the previous value for the same
-- reason — an app that sends a whole row back still succeeds and simply cannot
-- move these fields.
--
-- Not in scope here: H7 (these columns being publicly READABLE) is a separate
-- step. This migration is about write integrity only.
-- ============================================================================

-- ── Who is allowed to set server-managed columns ────────────────────────────

create or replace function public.tg_is_trusted_writer() returns boolean
  language plpgsql
  stable
  -- SECURITY INVOKER on purpose: current_user must stay the role that is
  -- actually writing. SECURITY DEFINER would rebind it to the owner and the
  -- guard below would pass for everyone. Measured, not assumed.
  set search_path = public
as $$
begin
  -- Anything that is not a direct PostgREST call from a client role: the
  -- service role, a SECURITY DEFINER function (current_user = the owner), a
  -- migration, or a direct psql session.
  if current_user not in ('authenticated', 'anon') then
    return true;
  end if;
  -- Platform administrators operate these fields from admin screens in the
  -- browser and the app, so they arrive as `authenticated`.
  return public.is_admin();
end;
$$;

comment on function public.tg_is_trusted_writer() is
  'True when the current write is NOT a direct client PostgREST call, or is one made by a platform admin. Used by the column-lock triggers. Keys on current_user because auth.uid() cannot distinguish a client write from a SECURITY DEFINER server path.';

-- ── local_businesses ────────────────────────────────────────────────────────

create or replace function public.tg_lock_business_columns() returns trigger
  language plpgsql
  -- SECURITY INVOKER on purpose: current_user must stay the role that is
  -- actually writing. SECURITY DEFINER would rebind it to the owner and the
  -- guard would pass for everyone. Measured, not assumed.
  set search_path = public
as $$
begin
  if public.tg_is_trusted_writer() then return new; end if;

  if tg_op = 'INSERT' then
    -- Entitlement, trust and money always start from nothing.
    new.subscription_tier                   := 'free';
    new.subscription_until                  := null;
    new.subscription_cancel_at_period_end   := false;
    new.is_verified                         := false;
    new.verified_at                         := null;
    new.payout_enabled                      := false;
    new.stripe_customer_id                  := null;
    new.stripe_subscription_id              := null;
    new.stripe_account_id                   := null;
    new.business_stripe_customer_id         := null;
    new.business_stripe_account_id          := null;
    new.has_business_payment_method         := false;
    new.business_stripe_onboarding_complete := false;
    new.business_stripe_payouts_enabled     := false;
    new.nfc_token                           := null;
    new.nfc_dispatched_at                   := null;
    new.nfc_activated_at                    := null;
    new.can_publish_urgent                  := false;
    return new;
  end if;

  -- UPDATE: silently restore whatever the row already held.
  new.subscription_tier                   := old.subscription_tier;
  new.subscription_until                  := old.subscription_until;
  new.subscription_cancel_at_period_end   := old.subscription_cancel_at_period_end;
  new.is_verified                         := old.is_verified;
  new.verified_at                         := old.verified_at;
  new.payout_enabled                      := old.payout_enabled;
  new.stripe_customer_id                  := old.stripe_customer_id;
  new.stripe_subscription_id              := old.stripe_subscription_id;
  new.stripe_account_id                   := old.stripe_account_id;
  new.business_stripe_customer_id         := old.business_stripe_customer_id;
  new.business_stripe_account_id          := old.business_stripe_account_id;
  new.has_business_payment_method         := old.has_business_payment_method;
  new.business_stripe_onboarding_complete := old.business_stripe_onboarding_complete;
  new.business_stripe_payouts_enabled     := old.business_stripe_payouts_enabled;
  new.nfc_token                           := old.nfc_token;
  new.nfc_dispatched_at                   := old.nfc_dispatched_at;
  new.nfc_activated_at                    := old.nfc_activated_at;
  new.can_publish_urgent                  := old.can_publish_urgent;
  -- Identity: a business must not change hands, or slug, by table update.
  new.owner_id                            := old.owner_id;
  new.slug                                := old.slug;
  new.created_at                          := old.created_at;
  return new;
end;
$$;

drop trigger if exists tg_zz_lock_business_columns on public.local_businesses;
create trigger tg_zz_lock_business_columns
  before insert or update on public.local_businesses
  for each row execute function public.tg_lock_business_columns();

-- ── hubs ────────────────────────────────────────────────────────────────────
-- Note the UPDATE policy is `owner_id = auth.uid() OR is_hub_admin(...)`, and
-- with no WITH CHECK that expression is also the check — so a hub admin who is
-- not the owner satisfies it whatever owner_id becomes. Locking owner_id closes
-- that handover path as well as the escalation one.

create or replace function public.tg_lock_hub_columns() returns trigger
  language plpgsql
  -- SECURITY INVOKER on purpose: current_user must stay the role that is
  -- actually writing. SECURITY DEFINER would rebind it to the owner and the
  -- guard would pass for everyone. Measured, not assumed.
  set search_path = public
as $$
begin
  if public.tg_is_trusted_writer() then return new; end if;

  if tg_op = 'INSERT' then
    new.is_verified       := false;
    new.payout_enabled    := false;
    new.stripe_account_id := null;
    return new;
  end if;

  new.is_verified       := old.is_verified;
  new.payout_enabled    := old.payout_enabled;
  new.stripe_account_id := old.stripe_account_id;
  new.owner_id          := old.owner_id;
  new.slug              := old.slug;
  new.created_at        := old.created_at;
  return new;
end;
$$;

drop trigger if exists tg_zz_lock_hub_columns on public.hubs;
create trigger tg_zz_lock_hub_columns
  before insert or update on public.hubs
  for each row execute function public.tg_lock_hub_columns();

-- ── driver_profiles ─────────────────────────────────────────────────────────
-- driver_status is the approval gate for taking deliveries; a driver was able
-- to set it to 'approved' on their own row. Admins still set it from the admin
-- screens, which tg_is_trusted_writer() permits.

create or replace function public.tg_lock_driver_columns() returns trigger
  language plpgsql
  -- SECURITY INVOKER on purpose: current_user must stay the role that is
  -- actually writing. SECURITY DEFINER would rebind it to the owner and the
  -- guard would pass for everyone. Measured, not assumed.
  set search_path = public
as $$
begin
  if public.tg_is_trusted_writer() then return new; end if;

  if tg_op = 'INSERT' then
    new.driver_status             := 'not_applied';   -- the schema default
    new.stripe_account_id         := null;
    new.stripe_onboarding_complete := false;
    new.stripe_payouts_enabled    := false;
    new.stripe_charges_enabled    := false;
    new.dispute_count             := 0;
    new.flagged_for_review        := false;
    return new;
  end if;

  new.driver_status              := old.driver_status;
  new.stripe_account_id          := old.stripe_account_id;
  new.stripe_onboarding_complete := old.stripe_onboarding_complete;
  new.stripe_payouts_enabled     := old.stripe_payouts_enabled;
  new.stripe_charges_enabled     := old.stripe_charges_enabled;
  new.dispute_count              := old.dispute_count;
  new.flagged_for_review         := old.flagged_for_review;
  new.id                         := old.id;
  new.created_at                 := old.created_at;
  return new;
end;
$$;

drop trigger if exists tg_zz_lock_driver_columns on public.driver_profiles;
create trigger tg_zz_lock_driver_columns
  before insert or update on public.driver_profiles
  for each row execute function public.tg_lock_driver_columns();

-- ── The one client path that legitimately wrote a locked column ─────────────
--
-- The app mints an NFC tile token client-side and writes it straight to the
-- table (lib/local-api.ts): generate_nfc_token() returns a string, then the
-- client UPDATEs nfc_token itself. Locking nfc_token would break that, so the
-- write moves server-side where it belonged — the token is what identifies a
-- business for payment in local-wallet-pay, and a client that can choose it can
-- collide with somebody else's tile.
--
-- The website already calls request_nfc_tile and silently falls back when it
-- 404s, so this also repairs a path that has never worked there.

create or replace function public.request_nfc_tile(p_business_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_name  text;
  v_token text;
begin
  select owner_id, name into v_owner, v_name
    from public.local_businesses where id = p_business_id;
  if v_owner is null then
    raise exception 'request_nfc_tile: no such business' using errcode = '42501';
  end if;
  if v_owner is distinct from auth.uid() and not public.is_admin() then
    raise exception 'request_nfc_tile: you do not run this business' using errcode = '42501';
  end if;

  -- Already has one: hand it back rather than rotating it, so a double tap on
  -- "request a tile" cannot orphan a tile that is already stuck to a counter.
  select nfc_token into v_token from public.local_businesses where id = p_business_id;
  if v_token is not null then return v_token; end if;

  v_token := public.generate_nfc_token(v_name);
  update public.local_businesses
     set nfc_token  = v_token,
         nfc_status = case when nfc_status = 'none' then 'requested' else nfc_status end
   where id = p_business_id;
  return v_token;
end;
$$;

comment on function public.request_nfc_tile(uuid) is
  'Mints and stores the NFC tile token for a business the caller owns. The token identifies a business for wallet payment, so it is issued server-side; nfc_token is locked against direct client writes by tg_lock_business_columns.';

revoke all on function public.request_nfc_tile(uuid) from public;
revoke all on function public.request_nfc_tile(uuid) from anon;
grant execute on function public.request_nfc_tile(uuid) to authenticated;
grant execute on function public.request_nfc_tile(uuid) to service_role;
