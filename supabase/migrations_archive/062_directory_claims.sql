-- 062_directory_claims.sql
-- Directory seeding + claim-a-business flow.
--
-- We seed the directory from a first-party CSV (117 Shetland businesses) as
-- *unclaimed* listings (owner_id NULL). A real owner then "claims" their
-- listing → admin verifies → owner_id is set, the listing becomes editable,
-- and they can upgrade to Pro/Premium. Admins can also grant a time-limited
-- discount that only becomes applicable a week after verification.

-- ── 1. Make owner_id nullable + add provenance/claim columns ──────────────────

alter table public.local_businesses
  alter column owner_id drop not null;

alter table public.local_businesses
  add column if not exists source        text    not null default 'owner'
    check (source in ('owner', 'csv', 'google', 'wordpress')),
  add column if not exists place_id       text,            -- Google place_id (stored indefinitely; allowed)
  add column if not exists is_claimed     boolean not null default true,
  add column if not exists claimed_at     timestamptz,
  add column if not exists verified_at    timestamptz;

-- Existing rows were all owner-created → keep them claimed.
update public.local_businesses
  set is_claimed = (owner_id is not null)
  where is_claimed is distinct from (owner_id is not null);

comment on column public.local_businesses.source is
  'How the listing entered the directory: owner (self-registered), csv/google/wordpress (seeded).';
comment on column public.local_businesses.place_id is
  'Google Places place_id — the only Places field we may store indefinitely. Used to refresh map coords / live hours.';
comment on column public.local_businesses.is_claimed is
  'FALSE for seeded stubs nobody owns yet. A verified claim flips this to TRUE and sets owner_id.';

create index if not exists idx_local_businesses_unclaimed
  on public.local_businesses (is_claimed) where is_claimed = false;

-- Seeded (unclaimed) listings must remain publicly readable even though
-- owner_id is NULL. The original SELECT policy used is_active=TRUE so this is
-- already covered, but make it explicit for clarity.
drop policy if exists "Anyone can read active businesses" on public.local_businesses;
create policy "Anyone can read active businesses"
  on public.local_businesses for select
  using (is_active = true or owner_id = auth.uid());

-- ── 2. Claim requests ─────────────────────────────────────────────────────────

create table if not exists public.business_claims (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.local_businesses(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected')),
  contact_name  text,
  contact_email text,
  contact_phone text,
  role          text,                 -- "Owner", "Manager", etc.
  evidence      text,                 -- free-text: how we can verify them
  admin_note    text,                 -- internal note on review
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz,
  reviewed_by   uuid references public.profiles(id) on delete set null
);

create index if not exists idx_business_claims_business on public.business_claims(business_id);
create index if not exists idx_business_claims_user     on public.business_claims(user_id);
create index if not exists idx_business_claims_pending  on public.business_claims(status) where status = 'pending';

-- One open claim per user per business.
create unique index if not exists uq_business_claims_open
  on public.business_claims (business_id, user_id) where status = 'pending';

alter table public.business_claims enable row level security;

create policy "Users manage their own claims"
  on public.business_claims for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Admins read all claims"
  on public.business_claims for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

create policy "Admins update claims"
  on public.business_claims for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ── 3. Admin discount grants ──────────────────────────────────────────────────
-- A 1-year discount on Pro/Premium that an admin grants after verification.
-- It only becomes *applicable* a week after the grant (applicable_from), and
-- expires a year later.

create table if not exists public.business_discount_grants (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.local_businesses(id) on delete cascade,
  tier            text not null check (tier in ('pro', 'premium')),
  percent_off     int  not null check (percent_off between 1 and 100),
  duration_months int  not null default 12,
  applicable_from timestamptz not null,   -- a week after grant
  expires_at      timestamptz not null,   -- applicable_from + 12 months
  status          text not null default 'active'
                    check (status in ('active', 'redeemed', 'expired', 'revoked')),
  stripe_coupon_id text,
  granted_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  redeemed_at     timestamptz
);

create index if not exists idx_discount_grants_business on public.business_discount_grants(business_id);

alter table public.business_discount_grants enable row level security;

-- Owners can see a discount waiting for their business (to upsell them).
create policy "Owners read their discount grants"
  on public.business_discount_grants for select
  using (business_id in (select id from public.local_businesses where owner_id = auth.uid()));

create policy "Admins manage discount grants"
  on public.business_discount_grants for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ── 4. Approve-claim RPC (SECURITY DEFINER) ───────────────────────────────────
-- Atomically: mark claim approved, assign owner, flip is_claimed, stamp verified.
-- Admin-only (checked inside).

create or replace function public.approve_business_claim(p_claim_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_claim    public.business_claims%rowtype;
begin
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
    into v_is_admin;
  if not v_is_admin then
    raise exception 'Only admins can approve claims';
  end if;

  select * into v_claim from public.business_claims where id = p_claim_id for update;
  if not found then raise exception 'Claim not found'; end if;
  if v_claim.status <> 'pending' then raise exception 'Claim already %', v_claim.status; end if;

  update public.business_claims
    set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid()
    where id = p_claim_id;

  update public.local_businesses
    set owner_id    = v_claim.user_id,
        is_claimed  = true,
        is_verified = true,
        claimed_at  = now(),
        verified_at = now()
    where id = v_claim.business_id;

  -- Reject any other pending claims on the same business.
  update public.business_claims
    set status = 'rejected', reviewed_at = now(), reviewed_by = auth.uid(),
        admin_note = coalesce(admin_note, '') || ' [auto-rejected: another claim approved]'
    where business_id = v_claim.business_id and status = 'pending' and id <> p_claim_id;
end;
$$;

grant execute on function public.approve_business_claim(uuid) to authenticated;
