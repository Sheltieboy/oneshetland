-- OneShetland Editions, release R1 (foundation). ADDITIVE ONLY: no existing table, column, policy or function is altered.
-- Spec: docs/editions/EDITIONS_SPEC.md (web repo, branch editions-web).
--
-- Model:  edition_organisers (a permanent identity with verified ownership) -> edition_organiser_members (owner/admin/editor)
--         -> editions (dated, branded) -> pages (configurable navigation), venues, sessions (programme), updates, sponsors.
--         edition_entitlements is the commercial ledger; PUBLICATION IS GATED on it (and on a verified organiser). Nothing bypasses the gate,
--         including test editions: they are published by a real admin grant.
-- Security rules applied everywhere:
--   * every table: revoke all from public/anon/authenticated, then grant only what is needed (column-level for updates); no FOR ALL policies;
--   * one policy per command with WITH CHECK, `TO authenticated` for anything that calls a membership helper (the 42501 trap);
--   * every SECURITY DEFINER function: search_path pinned, EXECUTE revoked from public/anon and granted back selectively,
--     and `auth.uid() is not null` (the NULL fail-open class);
--   * Editions never read or write local_businesses, local_offers, events, hubs or any payment table in R1.
-- Ships DARK: public reads additionally require admin_config 'editions.enabled' = 'true' (absent = off). Staff and organiser members always see.

-- ── helpers that need no Edition tables ─────────────────────────────────────────────────────────────────────────────

create or replace function public.editions_enabled() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select lower(btrim(c.value)) = 'true' from public.admin_config c where c.key = 'editions.enabled'), false)
$$;

create or replace function public.edition_role_rank(p_role text) returns integer
language sql immutable set search_path = public, pg_temp as $$
  select case p_role when 'owner' then 3 when 'admin' then 2 when 'editor' then 1 else 0 end
$$;

-- ── organisers ──────────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists public.edition_reserved_names (
  pattern text primary key check (pattern = lower(btrim(pattern)) and char_length(pattern) >= 4),
  note    text
);

