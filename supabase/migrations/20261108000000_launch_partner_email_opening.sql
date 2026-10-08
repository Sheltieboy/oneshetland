-- Launch partners: the editable "personalised opening" line of the outreach email draft.
--
-- The email body keeps a {{PERSONALISED_OPENING}} token; the opening text it is replaced with at render time lives in
-- ONE new column, launch_partner_campaigns.email_opening (null by default, at most 1000 characters). It is edited the
-- same way as email_subject / email_body: through admin_launch_partner_update, whose whitelist gains exactly one key.
--
--   * admin_launch_partner_update is the 20261106000000 definition with `email_opening` added (text, trimmed, blank ->
--     null, <= 1000 characters, 22023 otherwise). The admin gate, every other validation, the archived rule (notes
--     only), the event log (changed FIELD NAMES only, never the opening text) and the return shape are unchanged.
--   * admin_launch_partner_get is the 20261107000000 definition with `email_opening` added next to email_subject /
--     email_body. Every other field is unchanged.
--   * No other function, no policy, no grant and no other table is touched. Grants are restated for the two functions
--     exactly as the earlier migrations set them (CREATE OR REPLACE keeps them anyway).
--
-- Additive and idempotent: safe to apply twice.
begin;

alter table public.launch_partner_campaigns add column if not exists email_opening text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.launch_partner_campaigns'::regclass
                    and conname = 'launch_partner_campaigns_email_opening_check') then
    alter table public.launch_partner_campaigns
      add constraint launch_partner_campaigns_email_opening_check
      check (email_opening is null or char_length(email_opening) <= 1000);
  end if;
end $$;

