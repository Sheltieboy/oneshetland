-- ui-site-schema.sql — LOCAL-ONLY. Extends the throwaway fixture database so the WEBSITE (not just the notice screens) has the tables and columns its
-- public read queries select: events/businesses/offers/products/jobs/shifts/alerts/campaigns/home content. Column names and types follow the website's
-- own queries (lib/home-data.ts, lib/home-shelves.ts, lib/curated-businesses.ts, lib/jobs-data.ts) — it is NOT a copy of the production schema, and nothing
-- here is ever applied to a hosted project. Run by ui-fixture-env.sh after the notices migrations and before ui-site-fixtures.sql.

-- the campaign query orders by created_at (it was missing: the homepage campaign query returned HTTP 400)
alter table hub_campaigns add column if not exists created_at timestamptz not null default now(), add column if not exists description text,
  add column if not exists cover_url text, add column if not exists updated_at timestamptz not null default now();

alter table local_businesses add column if not exists phone text, add column if not exists website text, add column if not exists email text,
  add column if not exists tags text[], add column if not exists opening_hours jsonb, add column if not exists claimed_at timestamptz,
  add column if not exists verified_at timestamptz, add column if not exists is_demo boolean not null default false;

create table if not exists local_offers (
  id uuid primary key default gen_random_uuid(), business_id uuid not null references local_businesses(id) on delete cascade,
  title text not null, description text, image_url text, discount_type text, discount_value numeric, valid_from timestamptz not null default now(),
  valid_until timestamptz, is_active boolean not null default true, redemption_count int not null default 0, max_redemptions int, terms text,
  created_at timestamptz not null default now());

create table if not exists products (
  id uuid primary key default gen_random_uuid(), business_id uuid not null references local_businesses(id) on delete cascade,
  title text not null, description text, price_pence int not null, photos text[] not null default '{}', category text, is_active boolean not null default true,
  sold_at timestamptz, quantity int, created_at timestamptz not null default now());

alter table jobs add column if not exists employer_id uuid, add column if not exists posted_as_business_id uuid references local_businesses(id) on delete set null,
  add column if not exists source text, add column if not exists source_label text, add column if not exists source_url text, add column if not exists source_reference text,
  add column if not exists source_published_at timestamptz, add column if not exists listed_at timestamptz, add column if not exists source_meta jsonb,
  add column if not exists external_employer_name text, add column if not exists external_employer_logo_url text, add column if not exists description text,
  add column if not exists category text, add column if not exists contract_type text, add column if not exists pay_text text, add column if not exists pay_min numeric,
  add column if not exists pay_max numeric, add column if not exists pay_period text, add column if not exists pay_hidden boolean not null default false,
  add column if not exists remote_mode text not null default 'on_site', add column if not exists relocation_support boolean not null default false,
  add column if not exists housing_available boolean not null default false, add column if not exists is_seasonal boolean not null default false,
  add column if not exists season_label text, add column if not exists apply_url text, add column if not exists apply_email text,
  add column if not exists is_featured boolean not null default false, add column if not exists status text not null default 'open',
  add column if not exists is_hidden boolean not null default false, add column if not exists expires_at timestamptz,
  add column if not exists posted_at timestamptz not null default now(), add column if not exists created_at timestamptz not null default now();

create table if not exists shift_employer_profiles (
  id uuid primary key default gen_random_uuid(), business_name text not null, logo_url text, is_verified boolean not null default false, created_at timestamptz not null default now());

create table if not exists shifts (
  id uuid primary key default gen_random_uuid(), employer_id uuid references shift_employer_profiles(id), posted_as_business_id uuid references local_businesses(id) on delete set null,
  title text not null, description text, category text, location_text text, start_at timestamptz not null, end_at timestamptz not null,
  pay_type text not null default 'hourly', pay_amount numeric, positions_total int not null default 1, positions_filled int not null default 0,
  requirements text[] not null default '{}', urgency text not null default 'planned', status text not null default 'open', boosted_until timestamptz,
  created_at timestamptz not null default now());

create table if not exists partner_alerts (
  id uuid primary key default gen_random_uuid(), business_name text, message text not null, type text not null default 'info', is_active boolean not null default true,
  expires_at timestamptz, created_at timestamptz not null default now());

create table if not exists home_content (
  id uuid primary key default gen_random_uuid(), welcome_title text, welcome_body text, welcome_href text, welcome_cta text, feature_title text, feature_image text,
  feature_href text, spotlight_title text, spotlight_body text, spotlight_image text, spotlight_href text, spotlight_cta text);

create table if not exists spik_dictionary (
  id uuid primary key default gen_random_uuid(), word text not null, short_meaning text, example_sentence text, word_status text default 'approved');
create function public.spik_daily() returns table(word text, meaning text, example text) language sql stable as $$
  select word, short_meaning, example_sentence from public.spik_dictionary order by word limit 1 $$;
grant execute on function public.spik_daily() to anon, authenticated;

-- event / campaign / hub / word detail pages (the columns their own queries select)
alter table event_ticket_types add column if not exists name text, add column if not exists description text, add column if not exists quantity_available int,
  add column if not exists quantity_sold int not null default 0, add column if not exists per_order_max int, add column if not exists sale_starts_at timestamptz,
  add column if not exists sale_ends_at timestamptz, add column if not exists display_order int not null default 0;
create table if not exists event_updates (
  id uuid primary key default gen_random_uuid(), event_id uuid not null references events(id) on delete cascade, title text, body text, kind text, is_urgent boolean not null default false,
  created_at timestamptz not null default now());
alter table hub_campaigns add column if not exists story text;
alter table profiles add column if not exists full_name text;
alter table hub_members add column if not exists id uuid not null default gen_random_uuid(), add column if not exists status text not null default 'active', add column if not exists paid_until timestamptz;
alter table spik_dictionary add column if not exists slug text, add column if not exists part_of_speech text, add column if not exists pronunciation text, add column if not exists first_letter text;

-- read access for the public (anonymous) role: only the new, fictional tables; the demo proxy is read-only and anonymous-only on top of this
grant select on event_updates, local_offers, products, jobs, shift_employer_profiles, shifts, partner_alerts, home_content, spik_dictionary to anon, authenticated;
grant select on local_businesses to anon, authenticated;
