-- Notices & Alerts - step 2: the three-level hierarchy, the Essential Alert designation, official publishing, and the public read functions.
--
-- THE HIERARCHY (priority, publisher authority and notification permission are three SEPARATE things):
--   Level 1  ESSENTIAL ALERT   notices.is_essential = true. Can only be set by official_publish_notice / official_update_notice for an organisation that
--                              (a) is verified and active, (b) currently holds an un-revoked essential_alert_grants row, (c) is being published by one of its
--                              'publisher' members. Direct client writes of any essential field are refused by a trigger; the CHECK constraints below
--                              make an essential row without a title-quality body, an action, an expiry, a review time, an organisation or severity 'urgent'
--                              impossible even for a migration or the service role. It is ACTIVE only while published, started, unexpired, not hidden,
--                              before its review time, and its organisation still holds the grant.
--   Level 2  HEALTH & OFFICIAL a published notice that comes from an official source (an import, source IS NOT NULL) or from a verified organisation
--                              (official_publisher_id IS NOT NULL) and is not an active essential alert. An NHS routine notice is Level 2; the same
--                              organisation's genuinely critical notice is Level 1 only if it deliberately designates it and holds the grant.
--   Level 3  COMMUNITY         everything else (hub, business, person, OneShetland).
-- Deaths & funeral notices are NOT in this table at all (migration 20261129030000): they have their own privacy and moderation model, and keeping them
-- out of `notices` means no released app build can ever read, style or push one by accident.
--
-- OLD CLIENTS: every new column is nullable or defaulted; the public read policy is unchanged; an essential alert is an ordinary published platform notice
-- with severity 'urgent', so an installed build shows it as an urgent notice (labelled as it labels every platform notice) and nothing else changes.
-- NOTHING here sends a notification.
begin;

-- ── columns ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.notices
  add column official_publisher_id uuid references public.official_publishers(id) on delete restrict,
  add column is_essential          boolean not null default false,
  add column action_text           text,                      -- "what people need to do"
  add column review_at             timestamptz,               -- the time by which the publisher must confirm or resolve an essential alert
  add column link_url              text,                      -- supporting / source link for a directly published official notice
  add column essential_set_by      uuid references public.profiles(id) on delete set null,
  add column essential_set_at      timestamptz;

alter table public.notices add constraint notices_official_publisher_check check (
  official_publisher_id is null or (is_platform_notice and source is null));          -- an organisation notice is a platform notice; imports never carry one
alter table public.notices add constraint notices_link_url_check check (
  link_url is null or (length(link_url) <= 500 and link_url ~* '^https://[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:[0-9]+)?(/[^[:space:]]*)?$' and link_url !~ '@'));
alter table public.notices add constraint notices_essential_check check (
  not is_essential or (
    official_publisher_id is not null and source is null and severity = 'urgent' and visibility = 'public'
    and expires_at is not null and review_at is not null and review_at <= expires_at
    and action_text is not null and length(btrim(action_text)) >= 10
    and length(btrim(title)) >= 5 and length(btrim(body)) >= 20 and not is_person_notice));
alter table public.notices add constraint notices_review_before_expiry check (review_at is null or expires_at is null or review_at <= expires_at);

create index notices_official_idx on public.notices (official_publisher_id) where official_publisher_id is not null;
create index notices_essential_idx on public.notices (expires_at) where is_essential;
create index notices_feed_idx on public.notices (published_at desc, id) where status = 'published' and not is_hidden and visibility = 'public';

-- ── is a notice publicly readable RIGHT NOW (the same rule as the "notices read" policy, public visibility only) ────────────────────────────────
create function public.notice_is_public(n public.notices) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select n.status = 'published' and not n.is_hidden and n.visibility = 'public'
         and (n.starts_at is null or n.starts_at <= now()) and (n.expires_at is null or n.expires_at > now());
$$;

