-- ============================================================================
-- Loyalty: staff-verified redemption backbone + server-side instrumentation
--
-- Replaces the honour-system "customer taps redeemed" model with a two-party
-- flow: the customer starts a redemption (offer / stamp reward / pass / points)
-- and gets a short code + QR token; staff verify it on the business side, which
-- applies the effect and records who/when. One mechanism for every redeemable
-- thing — and it finally makes PASSES usable at the till.
--
-- Also wires stamp issuance + offer/reward redemptions into the analytics spine
-- at the DATABASE level (triggers), so platform-wide loyalty numbers are
-- reliable and consistent across app + web (client track() was app-only and
-- missed stamps entirely).
-- ============================================================================

create table if not exists public.local_redemptions (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.local_businesses(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('offer','reward','pass','points')),
  ref_id       uuid,                                    -- offer_id | card_id | purchase_id
  code         text not null,                           -- short human code shown to staff
  token        uuid not null default gen_random_uuid(), -- QR payload (scan alternative)
  status       text not null default 'pending' check (status in ('pending','consumed','expired','cancelled')),
  detail       jsonb not null default '{}',             -- {title, subtitle} snapshot for display
  amount       integer,                                  -- points to spend (kind='points'), else null
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  consumed_by  uuid                                      -- staff/owner who verified
);

-- Staff look up a pending redemption by its code within their business.
create index if not exists local_redemptions_verify_idx
  on public.local_redemptions (business_id, code) where status = 'pending';
create index if not exists local_redemptions_user_idx
  on public.local_redemptions (user_id, created_at desc);

alter table public.local_redemptions enable row level security;

-- The customer sees their own redemptions (to show the code/QR); the business
-- owner sees redemptions for their business (to verify). All writes go through
-- the edge functions (service role) — no client insert/update policies.
drop policy if exists "own redemptions" on public.local_redemptions;
create policy "own redemptions" on public.local_redemptions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "business sees its redemptions" on public.local_redemptions;
create policy "business sees its redemptions" on public.local_redemptions
  for select to authenticated
  using (business_id in (select id from public.local_businesses where owner_id = auth.uid()));

-- ── Analytics instrumentation (server-trusted, app+web consistent) ───────────
-- Mirrors the money-ledger triggers: fire straight off the ledger rows so the
-- platform pipeline can't miss a stamp or double-count. Uses the shared
-- analytics_emit() SECURITY DEFINER helper.

create or replace function public.tg_ae_loyalty_txn() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'stamp' then
    perform public.analytics_emit('loyalty_stamp_collected', new.user_id, new.business_id, null, null,
      'business', new.business_id::text, '{}'::jsonb);
  elsif new.type in ('reward','redeem') then
    perform public.analytics_emit('loyalty_reward_redeemed', new.user_id, new.business_id, null, null,
      'business', new.business_id::text, '{}'::jsonb);
  elsif new.type = 'points_earn' then
    perform public.analytics_emit('loyalty_points_earned', new.user_id, new.business_id, null, null,
      'business', new.business_id::text, jsonb_build_object('amount', new.amount));
  end if;
  return new;
end $$;
drop trigger if exists ae_loyalty_txn on public.local_loyalty_transactions;
create trigger ae_loyalty_txn after insert on public.local_loyalty_transactions
  for each row execute function public.tg_ae_loyalty_txn();

create or replace function public.tg_ae_offer_redemption() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_biz uuid;
begin
  select business_id into v_biz from public.local_offers where id = new.offer_id;
  perform public.analytics_emit('offer_redeemed', new.user_id, v_biz, null, null,
    'offer', new.offer_id::text, '{}'::jsonb);
  return new;
end $$;
drop trigger if exists ae_offer_redemption on public.local_offer_redemptions;
create trigger ae_offer_redemption after insert on public.local_offer_redemptions
  for each row execute function public.tg_ae_offer_redemption();
