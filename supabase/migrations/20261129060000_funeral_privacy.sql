-- Notices & Alerts — funeral privacy, account-deletion cleanup, retention (dry-run first), no-account enquiries and controlled audit redaction.
--
-- NOT APPLIED. Depends on 20261129000000 (audit log + account_is_closed + redaction trigger), 20261129030000 (funeral tables) and 20261129050000 (member notices).
-- The delete-account Edge Function may be deployed ONLY after this migration is applied (docs/DEPLOY-NOTICES-ALERTS.md §3b): before then it reports the cleanup
-- functions as "not present yet"; once they exist a cleanup failure aborts the deletion before anything irreversible happens.
--
-- Purposes and retention periods are PROPOSALS for review (docs/notices-account-deletion-and-retention.md). They are not statutory durations.

-- ── 1. retention schedule: retain_until is derived from status, never set by a client ─────────────────────────────────────────────────────────────
create function public.tg_funeral_retention() returns trigger language plpgsql as $$
begin
  if new.status = 'approved' then
    new.retain_until := new.display_until + interval '90 days';                   -- the announcement stays until its display period ends; deletion is scheduled after that
  elsif tg_op = 'INSERT' or new.status is distinct from old.status then
    new.retain_until := case new.status
      when 'withdrawn' then now() + interval '30 days'
      when 'rejected' then now() + interval '90 days'                              -- minimal moderation record (abuse prevention)
      when 'taken_down' then now() + interval '90 days'
      else null end;                                                               -- under review: no deletion date until the outcome is known
  end if;
  return new;
end $$;
create trigger funeral_notices_retention before insert or update on public.funeral_notices for each row execute function public.tg_funeral_retention();

-- ── 2. settings (the retention job is OFF until an administrator, after release approval, turns it on) ─────────────────────────────────────────
create table public.notice_privacy_settings (
  key        text primary key check (key in ('funeral_retention_enabled')),
  value      boolean not null default false,
  note       text,
  changed_by uuid,
  changed_at timestamptz not null default now()
);
insert into public.notice_privacy_settings (key, value, note) values ('funeral_retention_enabled', false, 'Off until release approval');
alter table public.notice_privacy_settings enable row level security;
revoke all on public.notice_privacy_settings from anon, authenticated;

