-- Geography Stage 2A - canonical geography foundation (ADDITIVE; no existing table, row, policy or function is touched).
--
-- WHY
-- Stage 1 found 8+ unrelated area systems (regions table, transit areas, two Local lists, two profile pickers, Jobs areas, free-text hub/notice/event/business
-- fields). Before Notices, Hubs, Jobs, Events or Businesses can share geography they need ONE vocabulary with stable IDs. This migration creates only that
-- reference layer. Nothing reads it yet, no content is migrated, no URL or app constant changes.
--
-- MODEL
--   areas            Level 0 shetland_wide (a SCOPE, not a place) -> 7 official localities (HSCP annual performance report 2024-25) -> places/islands/areas/sites
--   place_aliases    deterministic, exact (normalised) spellings -> a canonical area, or an explicit non-answer (ambiguous / non_geographic / invalid / unspecified)
--   geography_review admin queue for values nobody has resolved
--   geo_normalise()  trim, lower-case, accent-fold, "&"->"and", punctuation->space, trailing ", Shetland[ Islands][, Scotland|UK]" removed. NO fuzzy matching.
--   resolve_geography(text) -> jsonb {status: resolved|unresolved|ambiguous|invalid|non_geographic, ...}
--
-- RULES BAKED IN
--   * shetland_wide means "relevant to everyone". It is NOT a place and NOT "unknown": an address of just "Shetland" resolves to UNRESOLVED (unspecified), never shetland_wide.
--   * Remote / Hybrid / Offshore / Marine are work context, not geography (non_geographic).
--   * Only HIGH-confidence aliases onto HIGH-confidence active areas ever return status 'resolved'. Medium/low return 'unresolved' with a candidate.
--   * Foula and Papa Stour are registered but PENDING: no parent, inactive, never resolved (no official source places them).
--   * Boundaries: boundary_ref exists and is NULL everywhere (licence for the data-zone route is unconfirmed).
-- SECURITY: public read of ACTIVE rows; writes admin-only (is_admin()) or service role; review queue admin-only.

begin;

