/**
 * fetch-v2-pricing-terms.node.test.ts — Fetch v2 Step 4: the quote/create boundary, frozen terms, island derivation, 18+, and the
 * replacement-hold contract (migration 20261201000000 + supabase/functions/_shared/fetch-v2-intake.ts), against the real SQL.
 *
 * The REAL handlers (handleQuote / handleCreate) run against a throwaway database: their database calls go through a service-role
 * adapter to the real functions, while Google (geocoder), Stripe (card check) and the rate limiter are mocks. Nothing leaves the
 * machine. Pricing is asserted against the formula, frozen terms against later configuration changes, and the Step 5 hold contract
 * (archive a released driver's voided hold, start the next at a new generation) end to end in SQL.
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users; mocked Google and Stripe; nothing near production.
 * Run: ISOLATED_ONLY=fetch-v2-pricing-terms npm run test:isolated
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';
import { handleQuote, handleCreate, type IntakeDeps, type CardStatus } from '../functions/_shared/fetch-v2-intake.ts';
import { GeocodeUnavailable, type GeocodeQuery } from '../functions/_shared/fetch-v2-geocode.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX_NAME = '20261201000000_fetch_v2_pricing_terms.sql';
const FIX = join(REPO_ROOT, 'supabase/migrations', FIX_NAME);
const DOWN = join(REPO_ROOT, 'supabase/rollbacks/20261201000000_fetch_v2_pricing_terms.down.sql');

let db: ReplayDb;
const tag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !tag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^NOTICE/.test(l));
const lastRow = (o: string) => rowsOf(o).pop() ?? '';
const scalar = (sql: string) => lastRow(db.raw(sql));
const ok = (o: string) => assert.doesNotMatch(o, /ERROR/, o);
const fails = (o: string, re: RegExp = /ERROR/) => assert.match(o, re, o);

const ids = {
  ADMIN: 'ad000000-0000-4000-8000-0000000000ad',
  REQ: 'a1000000-0000-4000-8000-000000000001',
  KID: 'a3000000-0000-4000-8000-000000000003',        // never confirmed 18+
  BANNED: 'a4000000-0000-4000-8000-000000000004',     // restricted by an admin
  NOCARD: 'a5000000-0000-4000-8000-000000000005',
  CARDERR: 'a6000000-0000-4000-8000-000000000006',
  DRV_A: 'da000000-0000-4000-8000-00000000000a',
  DRV_B: 'db000000-0000-4000-8000-00000000000b',
  DRV_KID: 'dd000000-0000-4000-8000-00000000000d',    // approved driver who never confirmed 18+
} as const;
type Id = keyof typeof ids;
const roleSql = (w: Id) => `set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated;`;
const client = (w: Id, call: string) => lastRow(db.raw(`begin; ${roleSql(w)} select ${call}; commit;`));
const svcRaw = (call: string) => db.raw(`begin; set local role service_role; select ${call}; commit;`);
const svc = (call: string) => { const o = svcRaw(call); assert.doesNotMatch(o, /ERROR/, o); return JSON.parse(lastRow(o)); };
const setAudience = (v: string) => ok(db.raw(`update public.admin_config set value = '${v}' where key = 'fetch.v2.audience'`));

// ── the mocks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const C = {
  BRAE: { lat: 60.396, lng: -1.353 }, LERWICK: { lat: 60.155, lng: -1.145 }, MIDYELL: { lat: 60.600, lng: -1.060 },
  BALTASOUND: { lat: 60.757, lng: -0.857 }, MARYFIELD: { lat: 60.153, lng: -1.118 }, SKERRIES: { lat: 60.42, lng: -0.75 }, LONDON: { lat: 51.5, lng: -0.12 },
};
const ADDRESSES: Record<string, { lat: number; lng: number }> = {
  '7 Westerloch': C.BRAE, '12 Hillhead': C.LERWICK, 'Mid Yell Shop': C.MIDYELL, 'Baltasound Hall': C.BALTASOUND,
  'Maryfield': C.MARYFIELD, 'Skerries Pier': C.SKERRIES, 'Somewhere in London': C.LONDON,
};
const POSTCODES: Record<string, { lat: number; lng: number }> = { 'ZE2 9QJ': C.BRAE };
const PLACES: Record<string, { lat: number; lng: number }> = { 'ChIJ-mid-yell-shop': C.MIDYELL };
const geoCalls: GeocodeQuery[] = [];
const geocode = async (q: GeocodeQuery) => {
  geoCalls.push(q);
  if ('place_id' in q) return PLACES[q.place_id] ?? null;
  const first = q.address.split(',')[0].trim();
  if (first === 'GOOGLE DOWN') throw new GeocodeUnavailable('network');
  if (first === 'GOOGLE EXPLODES') throw new Error('Unexpected sk_live_SECRET AIza-KEY token in provider response');
  return ADDRESSES[first] ?? POSTCODES[first] ?? null;
};
const CARDS: Record<string, CardStatus> = { NOCARD: 'payment_method_required', CARDERR: 'card_check_failed' };
const cardCalls: string[] = [];
let limitAllows = true;
const limitCalls: string[][] = [];

const lit = (v: unknown) => (typeof v === 'object' && v !== null ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb` : v === null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const deps: IntakeDeps = {
  rpc: async (fn, args) => {
    const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
    const o = db.raw(`begin; set local role service_role; select (public.${fn}(${named}))::text; commit;`);
    if (/ERROR/.test(o)) return { data: null, error: { message: o } };
    return { data: JSON.parse(lastRow(o)), error: null };
  },
  geocode,
  cardCheck: async (userId) => { cardCalls.push(userId); const who = (Object.keys(ids) as Id[]).find((k) => ids[k] === userId)!; return CARDS[who] ?? 'eligible'; },
  limit: async (_u, actions) => { limitCalls.push(actions); return limitAllows; },
};
const RG: Record<string, string> = {};
const place = (region: string, address: string, extra: Record<string, unknown> = {}) => ({ region_id: RG[region], address, ...extra });
const quoteBody = (o: Record<string, unknown> = {}) => ({ size_class: 'small', pickup: place('north-mainland', '7 Westerloch', { area: 'Brae' }),
  destination: place('lerwick', '12 Hillhead', { area: 'Hillhead' }), ...o });
const createBody = (o: Record<string, unknown> = {}) => ({ ...quoteBody(), idempotency_key: `k-${randomUUID()}`, category_slug: 'small-parcel',
  item_description: 'Box of books', pickup_name: 'Mrs Isbister', contact_phone: '07700 900123', scheduling_mode: 'asap', ...o });
const quote = (o: Record<string, unknown> = {}, who: Id = 'REQ') => handleQuote(ids[who], quoteBody(o), deps);
const create = (o: Record<string, unknown> = {}, who: Id = 'REQ') => handleCreate(ids[who], createBody(o), deps);
// deno-lint-ignore no-explicit-any
const Q = (r: { body: Record<string, any> }) => r.body.quote;
const formula = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  Number(scalar(`select round(round(public.fetch_v2_straight_miles(${a.lat}, ${a.lng}, ${b.lat}, ${b.lng}) * 1.40, 2) * 65)`));

let beforeRows: string[] = [];
let afterRows: string[] = [];
const catalogueRows = (): string[] => {
  const o = db.raw(`select x from (
    select 'col:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) as x from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    union all select 'con:' || conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
    union all select 'pol:' || tablename || ':' || policyname || ':' || coalesce(qual, '') from pg_policies where schemaname in ('public', 'storage')
    union all select 'trg:' || tgrelid::regclass || ':' || tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text not like 'pg_%'
    union all select 'fn:' || p.oid::regprocedure || ':' || md5(p.prosrc) || ':' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a), '') from pg_proc p where p.pronamespace = 'public'::regnamespace
    union all select 'tbl:' || relname || ':' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(relacl) a), '') from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
    union all select 'rl:' || action || ':' || window_seconds || ':' || max_count from public.rate_limit_policies
  ) s order by x`);
  assert.doesNotMatch(o, /ERROR/, o);
  return rowsOf(o).filter((l) => !/^x$|^-+$|^\(\d+ rows?\)$/.test(l));
};
const setDiff = (want: string[], got: string[]) => ({ missing: want.filter((x) => !got.includes(x)), extra: got.filter((x) => !want.includes(x)) });

before(() => {
  db = createReplayDb('fetchv2price', { stopBefore: FIX_NAME });
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  const slugs = ['lerwick', 'scalloway', 'central-mainland', 'south-mainland', 'west-mainland', 'north-mainland', 'northmavine', 'bressay', 'burra',
    'trondra', 'muckle-roe', 'whalsay', 'yell', 'unst', 'fetlar', 'out-skerries', 'fair-isle'];
  ok(db.raw(`
    insert into auth.users (id, email) select x, 'u' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id = '${ids.ADMIN}';
    insert into public.regions (slug, name, display_order) select s, initcap(replace(s, '-', ' ')), o from unnest(array[${slugs.map((s) => `'${s}'`).join(',')}]) with ordinality t(s, o);
    update public.regions set island_group = case when slug in ('bressay','whalsay','yell','unst','fetlar') then slug when slug = 'out-skerries' then 'out_skerries' when slug = 'fair-isle' then 'fair_isle' else 'mainland' end;
    insert into public.delivery_pricing_config (price_per_mile_pence, min_fee_pence, road_correction_factor) values (65, 400, 1.40);
    insert into public.admin_config (key, value, category) values ('fees.fetch.fixed_pence', '150', 'fees'), ('fees.fetch.percent_bps', '0', 'fees')
      on conflict (key) do update set value = excluded.value;
    insert into public.delivery_categories (slug, name) values ('small-parcel', 'Small parcel'), ('other', 'Other');
    insert into public.driver_profiles (id, driver_status, vehicle_class, max_size_class, stripe_onboarding_complete, stripe_payouts_enabled, verification_ok_until) values
      ('${ids.DRV_A}', 'approved', 'van', 'bulky', true, true, now() + interval '1 year'),
      ('${ids.DRV_B}', 'approved', 'car', 'large', true, true, now() + interval '1 year'),
      ('${ids.DRV_KID}', 'approved', 'car', 'large', true, true, now() + interval '1 year');`));
  for (const s of slugs) RG[s] = scalar(`select id from public.regions where slug = '${s}'`);
  beforeRows = catalogueRows();
  ok(db.rawFile(FIX));
  afterRows = catalogueRows();
  setAudience('everyone');
  for (const w of ['REQ', 'BANNED', 'NOCARD', 'CARDERR', 'DRV_A', 'DRV_B'] as Id[]) assert.match(client(w, `public.fetch_v2_confirm_adult('fetch-18plus-v1')`), /"ok": true/);
  ok(db.raw(`update public.fetch_member_stats set restricted_at = now(), restricted_reason = 'Abusive requests' where user_id = '${ids.BANNED}'`));
});
after(() => { db?.drop(); });

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('0 · where a job is', () => {
  test('islands from coordinates: ferry terminals and main settlements', () => {
    const at = (lat: number, lng: number) => scalar(`select coalesce(public.fetch_v2_island_at(${lat}, ${lng}), 'OUTSIDE')`);
    for (const [name, lat, lng, island] of [
      ['Lerwick', 60.155, -1.145, 'mainland'], ['Brae', 60.396, -1.353, 'mainland'], ['Toft terminal', 60.468, -1.200, 'mainland'],
      ['Laxo terminal', 60.352, -1.170, 'mainland'], ['Burra (bridged)', 60.08, -1.33, 'mainland'], ['Muckle Roe (bridged)', 60.37, -1.43, 'mainland'],
      ['Bressay, Maryfield', 60.153, -1.118, 'bressay'], ['Ulsta terminal', 60.495, -1.165, 'yell'], ['Mid Yell', 60.600, -1.060, 'yell'],
      ['Gutcher terminal', 60.672, -0.995, 'yell'], ['Belmont terminal', 60.686, -0.965, 'unst'], ['Baltasound', 60.757, -0.857, 'unst'],
      ['Fetlar, Houbie', 60.611, -0.833, 'fetlar'], ['Whalsay, Symbister', 60.343, -1.030, 'whalsay'], ['Out Skerries', 60.42, -0.75, 'out_skerries'],
      ['Fair Isle', 59.535, -1.630, 'fair_isle'], ['Foula', 60.13, -2.07, 'foula'], ['London', 51.5, -0.12, 'OUTSIDE'], ['Orkney', 59.0, -3.0, 'OUTSIDE'],
    ] as [string, number, number, string][]) assert.equal(at(lat, lng), island, name);
  });
  test('the island areas are admin data, not client-readable', () => {
    assert.match(db.raw(`begin; ${roleSql('REQ')} select count(*) from public.fetch_island_areas; rollback;`), /^\s*0\s*$/m);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · QUOTE', () => {
  test('standard: mileage at 65p × 1.40, service fee £1.50, no ferry; waiting and return exposure; maximum hold', async () => {
    const r = await quote();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const q = Q(r);
    const m = formula(C.BRAE, C.LERWICK);
    assert.deepEqual([q.driver_delivery_pence, q.ferry_supplement_pence, q.service_fee_pence, q.expected_total_pence], [Math.max(400, m), 0, 150, Math.max(400, m) + 150]);
    assert.deepEqual(q.authorisation_breakdown, { expected_total_pence: Math.max(400, m) + 150, waiting_max_pence: 600, return_max_pence: m });
    assert.equal(q.max_authorisation_pence, Math.max(400, m) + 150 + 600 + m);
    assert.ok(q.max_authorisation_pence > q.expected_total_pence);
    assert.equal(`${q.ferry_required}:${q.minimum_applied}:${q.pricing_version}`, 'false:false:fetch_v2_p0');
  });
  test('£4 minimum (same village) and £8 bulky minimum — same mileage formula, no other bulky charge', async () => {
    const near = { destination: place('north-mainland', '7 Westerloch') };
    const s = Q(await quote(near));
    const b = Q(await quote({ ...near, size_class: 'bulky' }));
    assert.deepEqual([s.driver_delivery_pence, s.minimum_applied, s.authorisation_breakdown.return_max_pence], [400, true, 0]);
    assert.deepEqual([b.driver_delivery_pence, b.minimum_applied, b.service_fee_pence, b.ferry_supplement_pence], [800, true, 150, 0]);
  });
  test('ferry: one flat £2 for Yell, for Unst (two crossings) and for Bressay; none on the same island', async () => {
    const yell = Q(await quote({ pickup: place('lerwick', '12 Hillhead'), destination: place('yell', 'Mid Yell Shop') }));
    const unst = Q(await quote({ pickup: place('lerwick', '12 Hillhead'), destination: place('unst', 'Baltasound Hall') }));
    const bressay = Q(await quote({ pickup: place('lerwick', '12 Hillhead'), destination: place('bressay', 'Maryfield') }));
    const local = Q(await quote());
    assert.deepEqual([yell.ferry_supplement_pence, unst.ferry_supplement_pence, bressay.ferry_supplement_pence, local.ferry_supplement_pence], [200, 200, 200, 0]);
    assert.equal(yell.expected_total_pence, yell.driver_delivery_pence + 200 + 150);
  });
  test('locations are the server\'s: a place_id is resolved here; client coordinates and prices are ignored', async () => {
    geoCalls.length = 0;
    const r = Q(await quote({ destination: place('yell', 'Somewhere vague', { place_id: 'ChIJ-mid-yell-shop', lat: 51.5, lng: -0.12 }),
      delivery_fee_pence: 1, total_pence: 1, ferry_supplement_pence: 0, max_hold_pence: 1 }));
    assert.ok(geoCalls.some((g) => 'place_id' in g));
    assert.equal(r.ferry_supplement_pence, 200);
    assert.equal(r.driver_delivery_pence, Math.max(400, formula(C.BRAE, C.MIDYELL)));
  });
  test('postcode fallback when the address text cannot be placed', async () => {
    const r = await quote({ pickup: place('north-mainland', 'Unnamed croft', { postcode: 'ZE2 9QJ' }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  test('unresolved, outside Shetland, unsupported isle, region on the wrong island: clean refusals, never a minimum price', async () => {
    const cases: [Record<string, unknown>, number, string][] = [
      [{ destination: place('lerwick', 'No such street') }, 422, 'location_unresolved'],
      [{ destination: place('lerwick', 'Somewhere in London') }, 422, 'outside_service_area'],
      [{ destination: place('lerwick', '12 Hillhead', { postcode: 'SW1A 1AA' }) }, 422, 'outside_service_area'],
      [{ destination: place('out-skerries', 'Skerries Pier') }, 422, 'area_not_supported'],
      [{ destination: place('lerwick', 'Mid Yell Shop') }, 422, 'region_mismatch'],
      [{ destination: place('lerwick', 'GOOGLE DOWN') }, 503, 'location_service_unavailable'],
    ];
    for (const [o, status, code] of cases) {
      const r = await quote(o);
      assert.equal(`${r.status}:${r.body.code}`, `${status}:${code}`, JSON.stringify(o));
      assert.equal(r.body.quote, undefined);
    }
  });
  test('malformed input is refused before anything is resolved', async () => {
    for (const o of [{ size_class: 'huge' }, { size_class: undefined }, { pickup: { address: 'x' } }, { destination: place('lerwick', '12 Hillhead', { place_id: 'bad id!' }) },
      { pickup: { region_id: 'not-a-uuid', address: '7 Westerloch' } }, { destination: place('lerwick', 'x'.repeat(301)) }]) {
      const r = await quote(o);
      assert.equal(r.status, 400, JSON.stringify(o));
    }
  });
  test('quotes write nothing and can be repeated', async () => {
    const before = scalar(`select count(*) from public.delivery_requests`);
    await quote(); await quote();
    assert.equal(scalar(`select count(*) from public.delivery_requests`), before);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · who may quote and create', () => {
  test('signed out, outside the audience, under-18 (unconfirmed), restricted: refused before any geocode', async () => {
    geoCalls.length = 0;
    assert.equal((await handleQuote(null, quoteBody(), deps)).body.code, 'unauthorised');
    assert.equal((await quote({}, 'KID')).body.code, 'age_confirmation_required');
    assert.equal((await create({}, 'KID')).body.code, 'age_confirmation_required');
    assert.equal((await quote({}, 'BANNED')).body.code, 'member_restricted');
    assert.equal((await create({}, 'BANNED')).body.code, 'member_restricted');
    setAudience('admins');
    assert.equal((await quote()).body.code, 'fetch_unavailable');
    assert.equal((await create()).body.code, 'fetch_unavailable');
    setAudience('everyone');
    assert.equal(geoCalls.length, 0);
  });
  test('the database enforces 18+ as well (an edge bug cannot skip it)', () => {
    const r = svc(`public.fetch_v2_create_request('${ids.KID}', '{"idempotency_key": "abcdefgh-1"}'::jsonb)`);
    assert.equal(r.code, 'age_confirmation_required');
  });
  test('confirming 18+ is the member\'s own explicit act, recorded once with its wording version', () => {
    assert.match(client('KID', `public.fetch_v2_my_eligibility()`), /"problem": "age_confirmation_required"/);
    assert.match(client('KID', `public.fetch_v2_confirm_adult('bad version!')`), /invalid_request/);
    assert.match(db.raw(`begin; ${roleSql('KID')} insert into public.fetch_member_stats (user_id, adult_confirmed_at, adult_confirmation_version) values ('${ids.KID}', now(), 'x'); rollback;`), /permission denied/);
  });
  test('rate limited per member, with the v2 actions, before anything costly', async () => {
    limitAllows = false; geoCalls.length = 0; cardCalls.length = 0; limitCalls.length = 0;
    assert.equal((await quote()).status, 429);
    assert.equal((await create()).status, 429);
    assert.deepEqual(limitCalls, [['fetch_v2_quote', 'fetch_v2_quote_day'], ['fetch_v2_create', 'fetch_v2_create_day']]);
    assert.equal(geoCalls.length + cardCalls.length, 0);
    limitAllows = true;
    assert.equal(scalar(`select string_agg(action || '=' || max_count || '/' || window_seconds, ',' order by action) from public.rate_limit_policies where action like 'fetch_v2_%'`),
      'fetch_v2_create=10/3600,fetch_v2_create_day=30/86400,fetch_v2_quote=40/3600,fetch_v2_quote_day=200/86400');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · CREATE', () => {
  test('an eligible adult with a card creates a job; terms frozen; the answer is shaped and private-data free', async () => {
    const r = await create();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.request_id as string;
    assert.equal(scalar(`select fetch_version || ':' || status || ':' || pickup_island_group || ':' || dest_island_group from public.delivery_requests where id = '${id}'`), '2:pending:mainland:mainland');
    assert.equal(scalar(`select count(*) from public.fetch_v2_terms where request_id = '${id}'`), '1');
    assert.equal(Q(r).expected_total_pence, Number(scalar(`select total_pence from public.fetch_v2_terms where request_id = '${id}'`)));
    const out = JSON.stringify(r.body);
    for (const s of ['07700 900123', '7 Westerloch', '12 Hillhead', 'Mrs Isbister', 'lat', 'lng']) assert.ok(!out.includes(s), s);
  });
  test('card on file is required: none → 402 payment_method_required; Stripe cannot be asked → 503 card_check_failed; nothing created', async () => {
    const before = scalar(`select count(*) from public.delivery_requests`);
    geoCalls.length = 0;
    const none = await create({}, 'NOCARD');
    const err = await create({}, 'CARDERR');
    assert.equal(`${none.status}:${none.body.code}`, '402:payment_method_required');
    assert.equal(`${err.status}:${err.body.code}`, '503:card_check_failed');
    assert.equal(scalar(`select count(*) from public.delivery_requests`), before);
    assert.equal(geoCalls.length, 0, 'no geocoding is spent on a request that cannot be paid for');
  });
  test('an idempotency key is required; a retry (timeout, double tap) returns the same job and the same quote', async () => {
    assert.equal((await handleCreate(ids.REQ, { ...createBody(), idempotency_key: undefined }, deps)).body.code, 'idempotency_key_required');
    const body = createBody();
    const a = await handleCreate(ids.REQ, body, deps);
    const b = await handleCreate(ids.REQ, body, deps);
    assert.equal(`${a.status}:${b.status}:${b.body.already}:${a.body.request_id === b.body.request_id}`, '201:200:true:true');
    assert.deepEqual(Q(b), Q(a));
    assert.equal(scalar(`select count(*) from public.delivery_requests where idempotency_key = '${body.idempotency_key}'`), '1');
  });
  test('no client financial or state override: money, status, driver, coordinates and terms in the body are ignored', async () => {
    const r = await create({ base_fee_pence: 1, total_fee_pence: 1, ferry_supplement_pence: 0, max_hold_pence: 1, status: 'matched',
      driver_id: ids.DRV_A, pickup_lat: 51.5, pickup_lng: -0.12, terms: { total_pence: 1 }, payment_status: 'captured', fetch_version: 1,
      destination: place('yell', 'Mid Yell Shop') });
    const id = r.body.request_id as string;
    assert.equal(scalar(`select status || ':' || coalesce(driver_id::text, '-') || ':' || payment_status || ':' || ferry_supplement_pence || ':' || (pickup_lat > 60) from public.delivery_requests where id = '${id}'`),
      'pending:-:unpaid:200:true');
  });
  test('provider and database failures come back as shaped codes, never their text', async () => {
    const g = await create({ destination: place('lerwick', 'GOOGLE EXPLODES') });
    assert.equal(g.body.code, 'server_error');
    const bad = await handleCreate(ids.REQ, createBody(), { ...deps, rpc: async () => ({ data: null, error: { message: 'relation "public.fetch_v2_terms" does not exist' } }) });
    assert.equal(bad.body.code, 'server_error');
    for (const o of [g.body, bad.body]) assert.doesNotMatch(JSON.stringify(o), /sk_live|AIza|relation|does not exist/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · FROZEN TERMS', () => {
  let id = '';
  before(async () => {
    const r = await create({ destination: place('yell', 'Mid Yell Shop') });
    id = r.body.request_id as string;
  });
  test('the job carries every number it needs, consistent with itself and never 95p', () => {
    assert.equal(scalar(`select pricing_version || ':' || price_per_mile_pence || ':' || road_correction_factor || ':' || min_fee_pence || ':' || bulky_min_fee_pence || ':' ||
      ferry_supplement_pence || ':' || service_fee_pence || ':' || wait_grace_secs || '/' || wait_period_secs || '/' || wait_period_pence || '/' || wait_max_pence || ':' ||
      return_per_mile_pence || ':' || return_road_factor from public.fetch_v2_terms where request_id = '${id}'`), 'fetch_v2_p0:65:1.40:400:800:200:150:300/300/150/600:65:1.40');
    assert.equal(scalar(`select count(*) from public.fetch_v2_terms where price_per_mile_pence = 95 or return_per_mile_pence = 95`), '0');
  });
  test('terms cannot be edited by anyone', () => {
    fails(db.raw(`update public.fetch_v2_terms set service_fee_pence = 0 where request_id = '${id}'`), /frozen/);
    fails(db.raw(`delete from public.fetch_v2_terms where request_id = '${id}'`), /frozen/);
  });
  test('after every live price changes, the job is unchanged — and a fresh quote uses the new prices', async () => {
    const frozen = scalar(`select row(t.*)::text from public.fetch_v2_terms t where request_id = '${id}'`);
    ok(db.raw(`update public.delivery_pricing_config set price_per_mile_pence = 70, min_fee_pence = 500, bulky_min_fee_pence = 900, ferry_supplement_pence = 300, wait_max_pence = 900;
      update public.admin_config set value = '200' where key = 'fees.fetch.fixed_pence';`));
    assert.equal(scalar(`select row(t.*)::text from public.fetch_v2_terms t where request_id = '${id}'`), frozen);
    const fresh = Q(await quote({ pickup: place('lerwick', '12 Hillhead'), destination: place('yell', 'Mid Yell Shop') }));
    assert.deepEqual([fresh.ferry_supplement_pence, fresh.service_fee_pence, fresh.authorisation_breakdown.waiting_max_pence], [300, 200, 900]);
  });
  test('the hold, the waiting cap and the return all use the job\'s frozen terms, not the new prices', () => {
    const claim = svc(`public.fetch_v2_claim('${ids.DRV_A}', '${id}', true)`);
    assert.equal(claim.payment.amount_pence, Number(scalar(`select max_hold_pence from public.fetch_v2_terms where request_id = '${id}'`)));
    const auth = svc(`row_to_json(a) from public.fetch_v2_claim_authorisation('${ids.DRV_A}', '${id}') a`);
    assert.equal(`${auth.outcome}:${auth.generation}:${auth.idempotency_key}`, `claimed:1:fetch-auth-${id}`);
    assert.equal(scalar(`select base_fee_pence || ':' || service_fee_pence || ':' || wait_max_pence || ':' || amount_pence from public.fetch_authorisation_attempts where delivery_request_id = '${id}'`),
      scalar(`select (delivery_fee_pence + ferry_supplement_pence) || ':150:600:' || max_hold_pence from public.fetch_v2_terms where request_id = '${id}'`));
    // the hold is placed and confirmed (what Step 5 does), the driver waits two hours after "ready", collects
    ok(svcRaw(`public.settle_fetch_authorisation('${id}', 'authorised', 'pi_test_frozen', null, null)`));
    ok(db.raw(`update public.fetch_authorisation_attempts set hold_state = 'valid', hold_checked_at = now() where delivery_request_id = '${id}';
      update public.delivery_requests set payment_status = 'authorised', payment_intent_id = 'pi_test_frozen', ready_for_collection = true where id = '${id}';`));
    assert.match(client('DRV_A', `public.fetch_v2_mark_arrived('${id}')`), /"ok": true/);
    ok(db.raw(`update public.waiting_events set arrived_at = now() - interval '2 hours' where request_id = '${id}'`));
    assert.match(client('DRV_A', `public.fetch_v2_mark_collected('${id}')`), /"waiting_fee_pence": 600/);
    assert.match(client('DRV_A', `public.fetch_v2_mark_undeliverable('${id}', 'recipient_absent')`), /undeliverable/);
    const ret = svc(`public.fetch_v2_resolve_return('${ids.ADMIN}', '${id}', 'returned_to_sender', 'not_driver')`);
    const fee = Number(scalar(`select least(round(round(public.fetch_v2_straight_miles(dest_lat, dest_lng, pickup_lat, pickup_lng) * 1.40, 2) * 65), return_max_pence) from public.delivery_requests where id = '${id}'`));
    assert.equal(Number(scalar(`select return_fee_pence from public.delivery_requests where id = '${id}'`)), fee, 'return at the frozen 65p, not the new 70p');
    assert.equal(ret.capture_pence, Number(scalar(`select total_pence from public.fetch_v2_terms where request_id = '${id}'`)) + 600 + fee, 'one service fee, one ferry supplement');
    assert.equal(scalar(`set role service_role; select total_pence from public.fetch_capture_total_pence('${id}')`), String(ret.capture_pence), 'the capture total is the resolution');
    ok(db.raw(`update public.delivery_pricing_config set price_per_mile_pence = 65, min_fee_pence = 400, bulky_min_fee_pence = 800, ferry_supplement_pence = 200, wait_max_pence = 600;
      update public.admin_config set value = '150' where key = 'fees.fetch.fixed_pence';`));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · replacement holds after a release (the Step 5 contract)', () => {
  test('a released driver\'s hold is archived only once voided; the next driver\'s hold is a new generation with a new key', async () => {
    const id = (await create()).body.request_id as string;
    svc(`public.fetch_v2_claim('${ids.DRV_A}', '${id}', true)`);
    const g1 = svc(`row_to_json(a) from public.fetch_v2_claim_authorisation('${ids.DRV_A}', '${id}') a`);
    assert.equal(`${g1.generation}:${g1.idempotency_key}`, `1:fetch-auth-${id}`);
    const again = svc(`row_to_json(a) from public.fetch_v2_claim_authorisation('${ids.DRV_A}', '${id}') a`);
    assert.equal(again.outcome, 'in_flight', 'a second call never starts a second hold');
    ok(svcRaw(`public.settle_fetch_authorisation('${id}', 'authorised', 'pi_test_g1', null, null)`));
    ok(db.raw(`update public.delivery_requests set payment_status = 'authorised', payment_intent_id = 'pi_test_g1' where id = '${id}'`));

    assert.equal(svc(`public.fetch_v2_retire_authorisation('${id}')`).code, 'job_still_assigned');
    const rel = svc(`public.fetch_v2_release('${ids.DRV_A}', '${id}', 'changed_plans')`);
    assert.equal(`${rel.payment.action}:${rel.payment.payment_intent_id}`, 'void:pi_test_g1');
    assert.equal(svc(`public.fetch_v2_retire_authorisation('${id}')`).code, 'hold_still_live', 'not before Stripe has voided it');
    ok(svcRaw(`public.settle_fetch_authorisation('${id}', 'terminal', 'pi_test_g1', null, null)`));   // Step 5: after the void succeeds
    const ret = svc(`public.fetch_v2_retire_authorisation('${id}')`);
    assert.equal(`${ret.ok}:${ret.retired_generation}`, 'true:1');
    assert.equal(svc(`public.fetch_v2_retire_authorisation('${id}')`).already, true);
    assert.equal(scalar(`select generation || ':' || stripe_payment_intent_id || ':' || status from public.fetch_authorisation_generations where delivery_request_id = '${id}'`), '1:pi_test_g1:terminal');

    svc(`public.fetch_v2_claim('${ids.DRV_B}', '${id}', true)`);
    const g2 = svc(`row_to_json(a) from public.fetch_v2_claim_authorisation('${ids.DRV_B}', '${id}') a`);
    assert.equal(`${g2.outcome}:${g2.generation}:${g2.idempotency_key}:${g2.amount_pence}`,
      `claimed:2:fetch-auth-${id}-g2:${scalar(`select max_hold_pence from public.fetch_v2_terms where request_id = '${id}'`)}`);
    assert.equal(scalar(`select driver_id = '${ids.DRV_B}' from public.fetch_authorisation_attempts where delivery_request_id = '${id}'`), 't');
  });
  test('only the assigned driver can start a hold; clients cannot call either function', async () => {
    const id = (await create()).body.request_id as string;
    svc(`public.fetch_v2_claim('${ids.DRV_A}', '${id}', true)`);
    assert.match(svcRaw(`public.fetch_v2_claim_authorisation('${ids.DRV_B}', '${id}')`), /Fetch request not found/);
    assert.match(db.raw(`begin; ${roleSql('DRV_A')} select public.fetch_v2_claim_authorisation('${ids.DRV_A}', '${id}'); rollback;`), /permission denied/);
    assert.match(db.raw(`begin; ${roleSql('DRV_A')} select public.fetch_v2_retire_authorisation('${id}'); rollback;`), /permission denied/);
  });
  test('drivers must be adults too: claim and run creation refuse without the 18+ confirmation', async () => {
    const id = (await create()).body.request_id as string;
    assert.equal(svc(`public.fetch_v2_claim('${ids.DRV_KID}', '${id}', true)`).code, 'age_confirmation_required');
    assert.match(client('DRV_KID', `public.fetch_v2_create_run('${RG.lerwick}', '${RG.yell}', now() + interval '1 day', now() + interval '1 day 2 hours', '{}', null, null)`), /age_confirmation_required/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('6 · one source of price', () => {
  const v2Sources = () => [
    ...readdirSync(join(REPO_ROOT, 'supabase/functions/_shared')).filter((f) => f.startsWith('fetch-v2-') && f.endsWith('.ts') && !f.includes('.test.')).map((f) => `supabase/functions/_shared/${f}`),
    'supabase/functions/fetch-v2-quote/index.ts', 'supabase/functions/fetch-v2-create/index.ts',
  ].map((p) => [p, readFileSync(join(REPO_ROOT, p), 'utf8')] as const);
  test('no v2 edge code computes or configures a price: no commission maths, no calculate-fee, no rates', () => {
    for (const [p, src] of v2Sources()) {
      assert.doesNotMatch(src, /commission|calculate-fee|calculateCommission|price_per_mile|PER_MILE|\b95\b|\b65\b|road_correction/i, p);
    }
  });
  test('only one SQL function reads the fee configuration, and its default matches the one v1 uses', () => {
    assert.equal(scalar(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc like '%fees.fetch.fixed_pence%'`), 'fetch_v2_price');
    const ts = readFileSync(join(REPO_ROOT, 'supabase/functions/_shared/commission-config.ts'), 'utf8');
    assert.match(ts, /fetch:\s*\{\s*percent_bps:\s*0,\s*fixed_pence:\s*150\s*\}/);
    assert.equal(scalar(`select prosrc like '%else 150 end%' from pg_proc where proname = 'fetch_v2_price'`), 't');
  });
  test('the obsolete 95p appears in no Step 4 file', () => {
    for (const p of [FIX, ...v2Sources().map(([p]) => join(REPO_ROOT, p))]) assert.doesNotMatch(readFileSync(p, 'utf8'), /\b95\s*p\b|= 95\b|'95'/, p);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('7 · rollback', () => {
  test('refuses while frozen terms or 18+ confirmations exist', () => {
    fails(db.rawFile(DOWN), /refusing to roll back the pricing terms/);
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
  test('otherwise restores the catalogue exactly; the migration re-applies', () => {
    ok(db.raw(`delete from public.delivery_requests where fetch_version = 2; update public.fetch_member_stats set adult_confirmed_at = null, adult_confirmation_version = null;`));
    ok(db.rawFile(DOWN));
    assert.deepEqual(setDiff(beforeRows, catalogueRows()), { missing: [], extra: [] });
    ok(db.rawFile(FIX));
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
});
