-- Referral programme DISABLED for launch.
--
-- The programme as built (20260721040000_referrals.sql) pays £5 + £5 of ordinary, spendable wallet balance when a referred member makes a
-- wallet spend of £3 or more. A read-only audit (8 Oct 2026) confirmed it can be farmed and that its accounting is wrong:
--   · reciprocal A<->B rings, and years-old accounts, are accepted as "new" referees;
--   · a referee's spend at a business owned by the REFERRER qualifies;
--   · the reward survives a refund of the qualifying spend;
--   · the credit is platform-funded wallet value that becomes a Stripe transfer to any business;
--   · every reward is booked twice in the ledger (wallet_credit writes a 'refund' row, the trigger adds a 'topup' row) while the balance moves
--     once, so wallet_reconciliation() drifts by the reward amount and analytics counts the 'topup' rows as wallet top-up revenue;
--   · tg_referral_qualify is not idempotent on its own (two concurrent writers both pay out); only wallet_debit_with_ledger's balance-row lock
--     serialises it today;
--   · apply_referral_code is an unthrottled "does this code exist" oracle, and profiles.referral_code is freely user-editable.
-- Production has no codes, no referrals and no rewards, so nothing needs grandfathering. The decision is to ship with referrals OFF and to
-- redesign the programme later; this migration is the OFF switch and nothing more. The schema (profiles.referral_code, public.referrals,
-- the RLS select policy) is kept for the redesign.
--
-- Client contract (build 147 and the web call exactly these three things; neither is changed):
--   · ensure_referral_code()  -> text. Now RAISES "Referral rewards aren't available at the moment." Web shows that message (its catch uses
--     error.message); the app's screen loads with no code and an inert Share button, and applying a code shows the message below. A NULL return
--     was rejected: both clients would put "null" into the shared invite text.
--   · apply_referral_code(p_code) -> jsonb {ok, error}. Now ALWAYS {"ok": false, "error": "Referral rewards aren't available at the moment."}
--     for a signed-in caller, whatever the code: nothing is looked up, so there is no existence oracle, and nothing is written.
--   · select from referrals -> unchanged (an empty list).

begin;

-- ── 1. No reward can be qualified ───────────────────────────────────────────────────────────────────────────────────────────
-- Drop the trigger AND make its function inert, so re-attaching it by mistake still cannot pay anything. The old implementation stays in
-- 20260721040000_referrals.sql for the redesign to learn from.
drop trigger if exists referral_qualify on public.local_wallet_transactions;

create or replace function public.tg_referral_qualify() returns trigger
  language plpgsql
  set search_path to 'public'
as $function$
begin
  -- DISABLED (20261124000000): the programme does not pay out. This function does nothing.
  return new;
end;
$function$;

comment on function public.tg_referral_qualify() is
  'DISABLED for launch (20261124000000): inert no-op, and no trigger calls it. The original reward logic is in 20260721040000_referrals.sql and must not be re-enabled without the redesign.';

-- ── 2. No code is minted ──────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.ensure_referral_code(p_user uuid) returns text
  language plpgsql
  set search_path to 'public'
as $function$
begin
  raise exception 'Referral rewards aren''t available at the moment.';
end;
$function$;

create or replace function public.ensure_referral_code() returns text
  language plpgsql
  set search_path to 'public'
as $function$
begin
  raise exception 'Referral rewards aren''t available at the moment.';
end;
$function$;

comment on function public.ensure_referral_code() is 'DISABLED for launch (20261124000000): always raises. Does not mint or read a code.';
comment on function public.ensure_referral_code(uuid) is 'DISABLED for launch (20261124000000): always raises. Does not mint or read a code.';

-- ── 3. No referral is created, and no code can be probed ──────────────────────────────────────────────────────────────────
create or replace function public.apply_referral_code(p_code text) returns jsonb
  language plpgsql
  set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'auth required'; end if;
  -- DISABLED (20261124000000): identical answer for every input; no table is consulted or changed.
  return jsonb_build_object('ok', false, 'error', 'Referral rewards aren''t available at the moment.');