-- ── admin_launch_partner_update: the whitelist gains email_opening ──────────
create or replace function public.admin_launch_partner_update(p_id uuid, p_patch jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_via     text := public.launch_plan_authorised();
  c         public.launch_partner_campaigns;
  k         text;
  v         jsonb;
  s         text;
  v_changed text[] := '{}';
  n         public.launch_partner_campaigns;
begin
  if v_via is null then
    raise exception 'Only an administrator can edit a launch-partner record' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'The patch must be a JSON object' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('positioning', 'preview_config', 'page_config', 'contact_name', 'contact_email',
                 'email_subject', 'email_body', 'email_opening', 'notes') then
      raise exception 'Field "%" cannot be changed here', k using errcode = '22023';
    end if;
  end loop;

  select * into c from public.launch_partner_campaigns where id = p_id for update;
  if not found then raise exception 'No such launch-partner record' using errcode = 'P0002'; end if;

  if c.stage = 'archived' then
    for k in select jsonb_object_keys(p_patch) loop
      if k <> 'notes' then
        raise exception 'An archived record can only have its notes changed' using errcode = '55000';
      end if;
    end loop;
  end if;

  n := c;
  for k, v in select * from jsonb_each(p_patch) loop
    if k in ('preview_config', 'page_config') then
      if jsonb_typeof(v) <> 'object' then
        raise exception '% must be a JSON object', k using errcode = '22023';
      end if;
      if octet_length(v::text) > 262144 then
        raise exception '% is too large (limit 256 KB)', k using errcode = '22023';
      end if;
      if k = 'preview_config' then n.preview_config := v; else n.page_config := v; end if;
    else
      if jsonb_typeof(v) not in ('string', 'null') then
        raise exception '% must be text', k using errcode = '22023';
      end if;
      s := nullif(btrim(coalesce(v #>> '{}', '')), '');
      if k = 'positioning' then
        if char_length(coalesce(s, '')) > 200 then raise exception 'positioning is limited to 200 characters' using errcode = '22023'; end if;
        n.positioning := s;
      elsif k = 'contact_name' then
        if char_length(coalesce(s, '')) > 200 then raise exception 'contact_name is limited to 200 characters' using errcode = '22023'; end if;
        n.contact_name := s;
      elsif k = 'contact_email' then
        if s is not null and (char_length(s) > 254 or s !~ '^[^@\s]+@[^@\s]+$') then
          raise exception 'contact_email is not a valid email address' using errcode = '22023';
        end if;
        n.contact_email := s;
      elsif k = 'email_subject' then
        if char_length(coalesce(s, '')) > 200 then raise exception 'email_subject is limited to 200 characters' using errcode = '22023'; end if;
        n.email_subject := s;
      elsif k = 'email_body' then
        if char_length(coalesce(s, '')) > 8000 then raise exception 'email_body is limited to 8000 characters' using errcode = '22023'; end if;
        n.email_body := s;
      elsif k = 'email_opening' then
        if char_length(coalesce(s, '')) > 1000 then raise exception 'email_opening is limited to 1000 characters' using errcode = '22023'; end if;
        n.email_opening := s;
      elsif k = 'notes' then
        if char_length(coalesce(s, '')) > 4000 then raise exception 'notes is limited to 4000 characters' using errcode = '22023'; end if;
        n.notes := s;
      end if;
    end if;
  end loop;

  -- A preview that is ready, or already sent, must not be emptied underneath the invitation.
  if n.preview_config = '{}'::jsonb and c.stage in ('ready_to_invite', 'sent') then
    raise exception 'Move the record back to preparing before clearing its preview' using errcode = '55000';
  end if;

  if n.positioning     is distinct from c.positioning     then v_changed := array_append(v_changed, 'positioning'); end if;
  if n.preview_config  is distinct from c.preview_config  then v_changed := array_append(v_changed, 'preview_config'); end if;
  if n.page_config     is distinct from c.page_config     then v_changed := array_append(v_changed, 'page_config'); end if;
  if n.contact_name    is distinct from c.contact_name    then v_changed := array_append(v_changed, 'contact_name'); end if;
  if n.contact_email   is distinct from c.contact_email   then v_changed := array_append(v_changed, 'contact_email'); end if;
  if n.email_subject   is distinct from c.email_subject   then v_changed := array_append(v_changed, 'email_subject'); end if;
  if n.email_body      is distinct from c.email_body      then v_changed := array_append(v_changed, 'email_body'); end if;
  if n.email_opening   is distinct from c.email_opening   then v_changed := array_append(v_changed, 'email_opening'); end if;
  if n.notes           is distinct from c.notes           then v_changed := array_append(v_changed, 'notes'); end if;

  if cardinality(v_changed) > 0 then
    update public.launch_partner_campaigns set
      positioning = n.positioning, preview_config = n.preview_config, page_config = n.page_config,
      contact_name = n.contact_name, contact_email = n.contact_email, email_subject = n.email_subject,
      email_body = n.email_body, email_opening = n.email_opening, notes = n.notes, updated_at = now()
     where id = p_id;
    -- Field NAMES only: never the values (an email address, a draft body, a page).
    perform public._launch_partner_event(p_id, 'updated', jsonb_build_object('fields', to_jsonb(v_changed)), v_via);
  end if;
  return public._launch_partner_summary(p_id);
end;
$$;

-- ── admin_launch_partner_get: the returned object gains email_opening ───────
create or replace function public.admin_launch_partner_get(p_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  c        public.launch_partner_campaigns;
  v_events jsonb;
begin
  if public.launch_plan_authorised() is null then
    raise exception 'Only an administrator can read a launch-partner record' using errcode = '42501';
  end if;
  select * into c from public.launch_partner_campaigns where id = p_id;
  if not found then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'detail', e.detail,
                                               'actor', e.actor, 'actor_label', e.actor_label,
                                               'created_at', e.created_at) order by e.created_at desc, e.id), '[]'::jsonb)
    into v_events
    from (select * from public.launch_partner_events where campaign_id = p_id
           order by created_at desc, id limit 50) e;
  return public._launch_partner_summary(p_id) || jsonb_build_object(
    'preview_config', c.preview_config, 'page_config', c.page_config,
    'contact_email', c.contact_email, 'email_subject', c.email_subject, 'email_body', c.email_body,
    'email_opening', c.email_opening,
    'notes', c.notes, 'events', v_events,
    'approved_version_id', c.approved_version_id, 'approved_at', c.approved_at, 'approved_by', c.approved_by,
    'published_version_id', c.published_version_id,
    'versions', public._launch_partner_versions_list(c.id));
end;
$$;

revoke all on function public.admin_launch_partner_update(uuid, jsonb), public.admin_launch_partner_get(uuid)
  from public, anon, authenticated;
grant execute on function public.admin_launch_partner_update(uuid, jsonb), public.admin_launch_partner_get(uuid)
  to authenticated, service_role;

commit;
