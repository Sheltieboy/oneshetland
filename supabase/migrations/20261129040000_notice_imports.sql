-- Notices & Alerts - step 5: the controlled official-import framework.
--
-- NOTHING IS ENABLED. Every source starts DISABLED; enabling one is a deliberate platform-administrator act that must record how the source's reuse
-- conditions were confirmed. The importer is an edge function that is not deployed, and this migration contains no schedule (see
-- supabase/deploy/notices-import-cron.sql, which is documentation until a source is approved).
--
-- WHAT AN IMPORT IS: a short ORIGINAL summary plus a link to the authoritative announcement, attributed to its source ("Source: <label>"). It is a platform
-- notice carrying the Stage 2 source fields; (source, source_reference) is the identity, so a re-fetch UPDATES IN PLACE and can never duplicate. Imports are
-- severity 'info', must expire, can never be essential, never carry an organisation id, and are SILENT: notice_dispatchable() and the delivery trigger refuse
-- them, so no worker, route or future code path can push one.
--
-- SAFETY RAILS: allow-listed hosts (the item link must be https on an allowed host), a minimum interval between runs, summary and title length caps, a
-- circuit breaker that refuses to withdraw more than half of a source's live items in one run (a broken feed must not wipe the board), a staff-hidden or
-- staff-withdrawn notice is never resurrected, and a transition path that retires a source when an organisation starts publishing directly.
begin;

create table public.notice_import_sources (
  id                 text primary key check (id ~ '^[a-z][a-z0-9_]*$' and length(id) <= 48),     -- the notices.source value
  label              text not null check (btrim(label) <> '' and length(label) <= 140),          -- the notices.source_label ("Shetland Islands Council (Official Notices)")
  official_publisher_id uuid references public.official_publishers(id) on delete set null,       -- set when the organisation later publishes directly
  feed_kind          text not null check (feed_kind in ('rss', 'atom', 'json')),
  feed_url           text not null check (public.is_safe_https_url(feed_url)),
  allowed_hosts      text[] not null check (cardinality(allowed_hosts) >= 1),
  default_category   text not null default 'other' references public.notice_categories(id),
  default_area_ids   text[] not null default array['shetland_wide'],
  expiry_days        integer not null default 14 check (expiry_days between 1 and 90),
  rate_limit_minutes integer not null default 60 check (rate_limit_minutes >= 15),
  reuse_terms_note   text,                                                                       -- how the right to summarise and link was confirmed
  reuse_confirmed_at timestamptz,
  is_enabled         boolean not null default false,
  approved_by        uuid references public.profiles(id) on delete set null,
  approved_at        timestamptz,
  last_run_at        timestamptz,
  last_success_at    timestamptz,
  consecutive_failures integer not null default 0,
  retired_at         timestamptz,
  created_at         timestamptz not null default now(),
  constraint import_enabled_needs_approval check (not is_enabled or (approved_at is not null and reuse_confirmed_at is not null and reuse_terms_note is not null and btrim(reuse_terms_note) <> ''))
);

create table public.notice_import_items (
  source          text not null references public.notice_import_sources(id) on delete cascade,
  reference       text not null check (btrim(reference) <> ''),
  notice_id       uuid references public.notices(id) on delete set null,
  content_hash    text not null,
  last_seen_at    timestamptz not null default now(),
  auto_withdrawn  boolean not null default false,
  primary key (source, reference)
);

create table public.notice_import_runs (
  id             uuid primary key default gen_random_uuid(),
  source_id      text not null references public.notice_import_sources(id) on delete cascade,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  fetched        integer, created integer, updated integer, unchanged integer, withdrawn integer, errors integer,
  error_summary  text
);
create index notice_import_runs_source_idx on public.notice_import_runs (source_id, started_at desc);

alter table public.notice_import_sources enable row level security;
alter table public.notice_import_items enable row level security;
alter table public.notice_import_runs enable row level security;
revoke all on public.notice_import_sources, public.notice_import_items, public.notice_import_runs from anon, authenticated;

