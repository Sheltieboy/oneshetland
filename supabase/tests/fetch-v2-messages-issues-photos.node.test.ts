/**
 * fetch-v2-messages-issues-photos.node.test.ts — Fetch v2 Step 9 (migration 20261223000000 + supabase/functions/_shared/fetch-v2-photos.ts),
 * against the real SQL, the real Step 8 outbox and the real storage row-level security on the replayed storage.objects table.
 *
 * Photo bytes go to an in-memory store that behaves like Supabase Storage (one-use signed upload to an exact path, never overwritten by a
 * client; service writes; short-lived signed links with a recorded lifetime). JPEGs carry a fake GPS location in EXIF so metadata removal
 * is checked end to end.
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users; fake storage; nothing sent; no network.
 * Run: ISOLATED_ONLY=fetch-v2-messages-issues-photos npm run test:isolated
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';
import { handlePhotos, handleSupportAdmin, runPhotoSweep, MEMBER_LINK_SECS, ADMIN_LINK_SECS, type PhotoDeps, type PhotoStorage } from '../functions/_shared/fetch-v2-photos.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX_NAME = '20261223000000_fetch_v2_messages_issues_photos.sql';
const FIX = join(REPO_ROOT, 'supabase/migrations', FIX_NAME);
const DOWN = join(REPO_ROOT, 'supabase/rollbacks/20261223000000_fetch_v2_messages_issues_photos.down.sql');

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
  MEMBER: 'a2000000-0000-4000-8000-000000000002',
  D_A: 'd1000000-0000-4000-8000-000000000001',   // the driver who accepts
  D_B: 'd2000000-0000-4000-8000-000000000002',   // another eligible driver
} as const;
type Id = keyof typeof ids;
const lit = (v: unknown) => (v === null || v === undefined ? 'null' : typeof v === 'object' ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`
  : typeof v === 'boolean' || typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const asClient = (w: Id, stmt: string) => db.raw(`begin; set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated; ${stmt}; commit;`);
const asAnon = (stmt: string) => db.raw(`begin; set local role anon; ${stmt}; commit;`);
const call = (w: Id, fn: string) => JSON.parse(lastRow(asClient(w, `select ${fn}`)) || 'null');
const svc = (fn: string) => lastRow(db.raw(`begin; set local role service_role; select ${fn}; commit;`));
const SETOF = new Set(['fetch_v2_stale_photo_uploads']);
const rpc = async (fn: string, args: Record<string, unknown>) => {
  const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
  const sql = SETOF.has(fn) ? `coalesce(jsonb_agg(t), '[]'::jsonb) from public.${fn}(${named}) t` : `to_json(public.${fn}(${named}))`;
  const o = db.raw(`begin; set local role service_role; select ${sql}; commit;`);
  if (/ERROR/.test(o)) return { data: null, error: { message: o } };
  return { data: JSON.parse(lastRow(o)), error: null };
};

// ── in-memory photo storage ─────────────────────────────────────────────────────────────────────────────────────────────────
class FakeStorage implements PhotoStorage {
  objects = new Map<string, Uint8Array>();
  tokens = new Map<string, string>();
  links: number[] = [];
  async signedUpload(path: string) { const token = randomUUID(); this.tokens.set(token, path); return { url: `https://storage.test/upload?token=${token}`, token }; }
  clientUpload(token: string, b: Uint8Array) { const p = this.tokens.get(token); if (!p) return 'invalid_token'; if (this.objects.has(p)) return 'exists'; this.tokens.delete(token); this.objects.set(p, b); return 'ok'; }
  async read(path: string) { return this.objects.get(path) ?? null; }
  async write(path: string, b: Uint8Array) { this.objects.set(path, b); }
  async signedUrl(_path: string, ttl: number) { this.links.push(ttl); return `https://storage.test/object/sign/${randomUUID()}?expires_in=${ttl}`; }
  async remove(path: string) { this.objects.delete(path); }
}
const storage = new FakeStorage();
const deps = (): PhotoDeps => ({ rpc, storage, limit: async () => true });
const photos = (w: Id, action: string, extra: Record<string, unknown> = {}) => handlePhotos(ids[w], { action, ...extra }, deps());
const support = (action: string, extra: Record<string, unknown> = {}, w: Id = 'ADMIN') => handleSupportAdmin(ids[w], { area: 'support', action, ...extra }, deps());

const seg = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
const txt = (s: string) => [...s].map((c) => c.charCodeAt(0));
const GPS_EXIF = [...txt('Exif'), 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x25, 0x88, 4, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0, ...txt('GPS 60.155N 1.145W')];
const JPEG = new Uint8Array([0xff, 0xd8, ...seg(0xe0, txt('JFIF')), ...seg(0xe1, GPS_EXIF), ...seg(0xfe, txt('12 Hillhead')), 0xff, 0xda, 0, 2, 7, 7, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, ...txt('IEND'), 0, 0, 0, 0]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, ...new Array(40).fill(0)]);
async function upload(w: Id, job: string, kind: string, o: { bytes?: Uint8Array; mime?: string; issue?: string; board?: boolean } = {}) {
  const bytes = o.bytes ?? JPEG;
  const b = await photos(w, 'begin_upload', { request_id: job, kind, mime_type: o.mime ?? 'image/jpeg', size_bytes: bytes.length, issue_id: o.issue, show_on_board: o.board });
  if (b.status !== 200) return b;
  storage.clientUpload(String(b.body.upload_token), bytes);
  return { ...(await photos(w, 'submit', { upload_id: b.body.upload_id })), upload_id: b.body.upload_id as string };
}

// ── jobs ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const RG: Record<string, string> = {};
function job(): string {
  const p = { idempotency_key: `k-${randomUUID()}`, category_slug: 'small-parcel', item_description: 'Box of books', size_class: 'small',
    pickup_region_id: RG.lerwick, pickup_name: 'Mrs Isbister', pickup_location: '12 Hillhead, Lerwick', pickup_lat: 60.155, pickup_lng: -1.145,
    destination_region_id: RG.scalloway, destination_address: '3 Main Street, Scalloway', dest_lat: 60.137, dest_lng: -1.276,
    contact_phone: '07700 900123', scheduling_mode: 'asap', safe_place_allowed: true, safe_place_note: 'Behind the shed' };
  const out = JSON.parse(svc(`public.fetch_v2_create_request('${ids.REQ}', ${lit(p)})`));
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.request_id;
}
const claimed = () => { const j = job(); assert.equal(JSON.parse(svc(`public.fetch_v2_claim('${ids.D_A}', '${j}', true)`)).ok, true); return j; };
const setState = (j: string, sql: string) => ok(db.raw(`update public.delivery_requests set ${sql} where id = '${j}'`));
const collect = (j: string) => setState(j, `status = 'collected', collected_at = now() - interval '1 minute'`);
const closeAgo = (j: string, interval: string) => { collect(j); setState(j, `status = 'delivered', collected_at = now() - interval '${interval}' - interval '1 hour', delivered_at = now() - interval '${interval}'`); };
const send = (w: Id, j: string, body: string, ref?: string) => call(w, `public.fetch_v2_send_message('${j}', ${lit(body)}${ref ? `, '${ref}'` : ''})`);
const read = (w: Id, j: string) => asClient(w, `select public.fetch_v2_messages('${j}')`);
const report = (w: Id, j: string, kind: string, detail = 'It arrived wet', ref?: string) =>
  call(w, `public.fetch_v2_report_issue('${j}', '${kind}', ${lit(detail)}${ref ? `, '${ref}'` : ''})`);

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
    union all select 'rl:' || action || ':' || window_seconds || ':' || max_count from public.rate_limit_policies
    union all select 'cfg:' || key || '=' || value from public.admin_config where key like 'fetch.%' and key <> 'fetch.v2.audience'
  ) s order by x`);
  assert.doesNotMatch(o, /ERROR/, o);
  return rowsOf(o).filter((l) => !/^x$|^-+$|^\(\d+ rows?\)$/.test(l));
};
const setDiff = (want: string[], got: string[]) => ({ missing: want.filter((x) => !got.includes(x)), extra: got.filter((x) => !want.includes(x)) });

before(() => {
  db = createReplayDb('fetchv2mip', { stopBefore: FIX_NAME });
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  ok(db.raw(`
    insert into auth.users (id, email) select x, 'u' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id = '${ids.ADMIN}';
    insert into public.regions (slug, name, display_order) values ('lerwick', 'Lerwick', 1), ('scalloway', 'Scalloway', 2);
    update public.regions set island_group = 'mainland';
    insert into public.delivery_pricing_config (price_per_mile_pence, min_fee_pence, road_correction_factor) values (65, 400, 1.40);
    insert into public.admin_config (key, value, category) values ('fees.fetch.fixed_pence', '150', 'fees'), ('fees.fetch.percent_bps', '0', 'fees')
      on conflict (key) do update set value = excluded.value;
    insert into public.delivery_categories (slug, name) values ('small-parcel', 'Small parcel');
    update public.admin_config set value = 'everyone' where key = 'fetch.v2.audience';
    -- as on Supabase: client roles hold table privileges on storage.objects and row-level security decides
    grant select, insert, update, delete on storage.objects to anon, authenticated;`));
  for (const s of ['lerwick', 'scalloway']) RG[s] = scalar(`select id from public.regions where slug = '${s}'`);
  for (const w of Object.keys(ids) as Id[]) assert.match(lastRow(asClient(w, `select public.fetch_v2_confirm_adult('fetch-18plus-v1')`)), /"ok": true/);
  for (const w of ['D_A', 'D_B'] as Id[]) ok(db.raw(`
    insert into public.driver_profiles (id, driver_status, vehicle_class, max_size_class, vehicle_reg, stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled)
    values ('${ids[w]}', 'approved', 'car', 'medium', 'ZE1 ABC', 'acct_${w}', true, true);
    insert into public.driver_verification_items (driver_id, kind, status, verified_by, verified_at, expires_at)
    select '${ids[w]}', k, 'verified', '${ids.ADMIN}', now(), case when k in ('licence', 'insurance') then now() + interval '200 days' end
      from unnest(array['identity_check', 'licence', 'vehicle', 'insurance']) k;`));
  beforeRows = catalogueRows();
  ok(db.rawFile(FIX));
  afterRows = catalogueRows();
});
after(() => { db?.drop(); });

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · MESSAGES', () => {
  test('requester and assigned driver talk; plain text, kept exactly as sent (markup is just text)', () => {
    const j = claimed();
    assert.equal(send('REQ', j, 'Hi, the gate code is on the note').ok, true);
    assert.equal(send('D_A', j, '<script>alert(1)</script> on my way').ok, true);
    const req = JSON.parse(lastRow(read('REQ', j)));
    assert.deepEqual(req.messages.map((m: { from: string; body: string }) => `${m.from}:${m.body}`),
      ['you:Hi, the gate code is on the note', 'driver:<script>alert(1)</script> on my way']);
    assert.equal(req.can_send, true);
  });
  test('nobody else: an unrelated member, another driver, or a driver before accepting; signed out nothing', () => {
    const j = claimed();
    for (const w of ['MEMBER', 'D_B'] as Id[]) { fails(asClient(w, `select public.fetch_v2_send_message('${j}', 'hello')`), /not found/); fails(read(w, j), /not found/); }
    const open = job();
    fails(asClient('D_B', `select public.fetch_v2_send_message('${open}', 'can I take it?')`), /not found/);
    assert.equal(send('REQ', open, 'anyone?').code, 'no_driver_yet');
    fails(asAnon(`select public.fetch_v2_messages('${j}')`), /permission denied/);
    for (const w of ['REQ', 'D_A', 'MEMBER'] as Id[]) assert.equal(lastRow(asClient(w, 'select count(*) from public.fetch_messages')), '0', w);
  });
  test('empty, whitespace-only and over-long messages are refused', () => {
    const j = claimed();
    assert.equal(send('REQ', j, '   \n ').code, 'message_empty');
    assert.equal(send('REQ', j, 'x'.repeat(1001)).code, 'message_too_long');
    assert.equal(send('REQ', j, 'x'.repeat(1000)).ok, true);
    send('REQ', j, '\tvav\n');
    assert.equal(JSON.parse(lastRow(read('REQ', j))).messages.at(-1).body, 'vav', 'only whitespace is trimmed');
  });
  test('a retry with the same reference is the same message; a burst is rate-limited', () => {
    const j = claimed();
    const ref = randomUUID();
    const a = send('REQ', j, 'Are you nearby?', ref), b = send('REQ', j, 'Are you nearby?', ref);
    assert.equal(a.message_id, b.message_id);
    assert.equal(b.already, true);
    for (let i = 0; i < 20; i++) send('D_A', j, `update ${i}`);
    assert.equal(send('D_A', j, 'one too many').code, 'rate_limited');
    assert.equal(scalar(`select count(*) from public.fetch_messages where request_id = '${j}'`), '21', 'one from the requester, twenty from the driver');
  });
  test('never edited or deleted by anyone; an administrator hides with a reason — participants see only that it was removed', async () => {
    const j = claimed();
    const m = send('D_A', j, 'call me on 07700 900999').message_id;
    fails(asClient('D_A', `update public.fetch_messages set body = 'x' where id = '${m}'`), /permission denied/);
    fails(asClient('D_A', `delete from public.fetch_messages where id = '${m}'`), /permission denied/);
    fails(db.raw(`update public.fetch_messages set body = 'rewritten' where id = '${m}'`), /cannot be edited/);
    assert.equal((await support('hide_message', { message_id: m })).body.code, 'reason_required');
    assert.equal((await support('hide_message', { message_id: m, reason: 'Phone number shared' }, 'REQ')).body.code, 'forbidden');
    assert.equal((await support('hide_message', { message_id: m, reason: 'Phone number shared' })).body.ok, true);
    const seen = JSON.parse(lastRow(read('REQ', j))).messages[0];
    assert.deepEqual([seen.body, seen.hidden], [null, true]);
    assert.ok(!lastRow(read('REQ', j)).includes('07700'));
    const admin = JSON.parse(lastRow(read('ADMIN', j))).messages[0];
    assert.deepEqual([admin.body, admin.hidden_reason, admin.hidden_by], ['call me on 07700 900999', 'Phone number shared', ids.ADMIN]);
    assert.equal(scalar(`select count(*) from public.fetch_request_events where request_id = '${j}' and event = 'message_hidden' and metadata::text not like '%07700%'`), '1');
  });
  test('30 days after the job closes participants can no longer read or send; administrators still can', () => {
    const j = claimed();
    send('REQ', j, 'thanks!');
    closeAgo(j, '29 days');
    assert.equal(JSON.parse(lastRow(read('REQ', j))).messages.length, 1);
    closeAgo(j, '31 days');
    fails(read('REQ', j), /not found/);
    fails(read('D_A', j), /not found/);
    assert.equal(send('REQ', j, 'still there?').code, 'message_window_closed');
    assert.equal(JSON.parse(lastRow(read('ADMIN', j))).messages.length, 1);
  });
  test('one "new message" notice per job until it is read; never the text', () => {
    const j = claimed();
    send('REQ', j, 'first: the key is under the mat');
    send('REQ', j, 'second');
    const n = () => JSON.parse(scalar(`select coalesce(jsonb_agg(n order by id), '[]'::jsonb) from public.fetch_notifications n where request_id = '${j}' and kind = 'message'`));
    assert.equal(n().length, 1);
    assert.equal(`${n()[0].recipient_id}:${n()[0].title}:${n()[0].body}`, `${ids.D_A}:New message about your Fetch:Open the app to read it.`);
    ok(db.raw(`select public.fetch_v2_claim_notifications(10)`));
    send('REQ', j, 'third');
    assert.equal(n().length, 1, 'still unread in the inbox: no second notice');
    ok(db.raw(`update public.notification_log set read_at = now() where id = '${n()[0].inbox_id}'`));
    send('REQ', j, 'fourth');
    assert.equal(n().length, 2);
    assert.equal(scalar(`select count(*) from public.fetch_notifications where kind = 'message' and (body ~ 'key|mat|first|second' or data::text ~ 'key|mat')`), '0');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · ISSUES', () => {
  test('requester and assigned driver report; each only the conduct kind that is theirs; nobody else', () => {
    const j = claimed();
    assert.equal(report('REQ', j, 'damaged').ok, true);
    assert.equal(report('REQ', j, 'driver_conduct').ok, true);
    assert.equal(report('REQ', j, 'requester_conduct').code, 'invalid_kind');
    assert.equal(report('D_A', j, 'requester_conduct').ok, true);
    assert.equal(report('D_A', j, 'payment').ok, true);
    for (const k of ['cancellation', 'return', 'driver_verification', 'bogus']) assert.equal(report('REQ', j, k).code, 'invalid_kind', k);
    for (const w of ['MEMBER', 'D_B'] as Id[]) fails(asClient(w, `select public.fetch_v2_report_issue('${j}', 'other', 'x')`), /not found/);
  });
  test('within 72 hours of closing, not after; a retry is the same issue; a burst is limited', () => {
    const j = claimed();
    closeAgo(j, '71 hours');
    const ref = randomUUID();
    const a = report('REQ', j, 'not_delivered', 'Never arrived', ref), b = report('REQ', j, 'not_delivered', 'Never arrived', ref);
    assert.equal(a.issue_id, b.issue_id);
    report('REQ', j, 'other'); report('REQ', j, 'other');
    assert.equal(report('REQ', j, 'other').code, 'rate_limited', 'at most three open issues per job per reporter');
    const k = claimed();
    closeAgo(k, '73 hours');
    assert.equal(report('REQ', k, 'damaged').code, 'issue_window_closed');
  });
  test('never rewritten; an administrator resolves with the outcome recorded; the reporter sees it; notices to admins and the reporter', async () => {
    const j = claimed();
    const i = report('REQ', j, 'wrong_item', 'Wrong box').issue_id;
    fails(asClient('REQ', `update public.fetch_issues set detail = 'x' where id = '${i}'`), /permission denied/);
    fails(db.raw(`update public.fetch_issues set detail = 'rewritten' where id = '${i}'`), /cannot be rewritten/);
    assert.equal(scalar(`select count(*) from public.fetch_notifications where kind = 'admin_issue' and request_id = '${j}'`), '1');
    assert.equal((await support('resolve_issue', { issue_id: i })).body.code, 'resolution_required');
    assert.equal((await support('resolve_issue', { issue_id: i, reason: 'Driver swapped the boxes back' })).body.ok, true);
    assert.equal(scalar(`select status || ':' || resolved_by || ':' || (resolved_at is not null) from public.fetch_issues where id = '${i}'`), `resolved:${ids.ADMIN}:true`);
    fails(db.raw(`update public.fetch_issues set status = 'open', resolution = null, resolved_at = null where id = '${i}'`), /stays resolved/);
    const mine = call('REQ', `public.fetch_v2_my_issues('${j}')`).issues[0];
    assert.deepEqual([mine.status, mine.resolution], ['resolved', 'Driver swapped the boxes back']);
    const n = JSON.parse(scalar(`select to_jsonb(n) from public.fetch_notifications n where kind = 'issue_resolved' and request_id = '${j}'`));
    assert.equal(n.recipient_id, ids.REQ);
    assert.ok(!scalar(`select string_agg(title || body, '|') from public.fetch_notifications where request_id = '${j}'`).includes('Wrong box'));
  });
  test('an open issue holds the evidence: administrators keep access after the participant window', async () => {
    const j = claimed();
    collect(j);
    const i = report('D_A', j, 'safety', 'Aggressive dog').issue_id;
    const p = await upload('D_A', j, 'issue', { issue: i });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    closeAgo(j, '40 days');
    assert.equal((await photos('D_A', 'view', { photo_id: p.body.photo_id })).body.code, 'not_found');
    const v = await support('view_photo', { photo_id: p.body.photo_id });
    assert.equal(`${v.status}:${v.body.evidence_held}`, '200:true');
    assert.equal(JSON.parse(svc(`public.fetch_v2_support_record('${ids.ADMIN}', '${j}')`)).evidence_held, true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · PHOTOS', () => {
  test('a requester adds item photos; only the ones marked for the board reach the board (as ids), and only for a driver who can take jobs', async () => {
    const j = job();
    const shown = await upload('REQ', j, 'item', { board: true });
    const kept = await upload('REQ', j, 'item');
    assert.equal(`${shown.status}:${kept.status}`, '200:200');
    const board = JSON.parse(lastRow(asClient('D_B', `select coalesce(jsonb_agg(b), '[]'::jsonb) from public.fetch_v2_board(false) b`)));
    assert.deepEqual(board.find((r: { request_id: string }) => r.request_id === j).matching_photo_ids, [shown.body.photo_id]);
    assert.equal((await photos('D_B', 'view_board', { photo_id: shown.body.photo_id })).status, 200);
    assert.equal((await photos('D_B', 'view_board', { photo_id: kept.body.photo_id })).body.code, 'not_found');
    assert.equal((await photos('MEMBER', 'view_board', { photo_id: shown.body.photo_id })).body.code, 'not_found', 'not a driver');
    assert.equal((await photos('MEMBER', 'view', { photo_id: shown.body.photo_id })).body.code, 'not_found');
    assert.equal((await photos('REQ', 'view', { photo_id: kept.body.photo_id })).status, 200);
  });
  test('the requester can show, hide or withdraw item photos until the job is claimed (withdrawal keeps the record)', async () => {
    const j = job();
    const p = (await upload('REQ', j, 'item')).body.photo_id;
    assert.equal(call('REQ', `public.fetch_v2_set_item_photo('${j}', '${p}', 'show_on_board')`).ok, true);
    assert.equal(call('REQ', `public.fetch_v2_set_item_photo('${j}', '${p}', 'withdraw')`).ok, true);
    assert.equal(scalar(`select (removed_at is not null) || ':' || removed_reason || ':' || matching_visible from public.fetch_request_photos where id = '${p}'`),
      'true:Withdrawn by the requester:false');
    const q = (await upload('REQ', j, 'item')).body.photo_id;
    assert.equal(JSON.parse(svc(`public.fetch_v2_claim('${ids.D_A}', '${j}', true)`)).ok, true);
    assert.equal(call('REQ', `public.fetch_v2_set_item_photo('${j}', '${q}', 'withdraw')`).code, 'item_photos_closed');
    assert.equal((await upload('REQ', j, 'item')).body.code, 'item_photos_closed');
  });
  test('only the right member, at the right stage, on their own job', async () => {
    const j = claimed();
    assert.equal((await upload('REQ', j, 'delivery')).body.code, 'not_found', 'the requester takes no delivery photos');
    assert.equal((await upload('D_B', j, 'collection')).body.code, 'not_found', 'another driver');
    assert.equal((await upload('D_A', j, 'delivery')).body.code, 'invalid_state', 'not collected yet');
    assert.equal((await upload('D_A', j, 'collection')).status, 200);
    assert.equal((await upload('D_A', j, 'return')).body.code, 'invalid_state');
    assert.equal((await upload('MEMBER', j, 'issue', { issue: randomUUID() })).body.code, 'not_found');
  });
  test('JPEG / PNG / WEBP only, checked by the real bytes; size limited; a renamed executable is refused and deleted', async () => {
    const j = job();
    for (const mime of ['image/gif', 'image/heic', 'application/pdf', 'application/x-msdownload'])
      assert.equal((await upload('REQ', j, 'item', { mime })).body.code, 'file_type_not_allowed', mime);
    const exe = await upload('REQ', j, 'item', { bytes: EXE });
    assert.equal(`${exe.status}:${exe.body.code}`, '415:file_type_mismatch');
    assert.equal(scalar(`select count(*) from public.fetch_photo_uploads where id = '${exe.upload_id}'`), '0');
    assert.equal((await upload('REQ', j, 'item', { bytes: PNG, mime: 'image/jpeg' })).body.code, 'file_type_mismatch');
    assert.equal((await upload('REQ', j, 'item', { bytes: PNG, mime: 'image/png' })).status, 200);
    assert.equal((await photos('REQ', 'begin_upload', { request_id: j, kind: 'item', mime_type: 'image/jpeg', size_bytes: 11 * 1024 * 1024 })).body.code, 'file_too_large');
    const big = new Uint8Array(10 * 1024 * 1024 + 1); big.set(JPEG.subarray(0, 4));
    assert.equal((await upload('REQ', j, 'item', { bytes: big })).body.code, 'file_too_large');
  });
  test('location and other metadata are removed from the stored photo before it is registered', async () => {
    const j = job();
    const p = await upload('REQ', j, 'item');
    const path = scalar(`select storage_path from public.fetch_request_photos where id = '${p.body.photo_id}'`);
    const stored = Buffer.from(storage.objects.get(path)!);
    for (const s of ['GPS', '60.155', 'Hillhead', 'Exif']) assert.ok(!stored.includes(Buffer.from(s)), s);
    assert.ok(stored.includes(Buffer.from('JFIF')));
    assert.equal(scalar(`select size_bytes from public.fetch_photo_uploads where photo_id = '${p.body.photo_id}'`), String(JPEG.length));
  });
  test('an upload link lapses; the sweep removes the abandoned object; a submitted photo is registered once', async () => {
    const j = job();
    const b = await photos('REQ', 'begin_upload', { request_id: j, kind: 'item', mime_type: 'image/jpeg', size_bytes: JPEG.length });
    storage.clientUpload(String(b.body.upload_token), JPEG);
    ok(db.raw(`update public.fetch_photo_uploads set expires_at = now() - interval '1 second' where id = '${b.body.upload_id}'`));
    assert.equal((await photos('REQ', 'submit', { upload_id: b.body.upload_id })).body.code, 'upload_expired');
    const s = await runPhotoSweep(deps());
    assert.ok(s.uploads_removed >= 1);
    assert.equal(scalar(`select count(*) from public.fetch_photo_uploads where id = '${b.body.upload_id}'`), '0');
    const p = await upload('REQ', j, 'item');
    const again = await photos('REQ', 'submit', { upload_id: p.upload_id });
    assert.deepEqual([again.body.already, again.body.photo_id], [true, p.body.photo_id]);
    assert.equal(scalar(`select count(*) from public.fetch_request_photos where request_id = '${j}' and removed_at is null`), '1');
  });
  test('links are short-lived (60s members, 120s administrators) and carry no storage path; nothing reads the bucket directly', async () => {
    const j = job();
    const p = await upload('REQ', j, 'item');
    const v = await photos('REQ', 'view', { photo_id: p.body.photo_id });
    assert.equal(`${v.body.expires_in}:${storage.links.at(-1)}`, `${MEMBER_LINK_SECS}:60`);
    assert.ok(!JSON.stringify(v.body).includes('requests/') && !JSON.stringify(p.body).includes('requests/'));
    assert.equal((await support('view_photo', { photo_id: p.body.photo_id })).body.expires_in, ADMIN_LINK_SECS);
    ok(db.raw(`insert into storage.objects (bucket_id, name) select 'fetch-photos', storage_path from public.fetch_request_photos where id = '${p.body.photo_id}'`));
    for (const w of ['REQ', 'ADMIN', 'D_B'] as Id[]) assert.equal(lastRow(asClient(w, `select count(*) from storage.objects where bucket_id = 'fetch-photos'`)), '0', w);
    assert.equal(lastRow(asAnon(`select count(*) from storage.objects where bucket_id = 'fetch-photos'`)), '0');
    fails(asClient('REQ', `insert into storage.objects (bucket_id, name) values ('fetch-photos', 'requests/${j}/item/x.jpg')`), /row-level security|permission denied/);
    assert.equal(scalar(`select public from storage.buckets where id = 'fetch-photos'`), 'f');
    for (const w of ['REQ', 'D_A', 'MEMBER'] as Id[]) assert.equal(lastRow(asClient(w, 'select count(*) from public.fetch_request_photos')), '0', w);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · EVIDENCE RULES', () => {
  const precheck = (j: string) => JSON.parse(svc(`public.fetch_v2_delivery_precheck('${ids.D_A}', '${j}', true)`));
  test('safe-place delivery needs this driver\'s delivery photo, taken after collection — an old or unrelated photo does not count', async () => {
    const j = claimed();
    collect(j);
    assert.equal(precheck(j).code, 'delivery_photo_required');
    ok(db.raw(`insert into public.fetch_request_photos (request_id, kind, storage_path, created_by, created_at)
               values ('${j}', 'delivery', 'requests/${j}/delivery/${randomUUID()}.jpg', '${ids.D_A}', now() - interval '1 day')`));
    assert.equal(precheck(j).code, 'delivery_photo_required', 'taken before collection');
    ok(db.raw(`insert into public.fetch_request_photos (request_id, kind, storage_path, created_by)
               values ('${j}', 'delivery', 'requests/${j}/delivery/${randomUUID()}.jpg', '${ids.REQ}')`));
    assert.equal(precheck(j).code, 'delivery_photo_required', 'not from the driver');
    const p = await upload('D_A', j, 'delivery');
    assert.equal(p.status, 200);
    assert.equal(precheck(j).ok, true);
    await support('remove_photo', { photo_id: p.body.photo_id, reason: 'Shows a neighbour' });
    assert.equal(precheck(j).code, 'delivery_photo_required', 'a removed photo no longer counts');
  });
  test('reporting a return needs this driver\'s return photo, taken after it became undeliverable', async () => {
    const j = claimed();
    collect(j);
    assert.match(lastRow(asClient('D_A', `select public.fetch_v2_mark_undeliverable('${j}', 'recipient_absent')`)), /undeliverable/);
    assert.equal(call('D_A', `public.fetch_v2_report_return('${j}')`).code, 'return_photo_required');
    assert.equal((await upload('D_A', j, 'return')).status, 200);
    assert.equal(call('D_A', `public.fetch_v2_report_return('${j}')`).ok, true);
  });
  test('evidence is write-once: no rewrite, no client overwrite of the stored object; removal needs a reason and keeps the record', async () => {
    const j = claimed();
    collect(j);
    const p = await upload('D_A', j, 'collection');
    fails(db.raw(`update public.fetch_request_photos set storage_path = 'requests/${j}/collection/${randomUUID()}.jpg' where id = '${p.body.photo_id}'`), /cannot be rewritten/);
    fails(asClient('D_A', `update public.fetch_request_photos set removed_at = now() where id = '${p.body.photo_id}'`), /permission denied/);
    const b = await photos('D_A', 'begin_upload', { request_id: j, kind: 'collection', mime_type: 'image/jpeg', size_bytes: JPEG.length });
    const path = scalar(`select storage_path from public.fetch_photo_uploads where id = '${b.body.upload_id}'`);
    storage.objects.set(path, JPEG);
    assert.equal(storage.clientUpload(String(b.body.upload_token), PNG), 'exists');
    assert.equal((await support('remove_photo', { photo_id: p.body.photo_id })).body.code, 'reason_required');
    assert.equal((await support('remove_photo', { photo_id: p.body.photo_id, reason: 'x' }, 'D_B')).body.code, 'forbidden');
    assert.equal((await support('remove_photo', { photo_id: p.body.photo_id, reason: 'Wrong address visible' })).body.ok, true);
    assert.equal((await photos('REQ', 'view', { photo_id: p.body.photo_id })).body.code, 'not_found');
    assert.equal((await support('view_photo', { photo_id: p.body.photo_id })).body.removed, true);
    assert.equal(scalar(`select removed_by || ':' || removed_reason from public.fetch_request_photos where id = '${p.body.photo_id}'`), `${ids.ADMIN}:Wrong address visible`);
  });
  test('issue evidence: the reporter adds it while the issue is open; both parties and administrators see it; nobody else', async () => {
    const j = claimed();
    const i = report('REQ', j, 'damaged', 'Cracked lid').issue_id;
    const p = await upload('REQ', j, 'issue', { issue: i });
    assert.equal(p.status, 200);
    assert.equal((await upload('D_A', j, 'issue', { issue: i })).body.code, 'not_found', 'only the reporter adds to their issue');
    assert.equal((await photos('D_A', 'view', { photo_id: p.body.photo_id })).status, 200);
    assert.equal((await photos('MEMBER', 'view', { photo_id: p.body.photo_id })).body.code, 'not_found');
    await support('resolve_issue', { issue_id: i, reason: 'Refunded the lid' });
    assert.equal((await upload('REQ', j, 'issue', { issue: i })).body.code, 'issue_closed');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · PRIVACY, AUDIT and EXISTING WINDOWS', () => {
  test('the audit trail holds ids only — never message text, issue detail, paths or image data', () => {
    const t = scalar(`select string_agg(event || ' ' || coalesce(reason, '') || ' ' || metadata::text, ' | ') from public.fetch_request_events
                      where event in ('message_sent', 'issue_reported', 'issue_resolved', 'photo_added', 'photo_removed', 'photo_withdrawn')`);
    for (const s of ['gate code', 'Cracked lid', 'Aggressive dog', 'requests/', 'GPS']) assert.ok(!t.includes(s), s);
    assert.match(t, /message_sent/);
  });
  test('participants no longer get the exact address after 72 hours or the phone after the job ends, whatever messages remain', () => {
    const j = claimed();
    send('REQ', j, 'see you soon');
    closeAgo(j, '4 days');
    const d = lastRow(asClient('D_A', `select public.fetch_v2_request_detail('${j}')`));
    for (const s of ['Hillhead', 'Main Street', '07700', 'Behind the shed']) assert.ok(!d.includes(s), s);
    assert.equal(JSON.parse(lastRow(read('D_A', j))).messages.length, 1);
  });
  test('administrators: one support record of a job — every message (hidden included), issue and photo, no storage paths', async () => {
    const j = claimed();
    send('REQ', j, 'hello');
    const r = await support('record', { request_id: j });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.messages) && Array.isArray(r.body.issues) && Array.isArray(r.body.photos));
    assert.ok(!JSON.stringify(r.body).includes('requests/'));
    assert.equal((await support('record', { request_id: j }, 'REQ')).body.code, 'forbidden');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('6 · rollback', () => {
  test('refuses while Step 9 records exist', () => {
    fails(db.rawFile(DOWN), /refusing to roll back messages, issues and photos/);
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
  test('otherwise restores the catalogue exactly (functions, policies, storage policies); re-applies', () => {
    ok(db.raw(`alter table public.fetch_request_events disable trigger fetch_request_events_append_only;
      delete from public.fetch_request_events where event in ('message_sent', 'message_hidden', 'issue_reported', 'issue_resolved', 'photo_added',
        'photo_removed', 'photo_withdrawn', 'photo_visibility_changed');
      alter table public.fetch_request_events enable trigger fetch_request_events_append_only;
      delete from public.fetch_photo_uploads; update public.fetch_messages set client_ref = null; update public.fetch_issues set client_ref = null;`));
    ok(db.rawFile(DOWN));
    assert.deepEqual(setDiff(beforeRows, catalogueRows()), { missing: [], extra: [] });
    ok(db.rawFile(FIX));
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
});
