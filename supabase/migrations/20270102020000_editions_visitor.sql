-- OneShetland Editions R3: visitor features. Save an Edition, build a personal plan (sessions and approved events), analytics definitions.
--
-- Deliberately ADDITIVE and separate from the live My Saved tables (saved_items and its twelve functions are in production and shared with the
-- mobile app, so their CHECKs and bodies are not widened here). Own-row only, flag-gated (editions.enabled), capped, public-only, and removed
-- with the account (ON DELETE CASCADE from auth.users, so delete-account needs no change).

create table if not exists public.edition_saves (
  user_id    uuid not null references auth.users (id) on delete cascade,
  edition_id uuid not null references public.editions (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, edition_id)
);
create index if not exists edition_saves_edition_idx on public.edition_saves (edition_id);

create table if not exists public.edition_plan_items (
  user_id    uuid not null references auth.users (id) on delete cascade,
  edition_id uuid not null references public.editions (id) on delete cascade,
  kind       text not null check (kind in ('session', 'event')),
  session_id uuid references public.edition_sessions (id) on delete cascade,
  event_id   uuid references public.events (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint edition_plan_one_item check ((kind = 'session' and session_id is not null and event_id is null) or (kind = 'event' and event_id is not null and session_id is null))
);
create unique index if not exists edition_plan_session_uq on public.edition_plan_items (user_id, session_id) where session_id is not null;
create unique index if not exists edition_plan_event_uq on public.edition_plan_items (user_id, edition_id, event_id) where event_id is not null;
create index if not exists edition_plan_edition_idx on public.edition_plan_items (edition_id);

alter table public.edition_saves enable row level security;
alter table public.edition_plan_items enable row level security;
revoke all on public.edition_saves, public.edition_plan_items from public, anon, authenticated;
create policy "edition_saves own read" on public.edition_saves for select to authenticated using (user_id = auth.uid());
create policy "edition_plan own read" on public.edition_plan_items for select to authenticated using (user_id = auth.uid());
grant select on public.edition_saves, public.edition_plan_items to authenticated;

-- Everything a visitor may save must be public right now (flag on, published, entitled, verified, not test).
create or replace function public.edition_save(p_edition uuid, p_on boolean default true) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if not p_on then delete from public.edition_saves where user_id = auth.uid() and edition_id = p_edition; return false; end if;
  if not public.edition_is_public(p_edition) then raise exception 'edition not found' using errcode = 'P0002'; end if;
  if (select count(*) from public.edition_saves where user_id = auth.uid()) >= 200 then raise exception 'you have saved the most Editions allowed' using errcode = '23514'; end if;
  insert into public.edition_saves (user_id, edition_id) values (auth.uid(), p_edition) on conflict do nothing;
  return true;
end $$;

create or replace function public.edition_plan_toggle(p_edition uuid, p_kind text, p_item uuid, p_on boolean default true) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if p_kind not in ('session', 'event') then raise exception 'unknown kind' using errcode = '22023'; end if;
  if not p_on then
    delete from public.edition_plan_items where user_id = auth.uid() and edition_id = p_edition
      and ((p_kind = 'session' and session_id = p_item) or (p_kind = 'event' and event_id = p_item));
    return false;
  end if;
  if not public.edition_is_public(p_edition) then raise exception 'edition not found' using errcode = 'P0002'; end if;
  if p_kind = 'session' then
    if not exists (select 1 from public.edition_sessions s where s.id = p_item and s.edition_id = p_edition) then raise exception 'item not found' using errcode = 'P0002'; end if;
  else
    -- only an event the owner has agreed to show in this Edition, and that the public can see
    if not exists (select 1 from public.edition_links l join public.events e on e.id = l.event_id
                    where l.edition_id = p_edition and l.event_id = p_item and l.state = 'approved' and public.edition_participation_ok(l.id)
                      and e.status in ('published', 'cancelled', 'postponed')) then raise exception 'item not found' using errcode = 'P0002'; end if;
  end if;
  if (select count(*) from public.edition_plan_items where user_id = auth.uid()) >= 150 then raise exception 'your plan is full' using errcode = '23514'; end if;
  insert into public.edition_plan_items (user_id, edition_id, kind, session_id, event_id)
    values (auth.uid(), p_edition, p_kind, case when p_kind = 'session' then p_item end, case when p_kind = 'event' then p_item end) on conflict do nothing;
  return true;
end $$;

-- What the signed-in visitor has done on one Edition (for the buttons).
create or replace function public.edition_my_flags(p_edition uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'saved', exists (select 1 from public.edition_saves where user_id = auth.uid() and edition_id = p_edition),
    'sessions', coalesce((select jsonb_agg(session_id) from public.edition_plan_items where user_id = auth.uid() and edition_id = p_edition and kind = 'session'), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(event_id) from public.edition_plan_items where user_id = auth.uid() and edition_id = p_edition and kind = 'event'), '[]'::jsonb)) end
