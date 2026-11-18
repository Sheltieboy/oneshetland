-- Editions R11: a dedicated public page for every programme session. Sessions gain an optional hero photograph and presenters, and can name the participating
-- businesses. Participation stays consent-based: a session only POINTS at an existing partner link; the page shows the business only while that link is itself public
-- (approved, owner has not withdrawn), exactly as the Taking part page does. Rollback: supabase/rollbacks/20270102120000_editions_session_pages.rollback.sql
alter table public.edition_sessions
  add column if not exists image_url text check (image_url is null or image_url ~ '^https://[^[:space:]\\<>"'']+$'),
  add column if not exists presenters text check (presenters is null or char_length(btrim(presenters)) between 1 and 200);
comment on column public.edition_sessions.image_url is 'Optional hero photograph for the session page. https only.';
comment on column public.edition_sessions.presenters is 'Optional free-text presenters or hosts, shown on the session page.';
grant insert (image_url, presenters), update (image_url, presenters) on public.edition_sessions to authenticated;

create table if not exists public.edition_session_businesses (
  session_id uuid not null references public.edition_sessions (id) on delete cascade,
  link_id    uuid not null references public.edition_links (id) on delete cascade,
  position   integer not null default 0,
  primary key (session_id, link_id)
);
alter table public.edition_session_businesses enable row level security;
create policy "session businesses public read" on public.edition_session_businesses for select to anon, authenticated
  using (exists (select 1 from public.edition_sessions s where s.id = session_id and public.edition_is_public(s.edition_id)));
create policy "session businesses member read" on public.edition_session_businesses for select to authenticated
  using (exists (select 1 from public.edition_sessions s where s.id = session_id and (public.edition_can(s.edition_id, 'editor') or public.edition_staff())));
revoke all on public.edition_session_businesses from public, anon, authenticated;
grant select on public.edition_session_businesses to anon, authenticated;   -- writes only through edition_session_set_businesses

create or replace function public.edition_session_set_businesses(p_session uuid, p_links uuid[]) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ed uuid; v_org uuid; v_n integer;
begin
  select s.edition_id, e.organiser_id into v_ed, v_org from public.edition_sessions s join public.editions e on e.id = s.edition_id where s.id = p_session;
  if v_ed is null or auth.uid() is null or not public.edition_can(v_ed, 'editor') then raise exception 'not found' using errcode = 'P0002'; end if;
  p_links := coalesce((select array_agg(distinct x) from unnest(coalesce(p_links, '{}'::uuid[])) x), '{}'::uuid[]);
  if cardinality(p_links) > 12 then raise exception 'name at most 12 businesses on one session' using errcode = '23514'; end if;
  if (select count(*) from public.edition_links l where l.id = any (p_links) and l.edition_id = v_ed and l.kind = 'business') <> cardinality(p_links) then
    raise exception 'only businesses that are partners of this Edition can be named' using errcode = '23514';
  end if;
  delete from public.edition_session_businesses where session_id = p_session;
  insert into public.edition_session_businesses (session_id, link_id, position) select p_session, x, (row_number() over ())::int from unnest(p_links) x;
  get diagnostics v_n = row_count;
  perform public.edition_audit(v_org, v_ed, 'session_businesses_set', jsonb_build_object('session', p_session, 'count', v_n));
  return v_n;
end $$;
revoke all on function public.edition_session_set_businesses(uuid, uuid[]) from public, anon;
grant execute on function public.edition_session_set_businesses(uuid, uuid[]) to authenticated;
