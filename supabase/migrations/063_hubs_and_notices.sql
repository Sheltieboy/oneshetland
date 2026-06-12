-- 063_hubs_and_notices.sql
-- OneShetland Hubs (Phase 1) + noticeboard wiring.
--
-- Hubs give non-commercial community organisations (clubs, halls, sports
-- clubs, charities, societies, volunteer groups) their own branded mini-site
-- and member area — distinct from commercial Businesses, with none of the
-- tier/Stripe/loyalty machinery. This migration adds:
--   • hubs                — the organisation + its public page
--   • hub_members         — membership + roles (member / committee / owner)
--   • notices extension   — hub publisher + visibility (public / members / committee)
-- Helper functions keep membership checks out of the policies (no RLS recursion).

-- ── 1. Hubs ───────────────────────────────────────────────────────────────────

create table if not exists public.hubs (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references public.profiles(id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 120),
  slug          text unique,
  type          text not null default 'community'
                  check (type in ('club','sports','youth','hall','charity','society','volunteer','arts','community','other')),
  description   text,
  logo_url      text,
  cover_url     text,
  brand_color   text,
  contact_email text,
  contact_phone text,
  website       text,
  area          text,                 -- locality slug ("lerwick", "burra", "all-shetland")
  join_mode     text not null default 'approval' check (join_mode in ('open','approval')),
  is_active     boolean not null default true,
  is_verified   boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists idx_hubs_active on public.hubs(is_active) where is_active;
create index if not exists idx_hubs_type   on public.hubs(type)      where is_active;

-- ── 2. Hub members ────────────────────────────────────────────────────────────

create table if not exists public.hub_members (
  id        uuid primary key default gen_random_uuid(),
  hub_id    uuid not null references public.hubs(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  role      text not null default 'member'  check (role   in ('member','committee','owner')),
  status    text not null default 'active'  check (status in ('pending','active','rejected','left')),
  joined_at timestamptz not null default now(),
  unique (hub_id, user_id)
);

create index if not exists idx_hub_members_hub  on public.hub_members(hub_id)  where status = 'active';
create index if not exists idx_hub_members_user on public.hub_members(user_id) where status = 'active';
create index if not exists idx_hub_members_pending on public.hub_members(hub_id) where status = 'pending';

-- ── 3. Membership helper functions (SECURITY DEFINER → no policy recursion) ────

create or replace function public.is_hub_member(p_hub uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.hub_members
    where hub_id = p_hub and user_id = p_user and status = 'active'
  );
$$;

create or replace function public.is_hub_admin(p_hub uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.hub_members
    where hub_id = p_hub and user_id = p_user and status = 'active'
      and role in ('owner','committee')
  );
$$;

grant execute on function public.is_hub_member(uuid, uuid) to authenticated, anon;
grant execute on function public.is_hub_admin(uuid, uuid)  to authenticated, anon;

-- ── 4. Triggers: owner membership on create, join status from join_mode ────────

create or replace function public.tg_hub_owner_membership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.hub_members (hub_id, user_id, role, status)
  values (new.id, new.owner_id, 'owner', 'active')
  on conflict (hub_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_hub_owner_membership on public.hubs;
create trigger trg_hub_owner_membership
  after insert on public.hubs
  for each row execute function public.tg_hub_owner_membership();

-- A join request's status is decided by the hub's join_mode, never the client.
create or replace function public.tg_hub_member_join_status()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_mode text;
begin
  if new.role = 'member' then
    select join_mode into v_mode from public.hubs where id = new.hub_id;
    new.status := case when v_mode = 'open' then 'active' else 'pending' end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hub_member_join_status on public.hub_members;
create trigger trg_hub_member_join_status
  before insert on public.hub_members
  for each row execute function public.tg_hub_member_join_status();

-- ── 5. RLS: hubs ──────────────────────────────────────────────────────────────

alter table public.hubs enable row level security;

create policy "hubs read"   on public.hubs for select
  using (is_active = true or owner_id = auth.uid());

create policy "hubs insert" on public.hubs for insert
  with check (owner_id = auth.uid());

create policy "hubs update" on public.hubs for update
  using (owner_id = auth.uid() or public.is_hub_admin(id, auth.uid()));

create policy "hubs delete" on public.hubs for delete
  using (owner_id = auth.uid());

-- ── 6. RLS: hub_members ───────────────────────────────────────────────────────

alter table public.hub_members enable row level security;

-- See your own membership rows; hub admins see all rows for their hub.
create policy "hub_members read" on public.hub_members for select
  using (user_id = auth.uid() or public.is_hub_admin(hub_id, auth.uid()));

-- Request to join (your own row, as a plain member — status set by trigger).
create policy "hub_members join" on public.hub_members for insert
  with check (user_id = auth.uid() and role = 'member');

-- Admins manage members (approve, promote); members can update their own row (leave).
create policy "hub_members update" on public.hub_members for update
  using (public.is_hub_admin(hub_id, auth.uid()) or user_id = auth.uid());

create policy "hub_members delete" on public.hub_members for delete
  using (public.is_hub_admin(hub_id, auth.uid()) or user_id = auth.uid());

-- ── 7. Notices: hub publisher + visibility ────────────────────────────────────

-- Ensure the base notices table exists (migration 045 may not have been applied
-- to every environment). Idempotent — does nothing if it's already there.
create table if not exists public.notices (
  id              uuid primary key default gen_random_uuid(),
  publisher_business_id uuid references public.local_businesses(id) on delete set null,
  publisher_user_id     uuid references public.profiles(id)         on delete set null,
  severity        text not null default 'community'
                    check (severity in ('urgent','community','info')),
  title           text not null check (length(trim(title)) between 1 and 200),
  body            text,
  locality        text,
  lat             numeric(9,6),
  lng             numeric(9,6),
  is_pinned       boolean not null default false,
  is_hidden       boolean not null default false,
  expires_at      timestamptz,
  published_at    timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists idx_notices_published on public.notices(published_at desc) where not is_hidden;
create index if not exists idx_notices_pinned    on public.notices(is_pinned) where is_pinned and not is_hidden;

alter table public.notices enable row level security;

-- The notices insert policy references local_businesses.can_publish_urgent;
-- make sure that column exists too (also normally added by an earlier migration).
alter table public.local_businesses
  add column if not exists can_publish_urgent boolean not null default false;

alter table public.notices
  add column if not exists publisher_hub_id uuid references public.hubs(id) on delete cascade,
  add column if not exists visibility text not null default 'public'
      check (visibility in ('public','members','committee')),
  add column if not exists image_url text,
  add column if not exists category  text;

create index if not exists idx_notices_hub on public.notices(publisher_hub_id) where not is_hidden;

-- Rebuild the read policy so members-only / committee-only hub notices are gated.
drop policy if exists "notices read" on public.notices;
create policy "notices read" on public.notices for select
  using (
    (
      not is_hidden
      and (expires_at is null or expires_at > now())
      and (
        visibility = 'public'
        or (visibility = 'members'   and public.is_hub_member(publisher_hub_id, auth.uid()))
        or (visibility = 'committee' and public.is_hub_admin(publisher_hub_id, auth.uid()))
      )
    )
    or exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.role in ('admin','moderator'))
  );

-- Allow hub committee/owner to post for their hub (alongside the existing
-- business/user/admin publisher paths).
drop policy if exists "notices insert" on public.notices;
create policy "notices insert" on public.notices for insert
  with check (
    auth.uid() is not null
    and (
      severity <> 'urgent'
      or exists (select 1 from public.local_businesses b
                  where b.id = publisher_business_id and b.owner_id = auth.uid()
                    and b.can_publish_urgent = true)
      or exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.role in ('admin','moderator'))
    )
    and (
      publisher_user_id = auth.uid()
      or exists (select 1 from public.local_businesses b
                  where b.id = publisher_business_id and b.owner_id = auth.uid())
      or public.is_hub_admin(publisher_hub_id, auth.uid())
      or exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.role in ('admin','moderator'))
    )
  );

drop policy if exists "notices update" on public.notices;
create policy "notices update" on public.notices for update
  using (
    publisher_user_id = auth.uid()
    or exists (select 1 from public.local_businesses b
                where b.id = publisher_business_id and b.owner_id = auth.uid())
    or public.is_hub_admin(publisher_hub_id, auth.uid())
    or exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.role in ('admin','moderator'))
  );

drop policy if exists "notices delete" on public.notices;
create policy "notices delete" on public.notices for delete
  using (
    publisher_user_id = auth.uid()
    or exists (select 1 from public.local_businesses b
                where b.id = publisher_business_id and b.owner_id = auth.uid())
    or public.is_hub_admin(publisher_hub_id, auth.uid())
    or exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.role = 'admin')
  );
