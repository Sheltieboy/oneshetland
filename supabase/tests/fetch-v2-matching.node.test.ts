/**
 * fetch-v2-matching.node.test.ts — Fetch v2 Step 7: matching (migration 20261221000000), against the real SQL.
 *
 * A throwaway database replayed from every migration, with Shetland's real island geography: jobs and journeys are created through the
 * real create functions (server geocoding is replaced by fixed coordinates inside each island's area). Drivers are made eligible
 * directly (approved, verified evidence, payouts) — Step 6's suite proves the real path to that state.
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users; no network.
 * Run: ISOLATED_ONLY=fetch-v2-matching npm run test:isolated
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX_NAME = '20261221000000_fetch_v2_matching.sql';
const FIX = join(REPO_ROOT, 'supabase/migrations', FIX_NAME);
const DOWN = join(REPO_ROOT, 'supabase/rollbacks/20261221000000_fetch_v2_matching.down.sql');

let db: ReplayDb;
const tag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !tag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^NOTICE/.test(l));
const lastRow = (o: string) => rowsOf(o).pop() ?? '';
const scalar = (sql: string) => lastRow(db.raw(sql));
const ok = (o: string) => assert.doesNotMatch(o, /ERROR/, o);
const fails = (o: string, re: RegExp = /ERROR/) => assert.match(o, re, o);

const ids = {
  ADMIN: 'ad000000-0000-4000-8000-0000000000ad',
  REQ: 'a1000000-0000-4000-8000-000000000001',     // a requester who is not a driver
  MEMBER: 'a2000000-0000-4000-8000-000000000002',  // an ordinary member
  D_VAN: 'd1000000-0000-4000-8000-000000000001',   // van, bulky, two-person; journey Lerwick → Yell tomorrow
  D_UNST: 'd2000000-0000-4000-8000-000000000002',  // van, large; journey Lerwick → Unst tomorrow
  D_MAIN: 'd3000000-0000-4000-8000-000000000003',  // car, medium; journey Lerwick → Brae (Mainland only)
  D_REV: 'd4000000-0000-4000-8000-000000000004',   // car, medium; journey Yell → Lerwick
  D_SMALL: 'd5000000-0000-4000-8000-000000000005', // car, small; area Lerwick; no journey
  D_AREA: 'd6000000-0000-4000-8000-000000000006',  // estate, large; area North Mainland; no journey
  D_HINT: 'd7000000-0000-4000-8000-000000000007',  // car, medium; journey Brae → Bressay
  D_SELF: 'd8000000-0000-4000-8000-000000000008',  // eligible driver who also asks for things; journey Lerwick → Yell
  D_EXP: 'd9000000-0000-4000-8000-000000000009',   // approved, insurance expired; journey Lerwick → Yell
  D_SUSP: 'da000000-0000-4000-8000-00000000000a',  // suspended; journey Lerwick → Yell
  D_UNVER: 'db000000-0000-4000-8000-00000000000b', // approved, no evidence at all
} as const;
type Id = keyof typeof ids;
const nameOf = (u: string) => (Object.keys(ids) as Id[]).find((k) => ids[k] === u) ?? u;
const lit = (v: unknown) => (v === null || v === undefined ? 'null' : typeof v === 'object' ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`
  : typeof v === 'boolean' || typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const asClient = (w: Id, stmt: string) => db.raw(`begin; set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated; ${stmt}; commit;`);
const client = (w: Id, call: string) => lastRow(asClient(w, `select ${call}`));
const svc = (call: string) => lastRow(db.raw(`begin; set local role service_role; select ${call}; commit;`));

type Row = { request_id: string; match: string; match_reasons: string[]; match_summary: string; can_claim: boolean; fits_run_id: string | null } & Record<string, unknown>;
const board = (w: Id, showAll = false): Row[] => {
  const o = asClient(w, `select coalesce(jsonb_agg(b), '[]'::jsonb) from public.fetch_v2_board(${showAll}) b`);
  assert.doesNotMatch(o, /ERROR/, o);
  return JSON.parse(lastRow(o));
};
const on = (rows: Row[], id: string) => rows.find((r) => r.request_id === id);
const fit = (run: string, job: string) => scalar(`select public.fetch_v2_run_fit('${run}', '${job}')`);
const claim = (w: Id, job: string) => JSON.parse(svc(`public.fetch_v2_claim('${ids[w]}', '${job}', true)`));
const select = (job: string, kind = 'new_request'): { driver_id: string; tier: string; reason: string }[] =>
  JSON.parse(svc(`coalesce(jsonb_agg(t), '[]'::jsonb) from public.fetch_v2_select_recipients('${job}', '${kind}') t`));
const hint = (w: Id, job: string) => client(w, `public.fetch_v2_heading_that_way('${job}')`);

// ── places ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const RG: Record<string, string> = {};
const PLACE: Record<string, { region: string; lat: number; lng: number; addr: string }> = {
  lerwick: { region: 'lerwick', lat: 60.155, lng: -1.145, addr: '12 Hillhead, Lerwick' },
  scalloway: { region: 'scalloway', lat: 60.137, lng: -1.276, addr: '3 Main Street, Scalloway' },
  brae: { region: 'north-mainland', lat: 60.396, lng: -1.353, addr: '7 Westerloch, Brae' },
  yell: { region: 'yell', lat: 60.600, lng: -1.060, addr: 'Mid Yell' },
  unst: { region: 'unst', lat: 60.757, lng: -0.840, addr: 'Baltasound, Unst' },
  whalsay: { region: 'whalsay', lat: 60.343, lng: -0.980, addr: 'Symbister, Whalsay' },
  bressay: { region: 'bressay', lat: 60.150, lng: -1.080, addr: 'Maryfield, Bressay' },
};
function job(from: string, to: string, o: Record<string, unknown> = {}, who: Id = 'REQ'): string {
  const a = PLACE[from], b = PLACE[to];
  const p = { idempotency_key: `k-${randomUUID()}`, category_slug: 'small-parcel', item_description: 'Box of books', size_class: 'small',
    pickup_region_id: RG[a.region], pickup_name: 'Mrs Isbister', pickup_location: a.addr, pickup_lat: a.lat, pickup_lng: a.lng,
    destination_region_id: RG[b.region], destination_address: b.addr, dest_lat: b.lat, dest_lng: b.lng,
    contact_phone: '07700 900123', scheduling_mode: 'flexible', flexible_until: new Date(Date.now() + 3 * 86400_000).toISOString(), ...o };
  const out = JSON.parse(svc(`public.fetch_v2_create_request('${ids[who]}', ${lit(p)})`));
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.request_id;
}
const tomorrow = (h: number) => { const d = new Date(Date.now() + 86400_000); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
function run(w: Id, from: string, to: string, o: { start?: string; hours?: number; categories?: string[]; max?: string } = {}): string {
  const s = o.start ?? tomorrow(9);
  const e = new Date(Date.parse(s) + (o.hours ?? 4) * 3600_000).toISOString();
  const cats = o.categories ? `array[${o.categories.map((c) => `'${c}'`).join(',')}]` : "'{}'::text[]";
  const out = JSON.parse(client(w, `public.fetch_v2_create_run('${RG[PLACE[from].region]}', '${RG[PLACE[to].region]}', '${s}', '${e}', ${cats}, ${o.max ? `'${o.max}'` : 'null'})`));
  assert.equal(out.ok, true, `${w}: ${JSON.stringify(out)}`);
  return out.run_id;
}

// ── catalogue (exact rollback) ──────────────────────────────────────────────────────────────────────────────────────────────
let beforeRows: string[] = [];
let afterRows: string[] = [];
const catalogueRows = (): string[] => {
  const o = db.raw(`select x from (
    select 'col:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull as x
      from pg_attribute a join pg_class c on c.oid = a.attrelid
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    union all select 'con:' || conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
    union all select 'idx:' || indexrelid::regclass || ':' || pg_get_indexdef(indexrelid) from pg_index i join pg_class c on c.oid = i.indrelid where c.relnamespace = 'public'::regnamespace
    union all select 'trg:' || tgrelid::regclass || ':' || tgname || ':' || tgfoid::regproc from pg_trigger where not tgisinternal and tgrelid::regclass::text not like 'storage.%'
    union all select 'fn:' || p.oid::regprocedure || ':' || md5(p.prosrc) || ':' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a), '') from pg_proc p where p.pronamespace = 'public'::regnamespace
    union all select 'tacl:' || c.relname || ':' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(c.relacl) a), '') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'S')
    union all select 'pol:' || schemaname || '.' || tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') from pg_policies where schemaname in ('public', 'storage')
    union all select 'cfg:' || key || '=' || value from public.admin_config where key like 'fetch.%' and key <> 'fetch.v2.audience'
  ) s order by x`);
  assert.doesNotMatch(o, /ERROR/, o);
  return rowsOf(o).filter((l) => !/^x$|^-+$|^\(\d+ rows?\)$/.test(l));
};
const setDiff = (want: string[], got: string[]) => ({ missing: want.filter((x) => !got.includes(x)), extra: got.filter((x) => !want.includes(x)) });

const RUN: Record<string, string> = {};
before(() => {
  db = createReplayDb('fetchv2match', { stopBefore: FIX_NAME });
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  const slugs = ['lerwick', 'scalloway', 'north-mainland', 'yell', 'unst', 'bressay', 'whalsay'];
  ok(db.raw(`
    insert into auth.users (id, email) select x, 'u' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id = '${ids.ADMIN}';
    insert into public.regions (slug, name, display_order) select s, initcap(replace(s, '-', ' ')), o from unnest(array[${slugs.map((s) => `'${s}'`).join(',')}]) with ordinality t(s, o);
    update public.regions set island_group = case when slug in ('yell','unst','bressay','whalsay') then slug else 'mainland' end;
    insert into public.delivery_pricing_config (price_per_mile_pence, min_fee_pence, road_correction_factor) values (65, 400, 1.40);
    insert into public.admin_config (key, value, category) values ('fees.fetch.fixed_pence', '150', 'fees'), ('fees.fetch.percent_bps', '0', 'fees')
      on conflict (key) do update set value = excluded.value;
    insert into public.delivery_categories (slug, name) values ('small-parcel', 'Small parcel'), ('furniture', 'Furniture');
    update public.admin_config set value = 'everyone' where key = 'fetch.v2.audience';`));
  for (const s of slugs) RG[s] = scalar(`select id from public.regions where slug = '${s}'`);
  for (const w of Object.keys(ids) as Id[]) assert.match(client(w, `public.fetch_v2_confirm_adult('fetch-18plus-v1')`), /"ok": true/);
  const drv: [Id, string, string, boolean, string[]][] = [
    ['D_VAN', 'van', 'bulky', true, []], ['D_UNST', 'van', 'large', false, []], ['D_MAIN', 'car', 'medium', false, []],
    ['D_REV', 'car', 'medium', false, []], ['D_SMALL', 'car', 'small', false, ['lerwick']], ['D_AREA', 'estate', 'large', false, ['north-mainland']],
    ['D_HINT', 'car', 'medium', false, []], ['D_SELF', 'van', 'large', false, []], ['D_EXP', 'van', 'large', false, []],
    ['D_SUSP', 'van', 'large', false, []], ['D_UNVER', 'van', 'large', false, []]];
  for (const [w, cls, max, two, areas] of drv) {
    ok(db.raw(`insert into public.driver_profiles (id, driver_status, vehicle_class, max_size_class, can_two_person_lift, vehicle_reg, areas,
                 stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled)
               values ('${ids[w]}', 'approved', '${cls}', '${max}', ${two}, 'ZE${w.length} ABC',
                 array[${areas.map((a) => `'${RG[a]}'::uuid`).join(',')}]::uuid[], 'acct_${w}', true, true)`));
    if (w !== 'D_UNVER') ok(db.raw(`insert into public.driver_verification_items (driver_id, kind, status, verified_by, verified_at, expires_at)
      select '${ids[w]}', k, 'verified', '${ids.ADMIN}', now(), case when k in ('licence', 'insurance') then now() + interval '200 days' end
        from unnest(array['identity_check', 'licence', 'vehicle', 'insurance']) k`));
  }
  // Runs are created through the real function while every driver is eligible; then two drivers lose eligibility.
  RUN.van = run('D_VAN', 'lerwick', 'yell');
  RUN.unst = run('D_UNST', 'lerwick', 'unst');
  RUN.main = run('D_MAIN', 'lerwick', 'brae');
  RUN.rev = run('D_REV', 'yell', 'lerwick');
  RUN.hint = run('D_HINT', 'brae', 'bressay');
  RUN.self = run('D_SELF', 'lerwick', 'yell');
  RUN.exp = run('D_EXP', 'lerwick', 'yell');
  RUN.susp = run('D_SUSP', 'lerwick', 'yell');
  ok(db.raw(`update public.driver_verification_items set expires_at = now() - interval '1 hour' where driver_id = '${ids.D_EXP}' and kind = 'insurance';
             update public.driver_profiles set driver_status = 'suspended' where id = '${ids.D_SUSP}';`));
  beforeRows = catalogueRows();
  ok(db.rawFile(FIX));
  afterRows = catalogueRows();
});
after(() => { db?.drop(); });

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · BOARD ELIGIBILITY — one definition with the claim', () => {
  test('a verified, approved driver gets the board', () => { assert.ok(Array.isArray(board('D_VAN'))); });
  test('expired, suspended, unverified drivers and non-drivers are refused, each with the claim gate\'s own reason', () => {
    for (const [w, code] of [['D_EXP', 'driver_verification_expired'], ['D_SUSP', 'driver_suspended'], ['D_UNVER', 'driver_verification_incomplete'],
      ['MEMBER', 'driver_not_approved'], ['REQ', 'driver_not_approved']] as [Id, string][])
      fails(asClient(w, 'select count(*) from public.fetch_v2_board(false)'), new RegExp(`can take Fetch jobs.*${code}`));
  });
  test('the board, the claim and recipient selection agree on who is eligible', () => {
    for (const w of ['D_EXP', 'D_SUSP', 'D_UNVER'] as Id[]) {
      const j = job('lerwick', 'yell');
      assert.notEqual(claim(w, j).ok, true, w);
      assert.ok(!select(j).some((s) => s.driver_id === ids[w]), w);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · CAPACITY', () => {
  let small = '', bulky = '', heavy = '';
  before(() => {
    small = job('lerwick', 'scalloway');
    bulky = job('lerwick', 'scalloway', { size_class: 'bulky', item_description: 'Three-seat sofa', category_slug: 'furniture', approx_dimensions_cm: { l: 200, w: 90, h: 80 } });
    heavy = job('lerwick', 'scalloway', { size_class: 'medium', handling_flags: ['heavy_two_person'], item_description: 'Washing machine' });
  });
  test('a small-capacity driver sees the small job, not the sofa or the two-person lift', () => {
    const b = board('D_SMALL');
    assert.equal(on(b, small)?.can_claim, true);
    assert.equal(on(b, bulky), undefined);
    assert.equal(on(b, heavy), undefined);
  });
  test('a bulky-capable van with two people sees both', () => {
    const b = board('D_VAN');
    assert.equal(on(b, bulky)?.can_claim, true);
    assert.equal(on(b, heavy)?.can_claim, true);
  });
  test('"show all" lists them as beyond the vehicle, and the claim still refuses', () => {
    const b = board('D_SMALL', true);
    assert.equal(`${on(b, bulky)?.match}:${on(b, bulky)?.can_claim}`, 'beyond_vehicle:false');
    assert.match(String(on(b, heavy)?.match_summary), /Too large for your vehicle/);
    assert.match(String(on(board('D_MAIN', true), heavy)?.match_summary), /Needs a two-person lift/, 'a medium car without a second person');
    assert.equal(claim('D_SMALL', bulky).code, 'too_large_for_vehicle');
    assert.equal(claim('D_MAIN', heavy).code, 'two_person_lift_required', 'the claim now uses the same capacity rule');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · RUN MATCH: direction, endpoints, timing, state', () => {
  test('same direction fits; the reverse does not (unless a journey goes that way)', () => {
    const out = job('lerwick', 'yell'), back = job('yell', 'lerwick');
    assert.equal(fit(RUN.van, out), 'run_match');
    assert.equal(fit(RUN.van, back), 'wrong_direction');
    assert.equal(fit(RUN.rev, back), 'run_match');
    assert.equal(on(board('D_VAN'), back)?.match === 'your_run', false);
  });
  test('one end must be the journey\'s own end (section I): Scalloway → Brae does not fit Lerwick → Yell', () => {
    assert.equal(fit(RUN.van, job('scalloway', 'brae')), 'region_mismatch');
    assert.equal(fit(RUN.van, job('scalloway', 'yell')), 'run_match');
  });
  test('timing: a job due before the journey sets off is not a run match; a flexible one is', () => {
    const due = job('lerwick', 'yell', { scheduling_mode: 'by', needed_by: new Date(Date.now() + 2 * 3600_000).toISOString() });
    assert.equal(fit(RUN.van, due), 'timing_mismatch');
    assert.notEqual(on(board('D_VAN'), due)?.match, 'your_run');
    const flex = job('lerwick', 'yell');
    assert.equal(on(board('D_VAN'), flex)?.match, 'your_run');
    assert.ok(on(board('D_VAN'), flex)!.match_reasons.includes('flexible_timing'));
  });
  test('categories: a journey that only takes furniture does not fit a parcel', () => {
    const r = run('D_AREA', 'brae', 'lerwick', { categories: ['furniture'] });
    assert.equal(fit(r, job('brae', 'lerwick')), 'category_mismatch');
  });
  test('an expired or cancelled journey stops matching at once', () => {
    const r = run('D_AREA', 'brae', 'yell');
    const j = job('brae', 'yell');
    assert.equal(fit(r, j), 'run_match');
    ok(db.raw(`update public.runs set departure_start = now() - interval '5 hours', departure_end = now() - interval '1 hour' where id = '${r}'`));
    assert.equal(fit(r, j), 'run_closed');
    const r2 = run('D_AREA', 'brae', 'yell');
    assert.equal(fit(r2, j), 'run_match');
    assert.match(client('D_AREA', `public.fetch_v2_cancel_run('${r2}')`), /"ok": true/);
    assert.equal(fit(r2, j), 'run_closed');
  });
  test('only open, unclaimed jobs are on the board', () => {
    const j = job('lerwick', 'yell');
    assert.ok(on(board('D_UNST'), j));
    assert.equal(claim('D_VAN', j).ok, true);
    assert.equal(on(board('D_UNST'), j), undefined);
    const gone = job('lerwick', 'yell');
    ok(db.raw(`update public.delivery_requests set expires_at = now() - interval '1 minute' where id = '${gone}'`));
    assert.equal(on(board('D_UNST'), gone), undefined);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · FERRY / ISLANDS — routes, not distance', () => {
  test('Mainland → Yell journey: Mainland → Yell jobs fit', () => { assert.equal(fit(RUN.van, job('lerwick', 'yell')), 'run_match'); });
  test('Mainland → Unst journey also carries Mainland → Yell (Yell is on the way), but a Yell journey does not reach Unst', () => {
    assert.equal(fit(RUN.unst, job('lerwick', 'yell')), 'run_match');
    assert.equal(fit(RUN.unst, job('brae', 'unst')), 'run_match');
    assert.equal(fit(RUN.van, job('lerwick', 'unst')), 'off_route');
  });
  test('a Mainland-only journey never fits Whalsay or Bressay, however close across the water', () => {
    assert.equal(fit(RUN.main, job('lerwick', 'whalsay')), 'off_route');
    assert.equal(fit(RUN.main, job('lerwick', 'bressay')), 'off_route');
    assert.equal(fit(RUN.main, job('lerwick', 'brae')), 'run_match');
  });
  test('the island route is the ferry tree', () => {
    assert.equal(scalar(`select array_to_string(public.fetch_v2_island_route('unst', 'whalsay'), '>')`), 'unst>yell>mainland>whalsay');
    assert.equal(scalar(`select array_to_string(public.fetch_v2_island_route('fetlar', 'unst'), '>')`), 'fetlar>yell>unst');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · RANKING and REASONS', () => {
  test('your journey, then your area, then the rest; by deadline; then newest; the same every time', () => {
    const area = job('lerwick', 'scalloway');                                                       // D_SMALL's area, no journey
    const runJob = job('lerwick', 'yell', { scheduling_mode: 'flexible', flexible_until: new Date(Date.now() + 5 * 86400_000).toISOString() });
    const soon = job('scalloway', 'brae', { scheduling_mode: 'by', needed_by: new Date(Date.now() + 3 * 3600_000).toISOString() });
    const needed = new Date(Date.now() + 6 * 3600_000).toISOString();
    const older = job('scalloway', 'brae', { scheduling_mode: 'by', needed_by: needed });
    const newer = job('scalloway', 'brae', { scheduling_mode: 'by', needed_by: needed });
    const b = board('D_VAN').map((r) => r.request_id);
    const pos = (id: string) => b.indexOf(id);
    assert.ok(pos(runJob) < pos(soon), 'a journey match ranks above an earlier deadline');
    assert.ok(pos(soon) < pos(newer) && pos(newer) < pos(older), 'deadline first, then newest');
    assert.deepEqual(board('D_VAN').map((r) => r.request_id), b, 'deterministic');
    const s = board('D_SMALL').map((r) => r.request_id);
    assert.ok(s.indexOf(area) < s.indexOf(soon), 'your area above the rest');
  });
  test('reasons are codes and plain English — no scores', () => {
    const j = job('lerwick', 'yell');
    const r = on(board('D_VAN'), j)!;
    assert.deepEqual(r.match_reasons, ['fits_your_run', 'fits_your_vehicle', 'flexible_timing']);
    assert.equal(r.match_summary, 'Fits your Lerwick → Yell journey · Fits your vehicle · Flexible timing');
    assert.equal(r.fits_run_id, RUN.van);
    assert.ok(!Object.keys(r).some((k) => /score|tier|rank/.test(k)));
    const today = job('lerwick', 'yell', { scheduling_mode: 'asap' });
    assert.ok(on(board('D_VAN'), today)!.match_reasons.includes('needed_today') || on(board('D_VAN'), today)!.match_reasons.includes('as_soon_as_possible'));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('6 · REQUESTER HINT', () => {
  test('a safe hint when an eligible driver\'s journey fits — a day, never a driver; gone when the journey is cancelled', () => {
    const j = job('brae', 'bressay');
    const h = JSON.parse(hint('REQ', j));
    assert.equal(h.heading_that_way, true);
    assert.match(h.hint, /^A Fetch driver may be heading that way (today|tomorrow|on \w+)\. This isn't a booking: a driver still needs to accept your request\.$/);
    const text = JSON.stringify(h);
    for (const s of [...Object.values(ids), RUN.hint, 'ZE', 'acct_', 'Fixture', 'car', 'medium', ':00']) assert.ok(!text.includes(s), `leaked ${s}: ${text}`);
    assert.deepEqual(Object.keys(h).sort(), ['heading_that_way', 'hint', 'ok', 'on']);
    assert.match(client('D_HINT', `public.fetch_v2_cancel_run('${RUN.hint}')`), /"ok": true/);
    assert.equal(JSON.parse(hint('REQ', j)).heading_that_way, false);
  });
  test('an ineligible driver\'s journey never produces a hint; only the requester can ask', () => {
    const j = job('lerwick', 'yell', { size_class: 'large', item_description: 'Bed frame', approx_dimensions_cm: { l: 190, w: 100, h: 30 } });
    ok(db.raw(`update public.runs set status = 'cancelled' where id in ('${RUN.van}', '${RUN.unst}', '${RUN.self}')`));
    assert.equal(JSON.parse(hint('REQ', j)).heading_that_way, false, 'D_EXP and D_SUSP have matching journeys but cannot take jobs');
    ok(db.raw(`update public.runs set status = 'open' where id in ('${RUN.van}', '${RUN.unst}', '${RUN.self}')`));
    assert.equal(JSON.parse(hint('REQ', j)).heading_that_way, true);
    fails(asClient('MEMBER', `select public.fetch_v2_heading_that_way('${j}')`), /not found/);
    fails(db.raw(`begin; set local role anon; select public.fetch_v2_heading_that_way('${j}'); commit;`), /permission denied/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('7 · NOTIFICATION RECIPIENTS (chosen once; nothing sent)', () => {
  test('journey matches first, then areas; capacity, verification and the requester enforced; no broad blast when someone fits', () => {
    const j = job('lerwick', 'yell', { size_class: 'medium', item_description: 'Two boxes' }, 'D_SELF');
    const got = select(j);
    assert.deepEqual(got.map((g) => `${nameOf(g.driver_id)}:${g.tier}`),
      ['D_VAN:run', 'D_UNST:run'], JSON.stringify(got.map((g) => nameOf(g.driver_id))));
    for (const w of ['D_SELF', 'D_EXP', 'D_SUSP', 'D_UNVER', 'D_SMALL']) assert.ok(!got.some((g) => g.driver_id === ids[w as Id]), w);
    assert.ok(!got.some((g) => g.tier === 'broad'));
  });
  test('an area driver is chosen when they can carry it', () => {
    const j = job('lerwick', 'scalloway');
    const got = select(j);
    assert.ok(got.some((g) => g.driver_id === ids.D_SMALL && g.tier === 'area'), JSON.stringify(got));
  });
  test('at most once: a rerun, or a retry, chooses nobody again', () => {
    const j = job('lerwick', 'yell');
    const first = select(j).length;
    assert.ok(first > 0);
    assert.deepEqual(select(j), []);
    assert.deepEqual(select(j), []);
    assert.equal(scalar(`select count(*) from public.fetch_match_notifications where request_id = '${j}'`), String(first));
  });
  test('a new journey later adds only the newly fitting driver', () => {
    const j = job('lerwick', 'unst', { size_class: 'medium', item_description: 'Two boxes' });
    const first = select(j).map((g) => nameOf(g.driver_id));
    assert.ok(first.includes('D_UNST') && !first.includes('D_AREA'), first.join());
    run('D_AREA', 'lerwick', 'unst');
    assert.deepEqual(select(j).map((g) => `${nameOf(g.driver_id)}:${g.tier}`), ['D_AREA:run']);
  });
  test('broad fallback only when nobody fits, capped, in a fixed order', () => {
    ok(db.raw(`update public.admin_config set value = '2' where key = 'fetch.matching.broad_max'`));
    const j = job('scalloway', 'scalloway');
    const got = select(j);
    assert.equal(got.length, 2);
    assert.ok(got.every((g) => g.tier === 'broad'));
    assert.deepEqual(got.map((g) => g.driver_id), [...got.map((g) => g.driver_id)].sort());
    ok(db.raw(`update public.admin_config set value = '15' where key = 'fetch.matching.broad_max'`));
  });
  test('a job back on the board is a different notice, and never goes to the driver who held it', () => {
    const j = job('lerwick', 'yell');
    select(j);
    assert.equal(claim('D_VAN', j).ok, true);
    assert.deepEqual(select(j), [], 'a claimed job chooses nobody');
    assert.match(svc(`public.fetch_v2_release('${ids.D_VAN}', '${j}', 'changed_plans')`), /"status": "pending"/);
    const again = select(j, 'back_on_board');
    assert.ok(again.length > 0 && !again.some((g) => g.driver_id === ids.D_VAN), JSON.stringify(again));
  });
  test('the record is service-only', () => {
    fails(asClient('ADMIN', 'select count(*) from public.fetch_match_notifications'), /permission denied/);
    fails(asClient('D_VAN', `select * from public.fetch_v2_select_recipients('${randomUUID()}', 'new_request')`), /permission denied/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('8 · PRIVACY', () => {
  test('the board carries no address, phone, pickup name, notes or requester identity', () => {
    const text = JSON.stringify(board('D_VAN', true));
    for (const s of ['Hillhead', 'Westerloch', 'Main Street', '07700', 'Mrs Isbister', ids.REQ, ids.D_SELF, 'customer_id', 'contact_phone', 'lat', 'lng'])
      assert.ok(!text.includes(s), `board leaked ${s}`);
  });
  test('public journeys: no driver, run id, registration or exact time; only eligible drivers\' journeys; coarse order', () => {
    const o = db.raw(`begin; set local role anon; select coalesce(jsonb_agg(p), '[]'::jsonb) from public.fetch_public_runs() p; commit;`);
    ok(o);
    const rows = JSON.parse(lastRow(o)) as Record<string, unknown>[];
    const text = JSON.stringify(rows);
    for (const s of [...Object.values(ids), ...Object.values(RUN), 'ZE', 'acct_', 'T09:', 'driver']) assert.ok(!text.includes(s), `public leaked ${s}`);
    assert.ok(rows.length > 0);
    assert.equal(rows.filter((r) => r.origin_region === 'Lerwick' && r.destination_region === 'Yell').length, 2, 'D_VAN and D_SELF, not D_EXP or D_SUSP');
    assert.deepEqual(Object.keys(rows[0]).sort(), ['categories', 'crosses_water', 'departure_date', 'destination_island_group', 'destination_region',
      'max_size_class', 'origin_island_group', 'origin_region', 'part_of_day', 'run_key']);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('9 · ADMIN DIAGNOSTICS', () => {
  test('why a driver did or did not see / hear about a request — codes only', () => {
    const j = job('yell', 'lerwick');
    const d = (w: Id) => JSON.parse(client('ADMIN', `public.fetch_v2_match_diagnostics('${j}', '${ids[w]}')`));
    const van = d('D_VAN');
    assert.equal(`${van.job}:${van.driver}:${van.capacity}:${van.board_match}`, 'job_open:eligible:fits:other');
    assert.equal(van.runs.find((r: { run_id: string }) => r.run_id === RUN.van).result, 'wrong_direction');
    assert.equal(d('D_REV').board_match, 'your_run');
    assert.equal(d('D_EXP').driver, 'driver_verification_expired');
    const big = job('lerwick', 'yell', { size_class: 'large', item_description: 'Bed frame', approx_dimensions_cm: { l: 190, w: 100, h: 30 } });
    assert.equal(JSON.parse(client('ADMIN', `public.fetch_v2_match_diagnostics('${big}', '${ids.D_SMALL}')`)).capacity, 'too_large_for_vehicle');
    const text = JSON.stringify(van);
    for (const s of [ids.REQ, 'Hillhead', '07700', 'Mrs Isbister']) assert.ok(!text.includes(s), `diagnostics leaked ${s}`);
    fails(asClient('D_VAN', `select public.fetch_v2_match_diagnostics('${j}', '${ids.D_VAN}')`), /Only an administrator/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('10 · rollback', () => {
  test('refuses while recipient records exist', () => {
    fails(db.rawFile(DOWN), /refusing to roll back matching/);
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
  test('otherwise restores the catalogue exactly (functions, grants, indexes, policies); re-applies', () => {
    ok(db.raw('delete from public.fetch_match_notifications'));
    ok(db.rawFile(DOWN));
    assert.deepEqual(setDiff(beforeRows, catalogueRows()), { missing: [], extra: [] });
    ok(db.rawFile(FIX));
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
});