-- ── administration ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create function public.admin_upsert_import_source(p_id text, p_label text, p_feed_kind text, p_feed_url text, p_allowed_hosts text[], p_default_category text default 'other',
  p_default_area_ids text[] default array['shetland_wide'], p_expiry_days integer default 14, p_rate_limit_minutes integer default 60) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  insert into public.notice_import_sources (id, label, feed_kind, feed_url, allowed_hosts, default_category, default_area_ids, expiry_days, rate_limit_minutes)
  values (p_id, p_label, p_feed_kind, p_feed_url, p_allowed_hosts, p_default_category, p_default_area_ids, p_expiry_days, p_rate_limit_minutes)
  on conflict (id) do update set label = excluded.label, feed_kind = excluded.feed_kind, feed_url = excluded.feed_url, allowed_hosts = excluded.allowed_hosts,
    default_category = excluded.default_category, default_area_ids = excluded.default_area_ids, expiry_days = excluded.expiry_days, rate_limit_minutes = excluded.rate_limit_minutes
  where not public.notice_import_sources.is_enabled;                                   -- an ENABLED source is frozen: disable it first
  if not found then raise exception 'Disable a source before changing it' using errcode = '22023'; end if;
  perform public.notice_audit('import_source_changed', null, null, null, jsonb_build_object('source', p_id, 'change', 'configured'));
end $$;

