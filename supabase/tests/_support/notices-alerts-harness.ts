/**
 * notices-alerts-harness.ts — builds the ISOLATED Postgres every Notices & Alerts suite runs against, and the role-switching helpers.
 *
 * Starting state = the production notices model as it stands today: the attribution prefix schema + migration 20261121000000 (attribution guard) +
 * the geography layer + Stage 2 (20261128000000) + Stage 3A.1 (20261128010000). The NEW migrations are then applied in order, exactly as they would be
 * in production. Nothing here can reach a hosted project: PASS_PROOF_DSN is required and a Supabase DSN is refused.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const rd = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
if (!DSN) throw new Error('PASS_PROOF_DSN is required (isolated database only) — run via `npm run test:isolated`');
if (/supabase/i.test(DSN)) throw new Error('refusing to run against a Supabase DSN');

const run = (args: string[], input?: string) => {
  const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], { input, encoding: 'utf8', timeout: 180_000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
};
export const raw = (sql: string) => run(['-c', sql]);
export const file = (sql: string) => run([], sql);
export const last = (o: string) => o.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
export const scalar = (sql: string) => last(raw(sql));
export const failed = (o: string) => /ERROR/.test(o);
export const uuid = () => randomUUID();

/** The cast. Every id is fictional. */
export const U = {
  A: 'a0000000-0000-4000-8000-0000000000a1',   // ordinary member
  A2: 'a0000000-0000-4000-8000-0000000000a2',  // another ordinary member
  A3: 'a0000000-0000-4000-8000-0000000000a3',  // a third (no areas, no prefs)
  B: 'b0000000-0000-4000-8000-0000000000b1',   // owns BIZ_B (no urgent)
  V: 'c0000000-0000-4000-8000-0000000000c1',   // owns BIZ_V (can_publish_urgent = true: the OLD urgent permission)
  H: 'd0000000-0000-4000-8000-0000000000d1',   // owns HUB_V
  C: 'd0000000-0000-4000-8000-0000000000d2',   // committee of HUB_V
  M: 'd0000000-0000-4000-8000-0000000000d3',   // member of HUB_V
  P: 'f0000000-0000-4000-8000-0000000000f1',   // Council 'publisher' member
  D: 'f0000000-0000-4000-8000-0000000000f2',   // Council 'delegate' member
  N: 'f0000000-0000-4000-8000-0000000000f3',   // NHS 'publisher' member (organisation will NOT hold the entitlement)
  F: 'f0000000-0000-4000-8000-0000000000f4',   // a funeral director account
  S: 'e0000000-0000-4000-8000-0000000000e1',   // platform administrator
  O: 'e0000000-0000-4000-8000-0000000000e2',   // moderator (staff for notices, NOT a platform administrator)
};
export const BIZ_B = 'bb000000-0000-4000-8000-0000000000bb', BIZ_V = 'cc000000-0000-4000-8000-0000000000cc', HUB_V = 'dd000000-0000-4000-8000-0000000000dd';
export const HUB_O = 'dd000000-0000-4000-8000-0000000000d0';
export const N_LEGACY = 'a1000000-0000-4000-8000-000000000001';

export type Who = keyof typeof U | 'anon' | 'service';
/** run SQL as a role + user (a client, as PostgREST would): returns psql's output (contains ERROR on failure) */
export const as = (who: Who, sql: string) => {
  const role = who === 'service' ? 'service_role' : who === 'anon' ? 'anon' : 'authenticated';
  const sub = who === 'anon' || who === 'service' ? '' : U[who];
  return raw(`set role ${role}; select set_config('request.jwt.claim.sub','${sub}',false); ${sql}; reset role;`);
};
export const asScalar = (who: Who, sql: string) => last(as(who, sql));
export const idOf = (o: string) => (o.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []).pop() ?? '';

/** migrations the new feature adds, in order (a suite applies the prefix it needs) */
export const NEW_MIGRATIONS = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => /^20261129\d{6}_.*\.sql$/.test(f)).sort();

