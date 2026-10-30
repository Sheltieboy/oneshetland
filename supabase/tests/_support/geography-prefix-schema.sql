-- geography-prefix-schema.sql — a minimal PRE-Stage-2A world for the geography foundation migration.
-- Roles, auth.uid(), profiles + is_admin() as production defines them (is_admin copied from pg_get_functiondef), plus STUB content tables that
-- carry the geography-ish columns Stage 1 found. The migration must leave every stub row and column exactly as it is. Test-only.
drop schema if exists public cascade; create schema public;
drop schema if exists auth cascade; create schema auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
alter role service_role bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;

create table profiles (id uuid primary key, role text not null default 'customer', is_platform_owner boolean default false, location_area text);
create function public.is_admin() returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or is_platform_owner = true));
$$;
create table regions (id uuid primary key default gen_random_uuid(), slug text unique not null, name text not null, display_order int);
create table jobs (id uuid primary key default gen_random_uuid(), title text, locality text, location text);
create table events (id uuid primary key default gen_random_uuid(), title text, locality text, venue text);
create table local_businesses (id uuid primary key default gen_random_uuid(), name text, address text, lat numeric, lng numeric);
create table notices (id uuid primary key default gen_random_uuid(), title text, locality text);
create table hubs (id uuid primary key default gen_random_uuid(), name text, area text);
create table runs (id uuid primary key default gen_random_uuid(), origin_region_id uuid references regions(id), destination_region_id uuid references regions(id));
create table delivery_requests (id uuid primary key default gen_random_uuid(), destination_region_id uuid references regions(id), destination_address text);
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant select on all tables in schema public to anon;