$$;

-- The visitor's plan: only items that are STILL public right now (a withdrawn partner, unpublished event or suspended Edition drops out), with
-- the facts needed to show and export them. A removed item is simply absent; nothing is copied.
create or replace function public.edition_my_plan()
returns table (edition_id uuid, edition_title text, edition_slug text, edition_starts_on date, edition_ends_on date, edition_saved boolean,
               kind text, item_id uuid, title text, starts_at timestamptz, ends_at timestamptz, venue text, status text, item_href text, last_update_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  with mine as (select e.* from public.editions e where auth.uid() is not null and public.edition_is_public(e.id)
                  and (exists (select 1 from public.edition_saves s where s.user_id = auth.uid() and s.edition_id = e.id)
                       or exists (select 1 from public.edition_plan_items p where p.user_id = auth.uid() and p.edition_id = e.id)))
  select m.id, m.title, m.slug, m.starts_on, m.ends_on, exists (select 1 from public.edition_saves s where s.user_id = auth.uid() and s.edition_id = m.id),
         null::text, null::uuid, null::text, null::timestamptz, null::timestamptz, null::text, null::text, null::text,
         (select max(u.published_at) from public.edition_updates u where u.edition_id = m.id and u.published_at <= now())
    from mine m
  union all
  select m.id, m.title, m.slug, m.starts_on, m.ends_on, true, 'session', s.id, s.title, s.starts_at, s.ends_at, v.name, s.status, null, null
    from mine m join public.edition_plan_items p on p.edition_id = m.id and p.user_id = auth.uid() and p.kind = 'session'
    join public.edition_sessions s on s.id = p.session_id left join public.edition_venues v on v.id = s.venue_id
  union all
  select m.id, m.title, m.slug, m.starts_on, m.ends_on, true, 'event', ev.id, ev.title, ev.starts_at, ev.ends_at, ev.venue, ev.status, '/whats-on/' || ev.id::text, null
    from mine m join public.edition_plan_items p on p.edition_id = m.id and p.user_id = auth.uid() and p.kind = 'event'
    join public.edition_links l on l.edition_id = m.id and l.event_id = p.event_id and l.state = 'approved' and public.edition_participation_ok(l.id)
    join public.events ev on ev.id = p.event_id and ev.status in ('published', 'cancelled', 'postponed')
   order by 1, 7 nulls first, 10
$$;

revoke all on function public.edition_save(uuid, boolean), public.edition_plan_toggle(uuid, text, uuid, boolean), public.edition_my_flags(uuid), public.edition_my_plan() from public, anon, authenticated;
grant execute on function public.edition_save(uuid, boolean), public.edition_plan_toggle(uuid, text, uuid, boolean), public.edition_my_flags(uuid), public.edition_my_plan() to authenticated;

insert into public.analytics_event_defs (event_name, is_conversion, category, description) values
  ('edition_saved', true, 'sales_intent', 'A signed-in visitor saved an Edition (object_type edition, no personal data)'),
  ('edition_plan_added', false, 'content_interaction', 'A session or event was added to a personal plan'),
  ('edition_calendar_exported', false, 'content_interaction', 'An Edition or personal plan calendar file was downloaded'),
  ('edition_search', false, 'content_interaction', 'The Editions index was searched or filtered')
on conflict (event_name) do nothing;