create table if not exists public.edition_organisers (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 60),
  name               text not null check (char_length(btrim(name)) between 2 and 120),
  tagline            text check (tagline is null or char_length(tagline) <= 160),
  description        text check (description is null or char_length(description) <= 4000),
  logo_url           text check (logo_url is null or logo_url ~ '^https://[^[:space:]\\<>"'']+$'),
  cover_url          text check (cover_url is null or cover_url ~ '^https://[^[:space:]\\<>"'']+$'),
  brand_color        text check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$'),
  website            text check (website is null or website ~ '^https://[^[:space:]\\<>"'']+$'),
  contact_email      text check (contact_email is null or contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  hub_id             uuid references public.hubs (id) on delete set null,
  status             text not null default 'pending' check (status in ('pending', 'verified', 'rejected', 'suspended')),
  verified_at        timestamptz,
  verified_by        uuid references auth.users (id) on delete set null,
  verification_note  text,
  reserved_name_flag boolean not null default false,
  is_test            boolean not null default false,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.edition_organiser_members (
  organiser_id uuid not null references public.edition_organisers (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null check (role in ('owner', 'admin', 'editor')),
  invited_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (organiser_id, user_id)
);
create index if not exists edition_organiser_members_user_idx on public.edition_organiser_members (user_id);

create table if not exists public.edition_organiser_invites (
  id           uuid primary key default gen_random_uuid(),
  organiser_id uuid not null references public.edition_organisers (id) on delete cascade,
  email        text not null check (email = lower(btrim(email)) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  role         text not null check (role in ('admin', 'editor')),
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  invited_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '14 days'
);
create unique index if not exists edition_organiser_invites_open_uq on public.edition_organiser_invites (organiser_id, email) where status = 'pending';

create table if not exists public.edition_organiser_verifications (
  id           uuid primary key default gen_random_uuid(),
  organiser_id uuid not null references public.edition_organisers (id) on delete cascade,
  evidence     text not null check (char_length(btrim(evidence)) between 10 and 4000),
  requested_by uuid references auth.users (id) on delete set null,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by   uuid references auth.users (id) on delete set null,
  decided_at   timestamptz,
  note         text,
  created_at   timestamptz not null default now()
);
create unique index if not exists edition_organiser_verifications_open_uq on public.edition_organiser_verifications (organiser_id) where status = 'pending';

-- ── editions ────────────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists public.edition_series (
  id           uuid primary key default gen_random_uuid(),
  organiser_id uuid not null references public.edition_organisers (id) on delete restrict,
  name         text not null check (char_length(btrim(name)) between 2 and 120),
  created_at   timestamptz not null default now()
);

create table if not exists public.editions (
  id                      uuid primary key default gen_random_uuid(),
  organiser_id            uuid not null references public.edition_organisers (id) on delete restrict,
  series_id               uuid references public.edition_series (id) on delete set null,
  slug                    text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 80),
  title                   text not null check (char_length(btrim(title)) between 2 and 140),
  summary                 text check (summary is null or char_length(summary) <= 300),
  description             text check (description is null or char_length(description) <= 8000),
  kind                    text not null check (kind in ('single_day', 'multi_day', 'week', 'season', 'campaign')),
  starts_on               date not null,
  ends_on                 date not null,
  timezone                text not null default 'Europe/London',
  year_label              text check (year_label is null or char_length(year_label) <= 20),
  brand_color             text check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$'),
  logo_url                text check (logo_url is null or logo_url ~ '^https://[^[:space:]\\<>"'']+$'),
  cover_url               text check (cover_url is null or cover_url ~ '^https://[^[:space:]\\<>"'']+$'),
  theme                   jsonb not null default '{}'::jsonb check (jsonb_typeof(theme) = 'object' and theme - 'hero' - 'density' = '{}'::jsonb),
  status                  text not null default 'draft' check (status in ('draft', 'published', 'archived', 'suspended')),
  published_at            timestamptz,
  suspended_reason        text,
  suspended_by            uuid references auth.users (id) on delete set null,
  suspended_at            timestamptz,
  status_before_suspend   text,
  is_test                 boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint editions_dates_match_kind check (
    ends_on >= starts_on and case kind
      when 'single_day' then ends_on = starts_on
      when 'multi_day'  then ends_on - starts_on between 1 and 13
      when 'week'       then ends_on - starts_on between 5 and 9
      else ends_on - starts_on <= 400
    end)
);
create index if not exists editions_organiser_idx on public.editions (organiser_id);
create index if not exists editions_public_idx on public.editions (starts_on) where status = 'published';

create table if not exists public.edition_pages (
  id         uuid primary key default gen_random_uuid(),
  edition_id uuid not null references public.editions (id) on delete cascade,
  slug       text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 2 and 60),
  nav_label  text not null check (char_length(btrim(nav_label)) between 1 and 30),
  title      text not null check (char_length(btrim(title)) between 1 and 140),
  body       text not null default '' check (char_length(body) <= 20000 and body !~* '<[[:space:]]*(script|iframe|object|embed|style)'),
  position   integer not null default 0,
  in_nav     boolean not null default true,
  is_home    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (edition_id, slug)
);
create unique index if not exists edition_pages_one_home_uq on public.edition_pages (edition_id) where is_home;

create table if not exists public.edition_venues (
  id           uuid primary key default gen_random_uuid(),
  organiser_id uuid not null references public.edition_organisers (id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 1 and 120),
  address      text check (address is null or char_length(address) <= 300),
  lat          double precision check (lat is null or lat between -90 and 90),
  lng          double precision check (lng is null or lng between -180 and 180),
  notes        text check (notes is null or char_length(notes) <= 500),
  created_at   timestamptz not null default now()
);

create table if not exists public.edition_sessions (
  id          uuid primary key default gen_random_uuid(),
  edition_id  uuid not null references public.editions (id) on delete cascade,
  title       text not null check (char_length(btrim(title)) between 1 and 140),
  description text check (description is null or char_length(description) <= 2000),
  starts_at   timestamptz not null,
  ends_at     timestamptz,
  venue_id    uuid references public.edition_venues (id) on delete set null,
  kind        text not null default 'session' check (kind in ('event', 'activity', 'session', 'exhibition', 'tour')),
  ticket_mode text not null default 'none' check (ticket_mode in ('none', 'external')),
  ticket_url  text check (ticket_url is null or ticket_url ~ '^https://[^[:space:]\\<>"'']+$'),
  price_text  text check (price_text is null or char_length(price_text) <= 60),
  status      text not null default 'scheduled' check (status in ('scheduled', 'cancelled', 'changed')),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint edition_sessions_times check (ends_at is null or ends_at > starts_at),
  constraint edition_sessions_ticket_url check ((ticket_mode = 'external') = (ticket_url is not null))
);
create index if not exists edition_sessions_edition_idx on public.edition_sessions (edition_id, starts_at);

create table if not exists public.edition_updates (
  id           uuid primary key default gen_random_uuid(),
  edition_id   uuid not null references public.editions (id) on delete cascade,
  title        text not null check (char_length(btrim(title)) between 1 and 140),
  body         text not null default '' check (char_length(body) <= 4000 and body !~* '<[[:space:]]*(script|iframe|object|embed|style)'),
  pinned       boolean not null default false,
  published_at timestamptz,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists edition_updates_edition_idx on public.edition_updates (edition_id, published_at desc);

create table if not exists public.edition_sponsors (
  id         uuid primary key default gen_random_uuid(),
  edition_id uuid not null references public.editions (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 120),
  level      text check (level is null or char_length(level) <= 40),
  logo_url   text check (logo_url is null or logo_url ~ '^https://[^[:space:]\\<>"'']+$'),
  url        text check (url is null or url ~ '^https://[^[:space:]\\<>"'']+$'),
  position   integer not null default 0,
  created_at timestamptz not null default now()
);

-- ── commercial ledger (R1 holds the table + the admin grant; R4 adds orders and payments that write the same ledger) ──

create table if not exists public.edition_entitlements (
  id                       uuid primary key default gen_random_uuid(),
  organiser_id             uuid not null references public.edition_organisers (id) on delete restrict,
  edition_id               uuid not null references public.editions (id) on delete restrict,
  feature                  text not null check (feature in ('publish', 'featured_strip', 'follower_notice')),
  starts_at                timestamptz not null,
  ends_at                  timestamptz not null,
  source                   text not null check (source in ('payment', 'admin_grant', 'renewal')),
  order_id                 uuid,
  stripe_payment_intent_id text unique,
  amount_pence             integer check (amount_pence is null or amount_pence >= 0),
  granted_by               uuid references auth.users (id) on delete set null,
  reason                   text,
  voided_at                timestamptz,
  void_reason              text,
  created_at               timestamptz not null default now(),
  constraint edition_entitlements_window check (ends_at > starts_at),
  constraint edition_entitlements_grant_audit check (source <> 'admin_grant' or (granted_by is not null and char_length(btrim(coalesce(reason, ''))) >= 5))
);
create index if not exists edition_entitlements_edition_idx on public.edition_entitlements (edition_id, feature);

create table if not exists public.edition_audit_log (
  id           bigint generated always as identity primary key,
  actor        uuid,
  organiser_id uuid,
  edition_id   uuid,
  action       text not null,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists edition_audit_log_org_idx on public.edition_audit_log (organiser_id, created_at desc);

-- ── lock every table down, then grant selectively ───────────────────────────────────────────────────────────────────

do $$ declare t text; begin
  foreach t in array array['edition_reserved_names','edition_organisers','edition_organiser_members','edition_organiser_invites','edition_organiser_verifications',
    'edition_series','editions','edition_pages','edition_venues','edition_sessions','edition_updates','edition_sponsors','edition_entitlements','edition_audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence public.edition_audit_log_id_seq from public, anon, authenticated;

-- ── helper functions (all use auth.uid(); none accepts a user id, so none can be used to probe other people) ─────────

create or replace function public.edition_org_role(p_org uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select m.role from public.edition_organiser_members m where m.organiser_id = p_org and m.user_id = auth.uid() and auth.uid() is not null
$$;

create or replace function public.edition_org_can(p_org uuid, p_min text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.edition_role_rank(public.edition_org_role(p_org)) >= public.edition_role_rank(p_min), false)
$$;

create or replace function public.edition_can(p_edition uuid, p_min text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select public.edition_org_can(e.organiser_id, p_min) from public.editions e where e.id = p_edition), false)
$$;

create or replace function public.edition_staff() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and (coalesce(public.is_admin(), false) or coalesce(public.attribution_staff(), false))
$$;

create or replace function public.edition_entitled(p_edition uuid, p_feature text, p_at timestamptz default now()) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.edition_entitlements n
                  where n.edition_id = p_edition and n.feature = p_feature and n.voided_at is null
                    and n.starts_at <= p_at and n.ends_at > p_at)
$$;

-- Public means: feature on, not a test, organiser verified, edition published, and a live publish entitlement.
create or replace function public.edition_is_public(p_edition uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.editions_enabled() and exists (
    select 1 from public.editions e join public.edition_organisers o on o.id = e.organiser_id
     where e.id = p_edition and e.status = 'published' and not e.is_test and not o.is_test and o.status = 'verified'
       and public.edition_entitled(e.id, 'publish'))
$$;

create or replace function public.edition_audit(p_org uuid, p_edition uuid, p_action text, p_detail jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.edition_audit_log (actor, organiser_id, edition_id, action, detail) values (auth.uid(), p_org, p_edition, p_action, coalesce(p_detail, '{}'::jsonb))
$$;

-- ── policies ────────────────────────────────────────────────────────────────────────────────────────────────────────

-- organisers: the public sees verified, non-test organisers (flag on); members see their own; staff see all.
create policy "edition_organisers public read" on public.edition_organisers for select to anon, authenticated
  using (public.editions_enabled() and status = 'verified' and not is_test);
create policy "edition_organisers member read" on public.edition_organisers for select to authenticated
  using (public.edition_org_can(id, 'editor') or public.edition_staff());
create policy "edition_organisers admin update" on public.edition_organisers for update to authenticated
  using (public.edition_org_can(id, 'admin') or public.is_admin()) with check (public.edition_org_can(id, 'admin') or public.is_admin());
grant select on public.edition_organisers to anon, authenticated;
grant update (name, tagline, description, logo_url, cover_url, brand_color, website, contact_email) on public.edition_organisers to authenticated;

-- members / invites / verifications: read only through policies; ALL writes through definer functions.
create policy "edition_members read own or team" on public.edition_organiser_members for select to authenticated
  using (user_id = auth.uid() or public.edition_org_can(organiser_id, 'admin') or public.is_admin());
grant select on public.edition_organiser_members to authenticated;

create policy "edition_invites read" on public.edition_organiser_invites for select to authenticated
  using (public.edition_org_can(organiser_id, 'owner') or lower(coalesce(auth.jwt() ->> 'email', '')) = email or public.is_admin());
grant select on public.edition_organiser_invites to authenticated;

create policy "edition_verifications read" on public.edition_organiser_verifications for select to authenticated
  using (public.edition_org_can(organiser_id, 'admin') or public.edition_staff());
grant select on public.edition_organiser_verifications to authenticated;

create policy "edition_reserved_names staff read" on public.edition_reserved_names for select to authenticated using (public.edition_staff());
grant select on public.edition_reserved_names to authenticated;

-- series
create policy "edition_series public read" on public.edition_series for select to anon, authenticated
  using (exists (select 1 from public.editions e where e.series_id = edition_series.id and public.edition_is_public(e.id)));
create policy "edition_series member read" on public.edition_series for select to authenticated
  using (public.edition_org_can(organiser_id, 'editor') or public.edition_staff());
create policy "edition_series insert" on public.edition_series for insert to authenticated with check (public.edition_org_can(organiser_id, 'admin'));
create policy "edition_series update" on public.edition_series for update to authenticated
  using (public.edition_org_can(organiser_id, 'admin')) with check (public.edition_org_can(organiser_id, 'admin'));
grant select on public.edition_series to anon, authenticated;
grant insert (organiser_id, name) on public.edition_series to authenticated;
grant update (name) on public.edition_series to authenticated;

-- editions
create policy "editions public read" on public.editions for select to anon, authenticated using (public.edition_is_public(id));
create policy "editions member read" on public.editions for select to authenticated
  using (public.edition_org_can(organiser_id, 'editor') or public.edition_staff());
create policy "editions insert" on public.editions for insert to authenticated with check (public.edition_org_can(organiser_id, 'admin'));
create policy "editions update" on public.editions for update to authenticated
  using (public.edition_org_can(organiser_id, 'editor')) with check (public.edition_org_can(organiser_id, 'editor'));
create policy "editions delete draft" on public.editions for delete to authenticated
  using (status = 'draft' and public.edition_org_can(organiser_id, 'admin'));
grant select on public.editions to anon, authenticated;
grant insert (organiser_id, series_id, slug, title, summary, description, kind, starts_on, ends_on, year_label, brand_color, logo_url, cover_url, theme) on public.editions to authenticated;
grant update (series_id, title, summary, description, kind, starts_on, ends_on, year_label, brand_color, logo_url, cover_url, theme) on public.editions to authenticated;
grant delete on public.editions to authenticated;

-- child tables share one shape: public when the edition is public; members by role; writes editor+.
do $$ declare t text; begin
  foreach t in array array['edition_pages','edition_sessions','edition_updates','edition_sponsors'] loop
    execute format($f$create policy "%1$s public read" on public.%1$I for select to anon, authenticated using (public.edition_is_public(edition_id))$f$, t);
    execute format($f$create policy "%1$s member read" on public.%1$I for select to authenticated using (public.edition_can(edition_id, 'editor') or public.edition_staff())$f$, t);
    execute format($f$create policy "%1$s insert" on public.%1$I for insert to authenticated with check (public.edition_can(edition_id, 'editor'))$f$, t);
    execute format($f$create policy "%1$s update" on public.%1$I for update to authenticated using (public.edition_can(edition_id, 'editor')) with check (public.edition_can(edition_id, 'editor'))$f$, t);
    execute format($f$create policy "%1$s delete" on public.%1$I for delete to authenticated using (public.edition_can(edition_id, 'editor'))$f$, t);
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('grant delete on public.%I to authenticated', t);
  end loop;
end $$;
-- updates (updated_at touched by trigger; created_by forced by trigger)
grant insert (edition_id, slug, nav_label, title, body, position, in_nav, is_home) on public.edition_pages to authenticated;
grant update (slug, nav_label, title, body, position, in_nav, is_home) on public.edition_pages to authenticated;
grant insert (edition_id, title, description, starts_at, ends_at, venue_id, kind, ticket_mode, ticket_url, price_text, status, position) on public.edition_sessions to authenticated;
grant update (title, description, starts_at, ends_at, venue_id, kind, ticket_mode, ticket_url, price_text, status, position) on public.edition_sessions to authenticated;
grant insert (edition_id, title, body, pinned, published_at) on public.edition_updates to authenticated;
grant update (title, body, pinned, published_at) on public.edition_updates to authenticated;
grant insert (edition_id, name, level, logo_url, url, position) on public.edition_sponsors to authenticated;
grant update (name, level, logo_url, url, position) on public.edition_sponsors to authenticated;

-- venues: members only (addresses are shown publicly only through public sessions' own text; venue rows are read by members and, for a public session's venue, by anyone)
create policy "edition_venues public read" on public.edition_venues for select to anon, authenticated
  using (exists (select 1 from public.edition_sessions s where s.venue_id = edition_venues.id and public.edition_is_public(s.edition_id)));
create policy "edition_venues member read" on public.edition_venues for select to authenticated
  using (public.edition_org_can(organiser_id, 'editor') or public.edition_staff());
create policy "edition_venues insert" on public.edition_venues for insert to authenticated with check (public.edition_org_can(organiser_id, 'editor'));
create policy "edition_venues update" on public.edition_venues for update to authenticated
  using (public.edition_org_can(organiser_id, 'editor')) with check (public.edition_org_can(organiser_id, 'editor'));
create policy "edition_venues delete" on public.edition_venues for delete to authenticated using (public.edition_org_can(organiser_id, 'editor'));
grant select on public.edition_venues to anon, authenticated;
grant insert (organiser_id, name, address, lat, lng, notes) on public.edition_venues to authenticated;
grant update (name, address, lat, lng, notes) on public.edition_venues to authenticated;
grant delete on public.edition_venues to authenticated;

-- entitlements and audit: organiser admins read their own; nobody writes except definer functions.
create policy "edition_entitlements read" on public.edition_entitlements for select to authenticated
  using (public.edition_org_can(organiser_id, 'admin') or public.is_admin());
grant select on public.edition_entitlements to authenticated;
create policy "edition_audit read" on public.edition_audit_log for select to authenticated
  using ((organiser_id is not null and public.edition_org_can(organiser_id, 'admin')) or public.edition_staff());
grant select on public.edition_audit_log to authenticated;

-- ── triggers: integrity that must hold for every writer ─────────────────────────────────────────────────────────────

create or replace function public.edition_touch() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at := now(); return new; end $$;

create or replace function public.edition_updates_stamp() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then new.created_by := coalesce(auth.uid(), new.created_by); end if;
  new.updated_at := now();
  return new;
end $$;

create trigger edition_organisers_touch before update on public.edition_organisers for each row execute function public.edition_touch();
create trigger editions_touch before update on public.editions for each row execute function public.edition_touch();
create trigger edition_pages_touch before update on public.edition_pages for each row execute function public.edition_touch();
create trigger edition_sessions_touch before update on public.edition_sessions for each row execute function public.edition_touch();
create trigger edition_updates_stamp before insert or update on public.edition_updates for each row execute function public.edition_updates_stamp();

-- Slugs, ownership and the test flag never move after creation (belt and braces over the column grants).
create or replace function public.editions_immutable() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.slug is distinct from old.slug then raise exception 'an edition slug cannot change' using errcode = '42501'; end if;
  if new.organiser_id is distinct from old.organiser_id then raise exception 'an edition cannot change organiser' using errcode = '42501'; end if;
  if new.is_test is distinct from old.is_test and coalesce(current_setting('app.edition_test_mark', true), '') <> 'on' then
    raise exception 'is_test cannot change' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger aa_editions_immutable before update on public.editions for each row execute function public.editions_immutable();

create or replace function public.edition_organisers_immutable() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.slug is distinct from old.slug then raise exception 'slug cannot change' using errcode = '42501'; end if;
  if new.is_test is distinct from old.is_test and coalesce(current_setting('app.edition_test_mark', true), '') <> 'on' then
    raise exception 'is_test cannot change' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger aa_edition_organisers_immutable before update on public.edition_organisers for each row execute function public.edition_organisers_immutable();

-- Status is changed ONLY through definer functions (column grants already exclude it); this trigger enforces the publish gate for every writer.
create or replace function public.editions_publish_gate() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.edition_organisers%rowtype;
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from 'published') then
    select * into o from public.edition_organisers where id = new.organiser_id;
    if o.status <> 'verified' then raise exception 'organiser is not verified' using errcode = '42501'; end if;
    if not public.edition_entitled(new.id, 'publish') then raise exception 'no live publish entitlement for this edition' using errcode = '42501'; end if;
    if coalesce(btrim(new.summary), '') = '' then raise exception 'a summary is required before publishing' using errcode = '23514'; end if;
    new.published_at := coalesce(new.published_at, now());
  end if;
  return new;
end $$;
create trigger ab_editions_publish_gate before insert or update of status on public.editions for each row execute function public.editions_publish_gate();

-- A session must fall inside the edition's window (a day of tolerance for overnight events).
create or replace function public.edition_sessions_window() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare e public.editions%rowtype; d date;
begin
  select * into e from public.editions where id = new.edition_id;
  d := (new.starts_at at time zone e.timezone)::date;
  if d < e.starts_on - 1 or d > e.ends_on + 1 then
    raise exception 'session falls outside the edition dates' using errcode = '23514', hint = 'session_outside_edition';
  end if;
  if new.venue_id is not null and not exists (select 1 from public.edition_venues v where v.id = new.venue_id and v.organiser_id = e.organiser_id) then
    raise exception 'venue belongs to another organiser' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger edition_sessions_window before insert or update on public.edition_sessions for each row execute function public.edition_sessions_window();

-- The last owner can never be removed or demoted.
create or replace function public.edition_members_last_owner() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (tg_op = 'DELETE' or (tg_op = 'UPDATE' and new.role <> 'owner')) and old.role = 'owner' then
    if not exists (select 1 from public.edition_organiser_members m where m.organiser_id = old.organiser_id and m.role = 'owner' and m.user_id <> old.user_id) then
      -- allow the cascade when the organiser itself is being deleted
      if exists (select 1 from public.edition_organisers o where o.id = old.organiser_id) then
        raise exception 'an organiser must keep at least one owner' using errcode = '23514', hint = 'last_owner';
      end if;
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger edition_members_last_owner before update or delete on public.edition_organiser_members for each row execute function public.edition_members_last_owner();

-- Overlapping live admin grants for one edition+feature are refused: no silent stacking.
create or replace function public.edition_entitlements_no_stack() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.source = 'admin_grant' and exists (
      select 1 from public.edition_entitlements n
       where n.edition_id = new.edition_id and n.feature = new.feature and n.source = 'admin_grant' and n.voided_at is null and n.id <> new.id
         and tstzrange(n.starts_at, n.ends_at) && tstzrange(new.starts_at, new.ends_at)) then
    raise exception 'an overlapping admin grant already exists' using errcode = '23P01', hint = 'overlapping_grant';
  end if;
  return new;
end $$;
create trigger edition_entitlements_no_stack before insert on public.edition_entitlements for each row execute function public.edition_entitlements_no_stack();

-- Entitlement rows are append-only except for voiding.
create or replace function public.edition_entitlements_append_only() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'entitlements cannot be deleted' using errcode = '42501'; end if;
  if (to_jsonb(new) - 'voided_at' - 'void_reason') is distinct from (to_jsonb(old) - 'voided_at' - 'void_reason') then
    raise exception 'entitlements are append-only (only voiding is allowed)' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger edition_entitlements_append_only before update or delete on public.edition_entitlements for each row execute function public.edition_entitlements_append_only();

-- Audit every status change on editions and organisers, whoever made it.
create or replace function public.editions_audit_status() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    insert into public.edition_audit_log (actor, organiser_id, edition_id, action, detail)
    values (auth.uid(), new.organiser_id, new.id, 'edition_status', jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end $$;
create trigger zz_editions_audit_status after update of status on public.editions for each row execute function public.editions_audit_status();

create or replace function public.organisers_audit_status() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    insert into public.edition_audit_log (actor, organiser_id, action, detail)
    values (auth.uid(), new.id, 'organiser_status', jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end $$;
create trigger zz_organisers_audit_status after update of status on public.edition_organisers for each row execute function public.organisers_audit_status();

-- ── functions called by organisers ──────────────────────────────────────────────────────────────────────────────────

create or replace function public.edition_normalise_name(p text) returns text language sql immutable set search_path = public, pg_temp as $$
  select regexp_replace(lower(btrim(coalesce(p, ''))), '[^a-z0-9]+', ' ', 'g')
$$;

create or replace function public.create_edition_organiser(p_name text, p_slug text, p_tagline text default null, p_description text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_flag boolean;
begin
  if auth.uid() is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if (select count(*) from public.edition_organisers o where o.created_by = auth.uid() and o.status <> 'rejected') >= 5 then
    raise exception 'organiser limit reached' using errcode = '53400', hint = 'organiser_limit';
  end if;
  if p_slug in ('new','admin','api','edit','manage','organisers','editions','account','sign-in','sign-up','dashboard','test','null','undefined') then
    raise exception 'that address is reserved' using errcode = '23514', hint = 'reserved_slug';
  end if;
  select exists (select 1 from public.edition_reserved_names r
                  where public.edition_normalise_name(p_name) like '%' || r.pattern || '%'
                     or replace(p_slug, '-', ' ') like '%' || r.pattern || '%') into v_flag;
  insert into public.edition_organisers (slug, name, tagline, description, reserved_name_flag, created_by)
  values (p_slug, btrim(p_name), p_tagline, p_description, v_flag, auth.uid()) returning id into v_id;
  insert into public.edition_organiser_members (organiser_id, user_id, role, invited_by) values (v_id, auth.uid(), 'owner', auth.uid());
  perform public.edition_audit(v_id, null, 'organiser_created', jsonb_build_object('reserved_name_flag', v_flag));
  return v_id;
end $$;

create or replace function public.request_edition_organiser_verification(p_org uuid, p_evidence text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'owner') then raise exception 'owners only' using errcode = '42501'; end if;
  if (select status from public.edition_organisers where id = p_org) = 'verified' then raise exception 'already verified' using errcode = '23505'; end if;
  insert into public.edition_organiser_verifications (organiser_id, evidence, requested_by) values (p_org, p_evidence, auth.uid()) returning id into v_id;
  update public.edition_organisers set status = 'pending' where id = p_org and status in ('rejected');
  perform public.edition_audit(p_org, null, 'verification_requested');
  return v_id;
end $$;

create or replace function public.invite_edition_member(p_org uuid, p_email text, p_role text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_email text := lower(btrim(p_email));
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'owner') then raise exception 'owners only' using errcode = '42501'; end if;
  if p_role not in ('admin', 'editor') then raise exception 'role must be admin or editor' using errcode = '23514'; end if;
  if (select count(*) from public.edition_organiser_members where organiser_id = p_org) + (select count(*) from public.edition_organiser_invites where organiser_id = p_org and status = 'pending') >= 25 then
    raise exception 'team limit reached' using errcode = '53400', hint = 'team_limit';
  end if;
  insert into public.edition_organiser_invites (organiser_id, email, role, invited_by) values (p_org, v_email, p_role, auth.uid()) returning id into v_id;
  perform public.edition_audit(p_org, null, 'member_invited', jsonb_build_object('role', p_role));
  return v_id;
end $$;

create or replace function public.revoke_edition_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  select organiser_id into v_org from public.edition_organiser_invites where id = p_invite;
  if auth.uid() is null or v_org is null or not public.edition_org_can(v_org, 'owner') then raise exception 'owners only' using errcode = '42501'; end if;
  update public.edition_organiser_invites set status = 'revoked' where id = p_invite and status = 'pending';
end $$;

create or replace function public.accept_edition_invite(p_invite uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.edition_organiser_invites%rowtype; v_email text;
begin
  if auth.uid() is null then raise exception 'sign in required' using errcode = '42501'; end if;
  select lower(email) into v_email from auth.users where id = auth.uid();
  select * into i from public.edition_organiser_invites where id = p_invite for update;
  if not found or i.status <> 'pending' or i.expires_at <= now() or v_email is distinct from i.email then
    raise exception 'invitation not available' using errcode = '42501';
  end if;
  insert into public.edition_organiser_members (organiser_id, user_id, role, invited_by) values (i.organiser_id, auth.uid(), i.role, i.invited_by)
    on conflict (organiser_id, user_id) do update set role = case when public.edition_role_rank(excluded.role) > public.edition_role_rank(public.edition_organiser_members.role) then excluded.role else public.edition_organiser_members.role end;
  update public.edition_organiser_invites set status = 'accepted' where id = p_invite;
  perform public.edition_audit(i.organiser_id, null, 'member_joined', jsonb_build_object('role', i.role));
  return i.organiser_id;
end $$;

create or replace function public.set_edition_member_role(p_org uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'owner') then raise exception 'owners only' using errcode = '42501'; end if;
  if p_role not in ('owner', 'admin', 'editor') then raise exception 'bad role' using errcode = '23514'; end if;
  update public.edition_organiser_members set role = p_role where organiser_id = p_org and user_id = p_user;
  perform public.edition_audit(p_org, null, 'member_role_changed', jsonb_build_object('role', p_role));
end $$;

create or replace function public.remove_edition_member(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if p_user <> auth.uid() and not public.edition_org_can(p_org, 'owner') then raise exception 'owners only' using errcode = '42501'; end if;
  delete from public.edition_organiser_members where organiser_id = p_org and user_id = p_user;
  perform public.edition_audit(p_org, null, 'member_removed');
end $$;

create or replace function public.edition_org_team(p_org uuid)
returns table (user_id uuid, role text, full_name text, joined_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.user_id, m.role, p.full_name, m.created_at
    from public.edition_organiser_members m left join public.profiles p on p.id = m.user_id
   where m.organiser_id = p_org and public.edition_org_can(p_org, 'admin')
   order by public.edition_role_rank(m.role) desc, m.created_at
$$;

-- Publish / unpublish / archive by organiser admins. Moderation uses edition_moderate below. The publish gate trigger decides whether it succeeds.
create or replace function public.edition_set_status(p_edition uuid, p_to text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype;
begin
  if auth.uid() is null or not public.edition_can(p_edition, 'admin') then raise exception 'organiser admins only' using errcode = '42501'; end if;
  select * into e from public.editions where id = p_edition for update;
  if e.status = 'suspended' then raise exception 'suspended by OneShetland' using errcode = '42501', hint = 'suspended'; end if;
  if p_to not in ('draft', 'published', 'archived') then raise exception 'bad status' using errcode = '23514'; end if;
  update public.editions set status = p_to where id = p_edition;
end $$;

-- ── staff functions ─────────────────────────────────────────────────────────────────────────────────────────────────

create or replace function public.admin_decide_edition_organiser(p_org uuid, p_decision text, p_note text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.edition_organisers%rowtype;
begin
  if auth.uid() is null then raise exception 'sign in required' using errcode = '42501'; end if;
  select * into o from public.edition_organisers where id = p_org for update;
  if not found then raise exception 'unknown organiser' using errcode = 'P0002'; end if;
  if p_decision = 'suspend' then
    if not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
    update public.edition_organisers set status = 'suspended', verification_note = coalesce(p_note, verification_note) where id = p_org;
  elsif p_decision in ('verify', 'reject', 'reinstate') then
    if not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
    if p_decision = 'verify' and o.reserved_name_flag and char_length(btrim(coalesce(p_note, ''))) < 10 then
      raise exception 'a reserved-name organiser needs a written verification note' using errcode = '23514', hint = 'reserved_note_required';
    end if;
    if p_decision = 'verify' or p_decision = 'reinstate' then
      update public.edition_organisers set status = 'verified', verified_at = now(), verified_by = auth.uid(), verification_note = p_note where id = p_org;
    else
      update public.edition_organisers set status = 'rejected', verification_note = p_note where id = p_org;
    end if;
    update public.edition_organiser_verifications set status = case when p_decision = 'reject' then 'rejected' else 'approved' end,
           decided_by = auth.uid(), decided_at = now(), note = p_note where organiser_id = p_org and status = 'pending';
  else
    raise exception 'bad decision' using errcode = '23514';
  end if;
  perform public.edition_audit(p_org, null, 'organiser_' || p_decision, jsonb_build_object('note', p_note));
end $$;

create or replace function public.admin_link_edition_organiser_hub(p_org uuid, p_hub uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  update public.edition_organisers set hub_id = p_hub where id = p_org;
  perform public.edition_audit(p_org, null, 'hub_linked', jsonb_build_object('hub_id', p_hub));
end $$;

create or replace function public.edition_moderate(p_edition uuid, p_action text, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype;
begin
  -- Suspension and restoration are for OneShetland administrators only (decision 9 Nov 2026); moderators have no route here.
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  select * into e from public.editions where id = p_edition for update;
  if not found then raise exception 'unknown edition' using errcode = 'P0002'; end if;
  if p_action = 'suspend' then
    if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'a reason is required' using errcode = '23514'; end if;
    update public.editions set status_before_suspend = case when status = 'suspended' then status_before_suspend else status end,
           status = 'suspended', suspended_reason = p_reason, suspended_by = auth.uid(), suspended_at = now() where id = p_edition;
  elsif p_action = 'restore' then
    if e.status <> 'suspended' then raise exception 'not suspended' using errcode = '23514'; end if;
    update public.editions set status = case when coalesce(e.status_before_suspend, 'draft') = 'published' then 'draft' else coalesce(e.status_before_suspend, 'draft') end,
           suspended_reason = null, suspended_by = null, suspended_at = null where id = p_edition;
  else
    raise exception 'bad action' using errcode = '23514';
  end if;
  perform public.edition_audit(e.organiser_id, p_edition, 'edition_' || p_action, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.admin_grant_edition_entitlement(p_edition uuid, p_feature text, p_starts timestamptz, p_ends timestamptz, p_reason text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; v_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  select * into e from public.editions where id = p_edition;
  if not found then raise exception 'unknown edition' using errcode = 'P0002'; end if;
  if p_ends is null or p_ends <= coalesce(p_starts, now()) then raise exception 'a grant needs an end after its start' using errcode = '23514'; end if;
  if p_ends > now() + interval '25 months' then raise exception 'a grant cannot run longer than 24 months from now' using errcode = '23514', hint = 'grant_too_long'; end if;
  insert into public.edition_entitlements (organiser_id, edition_id, feature, starts_at, ends_at, source, granted_by, reason)
  values (e.organiser_id, p_edition, p_feature, coalesce(p_starts, now()), p_ends, 'admin_grant', auth.uid(), p_reason) returning id into v_id;
  perform public.edition_audit(e.organiser_id, p_edition, 'entitlement_granted', jsonb_build_object('feature', p_feature, 'ends_at', p_ends, 'reason', p_reason));
  return v_id;
end $$;

create or replace function public.admin_void_edition_entitlement(p_entitlement uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare n public.edition_entitlements%rowtype;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'a reason is required' using errcode = '23514'; end if;
  update public.edition_entitlements set voided_at = now(), void_reason = p_reason where id = p_entitlement and voided_at is null returning * into n;
  if not found then raise exception 'no live entitlement with that id' using errcode = 'P0002'; end if;
  perform public.edition_audit(n.organiser_id, n.edition_id, 'entitlement_voided', jsonb_build_object('reason', p_reason));
end $$;

-- Creating a private test organisation: a flagged organiser+edition for staff exercise. It still has to be verified and granted like any other.
create or replace function public.admin_mark_edition_test(p_org uuid, p_edition uuid default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  perform set_config('app.edition_test_mark', 'on', true);
  update public.edition_organisers set is_test = true where id = p_org;
  if p_edition is not null then update public.editions set is_test = true where id = p_edition and organiser_id = p_org; end if;
end $$;

-- ── grants for functions ────────────────────────────────────────────────────────────────────────────────────────────

do $$ declare f text; begin
  foreach f in array array[
    'edition_role_rank(text)','edition_org_role(uuid)','edition_org_can(uuid,text)','edition_can(uuid,text)','edition_staff()','edition_audit(uuid,uuid,text,jsonb)',
    'edition_normalise_name(text)','create_edition_organiser(text,text,text,text)','request_edition_organiser_verification(uuid,text)','invite_edition_member(uuid,text,text)',
    'revoke_edition_invite(uuid)','accept_edition_invite(uuid)','set_edition_member_role(uuid,uuid,text)','remove_edition_member(uuid,uuid)','edition_org_team(uuid)',
    'edition_set_status(uuid,text)','admin_decide_edition_organiser(uuid,text,text)','admin_link_edition_organiser_hub(uuid,uuid)','edition_moderate(uuid,text,text)',
    'admin_grant_edition_entitlement(uuid,text,timestamptz,timestamptz,text)','admin_void_edition_entitlement(uuid,text)','admin_mark_edition_test(uuid,uuid)',
    'editions_enabled()','edition_entitled(uuid,text,timestamptz)','edition_is_public(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
-- anon must be able to evaluate the public-read policies
grant execute on function public.editions_enabled() to anon, authenticated;
grant execute on function public.edition_entitled(uuid, text, timestamptz) to anon, authenticated;
grant execute on function public.edition_is_public(uuid) to anon, authenticated;
grant execute on function public.edition_role_rank(text) to anon, authenticated;
-- signed-in only
do $$ declare f text; begin
  foreach f in array array[
    'edition_org_role(uuid)','edition_org_can(uuid,text)','edition_can(uuid,text)','edition_staff()','create_edition_organiser(text,text,text,text)',
    'request_edition_organiser_verification(uuid,text)','invite_edition_member(uuid,text,text)','revoke_edition_invite(uuid)','accept_edition_invite(uuid)',
    'set_edition_member_role(uuid,uuid,text)','remove_edition_member(uuid,uuid)','edition_org_team(uuid)','edition_set_status(uuid,text)',
    'admin_decide_edition_organiser(uuid,text,text)','admin_link_edition_organiser_hub(uuid,uuid)','edition_moderate(uuid,text,text)',
    'admin_grant_edition_entitlement(uuid,text,timestamptz,timestamptz,text)','admin_void_edition_entitlement(uuid,text)','admin_mark_edition_test(uuid,uuid)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
-- edition_audit and edition_normalise_name stay internal (definer callers only). Trigger functions are never callable by clients either.
do $$ declare f text; begin
  foreach f in array array['edition_touch()','edition_updates_stamp()','editions_immutable()','edition_organisers_immutable()','editions_publish_gate()',
    'edition_sessions_window()','edition_members_last_owner()','edition_entitlements_no_stack()','edition_entitlements_append_only()',
    'editions_audit_status()','organisers_audit_status()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- ── reserved names (never seeded as pages; only used to flag organisers for careful admin verification) ────────────────

insert into public.edition_reserved_names (pattern, note) values
  ('taste of shetland', 'real event; not affiliated'),
  ('wool week', 'real event; not affiliated'),
  ('up helly aa', 'real event; not affiliated'),
  ('folk festival', 'real event; not affiliated')
on conflict do nothing;

-- ── storage: organiser-scoped public bucket (path prefix = organiser id) ───────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('edition-media', 'edition-media', true, 10485760, array['image/jpeg','image/jpg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists "edition-media public read" on storage.objects;
drop policy if exists "edition-media member write" on storage.objects;
drop policy if exists "edition-media member update" on storage.objects;
drop policy if exists "edition-media member delete" on storage.objects;
create policy "edition-media public read" on storage.objects for select using (bucket_id = 'edition-media');
create policy "edition-media member write" on storage.objects for insert to authenticated
  with check (bucket_id = 'edition-media' and exists (select 1 from public.edition_organiser_members m
               where m.organiser_id::text = split_part(name, '/', 1) and m.user_id = auth.uid()));
create policy "edition-media member update" on storage.objects for update to authenticated
  using (bucket_id = 'edition-media' and exists (select 1 from public.edition_organiser_members m
               where m.organiser_id::text = split_part(name, '/', 1) and m.user_id = auth.uid()));
create policy "edition-media member delete" on storage.objects for delete to authenticated
  using (bucket_id = 'edition-media' and exists (select 1 from public.edition_organiser_members m
               where m.organiser_id::text = split_part(name, '/', 1) and m.user_id = auth.uid()));

-- ── analytics registry (names only; no PII, no new columns) ────────────────────────────────────────────────────────

insert into public.analytics_event_defs (event_name, is_conversion, category, description) values
  ('edition_viewed', false, 'content_interaction', 'An Edition page was viewed (object_type edition)'),
  ('edition_session_viewed', false, 'content_interaction', 'An Edition programme session was viewed'),
  ('edition_ticket_clicked', true, 'sales_intent', 'External ticket link clicked from an Edition session')
on conflict (event_name) do nothing;
