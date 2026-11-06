-- Events & Activities, Phase 1 (part 2 of 2): ordinary-member event submissions with staff moderation.
--
-- An ordinary member cannot create an event: the events INSERT policy, the attribution guard and the CHECK events_attribution_exclusive are NOT touched.
-- Instead a member files a SUBMISSION (a private row only they and staff can see). Staff approve it, and approval - in one transaction - creates a
-- PLATFORM-owned event (is_platform_event = true, no business, no hub) plus its occurrence rows. The member never gets write access to the event.
--
-- Master switch: admin_config key 'events.member_submissions'. Submissions are CLOSED unless the value is 'open' (case/space-insensitive, as
-- fetch_is_open() does for 'fetch.operations'). The config row is deliberately NOT inserted here: absent = closed.
-- Staff (admin/moderator) may submit while the switch is closed, so the flow can be acceptance-tested without opening it to the public. That is safe:
-- a staff submission still waits in the queue and publishes nothing, and staff can already create platform events directly.
--
-- No emails, no notifications, no triggers that contact anyone.
--
-- SHARED CATEGORY LIST (slug -> label stored in events.category on approval). Legacy events.category values are untouched.
--   theatre_performing_arts  Theatre & Performing Arts   (NEW label)
--   music_gigs               Music
--   festivals                Festival
--   exhibitions_arts_culture Arts & Culture
--   markets_fairs            Market
--   fundraising_charity      Charity
--   talks_workshops          Community        (no chip of its own)
--   community                Community
--   food_drink               Food & Drink
--   outdoors                 Outdoors
--   family                   Family
--   sport                    Sport
--   business                 Business
--   heritage                 Arts & Culture   (no chip of its own)
--   comedy_film_literature   Arts & Culture   (no chip of its own)
--   other                    Other

begin;

