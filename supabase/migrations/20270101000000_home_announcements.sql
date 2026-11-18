-- Home announcements: the admin-managed "Latest from OneShetland" section of the homepage.
--
-- ONE new table, ADDITIVE ONLY. Nothing existing is altered.
--   * Anyone (signed out or in) can read ONLY rows that are live right now: published, started, not expired.
--     Drafts, withdrawn and scheduled-but-not-started rows are invisible to the public.
--   * Only an administrator (public.is_admin()) can read everything or write.
--   * Links are checked in the database: a site path ("/x", never "//x") or an https address; no spaces, quotes, angle brackets or backslashes.
--   * Order is `sort_order` (lowest first); the first live row is the featured story. admin_home_announcements_reorder() sets the order atomically.
-- Policy shape follows home_content (20260629140000): the admin policy is TO authenticated, so anonymous reads never evaluate is_admin() (see the
-- 42501 trap in the signed-out public surface notes).

create table if not exists public.home_announcements (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('new', 'know')),
  title       text not null check (char_length(btrim(title)) between 1 and 60),
  body        text not null default '' check (char_length(body) <= 200),
  cta_label   text not null check (char_length(btrim(cta_label)) between 1 and 24),
  href        text not null check (href ~ '^/([^/[:space:]\\<>"''][^[:space:]\\<>"'']*)?$' or href ~ '^https://[^[:space:]\\<>"'']+$'),
  visual      text not null default 'photo' check (visual in ('photo', 'save', 'activities', 'jobs', 'claim')),
  image_url   text check (image_url is null or image_url ~ '^/[^/[:space:]\\<>"''][^[:space:]\\<>"'']*$' or image_url ~ '^https://[^[:space:]\\<>"'']+$'),
  status      text not null default 'draft' check (status in ('draft', 'published', 'withdrawn')),
  starts_at   timestamptz,
  ends_at     timestamptz,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) on delete set null,
  constraint home_announcements_window check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create index if not exists home_announcements_live_idx on public.home_announcements (sort_order, created_at desc) where status = 'published';

alter table public.home_announcements enable row level security;

drop policy if exists "home_announcements public read live" on public.home_announcements;
create policy "home_announcements public read live" on public.home_announcements
  for select to anon, authenticated
  using (status = 'published' and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));

drop policy if exists "home_announcements admin all" on public.home_announcements;
create policy "home_announcements admin all" on public.home_announcements
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

revoke all on public.home_announcements from anon, authenticated;
grant select on public.home_announcements to anon, authenticated;
grant insert, update, delete on public.home_announcements to authenticated;

create or replace function public.home_announcements_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists home_announcements_touch on public.home_announcements;
create trigger home_announcements_touch before update on public.home_announcements
  for each row execute function public.home_announcements_touch();

-- Atomic reorder. SECURITY INVOKER: the caller's own row-level security applies, so a non-admin changes nothing and is told so.
create or replace function public.admin_home_announcements_reorder(p_ids uuid[])
returns integer language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  update public.home_announcements a
     set sort_order = o.ord::integer
    from unnest(p_ids) with ordinality as o(id, ord)
   where a.id = o.id;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.admin_home_announcements_reorder(uuid[]) from public, anon;
grant execute on function public.admin_home_announcements_reorder(uuid[]) to authenticated;
