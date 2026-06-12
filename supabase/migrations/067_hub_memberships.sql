-- 067_hub_memberships.sql
-- Hub paid memberships — foundation (slice 1).
--
-- Adds: membership types/tiers per hub, paid-membership fields on hub_members
-- (expiry, member number, payment reference), the hub's own Stripe Connect
-- account fields (destination charges route membership money straight to the
-- org — the platform never holds it), and the flat platform-fee config.
--
-- Free membership is unaffected: a hub with no paid types behaves exactly as
-- before. Paid membership is gated behind the hub completing Stripe onboarding
-- (payout_enabled), enforced in the edge function (slice 2).

-- ── 1. Hub: Stripe Connect + membership opt-in ────────────────────────────────

alter table public.hubs
  add column if not exists stripe_account_id   text,
  add column if not exists payout_enabled      boolean not null default false,
  add column if not exists memberships_enabled boolean not null default false;

comment on column public.hubs.stripe_account_id is
  'Hub''s own Stripe Connect (Express) account. Membership payments are destination-charged here; the platform keeps only the application fee.';
comment on column public.hubs.payout_enabled is
  'TRUE once the hub''s connected account can receive payouts. Required before any paid membership can be sold.';

-- ── 2. Membership types / tiers ───────────────────────────────────────────────

create table if not exists public.hub_membership_types (
  id          uuid primary key default gen_random_uuid(),
  hub_id      uuid not null references public.hubs(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 80),  -- "Adult", "Junior", "Family"
  description text,
  price_pence int  not null default 0 check (price_pence >= 0),           -- 0 = free tier
  -- How long a membership of this type lasts once paid for:
  period      text not null default 'year' check (period in ('once','month','year')),
  benefits    text,                 -- free text for now (could become jsonb later)
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists idx_hub_membership_types_hub
  on public.hub_membership_types(hub_id) where is_active;

alter table public.hub_membership_types enable row level security;

-- Anyone can see active membership types of an active hub (to view prices).
create policy "hub_membership_types read" on public.hub_membership_types for select
  using (
    is_active
    or public.is_hub_admin(hub_id, auth.uid())
  );

-- Only hub owner/committee manage their types.
create policy "hub_membership_types manage" on public.hub_membership_types for all
  using (public.is_hub_admin(hub_id, auth.uid()))
  with check (public.is_hub_admin(hub_id, auth.uid()));

-- ── 3. hub_members: membership type, expiry, number, payment ──────────────────

alter table public.hub_members
  add column if not exists membership_type_id      uuid references public.hub_membership_types(id) on delete set null,
  add column if not exists member_no               text,
  add column if not exists paid_until              timestamptz,   -- NULL = free / no expiry
  add column if not exists last_payment_pence      int,
  add column if not exists stripe_payment_intent_id text;

comment on column public.hub_members.paid_until is
  'Membership valid until this date (paid memberships). NULL for free memberships, which do not expire.';
comment on column public.hub_members.member_no is
  'Human-readable membership number, assigned when membership becomes active.';

-- Helper: is a membership currently valid? (free = always; paid = not expired)
create or replace function public.hub_membership_active(p_status text, p_paid_until timestamptz)
returns boolean language sql immutable as $$
  select p_status = 'active' and (p_paid_until is null or p_paid_until > now());
$$;

-- ── 4. Platform fee config ────────────────────────────────────────────────────
-- Flat fee (pence) added per paid-membership payment. Set to 0 to waive
-- (e.g. for charities). Mirrors the event-ticket booking fee.

insert into public.admin_config (key, value, description, category)
values ('fees.hub_membership.flat_pence', '50', 'Flat platform fee per paid hub membership (pence)', 'fees')
on conflict (key) do nothing;