-- ── is an essential alert ACTIVE right now (public + not past its review time + its organisation still holds the entitlement) ─────────────────────
create function public.notice_essential_active(n public.notices) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select n.is_essential and public.notice_is_public(n)
         and n.review_at is not null and n.review_at > now()
         and exists (select 1 from public.official_publishers p where p.id = n.official_publisher_id and p.verified_at is not null and p.is_active)
         and exists (select 1 from public.essential_alert_grants g where g.publisher_id = n.official_publisher_id and g.revoked_at is null);
$$;

-- ── areas: a member following an area is relevant to notices for that area, anything inside it, and any area that contains it (but NOT the Shetland-wide
--    root, which is matched explicitly: every locality's parent is shetland_wide, so treating it as an ancestor would match everything) ─────────────
create function public.area_neighbourhood(p_areas text[]) returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  with recursive up(id, parent_id) as (
    select a.id, a.parent_id from public.areas a where a.id = any(p_areas)
    union select a.id, a.parent_id from public.areas a join up on a.id = up.parent_id),
  down(id) as (
    select a.id from public.areas a where a.id = any(p_areas)
    union select a.id from public.areas a join down d on a.parent_id = d.id)
  select coalesce(array_agg(distinct x), '{}'::text[]) from (select id as x from up union select id from down) s where x <> 'shetland_wide';
$$;

-- Does this notice belong in a READ filtered by the given (already expanded) neighbourhood? Shetland-wide notices match everyone, and so does a notice with NO
-- area rows: hubs and businesses post without choosing an area (their forms have no area control), so "unspecified" means "island-wide" for reading. If it
-- meant "nobody", a member who picked their areas would stop seeing nearly every hub and business notice. This is READING only: notifications are chosen by
-- notice_dispatch_recipients, which still treats a notice with no areas as targeting nobody (nothing is announced to anyone by accident).
create function public.notice_matches_areas(p_notice uuid, p_neighbourhood text[]) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select not exists (select 1 from public.notice_areas na where na.notice_id = p_notice)
      or exists (select 1 from public.notice_areas na where na.notice_id = p_notice
                  and (na.area_id = 'shetland_wide' or na.area_id = any(coalesce(p_neighbourhood, '{}'::text[]))));
$$;

-- ── the publisher label gains one branch: a verified organisation ───────────────────────────────────────────────────────────────────────────────
create function public.official_publisher_label(p_publisher uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select p.name from public.official_publishers p where p.id = p_publisher and p.verified_at is not null and p.is_active;
$$;

create or replace function public.notice_publisher_display(p_notice uuid) returns jsonb
language sql stable security invoker set search_path to 'public', 'pg_temp' as $f$
  select case
    when n.official_publisher_id is not null then
      jsonb_build_object('kind', 'official', 'label', coalesce(public.official_publisher_label(n.official_publisher_id), 'Official notice'), 'is_official_source', true,
                         'source_label', public.official_publisher_label(n.official_publisher_id), 'source_url', n.link_url,
                         'byline', 'Issued by ' || coalesce(public.official_publisher_label(n.official_publisher_id), 'an official organisation'))
    when n.is_platform_notice and n.source is not null then
      jsonb_build_object('kind', 'platform', 'label', n.source_label, 'is_official_source', true, 'source_label', n.source_label, 'source_url', n.source_url, 'byline', 'Source: ' || n.source_label)
    when n.is_platform_notice then
      jsonb_build_object('kind', 'platform', 'label', 'OneShetland', 'is_official_source', false, 'source_label', null, 'source_url', null, 'byline', 'Posted by OneShetland')
    when n.is_person_notice then
      jsonb_build_object('kind', 'person', 'label', public.notice_person_label(n.publisher_user_id), 'is_official_source', false, 'source_label', null, 'source_url', null,
                         'byline', 'Posted by ' || public.notice_person_label(n.publisher_user_id))
    when n.publisher_hub_id is not null then
      jsonb_build_object('kind', 'hub', 'label', coalesce((select name from public.hubs h where h.id = n.publisher_hub_id), 'Community hub'), 'is_official_source', false, 'source_label', null, 'source_url', null,
                         'byline', 'Posted by ' || coalesce((select name from public.hubs h where h.id = n.publisher_hub_id), 'Community hub'))
    else
      jsonb_build_object('kind', 'business', 'label', coalesce((select name from public.local_businesses b where b.id = n.publisher_business_id), 'Local business'), 'is_official_source', false, 'source_label', null, 'source_url', null,
                         'byline', 'Posted by ' || coalesce((select name from public.local_businesses b where b.id = n.publisher_business_id), 'Local business'))
  end
  from public.notices n where n.id = p_notice;
$f$;

-- ── guards ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- (a) A CLIENT (authenticated / anon) can never set or change any essential / organisation field, whatever UI it came from.
-- (b) Whoever writes, the entitlement is re-checked at the instant a notice BECOMES essential, and an organisation notice's organisation is permanent.
create function public.tg_notices_essential_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.official_publisher_id is not null or new.is_essential or new.action_text is not null or new.review_at is not null or new.link_url is not null
         or new.essential_set_by is not null or new.essential_set_at is not null then
        raise exception 'Essential alert and organisation fields are set only by an authorised official publishing function' using errcode = '42501';
      end if;
    else
      if new.official_publisher_id is distinct from old.official_publisher_id or new.is_essential is distinct from old.is_essential
         or new.action_text is distinct from old.action_text or new.review_at is distinct from old.review_at or new.link_url is distinct from old.link_url
         or new.essential_set_by is distinct from old.essential_set_by or new.essential_set_at is distinct from old.essential_set_at then
        raise exception 'Essential alert and organisation fields are set only by an authorised official publishing function' using errcode = '42501';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' and new.official_publisher_id is distinct from old.official_publisher_id then
    raise exception 'A notice''s issuing organisation cannot be changed' using errcode = '42501';
  end if;
  if new.is_essential and (tg_op = 'INSERT' or not old.is_essential) then
    if not exists (select 1 from public.essential_alert_grants g join public.official_publishers p on p.id = g.publisher_id
                    where g.publisher_id = new.official_publisher_id and g.revoked_at is null and p.verified_at is not null and p.is_active) then
      raise exception 'That organisation does not hold the Essential Alert entitlement' using errcode = '42501';
    end if;
    new.essential_set_at := coalesce(new.essential_set_at, now());
  end if;
  return new;
end $$;
create trigger notices_essential_guard before insert or update on public.notices for each row execute function public.tg_notices_essential_guard();

-- Audit of status changes on organisation / essential notices (the publishing and correcting RPCs audit themselves).
create function public.tg_notices_alert_audit() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status is distinct from old.status and (old.is_essential or new.is_essential or new.official_publisher_id is not null) then
    perform public.notice_audit(case new.status when 'resolved' then 'notice_resolved' when 'withdrawn' then 'notice_withdrawn' else 'notice_corrected' end,
                                new.official_publisher_id, new.id, null, jsonb_build_object('from', old.status, 'to', new.status, 'essential', old.is_essential));
  end if;
  if old.is_essential and not new.is_essential then
    perform public.notice_audit('essential_demoted', new.official_publisher_id, new.id, null, '{}'::jsonb);
  end if;
  return null;
end $$;
create trigger notices_alert_audit after update on public.notices for each row execute function public.tg_notices_alert_audit();

-- ── revoking the entitlement demotes the organisation's live essential alerts (they stay published as ordinary official notices) ─────────────────
create function public.admin_revoke_essential_alert(p_publisher uuid, p_reason text) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_demoted integer;
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'A reason is required' using errcode = '22023'; end if;
  update public.essential_alert_grants set revoked_by = auth.uid(), revoked_at = now(), revoked_reason = btrim(p_reason) where publisher_id = p_publisher and revoked_at is null;
  if not found then raise exception 'That organisation holds no active Essential Alert entitlement' using errcode = 'P0002'; end if;
  update public.notices set is_essential = false, severity = 'info' where official_publisher_id = p_publisher and is_essential;
  get diagnostics v_demoted = row_count;
  perform public.notice_audit('essential_revoked', p_publisher, null, null, jsonb_build_object('reason', btrim(p_reason), 'demoted_notices', v_demoted));
  return v_demoted;
end $$;
revoke all on function public.admin_revoke_essential_alert(uuid, text) from public, anon;
grant execute on function public.admin_revoke_essential_alert(uuid, text) to authenticated, service_role;

-- ── official publishing ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create function public.is_safe_https_url(p text) returns boolean language sql immutable as $$
  select p is not null and length(p) <= 500 and p ~* '^https://[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:[0-9]+)?(/[^[:space:]]*)?$' and p !~ '@'
$$;

-- One function validates a publish OR a correction, so the two can never disagree. `p_essential` is the DESIGNATION: only an organisation with the live
-- entitlement, acting through a 'publisher' member, may ask for it; everyone else is refused here and again by the guard trigger.
create function public.official_validate_notice(
  p_publisher uuid, p_title text, p_body text, p_category text, p_area_ids text[], p_starts_at timestamptz, p_expires_at timestamptz, p_review_at timestamptz,
  p_link_url text, p_action_text text, p_essential boolean) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_auth text := public.official_publisher_authority(p_publisher); v_start timestamptz := coalesce(p_starts_at, now()); v_bad text[];
begin
  if v_auth = 'none' then raise exception 'You are not authorised to publish for that organisation' using errcode = '42501'; end if;
  if p_essential and v_auth <> 'essential' then
    raise exception 'This organisation or account cannot issue Essential Alerts' using errcode = '42501';
  end if;
  if p_title is null or length(btrim(p_title)) < 5 or length(btrim(p_title)) > 120 then raise exception 'The title must be 5 to 120 characters' using errcode = '22023'; end if;
  if p_body is null or length(btrim(p_body)) < 20 or length(btrim(p_body)) > 4000 then raise exception 'The explanation must be 20 to 4000 characters' using errcode = '22023'; end if;
  if not exists (select 1 from public.notice_categories c where c.id = p_category and c.is_active) then raise exception 'Choose a valid category' using errcode = '22023'; end if;
  if p_area_ids is null or cardinality(p_area_ids) = 0 then raise exception 'Choose at least one affected area (or Shetland-wide)' using errcode = '22023'; end if;
  select array_agg(a) into v_bad from unnest(p_area_ids) a where not exists (select 1 from public.areas x where x.id = a and x.is_active);
  if v_bad is not null then raise exception 'Unknown or inactive area' using errcode = '22023'; end if;
  if 'shetland_wide' = any(p_area_ids) and cardinality(p_area_ids) > 1 then raise exception 'Shetland-wide cannot be combined with specific areas' using errcode = '22023'; end if;
  if p_link_url is not null and not public.is_safe_https_url(p_link_url) then raise exception 'The link must be a plain https address' using errcode = '22023'; end if;
  if p_starts_at is not null and (p_starts_at < now() - interval '1 day' or p_starts_at > now() + interval '30 days') then
    raise exception 'The start time must be within the next 30 days' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= v_start then raise exception 'An official notice needs an expiry after it starts' using errcode = '22023'; end if;
  if p_expires_at > v_start + interval '180 days' then raise exception 'An official notice cannot run for more than 180 days' using errcode = '22023'; end if;
  if p_essential then
    if p_expires_at > v_start + interval '7 days' then raise exception 'An Essential Alert cannot run for more than 7 days; re-issue it if it is still needed' using errcode = '22023'; end if;
    if p_review_at is null or p_review_at <= v_start or p_review_at > p_expires_at then raise exception 'An Essential Alert needs a review time between its start and its expiry' using errcode = '22023'; end if;
    if p_action_text is null or length(btrim(p_action_text)) < 10 or length(btrim(p_action_text)) > 500 then raise exception 'Say what people need to do (10 to 500 characters)' using errcode = '22023'; end if;
  elsif p_action_text is not null and length(btrim(p_action_text)) > 500 then
    raise exception 'The action text is too long' using errcode = '22023';
  end if;
end $$;

create function public.official_publish_notice(
  p_publisher uuid, p_title text, p_body text, p_category text, p_area_ids text[], p_expires_at timestamptz,
  p_starts_at timestamptz default null, p_link_url text default null, p_action_text text default null, p_is_essential boolean default false, p_review_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_area text;
begin
  perform public.official_validate_notice(p_publisher, p_title, p_body, p_category, p_area_ids, p_starts_at, p_expires_at, p_review_at, p_link_url, p_action_text, coalesce(p_is_essential, false));
  insert into public.notices (is_platform_notice, official_publisher_id, severity, title, body, category, visibility, status, starts_at, expires_at, review_at, link_url, action_text,
                              is_essential, essential_set_by, essential_set_at)
  values (true, p_publisher, case when coalesce(p_is_essential, false) then 'urgent' else 'info' end, btrim(p_title), btrim(p_body), p_category, 'public', 'published',
          p_starts_at, p_expires_at, case when coalesce(p_is_essential, false) then p_review_at end, p_link_url, nullif(btrim(coalesce(p_action_text, '')), ''),
          coalesce(p_is_essential, false), case when coalesce(p_is_essential, false) then auth.uid() end, case when coalesce(p_is_essential, false) then now() end)
  returning id into v_id;
  foreach v_area in array p_area_ids loop insert into public.notice_areas (notice_id, area_id) values (v_id, v_area); end loop;
  perform public.notice_audit(case when coalesce(p_is_essential, false) then 'essential_published' else 'notice_published' end, p_publisher, v_id, null,
                              jsonb_build_object('essential', coalesce(p_is_essential, false), 'areas', p_area_ids, 'expires_at', p_expires_at, 'review_at', p_review_at));
  return v_id;
end $$;

-- Correct a published organisation notice. Editing NEVER sends anything: notification is a separate, explicitly requested, once-only dispatch.
create function public.official_update_notice(
  p_notice uuid, p_title text default null, p_body text default null, p_category text default null, p_area_ids text[] default null, p_expires_at timestamptz default null,
  p_link_url text default null, p_action_text text default null, p_is_essential boolean default null, p_review_at timestamptz default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype; v_ess boolean; v_area text; v_areas text[];
begin
  select * into n from public.notices where id = p_notice for update;
  if not found or n.official_publisher_id is null then raise exception 'Unknown organisation notice' using errcode = 'P0002'; end if;
  if n.status not in ('published', 'pending') then raise exception 'Only a live notice can be corrected' using errcode = '22023'; end if;
  v_ess := coalesce(p_is_essential, n.is_essential);
  select coalesce(p_area_ids, array_agg(na.area_id)) into v_areas from public.notice_areas na where na.notice_id = p_notice;
  perform public.official_validate_notice(n.official_publisher_id, coalesce(p_title, n.title), coalesce(p_body, n.body), coalesce(p_category, n.category), v_areas,
                                          null, coalesce(p_expires_at, n.expires_at), coalesce(p_review_at, n.review_at), coalesce(p_link_url, n.link_url),
                                          coalesce(p_action_text, n.action_text), v_ess);
  update public.notices set title = btrim(coalesce(p_title, title)), body = btrim(coalesce(p_body, body)), category = coalesce(p_category, category),
         expires_at = coalesce(p_expires_at, expires_at), review_at = case when v_ess then coalesce(p_review_at, review_at) else null end,
         link_url = coalesce(p_link_url, link_url), action_text = coalesce(nullif(btrim(coalesce(p_action_text, '')), ''), action_text),
         is_essential = v_ess, severity = case when v_ess then 'urgent' else 'info' end,
         essential_set_by = case when v_ess and not n.is_essential then auth.uid() else essential_set_by end
   where id = p_notice;
  if p_area_ids is not null then
    delete from public.notice_areas where notice_id = p_notice;
    foreach v_area in array p_area_ids loop insert into public.notice_areas (notice_id, area_id) values (p_notice, v_area); end loop;
  end if;
  perform public.notice_audit('notice_corrected', n.official_publisher_id, p_notice, null, jsonb_build_object('essential', v_ess));
end $$;

create function public.official_set_notice_status(p_notice uuid, p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype;
begin
  if p_status not in ('resolved', 'withdrawn') then raise exception 'An organisation can resolve or withdraw a notice' using errcode = '22023'; end if;
  select * into n from public.notices where id = p_notice for update;
  if not found or n.official_publisher_id is null then raise exception 'Unknown organisation notice' using errcode = 'P0002'; end if;
  if public.official_publisher_authority(n.official_publisher_id) = 'none' and not public.notices_admin() then
    raise exception 'You are not authorised to manage that notice' using errcode = '42501';
  end if;
  update public.notices set status = p_status where id = p_notice;   -- tg_notices_lifecycle stamps resolved_at / withdrawn_at; the audit trigger records it
end $$;

-- ── public reads (the same public predicate as the RLS policy, applied explicitly because these are definer functions) ───────────────────────────
create function public.get_public_notices(
  p_level text default 'all', p_area_ids text[] default null, p_category text default null, p_limit integer default 20, p_offset integer default 0, p_id uuid default null)
returns table (id uuid, title text, body text, action_text text, severity text, category text, category_label text, published_at timestamptz, starts_at timestamptz,
               expires_at timestamptz, review_at timestamptz, link_url text, level integer, is_essential_active boolean, publisher jsonb, area_ids text[], area_names text[],
               publisher_hub_id uuid, publisher_business_id uuid, event_id uuid, campaign_id uuid, image_url text,
               publisher_logo_url text, publisher_brand_color text, hub_slug text, business_slug text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_nb text[];
begin
  if p_level not in ('all', 'essential', 'official', 'community') then raise exception 'Unknown level' using errcode = '22023'; end if;
  p_limit := least(greatest(coalesce(p_limit, 20), 1), 50);
  p_offset := greatest(coalesce(p_offset, 0), 0);
  if p_area_ids is not null then v_nb := public.area_neighbourhood(p_area_ids); end if;
  return query
    with base as (
      select n.*, public.notice_essential_active(n) as ess,
             case when public.notice_essential_active(n) then 1 when n.source is not null or n.official_publisher_id is not null then 2 else 3 end as lvl
        from public.notices n
       where public.notice_is_public(n)
         and (p_id is null or n.id = p_id)
         and (p_category is null or n.category = p_category)
         and (p_area_ids is null or public.notice_matches_areas(n.id, v_nb)))
    select b.id, b.title, b.body, b.action_text, b.severity, b.category, c.label, b.published_at, b.starts_at, b.expires_at, b.review_at, b.link_url, b.lvl, b.ess,
           public.notice_publisher_display(b.id),
           coalesce((select array_agg(na.area_id order by na.area_id) from public.notice_areas na where na.notice_id = b.id), '{}'),
           coalesce((select array_agg(a.name_display order by a.name_display) from public.notice_areas na join public.areas a on a.id = na.area_id where na.notice_id = b.id), '{}'),
           b.publisher_hub_id, b.publisher_business_id, b.event_id, b.campaign_id, b.image_url,
           coalesce(h.logo_url, lb.logo_url), coalesce(h.brand_color, lb.brand_color), h.slug, lb.slug
      from base b left join public.notice_categories c on c.id = b.category
      left join public.hubs h on h.id = b.publisher_hub_id left join public.local_businesses lb on lb.id = b.publisher_business_id
     where (p_level = 'all' or (p_level = 'essential' and b.lvl = 1) or (p_level = 'official' and b.lvl = 2) or (p_level = 'community' and b.lvl = 3))
     order by b.ess desc, b.is_pinned desc, b.published_at desc, b.id
     limit p_limit offset p_offset;
end $$;

-- The reserved top-priority slot: ONLY currently active essential alerts, never anything else.
create function public.get_essential_alerts(p_area_ids text[] default null)
returns table (id uuid, title text, body text, action_text text, category text, published_at timestamptz, expires_at timestamptz, review_at timestamptz, link_url text,
               publisher jsonb, area_ids text[], area_names text[])
language sql stable security definer set search_path = public, pg_temp as $$
  select g.id, g.title, g.body, g.action_text, g.category, g.published_at, g.expires_at, g.review_at, g.link_url, g.publisher, g.area_ids, g.area_names
    from public.get_public_notices('essential', p_area_ids, null, 10, 0) g;
$$;

-- One public notice by id (the detail page): the same public rule and shape as the list, and nothing non-public.
create function public.get_public_notice(p_id uuid)
returns table (id uuid, title text, body text, action_text text, severity text, category text, category_label text, published_at timestamptz, starts_at timestamptz,
               expires_at timestamptz, review_at timestamptz, link_url text, level integer, is_essential_active boolean, publisher jsonb, area_ids text[], area_names text[],
               publisher_hub_id uuid, publisher_business_id uuid, event_id uuid, campaign_id uuid, image_url text,
               publisher_logo_url text, publisher_brand_color text, hub_slug text, business_slug text)
language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.get_public_notices('all', null, null, 1, 0, p_id);
$$;

revoke all on function public.notice_is_public(public.notices), public.notice_essential_active(public.notices), public.area_neighbourhood(text[]),
  public.notice_matches_areas(uuid, text[]), public.official_publisher_label(uuid), public.is_safe_https_url(text),
  public.official_validate_notice(uuid, text, text, text, text[], timestamptz, timestamptz, timestamptz, text, text, boolean),
  public.official_publish_notice(uuid, text, text, text, text[], timestamptz, timestamptz, text, text, boolean, timestamptz),
  public.official_update_notice(uuid, text, text, text, text[], timestamptz, text, text, boolean, timestamptz), public.official_set_notice_status(uuid, text),
  public.get_public_notices(text, text[], text, integer, integer, uuid), public.get_essential_alerts(text[]), public.get_public_notice(uuid) from public, anon;
grant execute on function public.notice_is_public(public.notices), public.notice_essential_active(public.notices), public.area_neighbourhood(text[]),
  public.notice_matches_areas(uuid, text[]), public.official_publisher_label(uuid), public.is_safe_https_url(text),
  public.get_public_notices(text, text[], text, integer, integer, uuid), public.get_essential_alerts(text[]), public.get_public_notice(uuid) to anon, authenticated, service_role;
grant execute on function public.official_validate_notice(uuid, text, text, text, text[], timestamptz, timestamptz, timestamptz, text, text, boolean),
  public.official_publish_notice(uuid, text, text, text, text[], timestamptz, timestamptz, text, text, boolean, timestamptz),
  public.official_update_notice(uuid, text, text, text, text[], timestamptz, text, text, boolean, timestamptz), public.official_set_notice_status(uuid, text) to authenticated, service_role;

-- ── a member edits their OWN person notice ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- Editing through the table is impossible by design: the edit sends a published notice back to review, and the read policy is public-only, so Postgres
-- refuses an UPDATE whose NEW row the caller could not read ("new row violates row-level security policy"). This is the one sanctioned route: the author,
-- a person notice that is still pending or published, the text only; the notice goes (back) to pending for staff approval. Severity, area, links, status
-- and everything else are untouched.
create function public.edit_my_person_notice(p_notice uuid, p_title text, p_body text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in to edit a notice' using errcode = '42501'; end if;
  select * into n from public.notices where id = p_notice for update;
  if not found or not n.is_person_notice or n.publisher_user_id is distinct from auth.uid() then raise exception 'You can only edit your own notices' using errcode = '42501'; end if;
  if n.status not in ('pending', 'published') then raise exception 'That notice can no longer be edited' using errcode = '22023'; end if;
  p_title := btrim(coalesce(p_title, n.title)); p_body := btrim(coalesce(p_body, n.body));
  if char_length(p_title) < 5 or char_length(p_title) > 120 then raise exception 'The title must be 5 to 120 characters' using errcode = '22023'; end if;
  if char_length(p_body) < 10 or char_length(p_body) > 4000 then raise exception 'The text must be 10 to 4000 characters' using errcode = '22023'; end if;
  update public.notices set title = p_title, body = p_body, status = 'pending', updated_at = now() where id = p_notice;
end $$;
revoke all on function public.edit_my_person_notice(uuid, text, text) from public, anon;
grant execute on function public.edit_my_person_notice(uuid, text, text) to authenticated, service_role;

commit;
