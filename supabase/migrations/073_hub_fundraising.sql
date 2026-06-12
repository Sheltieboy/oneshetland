-- 073_hub_fundraising.sql
-- Hub fundraising: campaigns + donations (destination-charged to the hub), with
-- Gift Aid declaration capture for charity hubs.

-- ── 1. Charity flags (gate Gift Aid) ──────────────────────────────────────────
alter table public.hubs
  add column if not exists is_charity     boolean not null default false,
  add column if not exists charity_number text;

-- ── 2. Campaigns ──────────────────────────────────────────────────────────────
create table if not exists public.hub_campaigns (
  id           uuid primary key default gen_random_uuid(),
  hub_id       uuid not null references public.hubs(id) on delete cascade,
  title        text not null check (length(trim(title)) between 1 and 160),
  story        text,
  goal_pence   int  not null check (goal_pence > 0),
  raised_pence int  not null default 0,   -- denormalised running total
  donor_count  int  not null default 0,
  cover_url    text,
  status       text not null default 'active' check (status in ('active','closed')),
  ends_at      timestamptz,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_hub_campaigns_hub on public.hub_campaigns(hub_id);

alter table public.hub_campaigns enable row level security;

create policy "hub_campaigns read"   on public.hub_campaigns for select using (true);
create policy "hub_campaigns manage" on public.hub_campaigns for all
  using (public.is_hub_admin(hub_id, auth.uid()))
  with check (public.is_hub_admin(hub_id, auth.uid()));

-- ── 3. Donations (incl. Gift Aid declaration) ─────────────────────────────────
create table if not exists public.hub_donations (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references public.hub_campaigns(id) on delete cascade,
  hub_id        uuid not null references public.hubs(id) on delete cascade,
  donor_user_id uuid references public.profiles(id) on delete set null,
  amount_pence  int  not null check (amount_pence > 0),
  fee_pence     int  not null default 0,
  message       text,
  is_anonymous  boolean not null default false,
  stripe_payment_intent_id text unique,
  -- Gift Aid declaration (only when the donor opts in at a charity hub)
  gift_aid      boolean not null default false,
  ga_title      text,
  ga_first_name text,
  ga_last_name  text,
  ga_address    text,
  ga_postcode   text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_hub_donations_campaign on public.hub_donations(campaign_id);
create index if not exists idx_hub_donations_giftaid   on public.hub_donations(hub_id) where gift_aid;

alter table public.hub_donations enable row level security;

-- No client INSERT policy → only the service-role edge function records donations.
-- Donor can see their own; hub admins see all for their hub (for export + Gift Aid).
create policy "hub_donations read" on public.hub_donations for select
  using (donor_user_id = auth.uid() or public.is_hub_admin(hub_id, auth.uid()));

-- ── 4. Record-donation RPC (service role; atomic, idempotent on PI) ────────────
create or replace function public.record_hub_donation(
  p_campaign uuid, p_hub uuid, p_user uuid, p_amount int, p_fee int,
  p_message text, p_anon boolean, p_pi text,
  p_gift_aid boolean, p_title text, p_first text, p_last text, p_address text, p_postcode text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.hub_donations (
    campaign_id, hub_id, donor_user_id, amount_pence, fee_pence, message, is_anonymous,
    stripe_payment_intent_id, gift_aid, ga_title, ga_first_name, ga_last_name, ga_address, ga_postcode
  ) values (
    p_campaign, p_hub, p_user, p_amount, p_fee, p_message, coalesce(p_anon, false),
    p_pi, coalesce(p_gift_aid, false), p_title, p_first, p_last, p_address, p_postcode
  )
  on conflict (stripe_payment_intent_id) do nothing;

  if found then
    update public.hub_campaigns
       set raised_pence = raised_pence + p_amount,
           donor_count  = donor_count + 1
     where id = p_campaign;
  end if;
end;
$$;
grant execute on function public.record_hub_donation(uuid,uuid,uuid,int,int,text,boolean,text,boolean,text,text,text,text,text) to service_role;

-- ── 5. Public donor wall (safe fields only; never exposes Gift Aid address) ────
create or replace function public.get_campaign_donors(p_campaign uuid)
returns table(name text, amount_pence int, message text, created_at timestamptz)
language sql security definer set search_path = public as $$
  select case when d.is_anonymous then 'Anonymous'
              else coalesce(p.display_name, p.full_name, 'Supporter') end,
         d.amount_pence, d.message, d.created_at
  from public.hub_donations d
  left join public.profiles p on p.id = d.donor_user_id
  where d.campaign_id = p_campaign
  order by d.created_at desc
  limit 50;
$$;
grant execute on function public.get_campaign_donors(uuid) to authenticated, anon;

-- ── 6. Fee config (default 0 — no platform cut on charitable donations) ────────
insert into public.admin_config (key, value, description, category)
values ('fees.hub_donation.flat_pence', '0', 'Flat platform fee per hub donation (pence)', 'fees')
on conflict (key) do nothing;
