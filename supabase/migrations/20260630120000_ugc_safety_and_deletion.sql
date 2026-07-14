-- App-store UGC safety + account deletion support.
--   • content_reports — users flag objectionable content (Apple 1.2 / Google UGC)
--   • blocked_users   — users block abusive users; their content is hidden
--   • profiles.deleted_at — marks a soft-deleted (account-deletion) profile
-- All additive. is_admin() already exists.

-- ── Reports ────────────────────────────────────────────────────────────────
create table if not exists public.content_reports (
  id              uuid primary key default gen_random_uuid(),
  reporter_id     uuid not null references public.profiles(id) on delete cascade,
  content_type    text not null,   -- memory | memory_comment | memory_pin | vessel_comment | notice | profile | job | shift | hub_campaign | other
  content_id      uuid not null,
  reported_user_id uuid references public.profiles(id) on delete set null,  -- author, when known
  reason          text not null,   -- spam | harassment | hate | sexual | violence | illegal | self_harm | other
  details         text,
  status          text not null default 'open',  -- open | reviewing | actioned | dismissed
  created_at      timestamptz not null default now(),
  reviewed_by     uuid references public.profiles(id) on delete set null,
  reviewed_at     timestamptz
);
create index if not exists idx_content_reports_status on public.content_reports (status, created_at desc);
create index if not exists idx_content_reports_target on public.content_reports (content_type, content_id);

alter table public.content_reports enable row level security;

drop policy if exists "file own report" on public.content_reports;
create policy "file own report" on public.content_reports
  for insert to authenticated with check (reporter_id = auth.uid());

drop policy if exists "read own or admin reports" on public.content_reports;
create policy "read own or admin reports" on public.content_reports
  for select to authenticated using (reporter_id = auth.uid() or public.is_admin());

drop policy if exists "admins manage reports" on public.content_reports;
create policy "admins manage reports" on public.content_reports
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ── Blocks ─────────────────────────────────────────────────────────────────
create table if not exists public.blocked_users (
  blocker_id  uuid not null references public.profiles(id) on delete cascade,
  blocked_id  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocked_users_not_self check (blocker_id <> blocked_id)
);
create index if not exists idx_blocked_users_blocker on public.blocked_users (blocker_id);

alter table public.blocked_users enable row level security;

drop policy if exists "manage own blocks" on public.blocked_users;
create policy "manage own blocks" on public.blocked_users
  for all to authenticated
  using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

-- Helper: has either party blocked the other? (used for server-side filtering)
create or replace function public.is_blocked_pair(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.blocked_users
    where (blocker_id = a and blocked_id = b)
       or (blocker_id = b and blocked_id = a)
  );
$$;

-- ── Account deletion marker ──────────────────────────────────────────────────
alter table public.profiles add column if not exists deleted_at timestamptz;