create function public.admin_set_import_source_enabled(p_id text, p_enabled boolean, p_reuse_note text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  if p_enabled then
    if p_reuse_note is null or btrim(p_reuse_note) = '' then raise exception 'Record how the source''s reuse conditions were confirmed before enabling it' using errcode = '22023'; end if;
    update public.notice_import_sources set is_enabled = true, reuse_terms_note = btrim(p_reuse_note), reuse_confirmed_at = now(), approved_by = auth.uid(), approved_at = now(),
           consecutive_failures = 0 where id = p_id and retired_at is null;
  else
    update public.notice_import_sources set is_enabled = false where id = p_id;
  end if;
  if not found then raise exception 'Unknown (or retired) source' using errcode = 'P0002'; end if;
  perform public.notice_audit('import_source_changed', null, null, null, jsonb_build_object('source', p_id, 'enabled', p_enabled));
end $$;

-- When an organisation starts publishing directly, retire its import: the source is disabled for good, and its live imported notices can be withdrawn so the
-- same announcement is never shown twice (once imported, once direct).
create function public.admin_retire_import_source(p_id text, p_publisher uuid, p_withdraw_live boolean default true) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer := 0;
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  update public.notice_import_sources set is_enabled = false, retired_at = now(), official_publisher_id = p_publisher where id = p_id;
  if not found then raise exception 'Unknown source' using errcode = 'P0002'; end if;
  if p_withdraw_live then
    update public.notices set status = 'withdrawn' where source = p_id and status = 'published';
    get diagnostics v_n = row_count;
  end if;
  perform public.notice_audit('import_source_changed', p_publisher, null, null, jsonb_build_object('source', p_id, 'retired', true, 'withdrawn', v_n));
  return v_n;
end $$;

create function public.admin_import_status()
returns table (id text, label text, is_enabled boolean, retired_at timestamptz, last_run_at timestamptz, last_success_at timestamptz, consecutive_failures integer, live_items bigint, last_status text, last_error text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  return query select s.id, s.label, s.is_enabled, s.retired_at, s.last_run_at, s.last_success_at, s.consecutive_failures,
                      (select count(*) from public.notices n where n.source = s.id and n.status = 'published'),
                      (select r.status from public.notice_import_runs r where r.source_id = s.id order by r.started_at desc limit 1),
                      (select r.error_summary from public.notice_import_runs r where r.source_id = s.id order by r.started_at desc limit 1)
                 from public.notice_import_sources s order by s.id;
end $$;

-- ── the importer's functions (service role only) ─────────────────────────────────────────────────────────────────────────────────────────────────
create function public.import_start_run(p_source text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.notice_import_sources%rowtype; v_run uuid;
begin
  select * into s from public.notice_import_sources where id = p_source for update;
  if not found then raise exception 'Unknown source' using errcode = 'P0002'; end if;
  if not s.is_enabled or s.retired_at is not null or s.approved_at is null then raise exception 'That source is not enabled' using errcode = '42501'; end if;
  if s.last_run_at is not null and s.last_run_at > now() - make_interval(mins => s.rate_limit_minutes) then raise exception 'That source was fetched too recently' using errcode = '54000'; end if;
  update public.notice_import_sources set last_run_at = now() where id = p_source;
  insert into public.notice_import_runs (source_id) values (p_source) returning id into v_run;
  return v_run;
end $$;

create function public.import_upsert_notice(p_source text, p_reference text, p_title text, p_summary text, p_source_url text, p_source_published_at timestamptz,
  p_category text default null, p_area_ids text[] default null, p_expires_at timestamptz default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.notice_import_sources%rowtype; it public.notice_import_items%rowtype; n public.notices%rowtype; v_id uuid; v_hash text; v_host text;
        v_cat text; v_areas text[]; v_exp timestamptz; v_area text;
begin
  select * into s from public.notice_import_sources where id = p_source;
  if not found or not s.is_enabled or s.retired_at is not null then raise exception 'That source is not enabled' using errcode = '42501'; end if;
  if p_reference is null or btrim(p_reference) = '' then raise exception 'An imported item needs a stable source reference' using errcode = '22023'; end if;
  if p_title is null or length(btrim(p_title)) < 3 or length(btrim(p_title)) > 200 then raise exception 'The title must be 3 to 200 characters' using errcode = '22023'; end if;
  if p_summary is null or length(btrim(p_summary)) < 10 or length(btrim(p_summary)) > 600 then raise exception 'The summary must be 10 to 600 characters (a short original summary, not the source text)' using errcode = '22023'; end if;
  if not public.is_safe_https_url(p_source_url) then raise exception 'The source link must be a plain https address' using errcode = '22023'; end if;
  v_host := lower(substring(p_source_url from '^https://([^/:]+)'));
  if not (v_host = any(select lower(h) from unnest(s.allowed_hosts) h)) then raise exception 'The source link is not on an allowed host' using errcode = '22023'; end if;
  v_cat := coalesce(p_category, s.default_category);
  if not exists (select 1 from public.notice_categories c where c.id = v_cat and c.is_active) then v_cat := s.default_category; end if;
  v_areas := coalesce(p_area_ids, s.default_area_ids);
  if exists (select 1 from unnest(v_areas) a where not exists (select 1 from public.areas x where x.id = a and x.is_active)) then v_areas := s.default_area_ids; end if;
  v_exp := coalesce(p_expires_at, now() + make_interval(days => s.expiry_days));
  if v_exp <= now() then return 'skipped_expired'; end if;
  v_exp := least(v_exp, now() + interval '90 days');
  v_hash := md5(concat_ws('|', btrim(p_title), btrim(p_summary), p_source_url, v_cat, array_to_string(v_areas, ','), date_trunc('day', v_exp)::text));

  select * into it from public.notice_import_items where source = p_source and reference = p_reference for update;
  if not found then
    insert into public.notices (is_platform_notice, source, source_reference, source_label, source_url, source_published_at, source_verified_at, severity, title, body, category,
                                visibility, status, expires_at)
    values (true, p_source, p_reference, s.label, p_source_url, p_source_published_at, now(), 'info', btrim(p_title), btrim(p_summary), v_cat, 'public', 'published', v_exp)
    returning id into v_id;
    foreach v_area in array v_areas loop insert into public.notice_areas (notice_id, area_id) values (v_id, v_area); end loop;
    insert into public.notice_import_items (source, reference, notice_id, content_hash) values (p_source, p_reference, v_id, v_hash);
    return 'created';
  end if;
  update public.notice_import_items set last_seen_at = now() where source = p_source and reference = p_reference;
  select * into n from public.notices where id = it.notice_id;
  if not found then return 'skipped_missing'; end if;
  -- a notice staff hid, or withdrew themselves, is never resurrected by a feed
  if n.is_hidden or (n.status = 'withdrawn' and not it.auto_withdrawn) then return 'skipped_staff'; end if;
  if it.content_hash = v_hash and not (n.status = 'withdrawn' and it.auto_withdrawn) then
    update public.notices set source_verified_at = now() where id = n.id;
    return 'unchanged';
  end if;
  update public.notices set title = btrim(p_title), body = btrim(p_summary), source_url = p_source_url, source_published_at = p_source_published_at, source_verified_at = now(),
         category = v_cat, expires_at = v_exp, status = case when n.status = 'withdrawn' and it.auto_withdrawn then 'published' else n.status end where id = n.id;
  delete from public.notice_areas where notice_id = n.id;
  foreach v_area in array v_areas loop insert into public.notice_areas (notice_id, area_id) values (n.id, v_area); end loop;
  update public.notice_import_items set content_hash = v_hash, auto_withdrawn = false where source = p_source and reference = p_reference;
  return 'updated';
end $$;

-- Close a run. On a clean 'ok' run, items the source no longer lists are withdrawn (kept, never deleted) - unless that would withdraw more than half of
-- the source's live items, which looks like a broken feed rather than a real clear-out: then nothing is withdrawn and the run is recorded as partial.
create function public.import_finish_run(p_run uuid, p_status text, p_fetched integer, p_created integer, p_updated integer, p_unchanged integer, p_errors integer, p_error text default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.notice_import_runs%rowtype; v_live integer; v_gone integer := 0; v_status text := p_status;
begin
  select * into r from public.notice_import_runs where id = p_run for update;
  if not found or r.status <> 'running' then raise exception 'Unknown or finished run' using errcode = 'P0002'; end if;
  if p_status not in ('ok', 'partial', 'failed') then raise exception 'Unknown status' using errcode = '22023'; end if;
  if p_status = 'ok' then
    select count(*) into v_live from public.notice_import_items i join public.notices n on n.id = i.notice_id where i.source = r.source_id and n.status = 'published' and not i.auto_withdrawn;
    select count(*) into v_gone from public.notice_import_items i join public.notices n on n.id = i.notice_id
     where i.source = r.source_id and n.status = 'published' and not i.auto_withdrawn and i.last_seen_at < r.started_at;
    if v_live > 2 and v_gone * 2 > v_live then
      v_status := 'partial'; p_error := coalesce(p_error || '; ', '') || format('refused to withdraw %s of %s live items (looks like a broken feed)', v_gone, v_live); v_gone := 0;
    elsif v_gone > 0 then
      update public.notices n set status = 'withdrawn' from public.notice_import_items i
       where i.notice_id = n.id and i.source = r.source_id and n.status = 'published' and not i.auto_withdrawn and i.last_seen_at < r.started_at;
      update public.notice_import_items i set auto_withdrawn = true
       where i.source = r.source_id and i.last_seen_at < r.started_at and not i.auto_withdrawn
         and exists (select 1 from public.notices n where n.id = i.notice_id and n.status = 'withdrawn');
    end if;
  end if;
  update public.notice_import_runs set finished_at = now(), status = v_status, fetched = p_fetched, created = p_created, updated = p_updated, unchanged = p_unchanged,
         withdrawn = v_gone, errors = p_errors, error_summary = left(p_error, 500) where id = p_run;
  update public.notice_import_sources set last_success_at = case when v_status in ('ok', 'partial') then now() else last_success_at end,
         consecutive_failures = case when v_status = 'failed' then consecutive_failures + 1 else 0 end where id = r.source_id;
  perform public.notice_audit('import_run', null, null, null, jsonb_build_object('source', r.source_id, 'status', v_status, 'created', p_created, 'updated', p_updated, 'withdrawn', v_gone, 'errors', p_errors));
  return v_gone;
end $$;

revoke all on function public.admin_upsert_import_source(text, text, text, text, text[], text, text[], integer, integer), public.admin_set_import_source_enabled(text, boolean, text),
  public.admin_retire_import_source(text, uuid, boolean), public.admin_import_status(), public.import_start_run(text),
  public.import_upsert_notice(text, text, text, text, text, timestamptz, text, text[], timestamptz), public.import_finish_run(uuid, text, integer, integer, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.admin_upsert_import_source(text, text, text, text, text[], text, text[], integer, integer), public.admin_set_import_source_enabled(text, boolean, text),
  public.admin_retire_import_source(text, uuid, boolean), public.admin_import_status() to authenticated;
grant execute on function public.import_start_run(text), public.import_upsert_notice(text, text, text, text, text, timestamptz, text, text[], timestamptz),
  public.import_finish_run(uuid, text, integer, integer, integer, integer, integer, text) to service_role;

commit;
