-- Notices & Alerts - step 4: Deaths & Funeral Notices.
--
-- A SEPARATE model on purpose. Funeral notices are not rows in `notices`: they have their own privacy rules, their own moderation, their own audience, and
-- they must never be readable, styled or pushed by an installed app build that predates them. They are never an Essential Alert and never Level 1.
--
--   SUBMISSION  an authenticated family representative, or a verified funeral director's account, submits. The "I am authorised" box is recorded but is NEVER proof:
--               a notice cannot be published until a moderator has recorded HOW the announcement was verified (a call back to the submitter, a funeral
--               director's confirmation, ...) and who did it. Nothing is imported, scraped or auto-created.
--   PRIVACY     submitter name / relationship / phone / email, the verification record and moderator notes live in columns no public function returns.
--               Funeral ARRANGEMENTS (venue, date, time, notes) are public only when the family explicitly ticked service_public. Photograph, remembrance,
--               family requests and donation details are all optional. Push notifications carry only what the family approved (see funeral_notification_text).
--   MODERATION  staff (administrator or moderator) review: start review -> request more information -> approve | reject; take down at any time. Every step is
--               in notice_audit_log. A published notice cannot be edited by its submitter: corrections and takedown requests go through funeral_change_requests.
--   RATE LIMIT  at most 3 submissions per account per 24 hours and 10 open at once.
-- Test data is fictional. NOTHING here sends a notification.
begin;

-- ── authorised funeral directors (explicit, administrator-granted) ───────────────────────────────────────────────────────────────────────────────
create table public.funeral_directors (
  id            uuid primary key default gen_random_uuid(),
  business_name text not null check (btrim(business_name) <> '' and length(business_name) <= 120),
  verified_at   timestamptz,
  verified_by   uuid references public.profiles(id) on delete set null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create table public.funeral_director_members (
  director_id uuid not null references public.funeral_directors(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  is_active   boolean not null default true,
  added_by    uuid references public.profiles(id) on delete set null,
  added_at    timestamptz not null default now(),
  primary key (director_id, user_id)
);

-- ── the notice ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table public.funeral_notices (
  id                uuid primary key default gen_random_uuid(),
  status            text not null default 'submitted' check (status in ('submitted', 'in_review', 'needs_info', 'approved', 'rejected', 'withdrawn', 'taken_down')),
  -- public content (only ever returned once approved)
  full_name         text not null check (length(btrim(full_name)) between 2 and 120),
  preferred_name    text check (preferred_name is null or length(btrim(preferred_name)) between 1 and 80),
  photo_url         text check (photo_url is null or public.is_safe_https_url(photo_url)),
  born_on           date,
  died_on           date,
  announcement      text check (announcement is null or (length(announcement) <= 1500 and announcement !~* '(https?://|www\.)')),
  service_public    boolean not null default false,                       -- the family explicitly approved PUBLISHING the arrangements below
  service_kind      text check (service_kind in ('funeral', 'burial', 'cremation', 'memorial', 'private')),
  service_venue     text check (service_venue is null or length(service_venue) <= 200),
  service_at        timestamptz,
  service_notes     text check (service_notes is null or length(service_notes) <= 500),
  family_requests   text check (family_requests is null or length(family_requests) <= 500),
  donation_info     text check (donation_info is null or length(donation_info) <= 500),
  donation_url      text check (donation_url is null or public.is_safe_https_url(donation_url)),
  area_id           text references public.areas(id) on delete set null,
  announce_in_notifications boolean not null default false,               -- the family approved a (discreet) push to people who opted in
  announce_name_in_preview  boolean not null default false,               -- ...and approved the name appearing in that push preview
  -- private
  submitter_id      uuid references public.profiles(id) on delete set null,
  submitter_role    text not null check (submitter_role in ('family', 'funeral_director')),
  submitter_name    text check (submitter_name is null or length(btrim(submitter_name)) between 2 and 120),     -- NULL only after the submitter's account is closed (scrubbed_at)
  submitter_relationship text check (submitter_relationship is null or length(submitter_relationship) <= 120),
  submitter_phone   text check (submitter_phone is null or length(submitter_phone) <= 40),
  submitter_email   text check (submitter_email is null or length(submitter_email) <= 200),
  funeral_director_id uuid references public.funeral_directors(id) on delete set null,
  family_authorised boolean not null default false,
  verification_method text check (verification_method in ('phone_callback', 'funeral_director_confirmation', 'in_person', 'existing_notice_source', 'other')),
  verified_by       uuid references public.profiles(id) on delete set null,
  verified_at       timestamptz,
  verification_note text,                                                  -- supplementary staff note: guarded (no telephone numbers / email addresses); NOT the evidence record
  verification_outcome text check (verification_outcome in ('confirmed', 'not_confirmed', 'unable_to_contact')),   -- STRUCTURED moderation record
  followup_action   text not null default 'none' check (followup_action in ('none', 'callback_later', 'awaiting_funeral_director', 'awaiting_family_reply', 'refer_to_administrator')),
  rejection_code    text check (rejection_code in ('unverifiable', 'duplicate', 'not_a_funeral_announcement', 'inappropriate', 'other')),
  review_message    text,                                                  -- shown to the submitter ("please confirm the date")
  review_note       text,                                                  -- private moderator note
  reviewed_by       uuid references public.profiles(id) on delete set null,
  reviewed_at       timestamptz,
  published_at      timestamptz,
  display_until     timestamptz,
  -- retention (see docs/notices-account-deletion-and-retention.md): a record is eligible for the retention job only when retain_until has passed and nothing blocks it
  retain_until      timestamptz,                                           -- approved: display_until + 90 days; withdrawn: +30 days; rejected / taken down: +90 days; NULL while under review
  scrubbed_at       timestamptz,                                           -- the submitter's private details were removed (account closed)
  retention_hold    boolean not null default false,                         -- an administrator-set exception (dispute); blocks the retention job
  retention_hold_reason text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint funeral_dates check (born_on is null or died_on is null or born_on <= died_on),
  constraint funeral_contact_present check (scrubbed_at is not null or (submitter_name is not null and (submitter_phone is not null or submitter_email is not null))),
  constraint funeral_approved_needs_verification check (status <> 'approved' or (verification_method is not null and verified_at is not null and published_at is not null and display_until is not null))
);
create index funeral_notices_public_idx on public.funeral_notices (published_at desc) where status = 'approved';
create index funeral_notices_submitter_idx on public.funeral_notices (submitter_id);

create table public.funeral_change_requests (
  id            uuid primary key default gen_random_uuid(),
  funeral_id    uuid not null references public.funeral_notices(id) on delete cascade,
  kind          text not null check (kind in ('correction', 'takedown', 'enquiry')),
  source        text not null default 'member' check (source in ('member', 'public', 'staff_logged')),   -- 'public' = no account (the website form)
  contact_name  text check (contact_name is null or length(contact_name) <= 120),
  relationship  text check (relationship is null or length(relationship) <= 120),
  authority_check text check (authority_check in ('funeral_director_confirmation', 'independent_contact', 'original_submitter', 'not_verified')),   -- how STAFF established the requester's authority
  requester_id  uuid references public.profiles(id) on delete set null,
  contact       text check (contact is null or length(contact) <= 200),
  message       text not null check (length(btrim(message)) between 5 and 1000),
  status        text not null default 'open' check (status in ('open', 'actioned', 'declined')),
  handled_by    uuid references public.profiles(id) on delete set null,
  handled_at    timestamptz,
  outcome_note  text,
  created_at    timestamptz not null default now()
);
create index funeral_change_requests_open_idx on public.funeral_change_requests (created_at) where status = 'open';

alter table public.funeral_directors enable row level security;
alter table public.funeral_director_members enable row level security;
alter table public.funeral_notices enable row level security;
alter table public.funeral_change_requests enable row level security;
revoke all on public.funeral_directors, public.funeral_director_members, public.funeral_notices, public.funeral_change_requests from anon, authenticated;

-- A date of death cannot be in the future (validated here: a CHECK cannot use the clock safely). Arrangements the family did NOT approve for publication may
-- still be stored (they help verification) but are never returned by a public function.
create function public.tg_funeral_notices_validate() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.died_on is not null and new.died_on > current_date then raise exception 'The date of death cannot be in the future' using errcode = '22023'; end if;
  return new;
end $$;
create trigger funeral_notices_validate before insert or update on public.funeral_notices for each row execute function public.tg_funeral_notices_validate();

-- ── staff = administrator or moderator (the existing moderation rule); directors are administrator-granted only ─────────────────────────────────
create function public.funeral_staff() returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and not public.account_is_closed(auth.uid()) and (public.attribution_staff() or public.notices_admin());
$$;

-- Staff notes are SUPPLEMENTARY and never the evidence record: they must not carry a telephone number or email address (the structured fields record method,
-- outcome, date and reviewer; the family's private contact details stay in the restricted submission, not in free text that is copied around).
create function public.funeral_note_has_contact(p_text text) returns boolean language sql immutable as $$
  select p_text is not null and (p_text ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' or p_text ~ '(\+?[0-9][0-9 ().-]{7,}[0-9])');
$$;

-- who may ANNOUNCE an approved funeral notice (explicit user: the edge function passes the verified caller, nothing is trusted from the request)
create function public.can_dispatch_funeral(p_user uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_user is not null and exists (select 1 from public.profiles p where p.id = p_user and not public.account_is_closed(p_user) and (p.role in ('admin', 'moderator') or coalesce(p.is_platform_owner, false)));
$$;

create function public.admin_set_funeral_director(p_name text, p_user uuid, p_verify boolean default true) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  if public.account_is_closed(p_user) then raise exception 'That account is closed' using errcode = '22023'; end if;
  select id into v_id from public.funeral_directors where business_name = p_name;
  if v_id is null then insert into public.funeral_directors (business_name) values (p_name) returning id into v_id; end if;
  if p_verify then update public.funeral_directors set verified_at = now(), verified_by = auth.uid() where id = v_id; end if;
  insert into public.funeral_director_members (director_id, user_id, added_by) values (v_id, p_user, auth.uid())
    on conflict (director_id, user_id) do update set is_active = true;
  return v_id;
end $$;

-- ── submission ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create function public.submit_funeral_notice(p jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_role text := coalesce(p->>'submitter_role', 'family'); v_dir uuid; v_area text := nullif(p->>'area_id', '');
begin
  if auth.uid() is null or public.account_is_closed(auth.uid()) then raise exception 'Sign in to submit a notice' using errcode = '42501'; end if;
  if (select count(*) from public.funeral_notices where submitter_id = auth.uid() and created_at > now() - interval '24 hours') >= 3 then
    raise exception 'Please wait: you have submitted 3 notices in the last 24 hours' using errcode = '54000';
  end if;
  if (select count(*) from public.funeral_notices where submitter_id = auth.uid() and status in ('submitted', 'in_review', 'needs_info')) >= 10 then
    raise exception 'You already have notices awaiting review' using errcode = '54000';
  end if;
  if v_role not in ('family', 'funeral_director') then raise exception 'Unknown submitter role' using errcode = '22023'; end if;
  if v_role = 'funeral_director' then
    select d.id into v_dir from public.funeral_director_members m join public.funeral_directors d on d.id = m.director_id
     where m.user_id = auth.uid() and m.is_active and d.is_active and d.verified_at is not null limit 1;
    if v_dir is null then raise exception 'Your account is not an authorised funeral director' using errcode = '42501'; end if;
  end if;
  if v_area is not null and not exists (select 1 from public.areas a where a.id = v_area and a.is_active and a.is_physical) then
    raise exception 'Choose a real Shetland area' using errcode = '22023';
  end if;
  if coalesce((p->>'family_authorised')::boolean, false) is not true then raise exception 'Please confirm you are authorised to make this announcement' using errcode = '22023'; end if;
  insert into public.funeral_notices (
    full_name, preferred_name, photo_url, born_on, died_on, announcement, service_public, service_kind, service_venue, service_at, service_notes, family_requests,
    donation_info, donation_url, area_id, announce_in_notifications, announce_name_in_preview, submitter_id, submitter_role, submitter_name, submitter_relationship,
    submitter_phone, submitter_email, funeral_director_id, family_authorised)
  values (
    btrim(p->>'full_name'), nullif(btrim(p->>'preferred_name'), ''), nullif(p->>'photo_url', ''), nullif(p->>'born_on', '')::date, nullif(p->>'died_on', '')::date,
    nullif(btrim(p->>'announcement'), ''), coalesce((p->>'service_public')::boolean, false), nullif(p->>'service_kind', ''), nullif(btrim(p->>'service_venue'), ''),
    nullif(p->>'service_at', '')::timestamptz, nullif(btrim(p->>'service_notes'), ''), nullif(btrim(p->>'family_requests'), ''), nullif(btrim(p->>'donation_info'), ''),
    nullif(p->>'donation_url', ''), v_area, coalesce((p->>'announce_in_notifications')::boolean, false), coalesce((p->>'announce_name_in_preview')::boolean, false),
    auth.uid(), v_role, btrim(p->>'submitter_name'), nullif(btrim(p->>'submitter_relationship'), ''), nullif(btrim(p->>'submitter_phone'), ''),
    nullif(btrim(p->>'submitter_email'), ''), v_dir, true)
  returning id into v_id;
  perform public.notice_audit('funeral_submitted', null, null, v_id, jsonb_build_object('role', v_role));
  return v_id;
end $$;

create function public.my_funeral_submissions()
returns table (id uuid, status text, full_name text, created_at timestamptz, published_at timestamptz, review_message text)
language sql stable security definer set search_path = public, pg_temp as $$
  select f.id, f.status, f.full_name, f.created_at, f.published_at, case when f.status in ('needs_info', 'rejected') then f.review_message end
    from public.funeral_notices f where f.submitter_id = auth.uid() order by f.created_at desc;
$$;

-- The submitter's own submission with every editable field (to pre-fill the edit form). Private moderator notes are never returned; review_message is the
-- staff message meant for the submitter.
create function public.my_funeral_submission(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select to_jsonb(x) from (select f.id, f.status, f.full_name, f.preferred_name, f.photo_url, f.born_on, f.died_on, f.announcement, f.service_public, f.service_kind, f.service_venue,
         f.service_at, f.service_notes, f.family_requests, f.donation_info, f.donation_url, f.area_id, f.announce_in_notifications, f.announce_name_in_preview,
         f.submitter_name, f.submitter_relationship, f.submitter_phone, f.submitter_email, f.created_at, f.published_at,
         case when f.status in ('needs_info', 'rejected') then f.review_message end as review_message
    from public.funeral_notices f where f.id = p_id and f.submitter_id = auth.uid()) x;
$$;

-- The submitter can amend an UNPUBLISHED submission (it returns to the review queue). A published one is corrected only by staff, on request.
create function public.update_my_funeral_submission(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare f public.funeral_notices%rowtype;
begin
  select * into f from public.funeral_notices where id = p_id and submitter_id = auth.uid() for update;
  if not found then raise exception 'Unknown notice' using errcode = 'P0002'; end if;
  if f.status not in ('submitted', 'needs_info') then raise exception 'This notice can no longer be edited; ask for a correction instead' using errcode = '22023'; end if;
  update public.funeral_notices set
    full_name = coalesce(btrim(p->>'full_name'), full_name), preferred_name = case when p ? 'preferred_name' then nullif(btrim(p->>'preferred_name'), '') else preferred_name end,
    photo_url = case when p ? 'photo_url' then nullif(p->>'photo_url', '') else photo_url end, born_on = case when p ? 'born_on' then nullif(p->>'born_on', '')::date else born_on end,
    died_on = case when p ? 'died_on' then nullif(p->>'died_on', '')::date else died_on end, announcement = case when p ? 'announcement' then nullif(btrim(p->>'announcement'), '') else announcement end,
    service_public = coalesce((p->>'service_public')::boolean, service_public), service_kind = case when p ? 'service_kind' then nullif(p->>'service_kind', '') else service_kind end,
    service_venue = case when p ? 'service_venue' then nullif(btrim(p->>'service_venue'), '') else service_venue end,
    service_at = case when p ? 'service_at' then nullif(p->>'service_at', '')::timestamptz else service_at end,
    service_notes = case when p ? 'service_notes' then nullif(btrim(p->>'service_notes'), '') else service_notes end,
    family_requests = case when p ? 'family_requests' then nullif(btrim(p->>'family_requests'), '') else family_requests end,
    donation_info = case when p ? 'donation_info' then nullif(btrim(p->>'donation_info'), '') else donation_info end,
    donation_url = case when p ? 'donation_url' then nullif(p->>'donation_url', '') else donation_url end,
    announce_in_notifications = coalesce((p->>'announce_in_notifications')::boolean, announce_in_notifications),
    announce_name_in_preview = coalesce((p->>'announce_name_in_preview')::boolean, announce_name_in_preview),
    status = 'submitted', review_message = null
   where id = p_id;
  perform public.notice_audit('funeral_corrected', null, null, p_id, jsonb_build_object('by', 'submitter'));
end $$;

-- A family can withdraw its own notice at once (no review needed to REMOVE something).
create function public.withdraw_my_funeral_notice(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.funeral_notices set status = 'withdrawn' where id = p_id and submitter_id = auth.uid() and status in ('submitted', 'in_review', 'needs_info', 'approved');
  if not found then raise exception 'Unknown notice' using errcode = 'P0002'; end if;
  perform public.notice_audit('funeral_taken_down', null, null, p_id, jsonb_build_object('by', 'submitter', 'kind', 'withdrawn'));
end $$;

-- ── public reads: ONLY approved, published, not-yet-expired notices, ONLY public fields ─────────────────────────────────────────────────────────
create function public.get_funeral_notices(p_area_ids text[] default null, p_limit integer default 20, p_offset integer default 0)
returns table (id uuid, full_name text, preferred_name text, photo_url text, born_on date, died_on date, announcement text, service_kind text, service_venue text,
               service_at timestamptz, service_notes text, family_requests text, donation_info text, donation_url text, area_id text, area_name text, published_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_nb text[];
begin
  p_limit := least(greatest(coalesce(p_limit, 20), 1), 50); p_offset := greatest(coalesce(p_offset, 0), 0);
  if p_area_ids is not null then v_nb := public.area_neighbourhood(p_area_ids); end if;
  return query
    select f.id, f.full_name, f.preferred_name, f.photo_url, f.born_on, f.died_on, f.announcement,
           case when f.service_public then f.service_kind end, case when f.service_public then f.service_venue end, case when f.service_public then f.service_at end,
           case when f.service_public then f.service_notes end, f.family_requests, f.donation_info, f.donation_url, f.area_id, a.name_display, f.published_at
      from public.funeral_notices f left join public.areas a on a.id = f.area_id
     where f.status = 'approved' and f.published_at <= now() and f.display_until > now()
       and (p_area_ids is null or f.area_id is null or f.area_id = any(coalesce(v_nb, '{}'::text[])))
     order by f.published_at desc, f.id limit p_limit offset p_offset;
end $$;

create function public.get_funeral_notice(p_id uuid)
returns table (id uuid, full_name text, preferred_name text, photo_url text, born_on date, died_on date, announcement text, service_kind text, service_venue text,
               service_at timestamptz, service_notes text, family_requests text, donation_info text, donation_url text, area_id text, area_name text, published_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select f.id, f.full_name, f.preferred_name, f.photo_url, f.born_on, f.died_on, f.announcement,
         case when f.service_public then f.service_kind end, case when f.service_public then f.service_venue end, case when f.service_public then f.service_at end,
         case when f.service_public then f.service_notes end, f.family_requests, f.donation_info, f.donation_url, f.area_id, a.name_display, f.published_at
    from public.funeral_notices f left join public.areas a on a.id = f.area_id
   where f.id = p_id and f.status = 'approved' and f.published_at <= now() and f.display_until > now();
$$;

-- ── corrections and takedown requests ────────────────────────────────────────────────────────────────────────────────────────────────────────────
create function public.request_funeral_notice_change(p_id uuid, p_kind text, p_message text, p_contact text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to send a request' using errcode = '42501'; end if;
  if p_kind not in ('correction', 'takedown') then raise exception 'Unknown request' using errcode = '22023'; end if;
  if not exists (select 1 from public.funeral_notices where id = p_id and status = 'approved') then raise exception 'Unknown notice' using errcode = 'P0002'; end if;
  if (select count(*) from public.funeral_change_requests where requester_id = auth.uid() and created_at > now() - interval '24 hours') >= 5 then
    raise exception 'Too many requests today' using errcode = '54000';
  end if;
  insert into public.funeral_change_requests (funeral_id, kind, requester_id, contact, message) values (p_id, p_kind, auth.uid(), p_contact, btrim(p_message)) returning id into v_id;
  perform public.notice_audit('funeral_change_requested', null, null, p_id, jsonb_build_object('kind', p_kind));
  return v_id;
end $$;

-- ── moderation (staff) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create function public.admin_funeral_queue(p_status text default null) returns setof public.funeral_notices
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.funeral_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  return query select * from public.funeral_notices where p_status is null or status = p_status order by created_at desc limit 200;
end $$;

create function public.admin_funeral_review(p_id uuid, p_action text, p_note text default null, p_verification_method text default null,
  p_verification_outcome text default null, p_followup text default null, p_rejection_code text default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare f public.funeral_notices%rowtype; v_until timestamptz;
begin
  if not public.funeral_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  if public.funeral_note_has_contact(p_note) then raise exception 'Do not put telephone numbers or email addresses in a note: record how it was verified in the structured fields' using errcode = '22023'; end if;
  if p_followup is not null and p_followup not in ('none', 'callback_later', 'awaiting_funeral_director', 'awaiting_family_reply', 'refer_to_administrator') then raise exception 'Unknown follow-up' using errcode = '22023'; end if;
  select * into f from public.funeral_notices where id = p_id for update;
  if not found then raise exception 'Unknown notice' using errcode = 'P0002'; end if;
  if p_action = 'start_review' then
    if f.status not in ('submitted', 'needs_info') then raise exception 'Not awaiting review' using errcode = '22023'; end if;
    update public.funeral_notices set status = 'in_review', reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
  elsif p_action = 'request_info' then
    if f.status not in ('submitted', 'in_review') then raise exception 'Not under review' using errcode = '22023'; end if;
    if p_note is null or btrim(p_note) = '' then raise exception 'Say what is needed' using errcode = '22023'; end if;
    update public.funeral_notices set status = 'needs_info', review_message = btrim(p_note), followup_action = coalesce(p_followup, 'awaiting_family_reply'), reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
  elsif p_action = 'approve' then
    if f.status not in ('submitted', 'in_review') then raise exception 'Not under review' using errcode = '22023'; end if;
    if p_verification_method is null then raise exception 'Record how the announcement was verified (method) before approving' using errcode = '22023'; end if;
    if p_verification_outcome is not null and p_verification_outcome <> 'confirmed' then raise exception 'A notice can only be approved when the verification outcome is confirmed' using errcode = '22023'; end if;     -- approving IS confirming
    v_until := coalesce(f.service_at, now()) + interval '60 days';
    update public.funeral_notices set status = 'approved', verification_method = p_verification_method, verification_outcome = 'confirmed', verified_by = auth.uid(), verified_at = now(),
           verification_note = nullif(btrim(coalesce(p_note, '')), ''), followup_action = coalesce(p_followup, 'none'), reviewed_by = auth.uid(), reviewed_at = now(), published_at = now(),
           display_until = greatest(v_until, now() + interval '14 days'), review_message = null where id = p_id;
  elsif p_action = 'reject' then
    if f.status not in ('submitted', 'in_review', 'needs_info') then raise exception 'Not under review' using errcode = '22023'; end if;
    if p_rejection_code is not null and p_rejection_code not in ('unverifiable', 'duplicate', 'not_a_funeral_announcement', 'inappropriate', 'other') then raise exception 'Unknown rejection reason' using errcode = '22023'; end if;
    update public.funeral_notices set status = 'rejected', review_note = btrim(coalesce(p_note, '')), review_message = nullif(btrim(coalesce(p_note, '')), ''), rejection_code = p_rejection_code,
           verification_outcome = coalesce(p_verification_outcome, verification_outcome), followup_action = coalesce(p_followup, 'none'), reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
  else
    raise exception 'Unknown action' using errcode = '22023';
  end if;
  perform public.notice_audit(case p_action when 'approve' then 'funeral_published' else 'funeral_reviewed' end, null, null, p_id, jsonb_build_object('action', p_action, 'method', p_verification_method, 'outcome', p_verification_outcome));
  return (select status from public.funeral_notices where id = p_id);
end $$;

create function public.admin_funeral_takedown(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.funeral_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  if public.funeral_note_has_contact(p_reason) then raise exception 'Do not put telephone numbers or email addresses in a note' using errcode = '22023'; end if;
  update public.funeral_notices set status = 'taken_down', review_note = btrim(coalesce(p_reason, '')), reviewed_by = auth.uid(), reviewed_at = now() where id = p_id and status = 'approved';
  if not found then raise exception 'Unknown published notice' using errcode = 'P0002'; end if;
  perform public.notice_audit('funeral_taken_down', null, null, p_id, jsonb_build_object('by', 'staff', 'reason', p_reason));
end $$;

create function public.admin_funeral_change_requests() returns setof public.funeral_change_requests
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.funeral_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  return query select * from public.funeral_change_requests where status = 'open' order by created_at;
end $$;

create function public.admin_funeral_resolve_change(p_request uuid, p_outcome text, p_note text default null, p_correction jsonb default null, p_authority_check text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.funeral_change_requests%rowtype;
begin
  if not public.funeral_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  if p_outcome not in ('actioned', 'declined') then raise exception 'Unknown outcome' using errcode = '22023'; end if;
  if p_authority_check is not null and p_authority_check not in ('funeral_director_confirmation', 'independent_contact', 'original_submitter', 'not_verified') then raise exception 'Unknown authority check' using errcode = '22023'; end if;
  if public.funeral_note_has_contact(p_note) then raise exception 'Do not put telephone numbers or email addresses in a note' using errcode = '22023'; end if;
  select * into r from public.funeral_change_requests where id = p_request and status = 'open' for update;
  if not found then raise exception 'Unknown open request' using errcode = 'P0002'; end if;
  -- a NO-ACCOUNT request is never trusted by itself: staff must record how the requester's authority was established independently before anything changes
  if p_outcome = 'actioned' and r.source in ('public', 'staff_logged') and coalesce(p_authority_check, 'not_verified') = 'not_verified' then
    raise exception 'Verify the requester independently (funeral director or independent contact) and record how before acting' using errcode = '22023';
  end if;
  if p_outcome = 'actioned' and r.kind = 'takedown' then perform public.admin_funeral_takedown(r.funeral_id, coalesce(p_note, 'Takedown requested')); end if;
  if p_outcome = 'actioned' and r.kind = 'correction' and p_correction is not null then
    update public.funeral_notices set
      preferred_name = case when p_correction ? 'preferred_name' then nullif(btrim(p_correction->>'preferred_name'), '') else preferred_name end,
      announcement = case when p_correction ? 'announcement' then nullif(btrim(p_correction->>'announcement'), '') else announcement end,
      service_venue = case when p_correction ? 'service_venue' then nullif(btrim(p_correction->>'service_venue'), '') else service_venue end,
      service_at = case when p_correction ? 'service_at' then nullif(p_correction->>'service_at', '')::timestamptz else service_at end,
      service_notes = case when p_correction ? 'service_notes' then nullif(btrim(p_correction->>'service_notes'), '') else service_notes end,
      family_requests = case when p_correction ? 'family_requests' then nullif(btrim(p_correction->>'family_requests'), '') else family_requests end,
      donation_info = case when p_correction ? 'donation_info' then nullif(btrim(p_correction->>'donation_info'), '') else donation_info end
     where id = r.funeral_id and status = 'approved';
    perform public.notice_audit('funeral_corrected', null, null, r.funeral_id, jsonb_build_object('by', 'staff', 'request', p_request));
  end if;
  update public.funeral_change_requests set status = p_outcome, handled_by = auth.uid(), handled_at = now(), outcome_note = p_note, authority_check = p_authority_check,
         contact = null, contact_name = null where id = p_request;     -- the enquirer's details are not needed once the outcome is recorded
end $$;

-- ── notification: only what the family approved, discreetly; never a name unless they said so ───────────────────────────────────────────────────
create function public.funeral_notification_text(p_id uuid) returns table (title text, body text)
language sql stable security definer set search_path = public, pg_temp as $$
  select 'A funeral announcement'::text,
         case when f.announce_name_in_preview then 'A notice has been published for ' || coalesce(f.preferred_name, f.full_name) || coalesce(' (' || a.name_display || ')', '') || '.'
              else 'A notice has been published' || coalesce(' for the ' || a.name_display || ' area', '') || '.' end
    from public.funeral_notices f left join public.areas a on a.id = f.area_id where f.id = p_id;
$$;

create function public.funeral_dispatchable(p_id uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f public.funeral_notices%rowtype;
begin
  select * into f from public.funeral_notices where id = p_id;
  if not found then return 'That notice does not exist'; end if;
  if f.status <> 'approved' or f.published_at > now() or f.display_until <= now() then return 'That notice is not published'; end if;
  if not f.announce_in_notifications then return 'The family has not approved a notification'; end if;
  return null;
end $$;

create function public.funeral_claim_dispatch(p_id uuid, p_by uuid default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_reason text := public.funeral_dispatchable(p_id); v_row public.notice_dispatches%rowtype;
begin
  if v_reason is not null then raise exception '%', v_reason using errcode = '22023'; end if;
  select * into v_row from public.notice_dispatches where subject_type = 'funeral' and subject_id = p_id and kind = 'funeral' for update;
  if found then
    if v_row.status = 'completed' then raise exception 'Already announced' using errcode = '23505'; end if;
    if v_row.status = 'claimed' and v_row.claimed_at > now() - interval '10 minutes' then raise exception 'A dispatch is already in progress' using errcode = '23505'; end if;
    update public.notice_dispatches set status = 'claimed', claimed_at = now(), error = null where id = v_row.id; return v_row.id;
  end if;
  insert into public.notice_dispatches (subject_type, subject_id, kind, claimed_by) values ('funeral', p_id, 'funeral', p_by) returning id into v_row.id;
  perform public.notice_audit('dispatch_claimed', null, null, p_id, jsonb_build_object('kind', 'funeral', 'by', p_by));
  return v_row.id;
end $$;

-- Opted-in (funeral_notices) members who follow the notice's area, its parent or children; a notice with no area goes to every opted-in member.
create function public.funeral_dispatch_recipients(p_id uuid, p_limit integer default 1000) returns table (user_id uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f public.funeral_notices%rowtype; v_nb text[];
begin
  if public.funeral_dispatchable(p_id) is not null then return; end if;
  select * into f from public.funeral_notices where id = p_id;
  if f.area_id is not null then v_nb := public.area_neighbourhood(array[f.area_id]); end if;
  return query
    select distinct p.user_id from public.notice_notification_prefs p
     where p.funeral_notices
       and (f.area_id is null or exists (select 1 from public.member_areas ma where ma.user_id = p.user_id and ma.area_id = any(v_nb)))
       and not exists (select 1 from public.notice_deliveries d where d.subject_type = 'funeral' and d.subject_id = p_id and d.user_id = p.user_id and (d.status in ('sent', 'held_quiet', 'skipped') or d.attempts >= 3))
     limit least(greatest(coalesce(p_limit, 1000), 1), 5000);
end $$;

create function public.funeral_record_delivery(p_id uuid, p_user uuid, p_status text, p_error text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_status not in ('sent', 'held_quiet', 'skipped', 'failed') then raise exception 'Unknown delivery status' using errcode = '22023'; end if;
  insert into public.notice_deliveries (subject_type, subject_id, user_id, kind, status, attempts, last_error)
  values ('funeral', p_id, p_user, 'funeral', p_status, case when p_status = 'failed' then 1 else 0 end, left(p_error, 300))
  on conflict (subject_type, subject_id, user_id) do update set status = excluded.status, attempts = public.notice_deliveries.attempts + case when excluded.status = 'failed' then 1 else 0 end,
        last_error = excluded.last_error, updated_at = now() where public.notice_deliveries.status not in ('sent', 'held_quiet', 'skipped');
end $$;

-- ── grants ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
revoke all on function public.funeral_note_has_contact(text) from public, anon, authenticated;
revoke all on function public.funeral_staff(), public.admin_set_funeral_director(text, uuid, boolean), public.submit_funeral_notice(jsonb), public.my_funeral_submissions(), public.my_funeral_submission(uuid),
  public.update_my_funeral_submission(uuid, jsonb), public.withdraw_my_funeral_notice(uuid), public.get_funeral_notices(text[], integer, integer), public.get_funeral_notice(uuid),
  public.request_funeral_notice_change(uuid, text, text, text), public.admin_funeral_queue(text), public.admin_funeral_review(uuid, text, text, text, text, text, text),
  public.admin_funeral_takedown(uuid, text), public.admin_funeral_change_requests(), public.admin_funeral_resolve_change(uuid, text, text, jsonb, text),
  public.funeral_notification_text(uuid), public.funeral_dispatchable(uuid), public.funeral_claim_dispatch(uuid, uuid), public.funeral_dispatch_recipients(uuid, integer),
  public.funeral_record_delivery(uuid, uuid, text, text), public.can_dispatch_funeral(uuid) from public, anon, authenticated;
grant execute on function public.get_funeral_notices(text[], integer, integer), public.get_funeral_notice(uuid) to anon, authenticated, service_role;
grant execute on function public.funeral_staff(), public.admin_set_funeral_director(text, uuid, boolean), public.submit_funeral_notice(jsonb), public.my_funeral_submissions(), public.my_funeral_submission(uuid),
  public.update_my_funeral_submission(uuid, jsonb), public.withdraw_my_funeral_notice(uuid), public.request_funeral_notice_change(uuid, text, text, text),
  public.admin_funeral_queue(text), public.admin_funeral_review(uuid, text, text, text, text, text, text), public.admin_funeral_takedown(uuid, text), public.admin_funeral_change_requests(),
  public.admin_funeral_resolve_change(uuid, text, text, jsonb, text) to authenticated;
grant execute on function public.funeral_notification_text(uuid), public.funeral_dispatchable(uuid), public.funeral_claim_dispatch(uuid, uuid),
  public.funeral_dispatch_recipients(uuid, integer), public.funeral_record_delivery(uuid, uuid, text, text), public.can_dispatch_funeral(uuid) to service_role;

commit;
