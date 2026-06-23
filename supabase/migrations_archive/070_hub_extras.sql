-- 070_hub_extras.sql
-- Member-only extras: member directory + documents.

-- ── 1. Member directory ───────────────────────────────────────────────────────
-- Opt-in per hub (off by default — important for youth/sensitive groups).

alter table public.hubs
  add column if not exists directory_enabled boolean not null default false;

-- Privacy-safe directory: returns only display name + role + tier to ACTIVE
-- members (admins always allowed). SECURITY DEFINER so it can read names without
-- widening profiles RLS, but it deliberately exposes NO contact details.
create or replace function public.get_hub_directory(p_hub uuid)
returns table(user_id uuid, name text, role text, tier text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.is_hub_member(p_hub, auth.uid()) or public.is_hub_admin(p_hub, auth.uid())) then
    raise exception 'Members only';
  end if;
  if not exists (
    select 1 from public.hubs
    where id = p_hub and (directory_enabled or public.is_hub_admin(p_hub, auth.uid()))
  ) then
    raise exception 'Directory not enabled';
  end if;

  return query
    select m.user_id,
           coalesce(p.display_name, p.full_name, 'Member') as name,
           m.role,
           coalesce(t.name, '') as tier
    from public.hub_members m
    join public.profiles p on p.id = m.user_id
    left join public.hub_membership_types t on t.id = m.membership_type_id
    where m.hub_id = p_hub
      and m.status = 'active'
      and (m.paid_until is null or m.paid_until > now())
    order by m.role, name;
end;
$$;

grant execute on function public.get_hub_directory(uuid) to authenticated;

-- ── 2. Documents ──────────────────────────────────────────────────────────────
-- Link-based (a title + a URL the hub already hosts, e.g. a PDF on Drive). Avoids
-- file-storage infra; native upload can be added later. Visibility gates who can
-- see the link in the app.

create table if not exists public.hub_documents (
  id          uuid primary key default gen_random_uuid(),
  hub_id      uuid not null references public.hubs(id) on delete cascade,
  title       text not null check (length(trim(title)) between 1 and 160),
  url         text not null,
  visibility  text not null default 'members' check (visibility in ('public','members','committee')),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_hub_documents_hub on public.hub_documents(hub_id);

alter table public.hub_documents enable row level security;

create policy "hub_documents read" on public.hub_documents for select
  using (
    visibility = 'public'
    or (visibility = 'members'   and public.is_hub_member(hub_id, auth.uid()))
    or (visibility = 'committee' and public.is_hub_admin(hub_id, auth.uid()))
  );

create policy "hub_documents manage" on public.hub_documents for all
  using (public.is_hub_admin(hub_id, auth.uid()))
  with check (public.is_hub_admin(hub_id, auth.uid()));
