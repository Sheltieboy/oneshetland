-- ═══════════════════════════════════════════════════════════════════════════
-- Taking Wallet payments is Pro; the money in a customer's wallet is theirs
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Fourth and last of the paid capabilities. Wallet is 'pro' on both clients and
-- was enforced by a redirect on the web and a section the app declined to draw.
--
-- ── The line this one has to get right ─────────────────────────────────────
--
-- local_wallet_balances is keyed on user_id alone. A customer's balance is
-- platform-wide and no business owns any part of it, and cashback becomes
-- ordinary balance the instant it is credited — `balance - spend + cashback`,
-- one statement. So a subscription lapsing cannot reach customer money, and
-- nothing here goes anywhere near it: no guard on balances, on top-ups, on
-- refunds, or on the ledger. A test asserts that census stays empty.
--
-- What stops is a business RECEIVING a new Wallet payment.
--
-- ── Two places, not five ───────────────────────────────────────────────────
--
-- ACTIVATION   accepts_wallet false → true needs current Pro.
--
-- PAYMENT      _shared/wallet-pay.ts, which both routes converge on — the tap
--              and the scan-to-charge. Counter, Till and NFC are interfaces
--              onto that one executor, so they inherit the boundary rather
--              than each needing their own.
--
-- The stored flag is deliberately NOT auto-flipped when a plan expires. It is
-- the owner's configuration and their intent; it simply stops being effective,
-- and works again on renewal without anybody having to remember to switch it
-- back on. Nothing in the subscription lifecycle is touched.
--
-- ── Cashback is deliberately NOT tier-gated ────────────────────────────────
--
-- Configuring cashback_percent needs no plan. The Business 2.0 model is set up
-- first, pay to go live, and cashback is setup: it can only ever be earned
-- inside a Wallet payment, which the executor now refuses. So a Free business
-- may keep its rate configured — W3I still requires terms for that write, both
-- directions — and it earns nobody anything until Wallet is live again.
create or replace function public.local_businesses_wallet_tier_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if new.accepts_wallet is not distinct from old.accepts_wallet then
    return new;                       -- ordinary edit, including cashback_percent
  end if;

  if new.accepts_wallet is not true then
    return new;                       -- turning it OFF is always allowed
  end if;

  if v_uid is null then
    return new;                       -- service role, webhooks, scheduled jobs
  end if;

  if exists (
    select 1 from public.profiles p
     where p.id = v_uid and p.role = any (array['admin'::text, 'moderator'::text])
  ) then
    return new;                       -- platform staff, deliberately
  end if;

  if not public.business_meets_tier(new.id, 'pro') then
    raise exception 'Taking Wallet payments needs a Pro plan. Your settings are saved — switch Wallet on once your plan is active.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.local_businesses_wallet_tier_guard() is
  'Turning accepts_wallet on requires effective Pro. Turning it off requires nothing, an update that does not touch the flag is never examined, and cashback_percent is deliberately not gated — cashback can only be earned inside a Wallet payment, which the shared executor refuses without Pro. Terms remain W3I''s job.';

drop trigger if exists local_businesses_wallet_tier_guard on public.local_businesses;
create trigger local_businesses_wallet_tier_guard
  before update on public.local_businesses
  for each row execute function public.local_businesses_wallet_tier_guard();

-- ── Presentation ───────────────────────────────────────────────────────────
--
-- Three customer surfaces advertise Wallet — the web listing, the app's
-- business detail and the app's browse list — and they disagreed: two gated on
-- the CONFIGURED tier and the browse list on nothing at all. Rather than teach
-- three clients the expiry rule (and let them drift from the server's), the
-- answer is computed once, here, beside the flag they already read.
--
-- A generated column cannot call a non-immutable function, and a view would
-- mean rewriting every loader. A plain column kept by the same trigger family
-- would go stale the moment a subscription expired with nobody writing the row.
-- So it is a function the loaders select — one definition, the same predicate
-- the executor enforces with, and no way for a client to hold a different rule.
-- A COMPUTED COLUMN, deliberately. Taking the row type rather than an id means
-- PostgREST exposes it as a selectable field: a loader adds `wallet_live` to
-- its select and Postgres evaluates it per row inside the same query. The
-- browse list can carry a hundred businesses, and a function keyed on an id
-- would have made that a hundred round trips.
create or replace function public.wallet_live(b public.local_businesses)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select b.accepts_wallet
     and b.is_active
     and public.business_meets_tier(b.id, 'pro');
$$;

comment on function public.wallet_live(public.local_businesses) is
  'Computed column: whether a customer may currently be told this business takes Wallet — the flag is on, the business is active, and it currently meets Pro. Selected as `wallet_live` by every customer-facing loader, so no client holds its own copy of the expiry rule and none of them can drift from what the payment executor enforces.';

revoke execute on function public.wallet_live(public.local_businesses) from public;
grant  execute on function public.wallet_live(public.local_businesses) to anon, authenticated, service_role;