export function buildDatabase(through: number = NEW_MIGRATIONS.length) {
  let o = file(rd('supabase/tests/_support/attribution-prefix-schema.sql'));
  if (/ERROR/i.test(o)) throw new Error(`prefix failed:\n${o.slice(0, 600)}`);
  o = file(`
    grant usage on schema public to anon, authenticated, service_role;
    create function public.is_admin() returns boolean language sql stable security definer set search_path to 'public' as $$
      select exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or is_platform_owner = true)); $$;
    alter table notices add column lat numeric, add column lng numeric; alter table profiles add column display_name text; alter table profiles add column location_area text; alter table profiles add column deleted_at timestamptz; alter table profiles add column is_active boolean default true;
    alter table hubs add column logo_url text, add column brand_color text; alter table local_businesses add column logo_url text, add column brand_color text;
    create table regions (id uuid primary key default gen_random_uuid(), slug text unique not null, name text not null, display_order int);
    create table jobs (id uuid primary key default gen_random_uuid(), title text, locality text, location text);
    create table runs (id uuid primary key default gen_random_uuid(), origin_region_id uuid references regions(id), destination_region_id uuid references regions(id));
    create table delivery_requests (id uuid primary key default gen_random_uuid(), destination_region_id uuid references regions(id), destination_address text);
    create table content_reports (id uuid primary key default gen_random_uuid(), reporter_id uuid, content_type text not null, content_id uuid not null, reason text);
    -- the production notification tables the audience migration reads (shapes copied from the baseline / spine migrations)
    create table notification_preferences (user_id uuid primary key, enabled boolean default true, notices_enabled boolean default true, hubs_enabled boolean default true,
      quiet_hours_start time, quiet_hours_end time, updated_at timestamptz default now());
    create table push_tokens (id uuid primary key default gen_random_uuid(), user_id uuid not null, token text not null, created_at timestamptz default now());
    create table notification_log (id uuid primary key default gen_random_uuid(), user_id uuid not null, category text not null, title text not null, body text not null,
      data jsonb, status text not null, error text, created_at timestamptz default now(), read_at timestamptz);
    grant select on all tables in schema public to anon; grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
    insert into profiles (id, role, display_name) values ('${U.A}','customer','Ann'), ('${U.A2}','customer',null), ('${U.A3}','customer','Cal'), ('${U.B}','customer','Bea'),
      ('${U.V}','customer','Vic'), ('${U.H}','customer','Hal'), ('${U.C}','customer','Cat'), ('${U.M}','customer','Meg'),
      ('${U.P}','customer','Pat (Council)'), ('${U.D}','customer','Dee (Council)'), ('${U.N}','customer','Nia (NHS)'), ('${U.F}','customer','Fin (Funeral director)'),
      ('${U.S}','admin','Staff'), ('${U.O}','moderator','Mod');
    insert into local_businesses (id, owner_id, name, slug, can_publish_urgent) values ('${BIZ_B}','${U.B}','Bea Bakery','bea',false), ('${BIZ_V}','${U.V}','Vic Garage','vic',true);
    alter table hubs disable trigger tg_zz_lock_hub_columns;
    insert into hubs (id, owner_id, name, slug, is_verified, payout_enabled) values ('${HUB_V}','${U.H}','Voe Hall','voe',true,true), ('${HUB_O}','${U.S}','Other Hub','other',false,false);
    alter table hubs enable trigger tg_zz_lock_hub_columns;
    insert into hub_members (hub_id, user_id, role) values ('${HUB_V}','${U.C}','committee'), ('${HUB_V}','${U.M}','member');
    insert into notices (id, publisher_hub_id, severity, title, body, visibility, published_at, created_at)
      values ('${N_LEGACY}','${HUB_V}','info','OneShetland is getting ready to launch','Legacy body','public','2026-10-04 11:20:42+00','2026-10-04 11:20:42+00');`);
  if (/ERROR/i.test(o)) throw new Error(`seed failed:\n${o.slice(0, 600)}`);
  for (const f of [
    'supabase/migrations/20261121000000_event_notice_attribution.sql', 'supabase/migrations/20261127000000_canonical_geography_foundation.sql',
    'supabase/migrations/20261127010000_geography_alias_ambiguity.sql', 'supabase/migrations/20261128000000_notices_structural_readiness.sql',
    'supabase/migrations/20261128010000_notices_read_protection.sql',
    ...NEW_MIGRATIONS.slice(0, through).map((m) => `supabase/migrations/${m}`),
  ]) {
    o = file(rd(f));
    if (/ERROR/i.test(o)) throw new Error(`${f} failed:\n${o.slice(0, 900)}`);
  }
}

/** a few real canonical area ids */
export const areaIds = () => scalar(`select string_agg(id, ',' order by sort_order, id) from (select id, sort_order from areas where type = 'locality' and is_active order by sort_order, id limit 4) s`).split(',');