create function public.geo_normalise(p text)
returns text
language sql
immutable
parallel safe
as $f$
  select btrim(
    regexp_replace(
      regexp_replace(
        translate(
          replace(replace(replace(
            regexp_replace(lower(btrim(coalesce(p, ''))),
              ',[[:space:]]*shetland([[:space:]]+islands)?([[:space:]]*,[[:space:]]*(scotland|uk|united kingdom))*[[:space:]]*$', ''),
            '&', ' and '), '’', ''), '''', ''),
          'àáâãäåèéêëìíîïòóôõöùúûüñç', 'aaaaaaeeeeiiiiooooouuuunc'),
        '[^a-z0-9]+', ' ', 'g'),
      '[[:space:]]+', ' ', 'g')
  );
$f$;

create function public.tg_geo_touch() returns trigger language plpgsql as $f$
begin new.updated_at := now(); return new; end;
$f$;

create table public.areas (
  id            text primary key check (id ~ '^[a-z][a-z0-9_]*$' and length(id) <= 64),
  slug          text not null unique check (slug ~ '^[a-z][a-z0-9-]*$'),
  name_official text not null check (btrim(name_official) <> ''),
  name_display  text not null check (btrim(name_display) <> ''),
  type          text not null check (type in ('shetland', 'locality', 'settlement', 'island', 'area', 'site')),
  parent_id     text references public.areas(id) on delete restrict,
  is_physical   boolean generated always as (type <> 'shetland') stored,
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  confidence    text not null check (confidence in ('high', 'medium', 'low')),
  source        text,
  evidence      text,
  metadata      jsonb not null default '{}'::jsonb,
  boundary_ref  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint areas_shetland_root   check (type <> 'shetland' or (parent_id is null and id = 'shetland_wide')),
  constraint areas_locality_parent check (type <> 'locality' or parent_id = 'shetland_wide'),
  constraint areas_pending_inactive check (parent_id is not null or type = 'shetland' or is_active = false)
);
create index areas_parent_idx on public.areas (parent_id, sort_order);
create trigger areas_touch before update on public.areas for each row execute function public.tg_geo_touch();

create function public.tg_areas_validate() returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $f$
declare v_parent_type text;
begin
  if new.type in ('settlement', 'island', 'area', 'site') and new.parent_id is not null then
    select type into v_parent_type from public.areas where id = new.parent_id;
    if v_parent_type is distinct from 'locality' then
      raise exception 'A % must sit directly beneath a locality (parent % is a %)', new.type, new.parent_id, coalesce(v_parent_type, 'missing') using errcode = '23514';
    end if;
  end if;
  return new;
end;
$f$;
create trigger areas_validate before insert or update on public.areas for each row execute function public.tg_areas_validate();

create table public.place_aliases (
  id               bigint generated always as identity primary key,
  alias            text not null,
  alias_normalised text generated always as (public.geo_normalise(alias)) stored,
  kind             text not null check (kind in ('place', 'area', 'scope', 'ambiguous', 'non_geographic', 'invalid', 'unspecified')),
  area_id          text references public.areas(id) on delete restrict,
  candidate_ids    text[] not null default '{}',
  confidence       text not null check (confidence in ('high', 'medium', 'low')),
  source           text,
  notes            text,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint place_aliases_nonempty check (alias_normalised <> ''),
  constraint place_aliases_target check (
    (kind in ('place', 'area', 'scope') and area_id is not null)
    or (kind not in ('place', 'area', 'scope') and area_id is null)),
  constraint place_aliases_scope check (kind <> 'scope' or area_id = 'shetland_wide'),
  constraint place_aliases_candidates check (kind = 'ambiguous' or cardinality(candidate_ids) = 0)
);
create unique index place_aliases_active_uq on public.place_aliases (alias_normalised) where is_active;
create index place_aliases_area_idx on public.place_aliases (area_id);
create trigger place_aliases_touch before update on public.place_aliases for each row execute function public.tg_geo_touch();

create function public.tg_place_aliases_validate() returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $f$
declare t text; c text;
begin
  if new.kind in ('place', 'area') then
    select type into t from public.areas where id = new.area_id;
    if new.kind = 'area'  and t is distinct from 'locality' then raise exception 'An "area" alias must point at a locality' using errcode = '23514'; end if;
    if new.kind = 'place' and t not in ('settlement', 'island', 'area', 'site') then raise exception 'A "place" alias must point at a settlement, island, area or site' using errcode = '23514'; end if;
  end if;
  foreach c in array new.candidate_ids loop
    if not exists (select 1 from public.areas where id = c) then raise exception 'Unknown candidate area %', c using errcode = '23503'; end if;
  end loop;
  return new;
end;
$f$;
create trigger place_aliases_validate before insert or update on public.place_aliases for each row execute function public.tg_place_aliases_validate();

create table public.geography_review (
  id                 bigint generated always as identity primary key,
  source_system      text not null,
  source_field       text not null,
  original_value     text not null,
  value_normalised   text generated always as (public.geo_normalise(original_value)) stored,
  occurrences        integer not null default 1,
  status             text not null default 'open' check (status in ('open', 'resolved', 'dismissed', 'invalid', 'non_geographic')),
  suggested_area_id  text references public.areas(id) on delete set null,
  resolved_area_id   text references public.areas(id) on delete set null,
  reason             text,
  notes              text,
  first_seen         timestamptz not null default now(),
  last_seen          timestamptz not null default now(),
  reviewed_by        uuid references public.profiles(id) on delete set null,
  reviewed_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint geography_review_resolved check (status <> 'resolved' or resolved_area_id is not null),
  constraint geography_review_uq unique (source_system, source_field, value_normalised)
);
create trigger geography_review_touch before update on public.geography_review for each row execute function public.tg_geo_touch();

-- ── Resolver ───────────────────────────────────────────────────────────────────
create function public.resolve_geography(p_input text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $f$
declare
  n text := public.geo_normalise(p_input);
  al public.place_aliases%rowtype;
  ar public.areas%rowtype;
  v_loc text;
  out jsonb := jsonb_build_object('input', p_input, 'normalised', n, 'status', 'unresolved', 'reason', 'no_match',
                                  'area_id', null, 'locality_id', null, 'area_type', null, 'is_shetland_wide', false,
                                  'confidence', null, 'kind', null, 'alias_id', null, 'candidate_ids', '[]'::jsonb);
begin
  if n = '' then return out || jsonb_build_object('reason', 'empty'); end if;
  select * into al from public.place_aliases where alias_normalised = n and is_active;
  if not found then return out; end if;
  out := out || jsonb_build_object('kind', al.kind, 'alias_id', al.id, 'confidence', al.confidence);

  if al.kind = 'ambiguous' then
    return out || jsonb_build_object('status', 'ambiguous', 'reason', 'ambiguous_alias', 'candidate_ids', to_jsonb(al.candidate_ids));
  elsif al.kind = 'non_geographic' then
    return out || jsonb_build_object('status', 'non_geographic', 'reason', 'work_context_not_geography');
  elsif al.kind = 'invalid' then
    return out || jsonb_build_object('status', 'invalid', 'reason', 'invalid_or_test_value');
  elsif al.kind = 'unspecified' then
    return out || jsonb_build_object('status', 'unresolved', 'reason', 'unspecified_within_shetland');
  end if;

  select * into ar from public.areas where id = al.area_id;
  if not found or not ar.is_active then
    return out || jsonb_build_object('reason', 'area_inactive_or_pending', 'candidate_ids', jsonb_build_array(al.area_id));
  end if;
  v_loc := case when ar.type = 'locality' then ar.id when ar.type = 'shetland' then null else ar.parent_id end;
  out := out || jsonb_build_object('area_id', ar.id, 'area_type', ar.type, 'locality_id', v_loc, 'is_shetland_wide', ar.id = 'shetland_wide');
  if al.confidence = 'high' and ar.confidence = 'high' then
    return out || jsonb_build_object('status', 'resolved', 'reason', 'exact_alias');
  end if;
  -- uncertain: report the candidate but do NOT resolve
  return out || jsonb_build_object('status', 'unresolved', 'reason', 'confidence_below_high', 'area_id', null, 'locality_id', null, 'is_shetland_wide', false,
                                   'candidate_ids', jsonb_build_array(ar.id));
end;
$f$;

-- ── Security ──────────────────────────────────────────────────────────────────
alter table public.areas            enable row level security;
alter table public.place_aliases    enable row level security;
alter table public.geography_review enable row level security;

revoke all on public.areas, public.place_aliases, public.geography_review from public, anon, authenticated;
grant select on public.areas, public.place_aliases to anon, authenticated;
grant insert, update, delete on public.areas, public.place_aliases to authenticated;      -- gated by the admin-only policies below
grant select, insert, update, delete on public.geography_review to authenticated;        -- admin-only policy
grant all on public.areas, public.place_aliases, public.geography_review to service_role;

create policy "areas public read"   on public.areas         for select to anon, authenticated using (is_active or public.is_admin());
create policy "areas admin write"   on public.areas         for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "aliases public read" on public.place_aliases for select to anon, authenticated using (is_active or public.is_admin());
create policy "aliases admin write" on public.place_aliases for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "review admin only"   on public.geography_review for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on function public.resolve_geography(text), public.geo_normalise(text) from public;
grant execute on function public.resolve_geography(text), public.geo_normalise(text) to anon, authenticated, service_role;


-- ── Seed: Level 0 (a scope, not a place) ──────────────────────────────────────
insert into public.areas (id, slug, name_official, name_display, type, parent_id, sort_order, is_active, confidence, source, evidence, metadata) values
  ('shetland_wide', 'shetland-wide', 'Shetland-wide', 'Shetland-wide', 'shetland', null, 0, true, 'high', 'OneShetland geography Stage 1 audit', 'Scope meaning "relevant to everyone in Shetland". Not a physical locality; not an unknown location; not Remote, Hybrid or Offshore/Marine.', '{"is_scope": true}'::jsonb);

-- ── Seed: Level 1 - the seven verified localities (HSCP annual performance report 2024-25; PHS lookup 2024-05; SIC housing areas list) ──
insert into public.areas (id, slug, name_official, name_display, type, parent_id, sort_order, is_active, confidence, source, evidence, metadata) values
  ('lerwick_bressay', 'lerwick-bressay', 'Lerwick & Bressay', 'Lerwick & Bressay', 'locality', 'shetland_wide', 10, true, 'high', 'Shetland HSCP annual performance report 2024-25 (PHS LIST Locality Profile, Dec 2024)', 'Official wording (HSCP 2024-25). PHS lookup name: Lerwick & Bressay. SIC housing name: Lerwick & Bressay.', '{"population_2024_25": 6848, "data_zones_phs_2024_05": 13, "phs_lookup_name": "Lerwick & Bressay", "sic_housing_name": "Lerwick & Bressay", "stage1_notes": "Lerwick, Bressay (and Noss). Identical wording in all three SIC/PHS sources."}'::jsonb),
  ('shetland_central', 'shetland-central', 'Shetland Central', 'Central Mainland', 'locality', 'shetland_wide', 20, true, 'high', 'Shetland HSCP annual performance report 2024-25 (PHS LIST Locality Profile, Dec 2024)', 'Official wording (HSCP 2024-25). PHS lookup name: Central Mainland. SIC housing name: Central.', '{"population_2024_25": 3494, "data_zones_phs_2024_05": 2, "phs_lookup_name": "Central Mainland", "sic_housing_name": "Central", "stage1_notes": "Scalloway, Burra, Trondra, Tingwall, Whiteness, Weisdale."}'::jsonb),
  ('shetland_north', 'shetland-north', 'Shetland North', 'North Mainland', 'locality', 'shetland_wide', 30, true, 'high', 'Shetland HSCP annual performance report 2024-25 (PHS LIST Locality Profile, Dec 2024)', 'Official wording (HSCP 2024-25). PHS lookup name: North Mainland. SIC housing name: North.', '{"population_2024_25": 3251, "data_zones_phs_2024_05": 4, "phs_lookup_name": "North Mainland", "sic_housing_name": "North", "stage1_notes": "Delting, Nesting & Lunnasting, Northmavine (Brae, Voe, Vidlin, Hillswick, North Roe ...). NB the transit data wrongly puts Nesting in Central."}'::jsonb),
  ('shetland_south', 'shetland-south', 'Shetland South', 'South Mainland', 'locality', 'shetland_wide', 40, true, 'high', 'Shetland HSCP annual performance report 2024-25 (PHS LIST Locality Profile, Dec 2024)', 'Official wording (HSCP 2024-25). PHS lookup name: South Mainland. SIC housing name: South.', '{"population_2024_25": 4494, "data_zones_phs_2024_05": 4, "phs_lookup_name": "South Mainland", "sic_housing_name": "South", "stage1_notes": "Dunrossness, Sandwick, Cunningsburgh, Gulberwick/Quarff; Fair Isle is listed here by SIC."}'::jsonb),
  ('shetland_west', 'shetland-west', 'Shetland West', 'West Mainland / Westside', 'locality', 'shetland_wide', 50, true, 'high', 'Shetland HSCP annual performance report 2024-25 (PHS LIST Locality Profile, Dec 2024)', 'Official wording (HSCP 2024-25). PHS lookup name: West Mainland. SIC housing name: West.', '{"population_2024_25": 2246, "data_zones_phs_2024_05": 3, "phs_lookup_name": "West Mainland", "sic_housing_name": "West", "stage1_notes": "Sandness & Walls, Sandsting & Aithsting. Foula and Papa Stour are not named in the SIC lists (see review)."}'::jsonb),
  ('whalsay_skerries', 'whalsay-skerries', 'Whalsay & Skerries', 'Whalsay & Skerries', 'locality', 'shetland_wide', 60, true, 'high', 'Shetland HSCP annual performance report 2024-25 (PHS LIST Locality Profile, Dec 2024)', 'Official wording (HSCP 2024-25). PHS lookup name: Whalsay & Skerries. SIC housing name: Whalsay & Skerries.', '{"population_2024_25": 1065, "data_zones_phs_2024_05": 2, "phs_lookup_name": "Whalsay & Skerries", "sic_housing_name": "Whalsay & Skerries", "stage1_notes": "Whalsay (Symbister, Brough) and Out Skerries."}'::jsonb),
  ('yell_unst_fetlar', 'yell-unst-fetlar', 'Yell, Unst & Fetlar', 'Yell, Unst & Fetlar / North Isles', 'locality', 'shetland_wide', 70, true, 'high', 'Shetland HSCP annual performance report 2024-25 (PHS LIST Locality Profile, Dec 2024)', 'Official wording (HSCP 2024-25). PHS lookup name: North Isles. SIC housing name: North Isles.', '{"population_2024_25": 1542, "data_zones_phs_2024_05": 2, "phs_lookup_name": "North Isles", "sic_housing_name": "North Isles", "stage1_notes": "Yell, Unst, Fetlar. \"North Isles\" is used by PHS and the SIC housing list for exactly this group; SIC community-council list uses a wider \"Isles\" (adds Whalsay, Skerries)."}'::jsonb);

-- ── Seed: places beneath their verified locality. HIGH = active and resolvable; MEDIUM = registered, never auto-resolved; LOW = pending, no parent, inactive ──
insert into public.areas (id, slug, name_official, name_display, type, parent_id, sort_order, is_active, confidence, source, evidence, metadata) values
  ('lerwick', 'lerwick', 'Lerwick', 'Lerwick', 'settlement', 'lerwick_bressay', 10, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas + CC list: Lerwick', '{"stage1_notes": "Venue/street aliases are Lerwick-only names."}'::jsonb),
  ('bressay', 'bressay', 'Bressay', 'Bressay', 'island', 'lerwick_bressay', 20, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas + CC list: Bressay', '{"stage1_notes": null}'::jsonb),
  ('noss', 'noss', 'Noss', 'Noss', 'island', 'lerwick_bressay', 30, true, 'medium', 'OneShetland geography Stage 1 audit', 'Shetland.org "Bressay and Noss" (secondary); SIC CC list names Bressay only', '{"stage1_notes": "Not named in SIC lists; assigned with Bressay. Needs confirmation."}'::jsonb),
  ('scalloway', 'scalloway', 'Scalloway', 'Scalloway', 'settlement', 'shetland_central', 40, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas + CC list: Scalloway', '{"stage1_notes": null}'::jsonb),
  ('burra', 'burra', 'Burra', 'Burra', 'island', 'shetland_central', 50, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Burra (Bridge End/Toogs; Hamnavoe); CC "Burra & Trondra"', '{"stage1_notes": "\"Hamnavoe\" alone is ambiguous (Burra vs a hamlet in Northmavine): Burra only where context/postcode ZE2 9LA supports it."}'::jsonb),
  ('trondra', 'trondra', 'Trondra', 'Trondra', 'island', 'shetland_central', 60, true, 'high', 'OneShetland geography Stage 1 audit', 'CC list "Burra & Trondra"', '{"stage1_notes": null}'::jsonb),
  ('tingwall', 'tingwall', 'Tingwall', 'Tingwall', 'settlement', 'shetland_central', 70, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Tingwall; CC "Tingwall, Whiteness & Weisdale"', '{"stage1_notes": "Girlsta and Gott are transit-data evidence only (Medium)."}'::jsonb),
  ('whiteness', 'whiteness', 'Whiteness', 'Whiteness', 'settlement', 'shetland_central', 80, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Whiteness', '{"stage1_notes": null}'::jsonb),
  ('weisdale', 'weisdale', 'Weisdale', 'Weisdale', 'settlement', 'shetland_central', 90, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Weisdale', '{"stage1_notes": null}'::jsonb),
  ('brae', 'brae', 'Brae', 'Brae', 'settlement', 'shetland_north', 100, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Brae', '{"stage1_notes": null}'::jsonb),
  ('voe', 'voe', 'Voe', 'Voe', 'settlement', 'shetland_north', 110, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Voe', '{"stage1_notes": null}'::jsonb),
  ('vidlin', 'vidlin', 'Vidlin', 'Vidlin', 'settlement', 'shetland_north', 120, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Vidlin; CC "Nesting & Lunnasting"', '{"stage1_notes": null}'::jsonb),
  ('mossbank', 'mossbank', 'Mossbank', 'Mossbank', 'settlement', 'shetland_north', 130, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Mossbank', '{"stage1_notes": null}'::jsonb),
  ('firth', 'firth', 'Firth', 'Firth', 'settlement', 'shetland_north', 140, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Firth', '{"stage1_notes": null}'::jsonb),
  ('nesting', 'nesting', 'Nesting', 'Nesting', 'area', 'shetland_north', 150, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: South Nesting; CC "Nesting & Lunnasting"', '{"stage1_notes": "Conflicts with transit data, which places Nesting in \"central\". Laxo = Medium."}'::jsonb),
  ('hillswick', 'hillswick', 'Hillswick', 'Hillswick', 'settlement', 'shetland_north', 160, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Hillswick; CC Northmavine', '{"stage1_notes": "Eshaness/Ronas Voe/Gloup/Fethaland are Northmavine places (Medium)."}'::jsonb),
  ('north_roe', 'north-roe', 'North Roe', 'North Roe', 'settlement', 'shetland_north', 170, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: North Roe', '{"stage1_notes": null}'::jsonb),
  ('ollaberry', 'ollaberry', 'Ollaberry', 'Ollaberry', 'settlement', 'shetland_north', 180, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Ollaberry, Urafirth', '{"stage1_notes": null}'::jsonb),
  ('sullom_voe', 'sullom-voe', 'Sullom Voe', 'Sullom Voe', 'site', 'shetland_north', 190, true, 'medium', 'OneShetland geography Stage 1 audit', 'CC "Delting" (Sullom Voe is in Delting) - not named in SIC lists', '{"stage1_notes": null}'::jsonb),
  ('toft', 'toft', 'Toft', 'Toft', 'settlement', 'shetland_north', 200, true, 'medium', 'OneShetland geography Stage 1 audit', 'Delting (not named in SIC lists)', '{"stage1_notes": null}'::jsonb),
  ('muckle_roe', 'muckle-roe', 'Muckle Roe', 'Muckle Roe', 'island', 'shetland_north', 210, true, 'medium', 'OneShetland geography Stage 1 audit', 'Delting (not named in SIC lists)', '{"stage1_notes": null}'::jsonb),
  ('northmavine', 'northmavine', 'Northmavine', 'Northmavine', 'area', 'shetland_north', 220, true, 'high', 'OneShetland geography Stage 1 audit', 'CC "Northmavine"', '{"stage1_notes": "Peninsula/CC area, not a settlement."}'::jsonb),
  ('delting', 'delting', 'Delting', 'Delting', 'area', 'shetland_north', 230, true, 'high', 'OneShetland geography Stage 1 audit', 'CC "Delting"', '{"stage1_notes": "CC area."}'::jsonb),
  ('sandwick', 'sandwick', 'Sandwick', 'Sandwick', 'settlement', 'shetland_south', 240, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Sandwick; CC "Sandwick"', '{"stage1_notes": "\"Sandwick\" in this data is the South Mainland Sandwick. Hoswick/Old Scatness/St Ninian''s Isle Medium."}'::jsonb),
  ('cunningsburgh', 'cunningsburgh', 'Cunningsburgh', 'Cunningsburgh', 'settlement', 'shetland_south', 250, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Cunningsburgh', '{"stage1_notes": null}'::jsonb),
  ('bigton', 'bigton', 'Bigton', 'Bigton', 'settlement', 'shetland_south', 260, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Bigton', '{"stage1_notes": null}'::jsonb),
  ('boddam', 'boddam', 'Boddam', 'Boddam', 'settlement', 'shetland_south', 270, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Boddam', '{"stage1_notes": null}'::jsonb),
  ('virkie', 'virkie', 'Virkie', 'Virkie', 'settlement', 'shetland_south', 280, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Virkie', '{"stage1_notes": null}'::jsonb),
  ('sumburgh', 'sumburgh', 'Sumburgh', 'Sumburgh', 'settlement', 'shetland_south', 290, true, 'medium', 'OneShetland geography Stage 1 audit', 'Dunrossness (not named in SIC lists)', '{"stage1_notes": null}'::jsonb),
  ('levenwick', 'levenwick', 'Levenwick', 'Levenwick', 'settlement', 'shetland_south', 300, true, 'medium', 'OneShetland geography Stage 1 audit', 'Dunrossness (not named in SIC lists)', '{"stage1_notes": null}'::jsonb),
  ('gulberwick', 'gulberwick', 'Gulberwick', 'Gulberwick', 'settlement', 'shetland_south', 310, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC CC list: "Gulberwick, Quarff & Cunningsburgh" -> South Mainland', '{"stage1_notes": "Close to Lerwick but officially South."}'::jsonb),
  ('quendale', 'quendale', 'Quendale', 'Quendale', 'settlement', 'shetland_south', 320, true, 'medium', 'OneShetland geography Stage 1 audit', 'Dunrossness (not named in SIC lists)', '{"stage1_notes": null}'::jsonb),
  ('mousa', 'mousa', 'Mousa', 'Mousa', 'island', 'shetland_south', 330, true, 'medium', 'OneShetland geography Stage 1 audit', 'Sandwick parish (not named in SIC lists)', '{"stage1_notes": null}'::jsonb),
  ('fair_isle', 'fair-isle', 'Fair Isle', 'Fair Isle', 'island', 'shetland_south', 340, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas lists Fair Isle under South', '{"stage1_notes": null}'::jsonb),
  ('walls', 'walls', 'Walls', 'Walls', 'settlement', 'shetland_west', 350, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Walls; CC "Sandness & Walls"', '{"stage1_notes": null}'::jsonb),
  ('sandness', 'sandness', 'Sandness', 'Sandness', 'settlement', 'shetland_west', 360, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Sandness', '{"stage1_notes": null}'::jsonb),
  ('aith', 'aith', 'Aith', 'Aith', 'settlement', 'shetland_west', 370, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Aith; CC "Sandsting & Aithsting"', '{"stage1_notes": null}'::jsonb),
  ('bixter', 'bixter', 'Bixter', 'Bixter', 'settlement', 'shetland_west', 380, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Bixter', '{"stage1_notes": null}'::jsonb),
  ('skeld', 'skeld', 'Skeld', 'Skeld', 'settlement', 'shetland_west', 390, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Skeld', '{"stage1_notes": null}'::jsonb),
  ('tresta', 'tresta', 'Tresta', 'Tresta', 'settlement', 'shetland_west', 400, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Tresta', '{"stage1_notes": null}'::jsonb),
  ('foula', 'foula', 'Foula', 'Foula', 'island', null, 410, false, 'low', 'OneShetland geography Stage 1 audit', 'Not named in the SIC lists; Shetland.org lists it as an area guide', '{"stage1_notes": "NEEDS REVIEW: probably Shetland West but no official source found. Do not auto-assign.", "provisional_parent": "shetland_west", "status": "pending_official_confirmation"}'::jsonb),
  ('papa_stour', 'papa-stour', 'Papa Stour', 'Papa Stour', 'island', null, 420, false, 'low', 'OneShetland geography Stage 1 audit', 'Not named in the SIC lists', '{"stage1_notes": "NEEDS REVIEW: probably Shetland West (Sandness & Walls CC) - unverified.", "provisional_parent": "shetland_west", "status": "pending_official_confirmation"}'::jsonb),
  ('whalsay', 'whalsay', 'Whalsay', 'Whalsay', 'island', 'whalsay_skerries', 430, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Whalsay (Brough, Symbister)', '{"stage1_notes": null}'::jsonb),
  ('out_skerries', 'out-skerries', 'Out Skerries', 'Out Skerries', 'island', 'whalsay_skerries', 440, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Out Skerries', '{"stage1_notes": "\"Skerries\" is the common short form."}'::jsonb),
  ('yell', 'yell', 'Yell', 'Yell', 'island', 'yell_unst_fetlar', 450, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Yell (Burravoe, Cullivoe, Mid Yell)', '{"stage1_notes": "\"Fish Holm, Yell Sound\" is a sea site, not on Yell - kept out of aliases in practice."}'::jsonb),
  ('unst', 'unst', 'Unst', 'Unst', 'island', 'yell_unst_fetlar', 460, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Unst (Baltasound, Haroldswick, Uyeasound)', '{"stage1_notes": null}'::jsonb),
  ('fetlar', 'fetlar', 'Fetlar', 'Fetlar', 'island', 'yell_unst_fetlar', 470, true, 'high', 'OneShetland geography Stage 1 audit', 'SIC housing areas: Fetlar', '{"stage1_notes": null}'::jsonb);

-- ── Seed: aliases (exact normalised spellings only). Venue, street and every other observed production string are deliberately NOT here: they sit in the review queue / deferred list. ──
insert into public.place_aliases (alias, kind, area_id, candidate_ids, confidence, source, notes) values
  ('Lerwick & Bressay', 'area', 'lerwick_bressay', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('Central Mainland', 'area', 'shetland_central', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('Shetland Central', 'area', 'shetland_central', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('North Mainland', 'area', 'shetland_north', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('Shetland North', 'area', 'shetland_north', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('Shetland South', 'area', 'shetland_south', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('South Mainland', 'area', 'shetland_south', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('Shetland West', 'area', 'shetland_west', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('West Mainland', 'area', 'shetland_west', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('West Mainland / Westside', 'area', 'shetland_west', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('Westside', 'area', 'shetland_west', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('Whalsay & Skerries', 'area', 'whalsay_skerries', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('North Isles', 'area', 'yell_unst_fetlar', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('Yell, Unst & Fetlar', 'area', 'yell_unst_fetlar', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('Yell, Unst & Fetlar / North Isles', 'area', 'yell_unst_fetlar', '{}'::text[], 'high', 'Official wording / PHS lookup / SIC housing (Stage 1)', null),
  ('Brae / Sullom Voe', 'area', 'shetland_north', '{}'::text[], 'high', 'Jobs vocabulary (JOB_AREAS)', 'Two-place label; both Brae and Sullom Voe are in Shetland North.'),
  ('Central', 'area', 'shetland_central', '{}'::text[], 'medium', 'SIC housing list wording', 'Bare compass word: official in the SIC housing list but ambiguous in free text ("Central, Shetland" business address, "North Road"). Never auto-resolved.'),
  ('North', 'area', 'shetland_north', '{}'::text[], 'medium', 'SIC housing list wording', 'Bare compass word: official in the SIC housing list but ambiguous in free text ("Central, Shetland" business address, "North Road"). Never auto-resolved.'),
  ('South', 'area', 'shetland_south', '{}'::text[], 'medium', 'SIC housing list wording', 'Bare compass word: official in the SIC housing list but ambiguous in free text ("Central, Shetland" business address, "North Road"). Never auto-resolved.'),
  ('West', 'area', 'shetland_west', '{}'::text[], 'medium', 'SIC housing list wording', 'Bare compass word: official in the SIC housing list but ambiguous in free text ("Central, Shetland" business address, "North Road"). Never auto-resolved.'),
  ('Isles', 'ambiguous', null, array['yell_unst_fetlar','whalsay_skerries']::text[], 'high', 'SIC community-council list', 'SIC "Isles" spans two canonical areas.'),
  ('Hamnavoe', 'ambiguous', null, array['burra']::text[], 'high', 'Stage 1 audit', 'Ambiguous: Burra (Hamnavoe) vs other hamlets. Needs context or coordinates.'),
  ('Lerwick', 'place', 'lerwick', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Bressay', 'place', 'bressay', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Noss', 'place', 'noss', '{}'::text[], 'medium', 'Canonical Places (Stage 1)', 'Registered but not auto-resolved (medium confidence).'),
  ('Scalloway', 'place', 'scalloway', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Burra', 'place', 'burra', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Trondra', 'place', 'trondra', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Tingwall', 'place', 'tingwall', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Whiteness', 'place', 'whiteness', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Weisdale', 'place', 'weisdale', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Brae', 'place', 'brae', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Voe', 'place', 'voe', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Vidlin', 'place', 'vidlin', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Mossbank', 'place', 'mossbank', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Firth', 'place', 'firth', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Nesting', 'place', 'nesting', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Hillswick', 'place', 'hillswick', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('North Roe', 'place', 'north_roe', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Ollaberry', 'place', 'ollaberry', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Sullom Voe', 'place', 'sullom_voe', '{}'::text[], 'medium', 'Canonical Places (Stage 1)', 'Registered but not auto-resolved (medium confidence).'),
  ('Toft', 'place', 'toft', '{}'::text[], 'medium', 'Canonical Places (Stage 1)', 'Registered but not auto-resolved (medium confidence).'),
  ('Muckle Roe', 'place', 'muckle_roe', '{}'::text[], 'medium', 'Canonical Places (Stage 1)', 'Registered but not auto-resolved (medium confidence).'),
  ('Northmavine', 'place', 'northmavine', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Delting', 'place', 'delting', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Sandwick', 'place', 'sandwick', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Cunningsburgh', 'place', 'cunningsburgh', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Bigton', 'place', 'bigton', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Boddam', 'place', 'boddam', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Virkie', 'place', 'virkie', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Sumburgh', 'place', 'sumburgh', '{}'::text[], 'medium', 'Canonical Places (Stage 1)', 'Registered but not auto-resolved (medium confidence).'),
  ('Levenwick', 'place', 'levenwick', '{}'::text[], 'medium', 'Canonical Places (Stage 1)', 'Registered but not auto-resolved (medium confidence).'),
  ('Gulberwick', 'place', 'gulberwick', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Quendale', 'place', 'quendale', '{}'::text[], 'medium', 'Canonical Places (Stage 1)', 'Registered but not auto-resolved (medium confidence).'),
  ('Mousa', 'place', 'mousa', '{}'::text[], 'medium', 'Canonical Places (Stage 1)', 'Registered but not auto-resolved (medium confidence).'),
  ('Fair Isle', 'place', 'fair_isle', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Walls', 'place', 'walls', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Sandness', 'place', 'sandness', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Aith', 'place', 'aith', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Bixter', 'place', 'bixter', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Skeld', 'place', 'skeld', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Tresta', 'place', 'tresta', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Foula', 'place', 'foula', '{}'::text[], 'low', 'Canonical Places (Stage 1)', 'Registered but not auto-resolved (low confidence).'),
  ('Papa Stour', 'place', 'papa_stour', '{}'::text[], 'low', 'Canonical Places (Stage 1)', 'Registered but not auto-resolved (low confidence).'),
  ('Whalsay', 'place', 'whalsay', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Out Skerries', 'place', 'out_skerries', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Yell', 'place', 'yell', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Unst', 'place', 'unst', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Fetlar', 'place', 'fetlar', '{}'::text[], 'high', 'Canonical Places (Stage 1)', null),
  ('Burra Isle', 'place', 'burra', '{}'::text[], 'high', 'Stage 1 audit: short/alternative name', null),
  ('Skerries', 'place', 'out_skerries', '{}'::text[], 'high', 'Stage 1 audit: short/alternative name', null),
  ('Bressay and Noss', 'place', 'bressay', '{}'::text[], 'medium', 'Shetland.org area guide', 'Includes Noss, which SIC lists do not name.'),
  ('Sullom', 'place', 'sullom_voe', '{}'::text[], 'medium', 'App profile picker value', 'Short form.'),
  ('Shetland-wide', 'scope', 'shetland_wide', '{}'::text[], 'high', 'Jobs vocabulary / app notice ranking sentinel (Stage 1)', null),
  ('All Shetland', 'scope', 'shetland_wide', '{}'::text[], 'high', 'Jobs vocabulary / app notice ranking sentinel (Stage 1)', null),
  ('Across Shetland', 'scope', 'shetland_wide', '{}'::text[], 'high', 'Jobs vocabulary / app notice ranking sentinel (Stage 1)', null),
  ('Shetland (see advert)', 'scope', 'shetland_wide', '{}'::text[], 'medium', 'Council jobs sync', 'Council jobs sync treats it as Shetland-wide; not auto-resolved here.'),
  ('Shetland', 'unspecified', null, '{}'::text[], 'high', 'Stage 1 audit', 'A location exists but is unspecified. This is NOT Shetland-wide.'),
  ('Shetland Islands', 'unspecified', null, '{}'::text[], 'high', 'Stage 1 audit', 'A location exists but is unspecified. This is NOT Shetland-wide.'),
  ('Shetland Islands, Scotland', 'unspecified', null, '{}'::text[], 'high', 'Stage 1 audit', 'A location exists but is unspecified. This is NOT Shetland-wide.'),
  ('Remote', 'non_geographic', null, '{}'::text[], 'high', 'Stage 1 audit: work context', 'Work mode/context, not geography.'),
  ('Hybrid', 'non_geographic', null, '{}'::text[], 'high', 'Stage 1 audit: work context', 'Work mode/context, not geography.'),
  ('Remote / hybrid', 'non_geographic', null, '{}'::text[], 'high', 'Stage 1 audit: work context', 'Work mode/context, not geography.'),
  ('Remote or hybrid', 'non_geographic', null, '{}'::text[], 'high', 'Stage 1 audit: work context', 'Work mode/context, not geography.'),
  ('Offshore', 'non_geographic', null, '{}'::text[], 'high', 'Stage 1 audit: work context', 'Work mode/context, not geography.'),
  ('Marine', 'non_geographic', null, '{}'::text[], 'high', 'Stage 1 audit: work context', 'Work mode/context, not geography.'),
  ('Offshore / marine', 'non_geographic', null, '{}'::text[], 'high', 'Stage 1 audit: work context', 'Work mode/context, not geography.'),
  ('Work from home', 'non_geographic', null, '{}'::text[], 'high', 'Stage 1 audit: work context', 'Work mode/context, not geography.'),
  ('London', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Test fixture / not a Shetland location.'),
  ('Not a real address', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Test fixture / not a Shetland location.'),
  ('Operator test fixture — not a real location', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Test fixture / not a Shetland location.'),
  ('Archaeological site', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Category label stored in business addresses; not a location.'),
  ('Castle or ruin', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Category label stored in business addresses; not a location.'),
  ('Lighthouse', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Category label stored in business addresses; not a location.'),
  ('Viewpoint', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Category label stored in business addresses; not a location.'),
  ('Historic site', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Category label stored in business addresses; not a location.'),
  ('Park or garden', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Category label stored in business addresses; not a location.'),
  ('Community hall', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Category label stored in business addresses; not a location.'),
  ('Nature reserve', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Category label stored in business addresses; not a location.'),
  ('Memorial', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Category label stored in business addresses; not a location.'),
  ('Museum', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Category label stored in business addresses; not a location.'),
  ('Library', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Category label stored in business addresses; not a location.'),
  ('Camp', 'invalid', null, '{}'::text[], 'high', 'Stage 1 audit', 'Category label stored in business addresses; not a location.');

-- ── Seed: review queue (values Stage 1 could not resolve safely). Admin-only. Values are COPIED here; the content tables are untouched. ──
insert into public.geography_review (source_system, source_field, original_value, occurrences, status, suggested_area_id, reason, notes) values
  ('events.venue', 'venue', 'Sound Hall', 2, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('events.venue', 'venue', 'Carnegie Hall', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('events.venue', 'venue', 'Ness Boating Club', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('jobs.location', 'location', 'Shetland Islands, Scotland', 5, 'open', null, 'UNKNOWN WITHIN SHETLAND: Only "Shetland" (or "Shetland Islands, Scotland") - a location exists but is unspecified. NOT the same as Shetland-wide.', 'stage1_audit'),
  ('jobs.location', 'location', 'Shetland', 3, 'open', null, 'UNKNOWN WITHIN SHETLAND: Only "Shetland" (or "Shetland Islands, Scotland") - a location exists but is unspecified. NOT the same as Shetland-wide.', 'stage1_audit'),
  ('jobs.location', 'location', 'NHS Shetland Sites', 2, 'open', null, 'NEEDS REVIEW - MULTIPLE AREAS: "NHS Shetland Sites" - several sites across Shetland.', 'stage1_audit'),
  ('jobs.location', 'location', 'Fish Holm, Yell Sound', 1, 'open', null, 'NEEDS REVIEW: Sea site in Yell Sound - do not map to Yell by name alone.', 'stage1_audit'),
  ('jobs.location', 'location', 'Hendra Ferry, Shetland Islands', 1, 'open', null, 'NEEDS REVIEW: A ferry (vessel), not a locality: marine work context.', 'stage1_audit'),
  ('jobs.location', 'location', 'Lerwick, Perth, Aberdeen or Inverness', 1, 'open', null, 'NEEDS REVIEW - MULTIPLE AREAS: Four possible bases; Lerwick is one. Multi-site, not a single locality.', 'stage1_audit'),
  ('jobs.location', 'location', 'Montfield Dental Unit', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('jobs.location', 'location', 'NHS Shetland', 1, 'open', null, 'NEEDS REVIEW - MULTIPLE AREAS: Employer name, not a place.', 'stage1_audit'),
  ('jobs.location', 'location', 'Shetland construction sites', 1, 'open', null, 'NEEDS REVIEW - MULTIPLE AREAS: "Shetland construction sites" - travelling work, no single area.', 'stage1_audit'),
  ('memories.place_name', 'place_name', 'Foula', 1, 'open', 'foula', 'MAPPED PLACE - AREA UNCONFIRMED: No official source places this island in a locality; probably Shetland West - needs Council confirmation.', 'stage1_audit'),
  ('memories.place_name', 'place_name', 'Hamnavoe', 1, 'open', null, 'NEEDS REVIEW: "Hamnavoe" is ambiguous (Burra vs other hamlets); needs context or coordinates.', 'stage1_audit'),
  ('memories.place_name', 'place_name', 'Lunna', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('memories.place_name', 'place_name', 'Oxna', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('memories.place_name', 'place_name', 'Staneydale', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('runs.destination_area', 'destination_area', 'Hamnavoe', 4, 'open', null, 'NEEDS REVIEW: "Hamnavoe" is ambiguous (Burra vs other hamlets); needs context or coordinates.', 'stage1_audit'),
  ('delivery_requests.destination_address', 'destination_address', 'Roadside, Shetland ZE2, UK', 4, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('delivery_requests.destination_address', 'destination_address', 'Roadside, Shetland, UK', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('game_shetland_places.region', 'region', 'foula', 5, 'open', 'foula', 'MAPPED PLACE - AREA UNCONFIRMED: No official source places this island in a locality; probably Shetland West - needs Council confirmation.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Shetland', 179, 'open', null, 'UNKNOWN WITHIN SHETLAND: Only "Shetland" (or "Shetland Islands, Scotland") - a location exists but is unspecified. NOT the same as Shetland-wide.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Archaeological site, Shetland', 60, 'invalid', null, 'NOT A LOCATION: A category label stored as an address (no place named). Needs coordinates.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Castle or ruin, Shetland', 26, 'invalid', null, 'NOT A LOCATION: A category label stored as an address (no place named). Needs coordinates.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Lighthouse, Shetland', 15, 'invalid', null, 'NOT A LOCATION: A category label stored as an address (no place named). Needs coordinates.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Viewpoint, Shetland', 7, 'invalid', null, 'NOT A LOCATION: A category label stored as an address (no place named). Needs coordinates.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Historic site, Shetland', 5, 'invalid', null, 'NOT A LOCATION: A category label stored as an address (no place named). Needs coordinates.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Main Street, Shetland', 5, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Park or garden, Shetland', 5, 'invalid', null, 'NOT A LOCATION: A category label stored as an address (no place named). Needs coordinates.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Community hall, Shetland', 4, 'invalid', null, 'NOT A LOCATION: A category label stored as an address (no place named). Needs coordinates.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Nature reserve, Shetland', 4, 'invalid', null, 'NOT A LOCATION: A category label stored as an address (no place named). Needs coordinates.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Burgh Road, Shetland', 2, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Church Road, Shetland', 2, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Memorial, Shetland', 2, 'invalid', null, 'NOT A LOCATION: A category label stored as an address (no place named). Needs coordinates.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Roadside, Shetland', 2, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Skelladale, Shetland', 2, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'South Road, Shetland', 2, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', '15 South Road, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', '2 New Street, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', '20 Greenfield Place, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', '4 Mounthooly Street, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', '5 Mounthooly Street, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', '6 Clairmont Place, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', '64 Burgh Road, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', '8 Clairmont Place, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Beach Road, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Brough Road, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Camp, Shetland', 1, 'invalid', null, 'NOT A LOCATION: A category label stored as an address (no place named). Needs coordinates.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Hillside, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Kantersted Road, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'London', 1, 'invalid', null, 'INVALID / TEST: Not in Shetland (test/fixture).', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Market Street, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Museum, Shetland', 1, 'invalid', null, 'NOT A LOCATION: A category label stored as an address (no place named). Needs coordinates.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'New Road, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'North Lochside, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Not a real address', 1, 'invalid', null, 'INVALID / TEST: Fixture.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Operator test fixture — not a real location', 1, 'invalid', null, 'INVALID / TEST: Fixture.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Port Arthur Road Port Arthur, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Rudda Park, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Sea Road, Shetland', 1, 'open', null, 'UNKNOWN WITHIN SHETLAND: Street name only; confirm by coordinates.', 'stage1_audit'),
  ('local_businesses.address', 'address', 'Tangwick, Shetland', 1, 'open', null, 'UNKNOWN / NEEDS REVIEW: No place named; do not guess.', 'stage1_audit'),
  ('Shetland.org area guides', 'value', 'Foula', 1, 'open', 'foula', 'MAPPED PLACE - AREA UNCONFIRMED: No official source places this island in a locality; probably Shetland West - needs Council confirmation.', 'stage1_audit'),
  ('Shetland.org area guides', 'value', 'Papa Stour', 1, 'open', 'papa_stour', 'MAPPED PLACE - AREA UNCONFIRMED: No official source places this island in a locality; probably Shetland West - needs Council confirmation.', 'stage1_audit')
on conflict (source_system, source_field, value_normalised) do nothing;

commit;