create function public.admin_set_funeral_retention_enabled(p_enabled boolean, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  if p_note is null or length(btrim(p_note)) < 10 then raise exception 'Record why (release approval reference)' using errcode = '22023'; end if;
  update public.notice_privacy_settings set value = coalesce(p_enabled, false), note = btrim(p_note), changed_by = public.active_uid(), changed_at = now() where key = 'funeral_retention_enabled';
  perform public.notice_audit('funeral_retention_run', null, null, null, jsonb_build_object('action', 'setting', 'enabled', coalesce(p_enabled, false)));
end $$;

-- ── 3. account deletion: funeral submissions ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- Service role only (called by delete-account). Atomic and idempotent: it acts only on rows still linked to this member (submitter_id), so a repeat does nothing.
-- REMOVED for every state: submitter name, relationship, telephone, email, the link to the account, the message shown to the submitter, the private moderator note.
-- KEPT for every state (the minimum evidence): submitter_role, funeral_director_id, family_authorised, verification method / outcome / date / reviewer, follow-up.
-- approved  : the public announcement is untouched (status, content, display period); deletion scheduled by retain_until (display_until + 90 days).
-- pending   : cannot be verified without the family's contact, so it is withdrawn (it was never public) and its content reduced to the minimum; deleted after 30 days.
-- withdrawn : content reduced to the minimum; deleted 30 days after withdrawal.
-- rejected / taken_down : content reduced to a moderation stub (reason code, dates); deleted 90 days after the decision.
create function public.delete_member_funeral_data(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare f record; v_counts jsonb := '{}'::jsonb; v_req integer; v_status text;
begin
  if p_user is null or not exists (select 1 from public.profiles where id = p_user) then raise exception 'Unknown member' using errcode = '22023'; end if;
  for f in select id, status from public.funeral_notices where submitter_id = p_user order by created_at for update loop
    v_status := f.status;
    if f.status in ('submitted', 'in_review', 'needs_info') then
      update public.funeral_notices set status = 'withdrawn', followup_action = 'none', announcement = null, preferred_name = null, photo_url = null, family_requests = null,
             donation_info = null, donation_url = null, service_notes = null, service_venue = null, service_at = null, service_public = false,
             announce_in_notifications = false, announce_name_in_preview = false, verification_note = null
       where id = f.id;
    elsif f.status = 'withdrawn' then
      update public.funeral_notices set announcement = null, preferred_name = null, photo_url = null, family_requests = null, donation_info = null, donation_url = null,
             service_notes = null, service_venue = null, service_at = null, verification_note = null where id = f.id;
    elsif f.status in ('rejected', 'taken_down') then
      update public.funeral_notices set full_name = '[removed]', announcement = null, preferred_name = null, photo_url = null, born_on = null, died_on = null,
             family_requests = null, donation_info = null, donation_url = null, service_notes = null, service_venue = null, service_at = null, verification_note = null where id = f.id;
    end if;
    update public.funeral_notices set submitter_id = null, submitter_name = null, submitter_relationship = null, submitter_phone = null, submitter_email = null,
           review_message = null, review_note = null, scrubbed_at = now() where id = f.id;
    perform public.notice_audit('funeral_submitter_scrubbed', null, null, f.id, jsonb_build_object('was', v_status));
    v_counts := jsonb_set(v_counts, array[v_status], to_jsonb(coalesce((v_counts->>v_status)::integer, 0) + 1));
  end loop;
  -- this member's own enquiries: the contact details go, the message stays so staff can still act on an open request
  update public.funeral_change_requests set requester_id = null, contact = null, contact_name = null where requester_id = p_user;
  get diagnostics v_req = row_count;
  return jsonb_build_object('funeral_notices', v_counts, 'change_requests', v_req);
end $$;

-- ── 4. account deletion: organisation memberships ────────────────────────────────────────────────────────────────────────────────────────────────
-- Deactivates (never deletes) this member's seats; the organisations and every other member are untouched. The membership row stays as history; the account itself
-- is anonymised by delete-account, and the authority checks also refuse a closed account (account_is_closed), so a deleted account cannot regain authority.
create function public.delete_member_memberships(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m record; v_pub integer := 0; v_fun integer := 0;
begin
  if p_user is null or not exists (select 1 from public.profiles where id = p_user) then raise exception 'Unknown member' using errcode = '22023'; end if;
  for m in select publisher_id, role from public.official_publisher_members where user_id = p_user and is_active for update loop
    update public.official_publisher_members set is_active = false, removed_at = now(), removed_by = null where publisher_id = m.publisher_id and user_id = p_user;
    perform public.notice_audit('member_memberships_deactivated', m.publisher_id, null, null, jsonb_build_object('kind', 'official_publisher', 'role', m.role));
    v_pub := v_pub + 1;
  end loop;
  for m in select director_id from public.funeral_director_members where user_id = p_user and is_active for update loop
    update public.funeral_director_members set is_active = false where director_id = m.director_id and user_id = p_user;
    perform public.notice_audit('member_memberships_deactivated', null, null, null, jsonb_build_object('kind', 'funeral_director'));
    v_fun := v_fun + 1;
  end loop;
  return jsonb_build_object('official_publisher_members', v_pub, 'funeral_director_members', v_fun);
end $$;

-- ── 5. retention: report (read-only), and the job (dry-run by default, gated) ────────────────────────────────────────────────────────────────────
create function public.funeral_retention_candidates()
returns table (funeral_id uuid, status text, retain_until timestamptz, eligible boolean, reason text, blocked_by text)
language sql stable security definer set search_path = public, pg_temp as $$
  select f.id, f.status, f.retain_until,
         (f.retain_until <= now() and not f.retention_hold and not (f.status = 'approved' and f.display_until > now())
            and not exists (select 1 from public.funeral_change_requests r where r.funeral_id = f.id and r.status = 'open')),
         case f.status when 'approved' then 'end of display period + 90 days' when 'withdrawn' then 'withdrawn + 30 days'
                       when 'rejected' then 'rejected + 90 days' else 'taken down + 90 days' end,
         case when f.retention_hold then 'retention_hold'
              when f.status = 'approved' and f.display_until > now() then 'still_displayed'
              when exists (select 1 from public.funeral_change_requests r where r.funeral_id = f.id and r.status = 'open') then 'open_request'
              else null end
    from public.funeral_notices f where f.retain_until is not null;
$$;

-- administrators: what the job WOULD do (no personal data, no content)
create function public.admin_funeral_retention_report() returns table (funeral_id uuid, status text, retain_until timestamptz, eligible boolean, reason text, blocked_by text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  return query select * from public.funeral_retention_candidates() order by retain_until;
end $$;

-- the job: service role only. p_dry_run (the default) changes nothing. A real run needs the setting turned on by an administrator, and never touches a public
-- announcement, a held record or one with an open request.
create function public.funeral_retention_run(p_dry_run boolean default true) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ids uuid[]; v_by jsonb; v_reqs integer := 0; v_deleted integer := 0; v_blocked jsonb; v_dry boolean := coalesce(p_dry_run, true);
begin
  if not v_dry and not coalesce((select value from public.notice_privacy_settings where key = 'funeral_retention_enabled'), false) then
    raise exception 'Funeral retention is not enabled' using errcode = '55000';
  end if;
  select coalesce(array_agg(funeral_id), '{}') into v_ids from public.funeral_retention_candidates() where eligible;
  select coalesce(jsonb_object_agg(status, n), '{}') into v_by from (select status, count(*) n from public.funeral_retention_candidates() where eligible group by status) x;
  select coalesce(jsonb_object_agg(blocked_by, n), '{}') into v_blocked from (select blocked_by, count(*) n from public.funeral_retention_candidates()
          where retain_until <= now() and blocked_by is not null group by blocked_by) x;
  select count(*) into v_reqs from public.funeral_change_requests where status <> 'open' and handled_at < now() - interval '90 days';
  if not v_dry then
    delete from public.funeral_notices where id = any(v_ids); get diagnostics v_deleted = row_count;
    delete from public.funeral_change_requests where status <> 'open' and handled_at < now() - interval '90 days';
    perform public.notice_audit('funeral_retention_run', null, null, null, jsonb_build_object('action', 'run', 'deleted', v_deleted, 'by_status', v_by, 'requests', v_reqs));
  else
    perform public.notice_audit('funeral_retention_run', null, null, null, jsonb_build_object('action', 'dry_run', 'eligible', coalesce(array_length(v_ids, 1), 0), 'by_status', v_by));
  end if;
  return jsonb_build_object('dry_run', v_dry, 'eligible', coalesce(array_length(v_ids, 1), 0), 'by_status', v_by, 'blocked', v_blocked,
                            'deleted', v_deleted, 'closed_requests_eligible', v_reqs);
end $$;

create function public.admin_set_funeral_retention_hold(p_id uuid, p_hold boolean, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  if p_hold and (p_reason is null or length(btrim(p_reason)) < 10) then raise exception 'Record why the record is held' using errcode = '22023'; end if;
  if public.funeral_note_has_contact(p_reason) then raise exception 'Do not put telephone numbers or email addresses in a note' using errcode = '22023'; end if;
  update public.funeral_notices set retention_hold = coalesce(p_hold, false), retention_hold_reason = case when p_hold then btrim(p_reason) end where id = p_id;
  if not found then raise exception 'Unknown notice' using errcode = 'P0002'; end if;
  perform public.notice_audit('funeral_retention_hold', null, null, p_id, jsonb_build_object('hold', coalesce(p_hold, false)));
end $$;

-- ── 6. no-account correction / takedown / enquiry ───────────────────────────────────────────────────────────────────────────────────────────────
-- Anyone may ask; nothing changes by itself. The request goes into the staff queue (admin_funeral_change_requests) and staff must record how the requester's
-- authority was verified independently before admin_funeral_resolve_change will act on it. Only a PUBLISHED notice can be referred to (same answer for
-- anything else, so this cannot be used to discover unpublished submissions). Never shown publicly.
create function public.submit_funeral_enquiry(p_id uuid, p_kind text, p_message text, p_contact text, p_contact_name text default null, p_relationship text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_contact text := nullif(btrim(coalesce(p_contact, '')), '');
begin
  if p_kind not in ('correction', 'takedown', 'enquiry') then raise exception 'Unknown request' using errcode = '22023'; end if;
  if p_message is null or length(btrim(p_message)) < 5 or length(btrim(p_message)) > 1000 then raise exception 'Please say what you need (5 to 1000 characters)' using errcode = '22023'; end if;
  if v_contact is null or length(v_contact) < 5 or length(v_contact) > 200 then raise exception 'Please give a telephone number or email address so we can reach you' using errcode = '22023'; end if;
  if length(coalesce(p_contact_name, '')) > 120 or length(coalesce(p_relationship, '')) > 120 then raise exception 'Too long' using errcode = '22023'; end if;
  if not exists (select 1 from public.funeral_notices where id = p_id and status = 'approved' and display_until > now()) then raise exception 'Unknown notice' using errcode = 'P0002'; end if;
  -- abuse prevention: per notice, per contact, and overall (a flood cannot bury genuine requests or be used to harass a family)
  if (select count(*) from public.funeral_change_requests where funeral_id = p_id and source = 'public' and created_at > now() - interval '24 hours') >= 3
     or (select count(*) from public.funeral_change_requests where source = 'public' and lower(contact) = lower(v_contact) and created_at > now() - interval '24 hours') >= 3
     or (select count(*) from public.funeral_change_requests where source = 'public' and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many requests. Please try again later or call us' using errcode = '54000';
  end if;
  insert into public.funeral_change_requests (funeral_id, kind, source, contact_name, relationship, contact, message)
  values (p_id, p_kind, 'public', nullif(btrim(coalesce(p_contact_name, '')), ''), nullif(btrim(coalesce(p_relationship, '')), ''), v_contact, btrim(p_message)) returning id into v_id;
  perform public.notice_audit('funeral_enquiry_received', null, null, p_id, jsonb_build_object('kind', p_kind, 'source', 'public'));
  return v_id;
end $$;

-- staff record a request received by telephone / email / in person
create function public.admin_log_funeral_enquiry(p_id uuid, p_kind text, p_message text, p_contact text default null, p_contact_name text default null, p_relationship text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not public.funeral_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  if p_kind not in ('correction', 'takedown', 'enquiry') then raise exception 'Unknown request' using errcode = '22023'; end if;
  if p_message is null or length(btrim(p_message)) < 5 or length(btrim(p_message)) > 1000 then raise exception 'Please say what is needed (5 to 1000 characters)' using errcode = '22023'; end if;
  if not exists (select 1 from public.funeral_notices where id = p_id) then raise exception 'Unknown notice' using errcode = 'P0002'; end if;
  insert into public.funeral_change_requests (funeral_id, kind, source, requester_id, contact_name, relationship, contact, message)
  values (p_id, p_kind, 'staff_logged', public.active_uid(), nullif(btrim(coalesce(p_contact_name, '')), ''), nullif(btrim(coalesce(p_relationship, '')), ''), nullif(btrim(coalesce(p_contact, '')), ''), btrim(p_message)) returning id into v_id;
  perform public.notice_audit('funeral_enquiry_received', null, null, p_id, jsonb_build_object('kind', p_kind, 'source', 'staff_logged'));
  return v_id;
end $$;

-- ── 7. audit privacy: administrator-authorised redaction of free text, with a ledger ──────────────────────────────────────────────────────────────
-- The append-only audit log is NOT editable. tg_notice_audit_immutable (core migration) allows one exception: inside admin_redact_audit_text a text value in
-- `details` may be replaced by the marker "[redacted]". Event, time, actor, subject ids and every key remain, so chronology and accountability are intact, and the
-- redaction itself is audited and recorded in notice_audit_redactions.
create table public.notice_audit_redactions (
  id          bigint generated always as identity primary key,
  audit_id    bigint not null,
  keys        text[] not null,
  reason      text not null check (length(btrim(reason)) >= 10),
  redacted_by uuid,
  redacted_at timestamptz not null default now()
);
alter table public.notice_audit_redactions enable row level security;
revoke all on public.notice_audit_redactions from anon, authenticated;

-- 12-month review point: entries old enough to be reviewed that still hold free text. Returns identifiers and key names only, never the text.
create function public.admin_audit_redaction_candidates(p_months integer default 12) returns table (audit_id bigint, at timestamptz, event text, keys text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  return query
    select a.id, a.at, a.event, array(select k from jsonb_object_keys(a.details) k where k in ('reason', 'note', 'message', 'outcome_note', 'request')
                                       and jsonb_typeof(a.details->k) = 'string' and a.details->>k <> '[redacted]')
      from public.notice_audit_log a
     where a.at < now() - make_interval(months => greatest(coalesce(p_months, 12), 1))
       and exists (select 1 from jsonb_object_keys(a.details) k where k in ('reason', 'note', 'message', 'outcome_note', 'request')
                    and jsonb_typeof(a.details->k) = 'string' and a.details->>k <> '[redacted]')
     order by a.at limit 500;
end $$;

create function public.admin_redact_audit_text(p_audit_id bigint, p_keys text[], p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.notice_audit_log%rowtype; v_new jsonb; k text; v_done text[] := '{}';
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then raise exception 'Record why this is being redacted' using errcode = '22023'; end if;
  if p_keys is null or cardinality(p_keys) = 0 then raise exception 'Name the text to redact' using errcode = '22023'; end if;
  select * into a from public.notice_audit_log where id = p_audit_id;
  if not found then raise exception 'Unknown audit entry' using errcode = 'P0002'; end if;
  v_new := a.details;
  foreach k in array p_keys loop
    if k not in ('reason', 'note', 'message', 'outcome_note', 'request') then raise exception 'Only free-text entries can be redacted' using errcode = '22023'; end if;
    if jsonb_typeof(v_new->k) = 'string' and v_new->>k <> '[redacted]' then v_new := jsonb_set(v_new, array[k], '"[redacted]"'::jsonb); v_done := v_done || k; end if;
  end loop;
  if cardinality(v_done) = 0 then return; end if;                                          -- nothing left to redact: idempotent
  perform set_config('notices.audit_redaction', 'on', true);                               -- transaction-local; only this function sets it
  update public.notice_audit_log set details = v_new where id = p_audit_id;
  perform set_config('notices.audit_redaction', 'off', true);
  insert into public.notice_audit_redactions (audit_id, keys, reason, redacted_by) values (p_audit_id, v_done, btrim(p_reason), public.active_uid());
  perform public.notice_audit('audit_text_redacted', a.publisher_id, a.notice_id, a.funeral_id, jsonb_build_object('audit_id', p_audit_id, 'keys', to_jsonb(v_done)));
end $$;

create function public.admin_audit_redactions(p_limit integer default 100) returns setof public.notice_audit_redactions
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  return query select * from public.notice_audit_redactions order by id desc limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;

-- ── grants ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
revoke all on function public.tg_funeral_retention(), public.delete_member_funeral_data(uuid), public.delete_member_memberships(uuid), public.funeral_retention_candidates(),
  public.funeral_retention_run(boolean), public.admin_set_funeral_retention_enabled(boolean, text), public.admin_funeral_retention_report(), public.admin_set_funeral_retention_hold(uuid, boolean, text),
  public.submit_funeral_enquiry(uuid, text, text, text, text, text), public.admin_log_funeral_enquiry(uuid, text, text, text, text, text),
  public.admin_audit_redaction_candidates(integer), public.admin_redact_audit_text(bigint, text[], text), public.admin_audit_redactions(integer) from public, anon, authenticated;
-- service role only (no policy for anyone else): the deletion function and the retention job
grant execute on function public.delete_member_funeral_data(uuid), public.delete_member_memberships(uuid), public.funeral_retention_run(boolean) to service_role;
-- the website form works signed out
grant execute on function public.submit_funeral_enquiry(uuid, text, text, text, text, text) to anon, authenticated;
-- staff / administrators (each function checks the role itself)
grant execute on function public.admin_set_funeral_retention_enabled(boolean, text), public.admin_funeral_retention_report(), public.admin_set_funeral_retention_hold(uuid, boolean, text),
  public.admin_log_funeral_enquiry(uuid, text, text, text, text, text), public.admin_audit_redaction_candidates(integer), public.admin_redact_audit_text(bigint, text[], text),
  public.admin_audit_redactions(integer) to authenticated;
