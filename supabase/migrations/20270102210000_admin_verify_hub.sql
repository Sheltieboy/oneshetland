-- Administrator-only Hub verification, so routine verification never needs a direct database change.
--
-- hubs.is_verified is a trust flag the platform already uses (a verified Hub's islands-wide events are calendar-approved without review, and the Editions pilot requires it). It is locked
-- against every client write by tg_lock_hub_columns; this function is the one deliberate door: a SECURITY DEFINER function runs as its owner, which that trigger treats as a trusted
-- writer. Administrators only (not moderators), a written note, one audit row per change in the existing Editions audit log, signed-in role only.
create or replace function public.admin_set_hub_verified(p_hub uuid, p_verified boolean, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare h public.hubs%rowtype;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if p_verified is null then raise exception 'verify or remove verification' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 5 then raise exception 'a note is required' using errcode = '23514', hint = 'note_required'; end if;
  select * into h from public.hubs where id = p_hub for update;
  if not found then raise exception 'Hub not found' using errcode = 'P0002'; end if;
  if coalesce(h.is_verified, false) = p_verified then raise exception 'the Hub is already in that state' using errcode = '23505', hint = 'no_change'; end if;
  update public.hubs set is_verified = p_verified where id = p_hub;
  perform public.edition_audit(null, null, case when p_verified then 'hub_verified' else 'hub_verification_removed' end,
                               jsonb_build_object('hub_id', p_hub, 'hub_name', h.name, 'note', btrim(p_note)));
end $$;
revoke all on function public.admin_set_hub_verified(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.admin_set_hub_verified(uuid, boolean, text) to authenticated;