-- ── category list: ONE source for validation and for the stored label ──────────────────────────────────────────────────────────────────────────
create or replace function public.event_category_label(p_slug text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case p_slug
    when 'theatre_performing_arts'  then 'Theatre & Performing Arts'
    when 'music_gigs'               then 'Music'
    when 'festivals'                then 'Festival'
    when 'exhibitions_arts_culture' then 'Arts & Culture'
    when 'markets_fairs'            then 'Market'
    when 'fundraising_charity'      then 'Charity'
    when 'talks_workshops'          then 'Community'
    when 'community'                then 'Community'
    when 'food_drink'               then 'Food & Drink'
    when 'outdoors'                 then 'Outdoors'
    when 'family'                   then 'Family'
    when 'sport'                    then 'Sport'
    when 'business'                 then 'Business'
    when 'heritage'                 then 'Arts & Culture'
    when 'comedy_film_literature'   then 'Arts & Culture'
    when 'other'                    then 'Other'
  end;
$$;

-- Text rules in the style of activity_message_problem(): no links, no web addresses; phone numbers and e-mail addresses unless p_allow_contact.
-- (Hyphens are NOT stripped before the long-digit test, so a date such as 12-11-2026 is not mistaken for a phone number.)
create or replace function public.event_submission_text_problem(p text, p_allow_contact boolean default false) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case
    when p ~* '(https?://|ftp://|www\.)' then 'Links are not allowed here.'
    when not p_allow_contact and position('@' in p) > 0 then 'Email addresses are not allowed here.'
    -- where e-mail addresses are allowed (contact details) their domain must not trip the web-address test
    when x.q ~* '(^|[^a-z0-9-])[a-z0-9][a-z0-9-]*\.(com|co\.uk|uk|org|net|scot|io|me|ly|info|biz|app|dev|link|gl|xyz|tk|site|online|shop|store|page|tv|eu|ie|us|ca|au|nz|fm|to|cc|ws|top|club|live|news|email|cloud)($|[^a-z0-9])' then 'Web addresses are not allowed here.'
    when not p_allow_contact and (regexp_replace(p, '[ ()]', '', 'g') ~ '\d{7,}' or p ~ '(\+|(^|[^0-9])00)\s?44' or regexp_replace(p, '[ ()\-]', '', 'g') ~ '(^|[^0-9])0[127]\d{8,9}($|[^0-9])')
      then 'Phone numbers are not allowed here.'
    else null end
  from (select case when p_allow_contact then regexp_replace(p, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+', '', 'g') else p end as q) x
$$;

-- ── table ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table public.event_submissions (
  id              uuid primary key default gen_random_uuid(),
  submitter_id    uuid not null references public.profiles(id) on delete cascade,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'changes_requested', 'withdrawn')),
  organiser_name  text not null check (organiser_name = btrim(organiser_name) and char_length(organiser_name) between 1 and 120),
  title           text not null check (title = btrim(title) and char_length(title) between 1 and 200),
  description     text not null check (char_length(description) between 1 and 2000),
  category        text not null check (public.event_category_label(category) is not null),
  venue           text not null check (char_length(venue) between 1 and 200),
  locality        text check (locality is null or char_length(locality) between 1 and 100),
  lat             numeric check (lat is null or lat between -90 and 90),
  lng             numeric check (lng is null or lng between -180 and 180),
  cover_url       text check (cover_url is null or char_length(cover_url) <= 500),
  contact_info    text check (contact_info is null or char_length(contact_info) <= 300),
  ticket_url      text check (ticket_url is null or (char_length(ticket_url) <= 500 and ticket_url ~ '^https://[^\s/]+(/\S*)?$')),
  price_text      text check (price_text is null or char_length(price_text) <= 100),
  occurrences     jsonb not null check (jsonb_typeof(occurrences) = 'array' and jsonb_array_length(occurrences) between 1 and 60),
  adult_confirmed boolean not null check (adult_confirmed),
  review_reason   text check (review_reason is null or char_length(review_reason) <= 500),
  reviewed_by     uuid references public.profiles(id) on delete set null,
  reviewed_at     timestamptz,
  event_id        uuid references public.events(id) on delete set null,
  request_id      uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint event_submissions_request_key unique (submitter_id, request_id),
  constraint event_submissions_latlng_pair check ((lat is null) = (lng is null))
);
-- ── attribution: a community event is platform-OWNED but must never read as OneShetland-organised ───────────────────────────────────────────────
-- Reader rule: OFFICIAL OneShetland event = is_platform_event AND source IS NULL.  COMMUNITY event = source = 'community_submission' (show organiser_name).
-- Rows that exist today have source NULL, so every existing platform event stays official.
alter table public.events add column if not exists source text;
alter table public.events add column if not exists submission_id uuid;
alter table public.events add constraint events_source_check check (source is null or source = 'community_submission');
alter table public.events add constraint events_community_needs_organiser check
  (source is null or (is_platform_event and organiser_name is not null and btrim(organiser_name) <> ''));

create index idx_event_submissions_status on public.event_submissions (status, created_at);
create index idx_event_submissions_submitter on public.event_submissions (submitter_id, created_at desc);

alter table public.events add constraint events_submission_id_fkey foreign key (submission_id) references public.event_submissions(id) on delete set null;

create function public.tg_event_submissions_touch() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at := now(); return new; end $$;
create trigger tg_event_submissions_touch before update on public.event_submissions for each row execute function public.tg_event_submissions_touch();

alter table public.event_submissions enable row level security;
revoke all on public.event_submissions from public, anon, authenticated;
grant select on public.event_submissions to authenticated;          -- RLS narrows it; there is NO client INSERT / UPDATE / DELETE - every write is a function
grant all on public.event_submissions to service_role;
create policy event_submissions_own_read on public.event_submissions for select to authenticated using (submitter_id = auth.uid());
create policy event_submissions_staff_read on public.event_submissions for select to authenticated using (public.attribution_staff());

-- ── switch ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.event_submissions_open() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select lower(btrim(value)) from public.admin_config where key = 'events.member_submissions'), 'closed') = 'open'
$$;

