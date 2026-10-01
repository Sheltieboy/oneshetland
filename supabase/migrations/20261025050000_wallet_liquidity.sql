-- Local Wallet liquidity architecture, 1 Oct 2026.
--
-- A real £5.00 Premium Wallet payment was correctly debited, correctly fee'd
-- (5p, the Premium rate), and then Stripe refused the £4.95 merchant transfer
-- with "Insufficient funds in Stripe account". The customer was automatically
-- and correctly refunded — the existing atomic reversal safety net worked
-- exactly as designed. The audit that followed found the real problem is
-- architectural, not a bug: a Wallet balance is presented as instantly
-- spendable with nothing checking, beforehand, whether OneShetland can
-- actually settle the resulting merchant transfer.
--
-- This adds:
--   1. Admin-configurable liquidity settings (reserve target, Low/Critical
--      coverage thresholds, an enabled flag).
--   2. A DB-backed reservation ledger so two concurrent Wallet spends cannot
--      each independently read the same "available" headroom and together
--      overdraw it — the check-and-reserve is one atomic, lock-serialised
--      operation, not two independent reads.
--   3. A tiny alert-state singleton so the scheduled liquidity monitor only
--      pages an admin on a status CHANGE, not on every tick while a
--      Low/Critical state persists.
--
-- Nothing here touches the customer's wallet balance model, the fee
-- calculation, or the existing debit/transfer/reversal mechanics. The
-- reservation ledger governs HEADROOM, not money — no pence of it is ever
-- itself moved by this migration.

insert into public.admin_config (key, value, description, category)
values
  ('wallet.liquidity.enabled', 'true',
   'Local Wallet liquidity protection — "true" runs a preflight check (Stripe available balance minus the reserve below) before every Wallet till payment, declining calmly before the customer is ever debited if headroom is insufficient. "false" disables the preflight and falls back to the original behaviour: debit, attempt the transfer, and rely on the automatic reversal if Stripe refuses it. Disabling this does not make anything unsafe — it only removes the early check.',
   'fees'),
  ('wallet.liquidity.reserve_pence', '10000',
   'Local Wallet liquidity — the amount, in pence, of the platform''s Stripe available balance that must NEVER be spent by a Wallet transfer, regardless of coverage. 10000 = £100.00. This is the floor the preflight check protects; it is not itself a target to hold liability under.',
   'fees'),
  ('wallet.liquidity.low_coverage_bps', '15000',
   'Local Wallet liquidity — below this coverage ratio (Stripe available balance ÷ total customer Wallet liability, in basis points; 15000 = 150%) the liquidity status is "Low" and an admin is alerted. Wallet payments remain usable wherever transaction-level headroom allows.',
   'fees'),
  ('wallet.liquidity.critical_coverage_bps', '10000',
   'Local Wallet liquidity — below this coverage ratio (basis points; 10000 = 100%, meaning available balance no longer covers total liability) the status is "Critical": an admin is alerted urgently and the preflight check will decline new Wallet spends wherever it finds insufficient headroom for that specific payment.',
   'fees')
on conflict (key) do update
  set value = excluded.value, description = excluded.description, category = excluded.category;

-- ── The reservation ledger ──────────────────────────────────────────────────
--
-- The race this closes: two concurrent £60 Wallet spends against £100 of
-- headroom. Read independently, BOTH see "£100 available, £60 needed — fine"
-- and both proceed, together needing £120 that was never there. A reservation
-- is held for the short window between "we decided this transfer fits" and
-- "Stripe has told us the outcome", computed and inserted inside a single
-- pg_advisory_xact_lock-serialised function call — never two independent
-- reads from two different requests.
--
-- A reservation older than 2 minutes is excluded from the held total, so a
-- function instance that crashed before releasing its own reservation cannot
-- permanently lock up headroom; nothing needs to clean it up.
create table if not exists public.local_wallet_liquidity_reservations (
  id             uuid primary key default gen_random_uuid(),
  amount_pence   integer not null check (amount_pence > 0),
  status         text not null default 'held' check (status in ('held', 'released')),
  created_at     timestamptz not null default now(),
  released_at    timestamptz
);

create index if not exists idx_wallet_liquidity_reservations_held
  on public.local_wallet_liquidity_reservations (status, created_at)
  where status = 'held';

alter table public.local_wallet_liquidity_reservations enable row level security;
-- No policies: nothing is granted to anon/authenticated, so RLS default-denies
-- everyone except service_role (which bypasses RLS) and the SECURITY DEFINER
-- functions below.

revoke all on public.local_wallet_liquidity_reservations from public, anon, authenticated;

create or replace function public.wallet_liquidity_reserve(
  p_amount_pence     integer,
  p_available_pence  integer,
  p_reserve_pence    integer
) returns table(ok boolean, reservation_id uuid, held_pence integer)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_held integer;
  v_id   uuid;
begin
  if p_amount_pence is null or p_amount_pence <= 0 then
    raise exception 'wallet_liquidity_reserve: amount must be positive' using errcode = '22023';
  end if;

  -- Serialises every concurrent caller through this one function body. Held
  -- for the transaction's duration and released automatically at COMMIT —
  -- nothing else to clean up.
  perform pg_advisory_xact_lock(hashtext('wallet_liquidity_reserve'));

  select coalesce(sum(amount_pence), 0) into v_held
    from public.local_wallet_liquidity_reservations
   where status = 'held'
     and created_at > now() - interval '2 minutes';

  if coalesce(p_available_pence, 0) - coalesce(p_reserve_pence, 0) - v_held >= p_amount_pence then
    insert into public.local_wallet_liquidity_reservations (amount_pence)
      values (p_amount_pence)
      returning id into v_id;
    return query select true, v_id, v_held;
  else
    return query select false, null::uuid, v_held;
  end if;
end;
$function$;

create or replace function public.wallet_liquidity_release(p_reservation_id uuid)
returns void
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  update public.local_wallet_liquidity_reservations
     set status = 'released', released_at = now()
   where id = p_reservation_id and status = 'held';
$function$;

revoke all on function public.wallet_liquidity_reserve(integer, integer, integer) from public, anon, authenticated;
revoke all on function public.wallet_liquidity_release(uuid) from public, anon, authenticated;
grant execute on function public.wallet_liquidity_reserve(integer, integer, integer) to service_role;
grant execute on function public.wallet_liquidity_release(uuid) to service_role;

-- ── Alert-state singleton, so the monitor pages on a status CHANGE only ────
create table if not exists public.local_wallet_liquidity_alert_state (
  id              boolean primary key default true check (id),  -- exactly one row, ever
  last_status     text,
  last_alerted_at timestamptz
);
insert into public.local_wallet_liquidity_alert_state (id) values (true) on conflict (id) do nothing;

revoke all on public.local_wallet_liquidity_alert_state from public, anon, authenticated;
alter table public.local_wallet_liquidity_alert_state enable row level security;

-- ── The scheduled monitor ────────────────────────────────────────────────
-- Every 15 minutes — money-safety-relevant, so more frequent than the nightly
-- reconcilers. cron.schedule with an existing job name replaces it, so
-- re-running this file never creates a second job.
select cron.schedule(
  'wallet-liquidity-monitor',
  '*/15 * * * *',
  $cron$
    select net.http_post(
      url := 'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/wallet-liquidity-monitor',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $cron$
);
