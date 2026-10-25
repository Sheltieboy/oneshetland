/**
 * fetch-v2-notifications.node.test.ts — Fetch v2 Step 8: the notification outbox (migration 20261205000000 +
 * supabase/functions/_shared/fetch-v2-notify.ts), against the real SQL and the real Notification Centre table (notification_log).
 *
 * Events come from the real Step 3–7 functions where that is practical (create → matching selection, claim, release, cancellation,
 * Stripe state applied through Step 5's single entry point); the rest are inserted as the authoritative event rows those functions
 * write. Push goes to a fake gateway that records every send. Nothing leaves the machine.
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users; fake push; no network.
 * Run: ISOLATED_ONLY=fetch-v2-notifications npm run test:isolated
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';
import { drainNotifications, type PushAttempt, type PushGateway, type PushMessage } from '../functions/_shared/fetch-v2-notify.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX_NAME = '20261205000000_fetch_v2_notifications.sql';
const FIX = join(REPO_ROOT, 'supabase/migrations', FIX_NAME);
const DOWN = join(REPO_ROOT, 'supabase/rollbacks/20261205000000_fetch_v2_notifications.down.sql');

let db: ReplayDb;
const tag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !tag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^NOTICE|^WARNING/.test(l));
const lastRow = (o: string) => rowsOf(o).pop() ?? '';
const scalar = (sql: string) => lastRow(db.raw(sql));
const ok = (o: string) => assert.doesNotMatch(o, /ERROR/, o);
const fails = (o: string, re: RegExp = /ERROR/) => assert.match(o, re, o);

const ids = {
  ADMIN: 'ad000000-0000-4000-8000-0000000000ad',
  REQ: 'a1000000-0000-4000-8000-000000000001',
  REQ2: 'a2000000-0000-4000-8000-000000000002',
  D_VAN: 'd1000000-0000-4000-8000-000000000001',   // journey Lerwick → Yell
  D_UNST: 'd2000000-0000-4000-8000-000000000002',  // journey Lerwick → Unst
  D_SMALL: 'd5000000-0000-4000-8000-000000000005', // area Lerwick, small only
  D_AREA: 'd6000000-0000-4000-8000-000000000006',  // area North Mainland, large
  D_SELF: 'd8000000-0000-4000-8000-000000000008',  // eligible driver who also asks; journey Lerwick → Yell
  D_EXP: 'd9000000-0000-4000-8000-000000000009',   // approved, insurance expired; journey Lerwick → Yell
  D_ANDROID: 'dc000000-0000-4000-8000-00000000000c', // area Scalloway, an Android device without push credentials
  D_BROAD1: 'dd000000-0000-4000-8000-00000000000d',
  D_BROAD2: 'de000000-0000-4000-8000-00000000000e',
} as const;
type Id = keyof typeof ids;
const nameOf = (u: string) => (Object.keys(ids) as Id[]).find((k) => ids[k] === u) ?? u;
const lit = (v: unknown) => (v === null || v === undefined ? 'null' : typeof v === 'object' ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`
  : typeof v === 'boolean' || typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const asClient = (w: Id, stmt: string) => db.raw(`begin; set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated; ${stmt}; commit;`);
const client = (w: Id, call: string) => lastRow(asClient(w, `select ${call}`));
const svc = (call: string) => lastRow(db.raw(`begin; set local role service_role; select ${call}; commit;`));
const SETOF = new Set(['fetch_v2_claim_notifications', 'fetch_v2_select_recipients', 'fetch_v2_claim_authorisation']);
const rpc = async (fn: string, args: Record<string, unknown>) => {
  const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
  const sql = SETOF.has(fn) ? `coalesce(jsonb_agg(t), '[]'::jsonb) from public.${fn}(${named}) t` : `to_json(public.${fn}(${named}))`;
  const o = db.raw(`begin; set local role service_role; select ${sql}; commit;`);
  if (/ERROR/.test(o)) return { data: null, error: { message: o } };
  return { data: JSON.parse(lastRow(o)), error: null };
};

// ── fake push ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Mode = 'ok' | 'dnr' | 'retry' | 'unavailable' | 'rejected';
class FakePush implements PushGateway {
  devices = new Map<string, { token: string; mode: Mode }[]>();
  sent: { user: string; token: string; m: PushMessage }[] = [];
  pruned: string[] = [];
  device(w: Id, mode: Mode = 'ok') { const t = `ExponentPushToken[${w}-${randomUUID().slice(0, 4)}]`; this.devices.set(ids[w], [...(this.devices.get(ids[w]) ?? []), { token: t, mode }]); return t; }
  async tokens(userId: string) { return (this.devices.get(userId) ?? []).map((d) => d.token); }
  async send(token: string, m: PushMessage): Promise<PushAttempt> {
    const [user, d] = [...this.devices.entries()].flatMap(([u, ds]) => ds.map((x) => [u, x] as const)).find(([, x]) => x.token === token)!;
    if (d.mode === 'ok') { this.sent.push({ user, token, m }); return { ok: true }; }
    return { ok: false, reason: d.mode === 'dnr' ? 'device_not_registered' : d.mode === 'retry' ? 'retryable' : d.mode, error: `fake_${d.mode}` };
  }
  async prune(userId: string, token: string) { this.pruned.push(token); this.devices.set(userId, (this.devices.get(userId) ?? []).filter((d) => d.token !== token)); }
}
let push = new FakePush();
const drain = () => drainNotifications({ rpc, push });

// ── places, jobs, runs ──────────────────────────────────────────────────────────────────────────────────────────────────────
const RG: Record<string, string> = {};
const PLACE: Record<string, { region: string; lat: number; lng: number; addr: string }> = {
  lerwick: { region: 'lerwick', lat: 60.155, lng: -1.145, addr: '12 Hillhead, Lerwick' },
  scalloway: { region: 'scalloway', lat: 60.137, lng: -1.276, addr: '3 Main Street, Scalloway' },
  brae: { region: 'north-mainland', lat: 60.396, lng: -1.353, addr: '7 Westerloch, Brae' },
  yell: { region: 'yell', lat: 60.600, lng: -1.060, addr: 'Mid Yell' },
};
function job(from: string, to: string, who: Id = 'REQ', o: Record<string, unknown> = {}): string {
  const a = PLACE[from], b = PLACE[to];
  const p = { idempotency_key: `k-${randomUUID()}`, category_slug: 'small-parcel', item_description: 'Granny\'s silver teapot', size_class: 'small',
    pickup_region_id: RG[a.region], pickup_name: 'Mrs Isbister', pickup_location: a.addr, pickup_lat: a.lat, pickup_lng: a.lng,
    pickup_notes: 'Key under the blue pot', destination_region_id: RG[b.region], destination_address: b.addr, dest_lat: b.lat, dest_lng: b.lng,
    delivery_notes: 'Ring twice', contact_phone: '07700 900123', scheduling_mode: 'flexible',
    flexible_until: new Date(Date.now() + 3 * 86400_000).toISOString(), ...o };
  const out = JSON.parse(svc(`public.fetch_v2_create_request('${ids[who]}', ${lit(p)})`));
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.request_id;
}
const tomorrow = (h: number) => { const d = new Date(Date.now() + 86400_000); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
function run(w: Id, from: string, to: string) {
  const s = tomorrow(9), e = tomorrow(13);
  const out = JSON.parse(client(w, `public.fetch_v2_create_run('${RG[PLACE[from].region]}', '${RG[PLACE[to].region]}', '${s}', '${e}', '{}'::text[], null)`));
  assert.equal(out.ok, true, `${w}: ${JSON.stringify(out)}`);
}
type Notice = { id: number; kind: string; recipient_id: string; audience: string; time_critical: boolean; state: string; push_result: string | null;
  inbox_status: string | null; title: string; body: string; data: Record<string, unknown>; attempts: number; inbox_id: string | null };
const notices = (where: string): Notice[] => JSON.parse(scalar(`select coalesce(jsonb_agg(n order by n.id), '[]'::jsonb) from public.fetch_notifications n where ${where}`));
const forJob = (j: string) => notices(`request_id = '${j}'`);
const inbox = (id: string | null) => JSON.parse(scalar(`select coalesce(to_jsonb(l), 'null'::jsonb) from public.notification_log l where id = '${id}'`));
const event = (j: string, ev: string, o: { role?: string; from?: string; to?: string; meta?: Record<string, unknown> } = {}) =>
  ok(db.raw(`insert into public.fetch_request_events (request_id, actor_id, actor_role, event, from_status, to_status, metadata)
             values ('${j}', ${o.role && o.role !== 'system' ? `'${ids.D_VAN}'` : 'null'}, '${o.role ?? 'system'}', '${ev}', ${lit(o.from ?? null)},
                     ${lit(o.to ?? null)}, ${lit(o.meta ?? {})})`));
const prefs = (w: Id, p: { enabled?: boolean; fetch?: boolean; quiet?: boolean }) => ok(db.raw(`
  insert into public.notification_preferences (user_id, enabled, fetch_enabled, quiet_hours_start, quiet_hours_end)
  values ('${ids[w]}', ${p.enabled ?? true}, ${p.fetch ?? true},
          ${p.quiet ? `((now() at time zone 'Europe/London') - interval '1 hour')::time` : 'null'},
          ${p.quiet ? `((now() at time zone 'Europe/London') + interval '1 hour')::time` : 'null'})
  on conflict (user_id) do update set enabled = excluded.enabled, fetch_enabled = excluded.fetch_enabled,
    quiet_hours_start = excluded.quiet_hours_start, quiet_hours_end = excluded.quiet_hours_end`));
const clearPrefs = () => ok(db.raw('delete from public.notification_preferences'));

// ── catalogue ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
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

before(() => {
  db = createReplayDb('fetchv2notify', { stopBefore: FIX_NAME });
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  const slugs = ['lerwick', 'scalloway', 'north-mainland', 'yell'];
  ok(db.raw(`
    insert into auth.users (id, email) select x, 'u' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id = '${ids.ADMIN}';
    insert into public.regions (slug, name, display_order) select s, initcap(replace(s, '-', ' ')), o from unnest(array[${slugs.map((s) => `'${s}'`).join(',')}]) with ordinality t(s, o);
    update public.regions set island_group = case when slug = 'yell' then 'yell' else 'mainland' end;
    insert into public.delivery_pricing_config (price_per_mile_pence, min_fee_pence, road_correction_factor) values (65, 400, 1.40);
    insert into public.admin_config (key, value, category) values ('fees.fetch.fixed_pence', '150', 'fees'), ('fees.fetch.percent_bps', '0', 'fees')
      on conflict (key) do update set value = excluded.value;
    insert into public.delivery_categories (slug, name) values ('small-parcel', 'Small parcel');
    update public.admin_config set value = 'everyone' where key = 'fetch.v2.audience';`));
  for (const s of slugs) RG[s] = scalar(`select id from public.regions where slug = '${s}'`);
  for (const w of Object.keys(ids) as Id[]) assert.match(client(w, `public.fetch_v2_confirm_adult('fetch-18plus-v1')`), /"ok": true/);
  const drv: [Id, string, string, string[]][] = [['D_VAN', 'van', 'bulky', []], ['D_UNST', 'van', 'large', []], ['D_SMALL', 'car', 'small', ['lerwick']],
    ['D_AREA', 'estate', 'large', ['north-mainland']], ['D_SELF', 'van', 'large', []], ['D_EXP', 'van', 'large', []], ['D_ANDROID', 'car', 'medium', ['scalloway']],
    ['D_BROAD1', 'car', 'medium', []], ['D_BROAD2', 'car', 'medium', []]];
  for (const [w, cls, max, areas] of drv) {
    ok(db.raw(`insert into public.driver_profiles (id, driver_status, vehicle_class, max_size_class, vehicle_reg, areas, stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled)
               values ('${ids[w]}', 'approved', '${cls}', '${max}', 'ZE1 ${w}', array[${areas.map((a) => `'${RG[a]}'::uuid`).join(',')}]::uuid[], 'acct_${w}', true, true);
               insert into public.driver_verification_items (driver_id, kind, status, verified_by, verified_at, expires_at)
               select '${ids[w]}', k, 'verified', '${ids.ADMIN}', now(), case when k in ('licence', 'insurance') then now() + interval '200 days' end
                 from unnest(array['identity_check', 'licence', 'vehicle', 'insurance']) k;`));
  }
  run('D_VAN', 'lerwick', 'yell'); run('D_UNST', 'lerwick', 'yell'); run('D_SELF', 'lerwick', 'yell'); run('D_EXP', 'lerwick', 'yell');
  ok(db.raw(`update public.driver_verification_items set expires_at = now() - interval '1 hour' where driver_id = '${ids.D_EXP}' and kind = 'insurance'`));
  beforeRows = catalogueRows();
  ok(db.rawFile(FIX));
  afterRows = catalogueRows();
  // The fatigue caps are tested on their own; elsewhere they are lifted so earlier tests cannot spend a later test's allowance.
  ok(db.raw(`update public.admin_config set value = '1000' where key in ('fetch.notify.opportunity_hourly_max', 'fetch.notify.opportunity_daily_max')`));
});
after(() => { db?.drop(); });
beforeEach(() => { push = new FakePush(); for (const w of Object.keys(ids) as Id[]) push.device(w); push.devices.delete(ids.D_ANDROID); push.device('D_ANDROID', 'unavailable'); clearPrefs(); });

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · MATCHING → OUTBOX (created automatically when a job is posted)', () => {
  test('journey drivers get "fits your journey", area drivers "in your area"; never the requester or an ineligible driver', () => {
    const j = job('lerwick', 'yell', 'D_SELF', { size_class: 'medium', item_description: 'Two boxes' });
    const got = forJob(j).filter((n) => n.audience === 'opportunity');
    assert.deepEqual(got.map((n) => `${nameOf(n.recipient_id)}:${n.kind}`).sort(), ['D_UNST:new_request_run', 'D_VAN:new_request_run']);
    assert.match(got[0].title, /^A Fetch fits your \w+ journey$/);
    assert.ok(!got.some((n) => [ids.D_SELF, ids.D_EXP, ids.D_SMALL].includes(n.recipient_id as never)), 'requester, lapsed and too-small excluded');
    const area = job('scalloway', 'brae');   // no journey fits either end (section I); two drivers cover those areas
    assert.deepEqual(forJob(area).filter((n) => n.audience === 'opportunity').map((n) => `${nameOf(n.recipient_id)}:${n.kind}`).sort(),
      ['D_ANDROID:new_request_area', 'D_AREA:new_request_area']);
  });
  test('broad fallback is capped (Step 7) and nobody is told twice about the same job', () => {
    ok(db.raw(`update public.admin_config set value = '2' where key = 'fetch.matching.broad_max'`));
    const j = job('brae', 'brae', 'REQ2', { size_class: 'large', item_description: 'Bed', approx_dimensions_cm: { l: 190, w: 100, h: 30 } });
    ok(db.raw(`update public.admin_config set value = '15' where key = 'fetch.matching.broad_max'`));
    const got = forJob(j).filter((n) => n.audience === 'opportunity');
    assert.ok(got.some((n) => n.recipient_id === ids.D_AREA && n.kind === 'new_request_area'));
    assert.ok(!got.some((n) => n.kind === 'new_request_broad'), 'an area match means no broad fallback');
    const lonely = job('scalloway', 'brae', 'REQ2', { size_class: 'medium', item_description: 'Two boxes' });
    void lonely;
    assert.equal(svc(`count(*) from public.fetch_v2_select_recipients('${j}', 'new_request')`), '0');
    assert.equal(scalar(`select count(*) from public.fetch_notifications where request_id = '${j}' and audience = 'opportunity'`), String(got.length));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · OUTBOX: once per logical notice', () => {
  test('the same key twice is one row; a different event or a different recipient is another', () => {
    const j = job('scalloway', 'brae');
    const q = (key: string, who: Id, kind: string) => svc(`public.fetch_v2_enqueue_notice('${key}', '${ids[who]}', '${j}', '${kind}', 'request_event', '1')`);
    assert.equal(q('test:dup:1', 'REQ', 'collected'), 't');
    assert.equal(q('test:dup:1', 'REQ', 'collected'), 'f');
    assert.equal(q('test:dup:2', 'REQ', 'delivered'), 't');
    assert.equal(q('test:dup:1b', 'REQ2', 'collected'), 't');
    assert.equal(scalar(`select count(*) from public.fetch_notifications where dedupe_key like 'test:dup:%'`), '3');
  });
  test('a replayed event cannot repeat a payment prompt in the same hold generation', () => {
    const j = job('scalloway', 'brae');
    event(j, 'payment_requires_action', { meta: { generation: 1 } });
    event(j, 'payment_requires_payment_method', { meta: { generation: 1 } });
    event(j, 'payment_requires_action', { meta: { generation: 2 } });
    assert.equal(forJob(j).filter((n) => n.kind === 'payment_action_needed').length, 2);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · NOTIFICATION CENTRE FIRST, then push', () => {
  test('every eligible notice gets exactly one inbox row; a pushed one becomes "sent" (accepted, not delivered)', async () => {
    const j = job('lerwick', 'yell');
    const before = Number(scalar('select count(*) from public.notification_log'));
    await drain(); await drain(); await drain();
    const ns = forJob(j);
    assert.ok(ns.length > 0 && ns.every((n) => n.state === 'completed' && n.inbox_id));
    assert.equal(Number(scalar('select count(*) from public.notification_log')) - before,
      Number(scalar(`select count(*) from public.fetch_notifications where inbox_id is not null and inbox_at > now() - interval '1 minute' and request_id = '${j}'`)) +
      Number(scalar(`select count(*) from public.fetch_notifications where inbox_id is not null and inbox_at > now() - interval '1 minute' and request_id <> '${j}'`)) +
      Number(scalar(`select count(*) from public.fetch_notifications where inbox_id is not null and inbox_at > now() - interval '1 minute' and request_id is null`)));
    const n = ns.find((x) => x.recipient_id === ids.D_VAN)!;
    assert.equal(`${n.push_result}:${inbox(n.inbox_id).status}`, 'accepted:sent');
    assert.equal(push.sent.filter((s) => s.user === ids.D_VAN && s.m.data.request_id === j).length, 1, 'one push across three drains');
  });
  test('a failed push never removes the inbox row; retryable failures are retried a bounded number of times', async () => {
    push.devices.set(ids.REQ, []); push.device('REQ', 'retry');
    const j = job('scalloway', 'brae');
    event(j, 'collected', { role: 'driver', from: 'matched', to: 'collected' });
    await drain();
    let n = forJob(j).find((x) => x.kind === 'collected')!;
    assert.equal(`${n.state}:${n.attempts}:${inbox(n.inbox_id).status}`, 'inbox_created:1:no_token', 'visible in the inbox while push is retried');
    for (let i = 0; i < 5; i++) { ok(db.raw(`update public.fetch_notifications set push_due_at = now() - interval '1 second' where id = ${n.id}`)); await drain(); }
    n = forJob(j).find((x) => x.kind === 'collected')!;
    assert.equal(`${n.state}:${n.push_result}:${n.attempts}`, 'completed:provider_error:4');
    assert.equal(`${inbox(n.inbox_id).status}:${inbox(n.inbox_id).error}`, 'no_token:provider_error');
  });
  test('no device: inbox only; a dead device is pruned; Android without push: inbox only — none of it fails the event', async () => {
    push.devices.set(ids.REQ, []);
    const j = job('lerwick', 'scalloway');
    event(j, 'delivered', { role: 'driver', from: 'collected', to: 'delivered' });
    push.devices.set(ids.D_SMALL, []); const dead = push.device('D_SMALL', 'dnr');
    await drain();
    const ns = forJob(j);
    assert.equal(ns.find((x) => x.kind === 'delivered')!.push_result, 'no_token');
    assert.equal(ns.find((x) => x.recipient_id === ids.D_SMALL)!.push_result, 'invalid_token');
    assert.deepEqual(push.pruned, [dead]);
    const android = ns.find((x) => x.recipient_id === ids.D_ANDROID)!;
    assert.equal(`${android.push_result}:${inbox(android.inbox_id).status}`, 'push_unavailable:no_token');
    for (const x of ns) assert.ok(['sent', 'no_token', 'skipped_quiet'].includes(inbox(x.inbox_id).status), 'visible in every client\'s inbox');
  });
  test('one member\'s failure does not stop another\'s', async () => {
    push.devices.set(ids.D_VAN, []); push.device('D_VAN', 'rejected');
    const j = job('lerwick', 'yell');
    await drain();
    const ns = forJob(j);
    assert.equal(ns.find((x) => x.recipient_id === ids.D_VAN)!.push_result, 'provider_error');
    assert.equal(ns.find((x) => x.recipient_id === ids.D_UNST)!.push_result, 'accepted');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · PREFERENCES and QUIET HOURS', () => {
  test('Fetch muted: an opportunity is a hidden opt-out; an activity notice stays in the inbox without a push', async () => {
    prefs('D_VAN', { fetch: false }); prefs('REQ', { fetch: false });
    const j = job('lerwick', 'yell');
    event(j, 'collected', { role: 'driver', from: 'matched', to: 'collected' });
    await drain();
    const opp = forJob(j).find((x) => x.recipient_id === ids.D_VAN)!;
    assert.equal(`${opp.push_result}:${inbox(opp.inbox_id).status}`, 'opted_out:skipped_pref');
    const act = forJob(j).find((x) => x.kind === 'collected')!;
    assert.equal(`${act.push_result}:${inbox(act.inbox_id).status}:${inbox(act.inbox_id).error}`, 'opted_out:no_token:push_off');
    assert.ok(!push.sent.some((s) => s.user === ids.D_VAN || s.user === ids.REQ));
  });
  test('all notifications off: no push at all, even time-critical; the activity inbox row remains', async () => {
    prefs('REQ', { enabled: false });
    const j = job('scalloway', 'brae');
    event(j, 'payment_requires_action', { meta: { generation: 1 } });
    await drain();
    const n = forJob(j).find((x) => x.kind === 'payment_action_needed')!;
    assert.equal(`${n.time_critical}:${n.push_result}:${inbox(n.inbox_id).status}`, 'true:opted_out:no_token');
    assert.equal(push.sent.filter((x) => x.user === ids.REQ).length, 0);
  });
  test('quiet hours hold back opportunities and ordinary updates (still in the inbox), but not the four time-critical notices', async () => {
    prefs('D_VAN', { quiet: true }); prefs('REQ', { quiet: true });
    const j = job('lerwick', 'yell');
    event(j, 'collected', { role: 'driver', from: 'matched', to: 'collected' });
    event(j, 'undeliverable', { role: 'driver', from: 'collected', to: 'undeliverable' });
    await drain();
    const ns = forJob(j);
    const opp = ns.find((x) => x.recipient_id === ids.D_VAN)!;
    assert.equal(`${opp.push_result}:${inbox(opp.inbox_id).status}`, 'quiet_hours:skipped_quiet');
    assert.equal(ns.find((x) => x.kind === 'collected')!.push_result, 'quiet_hours');
    assert.equal(ns.find((x) => x.kind === 'undeliverable')!.push_result, 'accepted');
    assert.deepEqual(scalar(`select string_agg(kind, ',' order by kind) from (select distinct kind from public.fetch_notifications where time_critical) k`)
      .split(',').filter((k) => k !== '').every((k) => ['payment_action_needed', 'cancel_requested', 'undeliverable', 'verification_blocks_collection'].includes(k)), true);
    assert.equal(scalar(`select count(*) from public.fetch_notifications where audience = 'opportunity' and time_critical`), '0');
  });
  test('opportunity pushes are capped per hour; the rest still reach the inbox; activity notices are never capped', async () => {
    ok(db.raw(`update public.admin_config set value = '2' where key = 'fetch.notify.opportunity_hourly_max'`));
    const jobs = [job('lerwick', 'yell', 'REQ2'), job('lerwick', 'yell', 'REQ2'), job('lerwick', 'yell', 'REQ2'), job('lerwick', 'yell', 'REQ2')];
    await drain();
    const mine = notices(`recipient_id = '${ids.D_UNST}' and request_id in (${jobs.map((j) => `'${j}'`).join(',')})`);
    assert.ok(mine.filter((n) => n.push_result === 'rate_limited').length >= 2, JSON.stringify(mine.map((n) => n.push_result)));
    assert.ok(mine.every((n) => inbox(n.inbox_id).status === 'no_token' || inbox(n.inbox_id).status === 'sent'));
    const k = job('scalloway', 'brae', 'REQ');
    for (let i = 0; i < 4; i++) event(k, i % 2 ? 'collected' : 'delivered', { role: 'driver' });
    await drain();
    assert.ok(forJob(k).filter((n) => n.audience === 'activity').every((n) => n.push_result === 'accepted'));
    ok(db.raw(`update public.admin_config set value = '1000' where key = 'fetch.notify.opportunity_hourly_max'`));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · LIFECYCLE (real functions where practical)', () => {
  test('accepted, payment needed, payment ready (only once the hold is real), cancellation asked/agreed', async () => {
    const j = job('lerwick', 'yell');
    assert.equal(JSON.parse(svc(`public.fetch_v2_claim('${ids.D_VAN}', '${j}', true)`)).ok, true);
    const auth = JSON.parse(svc(`coalesce(jsonb_agg(t), '[]'::jsonb) from public.fetch_v2_claim_authorisation('${ids.D_VAN}', '${j}') t`))[0];
    assert.equal(auth.outcome, 'claimed', JSON.stringify(auth));
    const hold = Number(scalar(`select max_hold_pence from public.fetch_v2_terms where request_id = '${j}'`));
    const apply = (state: string, cap: number) => svc(`public.fetch_v2_apply_payment_state('${j}', 'pi_n_${j.slice(0, 8)}', 1, '${state}', ${cap}, 0, now() + interval '7 days', 'test')`);
    apply('requires_action', 0);
    apply('requires_capture', hold);
    const kinds = () => forJob(j).filter((n) => n.audience === 'activity').map((n) => `${nameOf(n.recipient_id)}:${n.kind}`);
    assert.deepEqual(kinds(), ['REQ:driver_accepted', 'REQ:payment_action_needed', 'D_VAN:payment_ready']);
    assert.match(client('REQ', `public.fetch_v2_request_cancellation('${j}', 'Plans changed')`), /"ok": true/);
    assert.match(svc(`public.fetch_v2_agree_cancellation('${ids.D_VAN}', '${j}')`), /"status": "cancelled"/);
    assert.deepEqual(kinds().slice(3), ['D_VAN:cancel_requested', 'REQ:cancellation_agreed']);
    assert.equal(forJob(j).find((n) => n.kind === 'cancel_requested')!.time_critical, true);
  });
  test('an instant authorisation does not ping the driver (they saw it when accepting)', () => {
    const j = job('lerwick', 'yell');
    svc(`public.fetch_v2_claim('${ids.D_UNST}', '${j}', true)`);
    svc(`public.fetch_v2_claim_authorisation('${ids.D_UNST}', '${j}')`);
    const hold = Number(scalar(`select max_hold_pence from public.fetch_v2_terms where request_id = '${j}'`));
    svc(`public.fetch_v2_apply_payment_state('${j}', 'pi_i_${j.slice(0, 8)}', 1, 'requires_capture', ${hold}, 0, now() + interval '7 days', 'test')`);
    assert.ok(!forJob(j).some((n) => n.kind === 'payment_ready'));
  });
  test('a driver release tells the requester and puts it back in front of other drivers (never the one who let it go)', () => {
    const j = job('lerwick', 'yell');
    svc(`public.fetch_v2_claim('${ids.D_VAN}', '${j}', true)`);
    assert.match(svc(`public.fetch_v2_release('${ids.D_VAN}', '${j}', 'changed_plans')`), /"status": "pending"/);
    const ns = forJob(j);
    assert.ok(ns.some((n) => n.kind === 'driver_released' && n.recipient_id === ids.REQ));
    const back = ns.filter((n) => n.kind === 'back_on_board').map((n) => nameOf(n.recipient_id));
    assert.ok(back.length > 0 && !back.includes('D_VAN'), back.join());
  });
  test('collected, delivered, could not deliver (+ administrators), returned, payment timeout, expired', () => {
    const j = job('scalloway', 'brae');
    for (const [ev, from, to] of [['collected', 'matched', 'collected'], ['undeliverable', 'collected', 'undeliverable'], ['return_resolved', 'undeliverable', 'returned']])
      event(j, ev, { role: 'driver', from, to });
    const kinds = forJob(j).filter((n) => n.audience !== 'opportunity').map((n) => `${nameOf(n.recipient_id)}:${n.kind}`);
    assert.deepEqual(kinds, ['REQ:collected', 'REQ:undeliverable', 'ADMIN:admin_undeliverable', 'REQ:return_resolved']);
    const t = job('scalloway', 'brae');
    event(t, 'payment_timeout', { from: 'matched', to: 'pending', meta: { released_driver: ids.D_SMALL } });
    event(t, 'expired', { from: 'pending', to: 'expired' });
    assert.deepEqual(forJob(t).filter((n) => n.audience === 'activity').map((n) => `${nameOf(n.recipient_id)}:${n.kind}`),
      ['REQ:payment_not_completed', 'D_SMALL:job_released_payment', 'REQ:expired']);
  });
  test('a verification problem before collection reaches the driver (time-critical) and administrators', () => {
    const j = job('lerwick', 'yell');
    svc(`public.fetch_v2_claim('${ids.D_UNST}', '${j}', true)`);
    ok(db.raw(`insert into public.fetch_issues (request_id, reporter_role, kind, detail) values ('${j}', 'system', 'driver_verification', 'test')`));
    const ns = forJob(j).filter((n) => ['verification_blocks_collection', 'admin_issue'].includes(n.kind));
    assert.deepEqual(ns.map((n) => `${nameOf(n.recipient_id)}:${n.kind}:${n.time_critical}`).sort(),
      ['ADMIN:admin_issue:false', 'D_UNST:verification_blocks_collection:true']);
  });
  test('a failure inside a notice producer can never undo the Fetch action', () => {
    ok(db.raw(`alter table public.fetch_notifications add constraint zz_break check (kind <> 'driver_accepted') not valid`));
    const j = job('lerwick', 'yell');
    assert.equal(JSON.parse(svc(`public.fetch_v2_claim('${ids.D_VAN}', '${j}', true)`)).ok, true);
    assert.equal(scalar(`select status from public.delivery_requests where id = '${j}'`), 'matched');
    ok(db.raw('alter table public.fetch_notifications drop constraint zz_break'));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('6 · VERIFICATION notices', () => {
  const vev = (ev: string, notify: string | null, item: string | null = null) =>
    ok(db.raw(`insert into public.driver_verification_events (driver_id, item_id, actor_role, event, notify_kind)
               values ('${ids.D_AREA}', ${item ? `'${item}'` : 'null'}, 'system', '${ev}', ${notify ? `'${notify}'` : 'null'})`));
  test('accepted, rejected, approved; an expiry reminder for the same document is sent once', async () => {
    const item = scalar(`select id from public.driver_verification_items where driver_id = '${ids.D_AREA}' and kind = 'insurance'`);
    vev('evidence_approved', null, item);
    vev('evidence_rejected', 'evidence_rejected', item);
    vev('driver_approved', 'driver_approved');
    vev('evidence_expiring', 'evidence_expiring', item);
    vev('evidence_expiring', 'evidence_expiring', item);
    vev('evidence_expired', 'evidence_expired', item);
    const ns = notices(`recipient_id = '${ids.D_AREA}' and audience = 'verification'`);
    assert.deepEqual(ns.map((n) => n.kind), ['evidence_approved', 'evidence_rejected', 'driver_approved', 'evidence_expiring', 'evidence_expired']);
    assert.ok(ns.every((n) => n.data.route === '/fetch/driver/verification' && !n.data.request_id));
    await drain();
    assert.equal(scalar(`select count(*) from public.driver_verification_events where driver_id = '${ids.D_AREA}' and notify_kind is not null and notified_at is null`), '1',
      'every notice except the duplicate reminder (which never got its own row) is stamped notified');
  });
  test('administrators get one review nudge per driver per day, however many documents arrive', () => {
    for (let i = 0; i < 3; i++) vev('evidence_submitted', null);
    vev('application_submitted', null);
    assert.equal(scalar(`select count(*) from public.fetch_notifications where kind = 'admin_review' and recipient_id = '${ids.ADMIN}'`), '1');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('7 · PRIVACY and SECURITY', () => {
  test('no address, phone, access note, item description, payment or document detail in any notice; links carry ids only', async () => {
    await drain();
    const text = scalar(`select string_agg(title || ' ' || body || ' ' || data::text, ' | ') from public.fetch_notifications`) +
                 scalar(`select string_agg(title || ' ' || body || ' ' || coalesce(data::text, ''), ' | ') from public.notification_log`);
    for (const s of ['Hillhead', 'Westerloch', 'Main Street', '07700', 'Mrs Isbister', 'blue pot', 'Ring twice', 'teapot', 'acct_', 'pi_', 'licence', 'ZE1'])
      assert.ok(!text.includes(s), `leaked ${s}`);
    const keys = scalar(`select string_agg(distinct k, ',' order by k) from public.fetch_notifications, jsonb_object_keys(data) k`);
    assert.equal(keys, 'kind,request_id,route,screen');
    assert.equal(scalar(`select count(*) from public.fetch_notifications where data ->> 'route' !~ '^/(fetch|admin/fetch)/[a-z/0-9-]+$'`), '0');
  });
  test('clients cannot queue, claim, settle or read notices, or write an inbox row for someone else', () => {
    const j = job('scalloway', 'brae');
    for (const call of [`public.fetch_v2_enqueue_notice('x:forged:1', '${ids.D_VAN}', '${j}', 'payment_action_needed', 'request_event', '1')`,
      'public.fetch_v2_claim_notifications(10)', `public.fetch_v2_settle_notification(1, 'accepted', null)`])
      fails(asClient('REQ', `select ${call}`), /permission denied/);
    fails(asClient('REQ', 'select count(*) from public.fetch_notifications'), /permission denied/);
    fails(asClient('REQ', `insert into public.notification_log (user_id, category, title, body, status) values ('${ids.D_VAN}', 'fetch.payment_needed', 'x', 'y', 'sent')`),
      /row-level security|permission denied/);
    fails(asClient('REQ', `insert into public.fetch_request_events (request_id, actor_role, event) values ('${j}', 'system', 'undeliverable')`), /permission denied|row-level/);
  });
  test('the legacy notify-drivers / notify-collected paths refuse Fetch v2 jobs before authorising or sending anything', () => {
    for (const fn of ['notify-drivers', 'notify-collected']) {
      const src = readFileSync(join(REPO_ROOT, `supabase/functions/${fn}/index.ts`), 'utf8');
      const refuse = src.indexOf("fetch_version === 2");
      assert.ok(refuse > 0 && refuse < src.indexOf('authoriseFetchNotify(supabase') && refuse < src.indexOf('await sendUserPush'), fn);
      assert.match(src, /handled_by_fetch_v2/);
    }
  });
  test('administrators can see what happened to every notice — never "delivered"', () => {
    const j = notices(`kind = 'collected'`)[0];
    const d = JSON.parse(client('ADMIN', `public.fetch_v2_notification_diagnostics('${scalar(`select request_id from public.fetch_notifications where id = ${j.id}`)}', null)`));
    assert.ok(d.notices.length > 0 && d.notices.every((n: { push: string }) => n.push !== 'delivered'));
    assert.ok(d.notices.some((n: { inbox: string; push: string }) => n.inbox && n.push));
    fails(asClient('REQ', `select public.fetch_v2_notification_diagnostics(null, '${ids.REQ}')`), /Only an administrator/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('8 · rollback', () => {
  test('refuses while the outbox holds anything', () => {
    ok(db.raw(`update public.admin_config set value = '3' where key = 'fetch.notify.opportunity_hourly_max';
               update public.admin_config set value = '8' where key = 'fetch.notify.opportunity_daily_max';`));
    fails(db.rawFile(DOWN), /refusing to roll back Fetch notifications/);
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
  test('otherwise restores the catalogue exactly; inbox rows already written stay; re-applies', () => {
    const inboxBefore = scalar('select count(*) from public.notification_log');
    ok(db.raw('delete from public.fetch_notifications'));
    ok(db.rawFile(DOWN));
    assert.deepEqual(setDiff(beforeRows, catalogueRows()), { missing: [], extra: [] });
    assert.equal(scalar('select count(*) from public.notification_log'), inboxBefore);
    ok(db.rawFile(FIX));
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
});