-- ── shared validation (used by submit AND by the change-request flow in the next migration) ──────────────────────────────────────────────────
create or replace function public.event_submission_ts(p jsonb) returns timestamptz
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p is null or jsonb_typeof(p) <> 'string' then return null; end if;
  -- an explicit offset is required: a bare local time would be read in whatever time zone the session happens to use
  if (p #>> '{}') !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$' then return null; end if;
  return (p #>> '{}')::timestamptz;
exception when others then return null;
end $$;

-- One field -> cleaned text (null for an empty optional one). Raises a plain-English P0001 with the field name as hint.
create or replace function public.event_clean_field(p_name text, p_val jsonb, p_uid uuid) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare v text; v_problem text; v_max int;
begin
  if p_val is not null and jsonb_typeof(p_val) not in ('string', 'null') then raise exception '% must be text', p_name using errcode = '22023'; end if;
  v := case when p_val is null or jsonb_typeof(p_val) = 'null' then null else p_val #>> '{}' end;
  if p_name = 'description' then
    v := btrim(regexp_replace(replace(coalesce(v, ''), E'\r', ''), '[\x01-\x09\x0b-\x1f\x7f]', '', 'g'), E' \n\t');
  else
    v := btrim(regexp_replace(coalesce(v, ''), '[\x00-\x1f\x7f]', '', 'g'));
  end if;
  v := nullif(v, '');
  if p_name in ('organiser_name', 'title', 'description', 'venue') and v is null then
    raise exception 'Please fill in the % field.', replace(p_name, '_', ' ') using errcode = 'P0001', hint = p_name;
  end if;
  if v is null then return null; end if;
  v_max := case p_name when 'organiser_name' then 120 when 'title' then 200 when 'description' then 2000 when 'venue' then 200 when 'locality' then 100
                       when 'price_text' then 100 when 'contact_info' then 300 else 500 end;
  if char_length(v) > v_max then
    raise exception 'The % is too long.', replace(p_name, '_', ' ') using errcode = 'P0001', hint = p_name;
  end if;
  if p_name = 'category' then
    if public.event_category_label(v) is null then raise exception 'Choose a category from the list.' using errcode = 'P0001', hint = 'category'; end if;
  elsif p_name = 'ticket_url' then
    if v !~ '^https://[^\s/]+(/\S*)?$' then raise exception 'A ticket link must start with https://' using errcode = 'P0001', hint = 'ticket_url'; end if;
  elsif p_name = 'cover_url' then
    -- event-media is the public bucket; its write policy keys the first folder on the signed-in user (see the storage migration), so the poster must be the person's own
    if p_uid is null or v !~ ('^https://nkrtmakxygkvxuxriiil\.supabase\.co/storage/v1/object/public/event-media/' || p_uid::text || '/events/[A-Za-z0-9._~%-]+$') then
      raise exception 'Upload the picture through OneShetland to use it as a cover.' using errcode = 'P0001', hint = 'cover_url';
    end if;
  else
    v_problem := public.event_submission_text_problem(v, p_name = 'contact_info');
    if v_problem is not null then raise exception '%', replace(v_problem, 'here', 'in the ' || replace(p_name, '_', ' ')) using errcode = 'P0001', hint = p_name; end if;
  end if;
  return v;
end $$;

-- Occurrence list -> normalised, sorted jsonb array. 1..60 items {starts_at, ends_at?, note?}; all in the future at p_now; ends after starts; whole span <= 400 days.
create or replace function public.event_validate_occurrences(v_occ jsonb, v_now timestamptz) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare v_item jsonb; v_norm jsonb := '[]'::jsonb; v_s timestamptz; v_e timestamptz; v_note text; v_first timestamptz; v_last timestamptz; v_seen timestamptz[] := '{}'; v_problem text;
begin
  if jsonb_typeof(v_occ) is distinct from 'array' or jsonb_array_length(v_occ) < 1 then raise exception 'Add at least one date.' using errcode = 'P0001', hint = 'occurrences'; end if;
  if jsonb_array_length(v_occ) > 60 then raise exception 'An event can have up to 60 dates.' using errcode = 'P0001', hint = 'occurrences'; end if;
  for v_item in select * from jsonb_array_elements(v_occ) loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'Each date must have a start time.' using errcode = 'P0001', hint = 'occurrences'; end if;
    v_s := public.event_submission_ts(v_item -> 'starts_at');
    if v_s is null then raise exception 'Each date needs a valid start time with a time zone.' using errcode = 'P0001', hint = 'occurrences'; end if;
    v_e := null;
    if v_item ? 'ends_at' and jsonb_typeof(v_item -> 'ends_at') <> 'null' then
      v_e := public.event_submission_ts(v_item -> 'ends_at');
      if v_e is null then raise exception 'An end time is not valid.' using errcode = 'P0001', hint = 'occurrences'; end if;
      if v_e <= v_s then raise exception 'An end time must be after its start time.' using errcode = 'P0001', hint = 'occurrences'; end if;
    end if;
    if v_s <= v_now then raise exception 'Dates must be in the future.' using errcode = 'P0001', hint = 'occurrences'; end if;
    if v_s = any (v_seen) then raise exception 'The same start time is listed twice.' using errcode = 'P0001', hint = 'occurrences'; end if;
    v_seen := v_seen || v_s;
    v_note := null;
    if v_item ? 'note' and jsonb_typeof(v_item -> 'note') <> 'null' then
      if jsonb_typeof(v_item -> 'note') <> 'string' then raise exception 'A date note must be text.' using errcode = 'P0001', hint = 'occurrences'; end if;
      v_note := nullif(btrim(v_item ->> 'note'), '');
      if v_note is not null and char_length(v_note) > 200 then raise exception 'A date note can be up to 200 characters.' using errcode = 'P0001', hint = 'occurrences'; end if;
      v_problem := case when v_note is null then null else public.event_submission_text_problem(v_note) end;
      if v_problem is not null then raise exception '%', replace(v_problem, 'here', 'in a date note') using errcode = 'P0001', hint = 'occurrences'; end if;
    end if;
    v_first := least(coalesce(v_first, v_s), v_s);
    v_last := greatest(coalesce(v_last, coalesce(v_e, v_s)), coalesce(v_e, v_s));
    v_norm := v_norm || jsonb_strip_nulls(jsonb_build_object(
      'starts_at', to_char(v_s at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'ends_at', case when v_e is not null then to_char(v_e at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
      'note', v_note));
  end loop;
  if v_last - v_first > interval '400 days' then raise exception 'The dates must fall within 400 days of each other.' using errcode = 'P0001', hint = 'occurrences'; end if;
  select jsonb_agg(x order by x ->> 'starts_at') into v_norm from jsonb_array_elements(v_norm) x;
  return v_norm;
end $$;

-- ── submit ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.submit_event_submission(payload jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_req uuid; v_ex uuid;
  v_org text; v_title text; v_desc text; v_cat text; v_venue text; v_loc text; v_cover text; v_contact text; v_ticket text; v_price text;
  v_lat numeric; v_lng numeric; v_norm jsonb; v_now timestamptz := now(); v_id uuid;
begin
  if v_uid is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if payload is null or jsonb_typeof(payload) <> 'object' then raise exception 'Send the event as an object' using errcode = '22023'; end if;
  if octet_length(payload::text) > 60000 then raise exception 'That submission is too large' using errcode = '22023'; end if;
  if not public.attribution_staff() and not public.event_submissions_open() then
    raise exception 'Event submissions are not open yet.' using errcode = 'P0001', hint = 'closed';
  end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid and coalesce(p.is_active, true) and p.deleted_at is null) then
    raise exception 'Your account cannot submit events' using errcode = '42501';
  end if;

  if jsonb_typeof(payload -> 'request_id') is distinct from 'string' or (payload ->> 'request_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'A request id is required' using errcode = '22023';
  end if;
  v_req := (payload ->> 'request_id')::uuid;

  -- Concurrent submissions by one person take turns, so the limits below cannot be raced.
  perform pg_advisory_xact_lock(hashtextextended('event-submission:' || v_uid::text, 0));
  select id into v_ex from public.event_submissions where submitter_id = v_uid and request_id = v_req;
  if found then return v_ex; end if;                                    -- a retry or double tap returns the first result and writes nothing

  v_org := public.event_clean_field('organiser_name', payload -> 'organiser_name', v_uid);
  v_title := public.event_clean_field('title', payload -> 'title', v_uid);
  v_desc := public.event_clean_field('description', payload -> 'description', v_uid);
  v_cat := public.event_clean_field('category', payload -> 'category', v_uid);
  if v_cat is null then raise exception 'Choose a category from the list.' using errcode = 'P0001', hint = 'category'; end if;
  v_venue := public.event_clean_field('venue', payload -> 'venue', v_uid);
  v_loc := public.event_clean_field('locality', payload -> 'locality', v_uid);
  v_price := public.event_clean_field('price_text', payload -> 'price_text', v_uid);
  v_contact := public.event_clean_field('contact_info', payload -> 'contact_info', v_uid);
  v_ticket := public.event_clean_field('ticket_url', payload -> 'ticket_url', v_uid);
  v_cover := public.event_clean_field('cover_url', payload -> 'cover_url', v_uid);

  if (payload -> 'lat' is not null and jsonb_typeof(payload -> 'lat') <> 'null') or (payload -> 'lng' is not null and jsonb_typeof(payload -> 'lng') <> 'null') then
    if jsonb_typeof(payload -> 'lat') is distinct from 'number' or jsonb_typeof(payload -> 'lng') is distinct from 'number' then
      raise exception 'Give both a latitude and a longitude, or neither.' using errcode = 'P0001', hint = 'lat';
    end if;
    v_lat := (payload ->> 'lat')::numeric; v_lng := (payload ->> 'lng')::numeric;
    if v_lat not between -90 and 90 or v_lng not between -180 and 180 then raise exception 'That map position is not valid.' using errcode = 'P0001', hint = 'lat'; end if;
  end if;

  if payload -> 'adult_confirmed' is distinct from 'true'::jsonb then
    raise exception 'Please confirm you are 18 or over and have the organiser''s permission to submit this event.' using errcode = 'P0001', hint = 'adult_confirmed';
  end if;

  v_norm := public.event_validate_occurrences(payload -> 'occurrences', v_now);

  -- limits (staff share the per-person caps)
  if (select count(*) from public.event_submissions where submitter_id = v_uid and status = 'pending') >= 3 then
    raise exception 'You already have 3 submissions waiting for review. Please wait for a decision or withdraw one.' using errcode = 'P0001', hint = 'pending_limit';
  end if;
  if (select count(*) from public.event_submissions where submitter_id = v_uid and created_at > v_now - interval '24 hours') >= 10 then
    raise exception 'You can send 10 submissions in any 24 hours. Please try again later.' using errcode = 'P0001', hint = 'daily_limit';
  end if;
  if (select count(*) from public.event_submissions where status = 'pending') >= 500 then
    raise exception 'We have a lot of submissions waiting. Please try again later.' using errcode = 'P0001', hint = 'global_limit';
  end if;

  insert into public.event_submissions (submitter_id, organiser_name, title, description, category, venue, locality, lat, lng, cover_url, contact_info, ticket_url, price_text,
                                        occurrences, adult_confirmed, request_id)
  values (v_uid, v_org, v_title, v_desc, v_cat, v_venue, v_loc, v_lat, v_lng, v_cover, v_contact, v_ticket, v_price, v_norm, true, v_req)
  returning id into v_id;
  return v_id;
end $$;

-- ── withdraw ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.withdraw_event_submission(p_id uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); s public.event_submissions;
begin
  if v_uid is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  select * into s from public.event_submissions where id = p_id and submitter_id = v_uid for update;
  -- unknown and not-yours are the same answer
  if not found then raise exception 'You cannot withdraw that submission' using errcode = '42501'; end if;
  if s.status = 'withdrawn' then return 'withdrawn'; end if;
  if s.status not in ('pending', 'changes_requested') then raise exception 'This submission has already been decided' using errcode = 'P0001', hint = 'decided'; end if;
  update public.event_submissions set status = 'withdrawn' where id = p_id;
  return 'withdrawn';
end $$;

-- ── staff review ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.admin_review_event_submission(p_id uuid, p_decision text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid(); s public.event_submissions; v_reason text := nullif(btrim(p_reason), '');
  v_event uuid; v_first jsonb; v_item jsonb; v_future int; v_all_s timestamptz;
begin
  if v_uid is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can review submissions' using errcode = '42501'; end if;
  if p_decision not in ('approve', 'reject', 'changes_requested') then raise exception 'Decision must be approve, reject or changes_requested' using errcode = '22023'; end if;
  if p_decision <> 'approve' and v_reason is null then raise exception 'Give a reason for the member' using errcode = 'P0001', hint = 'reason_required'; end if;
  if v_reason is not null and char_length(v_reason) > 500 then raise exception 'The reason can be up to 500 characters' using errcode = 'P0001', hint = 'reason_too_long'; end if;

  select * into s from public.event_submissions where id = p_id for update;                    -- two staff clicking at once take turns
  if not found then raise exception 'No such submission' using errcode = 'P0002'; end if;

  if p_decision = 'approve' and s.status = 'approved' then
    return jsonb_build_object('id', s.id, 'status', 'approved', 'event_id', s.event_id, 'duplicate', true);   -- double approve: one event
  end if;
  if s.status <> 'pending' then raise exception 'This submission is % and can no longer be decided', s.status using errcode = 'P0001', hint = 'not_pending'; end if;

  if p_decision <> 'approve' then
    update public.event_submissions set status = case p_decision when 'reject' then 'rejected' else p_decision end, review_reason = v_reason, reviewed_by = v_uid, reviewed_at = now() where id = p_id;
    return jsonb_build_object('id', s.id, 'status', case p_decision when 'reject' then 'rejected' else p_decision end, 'event_id', null, 'duplicate', false);
  end if;

  select count(*) into v_future from jsonb_array_elements(s.occurrences) o where (o ->> 'starts_at')::timestamptz > now();
  if v_future = 0 then raise exception 'Every date on this submission has passed. Ask the member to submit it again.' using errcode = 'P0001', hint = 'all_dates_passed'; end if;

  v_first := s.occurrences -> 0;
  -- Runs as the function owner, so the attribution guard takes its "server path" (current_user is not authenticated/anon). The CHECK still holds:
  -- platform event, no business, no hub. organiser_user_id records the submitter for audit only; it is never read as authority.
  insert into public.events (organiser_user_id, organiser_name, title, description, category, venue, locality, lat, lng, starts_at, ends_at, cover_url, price_text, ticket_url,
                             contact_info, status, has_tickets, is_platform_event, organiser_business_id, organiser_hub_id, source, submission_id)
  values (s.submitter_id, s.organiser_name, s.title, s.description, public.event_category_label(s.category), s.venue, s.locality, s.lat, s.lng,
          (v_first ->> 'starts_at')::timestamptz, (v_first ->> 'ends_at')::timestamptz, s.cover_url, s.price_text, s.ticket_url, s.contact_info,
          'published', false, true, null, null, 'community_submission', s.id)
  returning id into v_event;

  -- One date = a plain one-off event, no child rows. Several = occurrence rows; the sync trigger then sets the parent's span and is_dated_run.
  if jsonb_array_length(s.occurrences) > 1 then
    insert into public.event_occurrences (event_id, starts_at, ends_at, note)
    select v_event, (o ->> 'starts_at')::timestamptz, (o ->> 'ends_at')::timestamptz, o ->> 'note' from jsonb_array_elements(s.occurrences) o;
  end if;

  update public.event_submissions set status = 'approved', event_id = v_event, review_reason = v_reason, reviewed_by = v_uid, reviewed_at = now() where id = p_id;
  return jsonb_build_object('id', s.id, 'status', 'approved', 'event_id', v_event, 'duplicate', false);
end $$;

-- ── staff queue ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.admin_event_submission_counts() returns table (pending int, changes_requested int, oldest_pending_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can do this' using errcode = '42501'; end if;
  return query select count(*) filter (where s.status = 'pending')::int, count(*) filter (where s.status = 'changes_requested')::int,
                      min(s.created_at) filter (where s.status = 'pending')
                 from public.event_submissions s;
end $$;

create or replace function public.admin_list_event_submissions(p_status text default 'pending', p_limit int default 50)
returns table (id uuid, submitter_id uuid, status text, organiser_name text, title text, category text, occurrence_count int, first_starts_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can do this' using errcode = '42501'; end if;
  return query
    select s.id, s.submitter_id, s.status, s.organiser_name, s.title, s.category, jsonb_array_length(s.occurrences),
           (s.occurrences -> 0 ->> 'starts_at')::timestamptz, s.created_at
      from public.event_submissions s where s.status = p_status order by s.created_at limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

-- ── events guard, extended: clients can never set or change source / submission_id / organiser_name ──────────────────────────────────────────
-- (A business or hub owner editing their own event must not be able to dress it up as a community event or rename an organiser; staff may.)
create or replace function public.tg_events_occurrence_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;     -- server path and the definer functions
  if tg_op = 'INSERT' then
    new.is_dated_run := false;
    if not public.attribution_staff() then new.source := null; new.submission_id := null; new.organiser_name := null; end if;
    return new;
  end if;
  new.is_dated_run := old.is_dated_run;
  if not public.attribution_staff() then
    new.source := old.source; new.submission_id := old.submission_id; new.organiser_name := old.organiser_name;
  end if;
  if (new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at)
     and public.event_has_occurrences(old.id) then
    raise exception 'This event has dated occurrences - change the dates there, not on the event itself' using errcode = 'P0001', hint = 'edit_occurrences';
  end if;
  return new;
end $$;

-- ── privileges: anon never; authenticated only where meant ─────────────────────────────────────────────────────────────────────────────────────
revoke all on function public.event_category_label(text), public.event_submission_text_problem(text, boolean), public.event_submissions_open(), public.event_submission_ts(jsonb),
  public.tg_event_submissions_touch(), public.event_clean_field(text, jsonb, uuid), public.event_validate_occurrences(jsonb, timestamptz),
  public.submit_event_submission(jsonb), public.withdraw_event_submission(uuid), public.admin_review_event_submission(uuid, text, text),
  public.admin_event_submission_counts(), public.admin_list_event_submissions(text, int) from public, anon, authenticated;
grant execute on function public.event_category_label(text) to authenticated, service_role;      -- the table CHECK calls it as the writer
grant execute on function public.event_submissions_open() to authenticated, service_role;        -- lets the app show "not open yet" instead of a form
grant execute on function public.submit_event_submission(jsonb), public.withdraw_event_submission(uuid), public.admin_review_event_submission(uuid, text, text),
  public.admin_event_submission_counts(), public.admin_list_event_submissions(text, int) to authenticated, service_role;

commit;
