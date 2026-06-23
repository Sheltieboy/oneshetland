-- ─────────────────────────────────────────────────────────────────────────────
-- 080_cruise_visits.sql — Cruise Ship Visits
--
-- Three tables + a day-level view + live-position table:
--   cruise_ships     — vessel master (dedupes "repeat ship"; holds IMO/MMSI)
--   cruise_visits    — one port call (maps the old ACF "cruise_visit" record)
--   ship_positions   — latest live AIS position per vessel (for the live map)
--   cruise_day_summary (view) — per-date aggregate + the Cruise Barometer
--
-- Public read; admin-only writes (imports run via the service role, which
-- bypasses RLS). Realtime enabled on ship_positions + cruise_visits.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── shared touch-updated_at trigger (scoped name to avoid clashes) ───────────
create or replace function public.cruise_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. cruise_ships — the vessel (one row per real ship)
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.cruise_ships (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text unique,                       -- for /cruise/ship/<slug>
  vessel_type   text,                              -- free text (source has 'unknown' etc.)
  cruise_line   text,                              -- operator (addition — useful for spend profile)
  image_url     text,                              -- full URL (old site stored filename only)
  length_m      numeric,                           -- parsed metres, e.g. 229
  length_label  text,                              -- as-imported, e.g. "229m"
  default_pax   int,                               -- typical capacity
  imo           text,                              -- IMO number — stable vessel id (for tracking + dedupe)
  mmsi          text,                              -- AIS id — links to ship_positions (can change)
  is_large_ship boolean not null default false,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists cruise_ships_imo_uq on public.cruise_ships (imo) where imo is not null;
create index if not exists cruise_ships_mmsi_idx on public.cruise_ships (mmsi) where mmsi is not null;
create index if not exists cruise_ships_name_idx on public.cruise_ships (lower(name));

drop trigger if exists cruise_ships_touch on public.cruise_ships;
create trigger cruise_ships_touch before update on public.cruise_ships
  for each row execute function public.cruise_touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. cruise_visits — one port call
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.cruise_visits (
  id                 uuid primary key default gen_random_uuid(),
  ship_id            uuid references public.cruise_ships(id) on delete set null,
  ship_name_cache    text,                          -- denormalised for import safety / display

  -- Arrival / departure (timestamptz = the single sortable truth; AT TIME ZONE 'Europe/London' for display)
  arrival_at         timestamptz,
  departure_at       timestamptz,
  visit_date         date,                          -- Shetland-local arrival date (set by trigger) — the grouping key
  from_location      text,
  to_location        text,                          -- ACF "destination"

  -- Port & berthing
  berth              text,
  berth_area_group   text,                          -- free text (source has 'Other' etc.)
  is_tender          boolean not null default false, -- Anchor => tendered ashore (changes footfall timing)
  time_in_port_hours numeric,
  all_aboard_at      timestamptz,                    -- addition: last tender / all-aboard

  -- Passengers
  est_pax            int,                            -- numeric when known
  est_pax_label      text,                           -- keeps "TBC" etc. from the source
  est_passenger_range text,                          -- free text (source has '1501–3000' etc.)

  -- Day load (true footfall lives in the day view; these are per-visit hints)
  ships_same_day     int,
  is_multi_ship_day  boolean not null default false,

  -- Operational scores (imported)
  est_footfall_score int,
  port_load_score    int,

  -- Classification flags
  is_cruise_ship     boolean not null default true,
  is_repeat_ship     boolean not null default false,
  is_weekend         boolean not null default false, -- set by trigger from visit_date

  -- Status & verification
  status             text not null default 'scheduled'
                       check (status in ('scheduled','confirmed','in_port','departed','cancelled','completed')),
  last_verified      date,
  verification_source text check (verification_source in
                       ('lerwick_harbour','agent_update','manual_check','marinetraffic')),
  agent              text,

  -- Promo / display
  headline_text      text,
  social_caption     text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists cruise_visits_date_idx     on public.cruise_visits (visit_date);
create index if not exists cruise_visits_arrival_idx  on public.cruise_visits (arrival_at);
create index if not exists cruise_visits_ship_idx     on public.cruise_visits (ship_id);
create index if not exists cruise_visits_status_idx   on public.cruise_visits (status);
-- fast "what's coming up"
create index if not exists cruise_visits_upcoming_idx on public.cruise_visits (arrival_at)
  where status in ('scheduled','confirmed','in_port');

-- derive visit_date / is_weekend / updated_at on write
create or replace function public.cruise_visit_derive()
returns trigger language plpgsql as $$
begin
  if new.arrival_at is not null then
    new.visit_date := (new.arrival_at at time zone 'Europe/London')::date;
    new.is_weekend := extract(isodow from new.visit_date) in (6,7);
  end if;
  new.is_tender := coalesce(new.berth_area_group = 'Anchor', new.is_tender);
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists cruise_visits_derive on public.cruise_visits;
create trigger cruise_visits_derive before insert or update on public.cruise_visits
  for each row execute function public.cruise_visit_derive();

-- recompute same-day counts/flags for a date (call after an import batch)
create or replace function public.recompute_cruise_day(target date)
returns void language plpgsql as $$
declare n int;
begin
  select count(*) into n from public.cruise_visits
    where visit_date = target and status <> 'cancelled';
  update public.cruise_visits
    set ships_same_day = n, is_multi_ship_day = (n > 1)
    where visit_date = target;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. The Cruise Barometer + day summary view
--    Day rating from total passengers + ships in port. Thresholds are
--    Lerwick-calibrated and easy to tune.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.cruise_barometer(total_pax int, ships int)
returns text language sql immutable as $$
  select case
    when coalesce(ships,0) >= 3 or coalesce(total_pax,0) >= 5000 then 'peak'
    when coalesce(total_pax,0) >= 2500                            then 'very_busy'
    when coalesce(total_pax,0) >= 800                             then 'busy'
    else 'quiet'
  end
$$;

create or replace view public.cruise_day_summary
with (security_invoker = true) as
  select
    visit_date,
    count(*)                              as ships_count,
    sum(coalesce(est_pax,0))              as total_est_pax,
    sum(coalesce(est_footfall_score,0))   as total_footfall_score,
    max(time_in_port_hours)               as max_time_in_port_hours,
    bool_or(is_multi_ship_day)            as multi_ship,
    public.cruise_barometer(sum(coalesce(est_pax,0))::int, count(*)::int) as barometer
  from public.cruise_visits
  where status <> 'cancelled' and visit_date is not null
  group by visit_date;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. ship_positions — latest live AIS fix (one row per vessel, upserted by the
--    ingest worker via the service role). Realtime-streamed to the live map.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.ship_positions (
  mmsi        text primary key,
  ship_id     uuid references public.cruise_ships(id) on delete set null,
  lat         double precision,
  lng         double precision,
  sog         numeric,        -- speed over ground (knots)
  cog         numeric,        -- course over ground (deg)
  heading     numeric,        -- true heading (deg)
  nav_status  text,           -- e.g. "Under way", "Moored"
  source      text,           -- 'aisstream' | 'marinetraffic' | 'vesselfinder'
  updated_at  timestamptz not null default now()
);
create index if not exists ship_positions_ship_idx    on public.ship_positions (ship_id);
create index if not exists ship_positions_updated_idx on public.ship_positions (updated_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. RLS — public read, admin-only writes (service role bypasses RLS)
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.cruise_ships    enable row level security;
alter table public.cruise_visits   enable row level security;
alter table public.ship_positions  enable row level security;

-- helper: current user is admin
-- (inline EXISTS used directly in policies to match existing migration style)

-- cruise_ships
create policy "cruise_ships read"  on public.cruise_ships for select using (true);
create policy "cruise_ships admin write" on public.cruise_ships for all
  using  (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- cruise_visits
create policy "cruise_visits read" on public.cruise_visits for select using (true);
create policy "cruise_visits admin write" on public.cruise_visits for all
  using  (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ship_positions (writes normally come from the service-role ingest worker)
create policy "ship_positions read" on public.ship_positions for select using (true);
create policy "ship_positions admin write" on public.ship_positions for all
  using  (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Realtime — live positions + visit status changes
-- ═══════════════════════════════════════════════════════════════════════════
do $$ begin
  alter publication supabase_realtime add table public.ship_positions;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.cruise_visits;
exception when duplicate_object then null; end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Storage — ship images
-- ═══════════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public)
  values ('cruise-media', 'cruise-media', true)
  on conflict (id) do nothing;

create policy "cruise-media public read" on storage.objects for select
  using (bucket_id = 'cruise-media');
create policy "cruise-media admin write" on storage.objects for insert
  with check (bucket_id = 'cruise-media'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
create policy "cruise-media admin update" on storage.objects for update
  using (bucket_id = 'cruise-media'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
create policy "cruise-media admin delete" on storage.objects for delete
  using (bucket_id = 'cruise-media'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
