-- Editions 1.1: "Add from your Hub". Lists the Hub's own public events (inside the Edition's dates) and eligible regular activities so a Hub owner or
-- active committee member can add them to a Hub-run Edition in one click. READ-ONLY and additive: the adding itself reuses edition_invite_partner, which
-- already approves a link the caller controls without an invitation, and removing reuses edition_link_act('remove') (the original is never touched).
-- Eligibility mirrors edition_hub_item_options: published, not hidden, not a platform listing, Hub visibility 'hub' or 'islands' (never members-only).
create or replace function public.edition_hub_own_items(p_edition uuid)
returns table (kind text, id uuid, title text, starts_at timestamptz, venue text, link_id uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_hub uuid; v_from date; v_to date;
begin
  if auth.uid() is null or not public.edition_can(p_edition, 'editor') then raise exception 'not permitted' using errcode = '42501'; end if;
  select o.hub_id, e.starts_on, e.ends_on into v_hub, v_from, v_to
    from public.editions e join public.edition_organisers o on o.id = e.organiser_id where e.id = p_edition;
  if v_hub is null then raise exception 'this Edition is not run by a Hub' using errcode = '23514'; end if;
  -- the Hub's own authority (owner or active committee): an Editor who was only invited to the organiser team does not control the Hub's listings
  if not public.edition_controls_hub(v_hub) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query
    (select 'event'::text, ev.id, ev.title, ev.starts_at, ev.venue,
            (select l.id from public.edition_links l where l.edition_id = p_edition and l.kind = 'event' and l.event_id = ev.id and l.state in ('pending', 'approved') limit 1)
       from public.events ev
      where ev.organiser_hub_id = v_hub and not ev.is_platform_event and ev.status = 'published' and not ev.is_hidden
        and ev.hub_visibility in ('hub', 'islands')
        and (ev.starts_at at time zone 'Europe/London')::date between v_from and v_to
      order by ev.starts_at limit 100)
    union all
    (select 'activity'::text, a.id, a.title, null::timestamptz, a.venue,
            (select l.id from public.edition_links l where l.edition_id = p_edition and l.kind = 'activity' and l.activity_id = a.id and l.state in ('pending', 'approved') limit 1)
       from public.regular_activities a
      where a.organiser_hub_id = v_hub and not a.is_platform_activity and a.status = 'published' and not a.admin_paused and a.calendar_approved
        and (a.active_until is null or a.active_until >= current_date)
      order by a.title limit 100);
end $$;
revoke all on function public.edition_hub_own_items(uuid) from public, anon, authenticated;
grant execute on function public.edition_hub_own_items(uuid) to authenticated;