end;
$function$;

comment on function public.apply_referral_code(text) is
  'DISABLED for launch (20261124000000): returns the same "not available" answer for every code and writes nothing.';

-- ── 4. referral_code is server-managed ────────────────────────────────────────────────────────────────────────────────────
-- Same function, same convention as role / stripe_*: a user-JWT update of their own row silently keeps the stored value (so an app that sends
-- a whole profile back still succeeds). Service role and migrations (auth.uid() NULL) are unaffected. NOTE for the redesign: the lock keys on
-- auth.uid(), which stays set inside a SECURITY DEFINER RPC, so a future code-minting RPC must run as a trusted writer or adjust this.
create or replace function public.tg_profiles_lock_sensitive() returns trigger
    language plpgsql security definer
    set search_path to 'public'
    as $$
begin
  -- Only constrain a user editing their OWN row via a user JWT.
  -- auth.uid() is NULL for service-role / server contexts → unaffected.
  if auth.uid() is not null and auth.uid() = old.id then
    new.role                       := old.role;
    new.is_platform_owner          := old.is_platform_owner;   -- the other half of is_admin()
    new.email_verified             := old.email_verified;
    new.is_active                  := old.is_active;
    new.has_payment_method         := old.has_payment_method;
    new.stripe_customer_id         := old.stripe_customer_id;
    new.stripe_account_id          := old.stripe_account_id;
    new.stripe_onboarding_complete := old.stripe_onboarding_complete;
    new.stripe_payouts_enabled     := old.stripe_payouts_enabled;
    new.stripe_charges_enabled     := old.stripe_charges_enabled;
    new.referral_code              := old.referral_code;        -- 20261124000000: server-managed
  end if;
  return new;
end;
$$;

-- ── 5. Direct DML on referrals was only ever stopped by RLS; stop it at the privilege level too ────────────────────────────
revoke insert, update, delete on table public.referrals from anon, authenticated;

comment on table public.referrals is
  'Referral relationships. Programme DISABLED for launch (20261124000000): nothing writes here; kept for the redesigned programme.';

-- ── prove the end state inside the same transaction ──────────────────────────────────────────────────────────────────────
do $$
declare r text; a text;
begin
  if exists (select 1 from pg_trigger where tgname = 'referral_qualify' and not tgisinternal) then
    raise exception 'referral_qualify trigger is still attached';
  end if;
  if exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'tg_referral_qualify' and not t.tgisinternal) then
    raise exception 'something still calls tg_referral_qualify';
  end if;
  if (select prosrc from pg_proc where proname = 'tg_referral_qualify') ~* 'wallet_credit|referrals|insert' then
    raise exception 'tg_referral_qualify is not inert';
  end if;
  if (select prosrc from pg_proc where proname = 'apply_referral_code') ~* 'from public\.profiles|public\.referrals|insert' then
    raise exception 'apply_referral_code still reads or writes';
  end if;
  if (select count(*) from pg_proc where proname = 'ensure_referral_code' and prosrc !~ 'raise exception') <> 0 then
    raise exception 'ensure_referral_code can still mint';
  end if;
  if (select pg_get_functiondef('public.tg_profiles_lock_sensitive'::regproc)) !~ 'referral_code' then
    raise exception 'profiles lock does not cover referral_code';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    foreach a in array array['INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(r, 'public.referrals', a) then raise exception '% still has % on referrals', r, a; end if;
    end loop;
    if not has_table_privilege('authenticated', 'public.referrals', 'SELECT') then raise exception 'authenticated lost SELECT on referrals'; end if;
  end loop;
  foreach a in array array['INSERT', 'UPDATE', 'DELETE', 'SELECT'] loop
    if not has_table_privilege('service_role', 'public.referrals', a) then raise exception 'service_role lost % on referrals', a; end if;
  end loop;
end $$;

commit;
