/**
 * notice-broadcast-eligibility.node.test.ts — Notices Stage 3A.1 safeguard: the island-wide urgent channel (notify-community-notice) may only
 * send a notice that is eligible for publication.
 *
 * THE FINDING
 * notify-community-notice reads notices with the SERVICE ROLE, so the Stage 3A.1 read-protection policy cannot protect it. It checked severity,
 * visibility, is_hidden and expiry - never `status` or `starts_at` - so an admin could push every device on the island about a pending, withdrawn
 * or resolved urgent notice, or one scheduled for later.
 *
 * WHAT RUNS
 * The function's REAL source (supabase/functions/notify-community-notice/index.ts) with its imports stubbed, talking to an isolated Postgres
 * (migrations through 20261128010000 applied) through the psql-backed client. Push delivery is a MOCK that records what would have been sent: nothing
 * here can send a push or an email. The ORIGINAL deployed source (git 4535964, byte-identical to production) is run as a control against the same
 * fixtures to show which of them it would have sent.
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a Supabase DSN. No network, no real notification service.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';
import { assertIsolated, pgClient, must, scalar } from './_support/purchase-fixture.ts';

assertIsolated();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const file = (sql: string) => { const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', timeout: 180_000 }); return `${r.stdout ?? ''}${r.stderr ?? ''}`; };
const FN = 'supabase/functions/notify-community-notice/index.ts';
const ORIGINAL_COMMIT = '4535964';   // last commit that touched the function; its content == the deployed bundle (verified byte-for-byte)
const original = spawnSync('git', ['show', `${ORIGINAL_COMMIT}:${FN}`], { cwd: ROOT, encoding: 'utf8' }).stdout;

const ADMIN = 'e0000000-0000-4000-8000-0000000000e1', MOD = 'e0000000-0000-4000-8000-0000000000e2', MEMBER = 'a0000000-0000-4000-8000-0000000000a1';
const R1 = 'c1000000-0000-4000-8000-000000000001', R2 = 'c1000000-0000-4000-8000-000000000002', R3 = 'c1000000-0000-4000-8000-000000000003', R4 = 'c1000000-0000-4000-8000-000000000004';
const HUB = 'dd000000-0000-4000-8000-0000000000dd', BIZ = 'bb000000-0000-4000-8000-0000000000bb';
let n = 0; const nid = () => `f2000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

// ── fixtures: every notice is URGENT unless the case says otherwise ───────────────────────────────
type Fx = { id: string; label: string; eligible: boolean; cols: string; vals: string };
const FX: Record<string, Fx> = {};
const add = (key: string, label: string, eligible: boolean, cols: string, vals: string) => { FX[key] = { id: nid(), label, eligible, cols, vals }; };
const P = `is_platform_notice, severity, title, body, locality`;
const pv = (t: string) => `true, 'urgent', '${t}', 'Body of ${t}', 'Sumburgh'`;
add('active', '1 published and currently active', true, P, pv('active'));
add('activeWindow', '1b published, started 1h ago, expires in 1h', true, `${P}, starts_at, expires_at`, `${pv('window')}, now() - interval '1 hour', now() + interval '1 hour'`);
add('activeOffset', '1c eligible, timestamps written with a +05:00 offset', true, `${P}, starts_at, expires_at`, `${pv('offset')}, (now() - interval '1 hour') at time zone 'UTC' at time zone 'Asia/Karachi', (now() + interval '1 hour')`);
add('pending', '2 pending approval', false, `${P}, status`, `${pv('pending')}, 'pending'`);
add('withdrawn', '3 withdrawn', false, `${P}, status`, `${pv('withdrawn')}, 'withdrawn'`);
add('resolved', '4 resolved', false, `${P}, status`, `${pv('resolved')}, 'resolved'`);
add('scheduled', '5 scheduled for the future (published, starts in 2 days)', false, `${P}, starts_at`, `${pv('scheduled')}, now() + interval '2 day'`);
add('hidden', '6 hidden', false, `${P}, is_hidden`, `${pv('hidden')}, true`);
add('expired', '7 expired', false, `${P}, expires_at`, `${pv('expired')}, now() - interval '1 minute'`);
add('notStarted', '8 not yet started (starts in 10 minutes)', false, `${P}, starts_at`, `${pv('notStarted')}, now() + interval '10 minutes'`);
add('members', '9 members-only hub notice', false, `publisher_hub_id, severity, title, body, visibility`, `'${HUB}', 'urgent', 'members', 'Body', 'members'`);
add('committee', '10 committee-only hub notice', false, `publisher_hub_id, severity, title, body, visibility`, `'${HUB}', 'urgent', 'committee', 'Body', 'committee'`);
add('community', 'not urgent (community)', false, `is_platform_notice, severity, title, body`, `true, 'community', 'community', 'Body'`);
add('already', 'already broadcast', false, `${P}, broadcast_at, broadcast_by`, `${pv('already')}, now() - interval '1 day', '${ADMIN}'`);
add('business', 'eligible urgent notice from an approved business', true, `publisher_business_id, severity, title, body`, `'${BIZ}', 'urgent', 'business', 'Body'`);
add('imported', 'official import (source set), otherwise eligible - see risk R1', true, `${P}, source, source_reference, source_label, expires_at`, `${pv('imported')}, 'nhs_shetland', 'r1', 'NHS Shetland', now() + interval '2 day'`);
const LIFECYCLE_GAP = ['pending', 'withdrawn', 'resolved', 'scheduled', 'notStarted'];   // what the ORIGINAL function wrongly sent

const ENV: Record<string, string> = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
(globalThis as any).Deno = { env: { get: (k: string) => ENV[k] } };

let handler: (req: Request) => Promise<Response>;
const pushCalls: Array<{ ids: string[]; payload: any }> = [];
let afterFirstNoticeRead: (() => void) | null = null;
const TOKENS: Record<string, string | null> = { admin: ADMIN, mod: MOD, member: MEMBER, bad: null };

function build(source: string | null) {
  const svc = pgClient();
  const from = svc.from.bind(svc);
  (svc as any).from = (t: string) => {
    const q: any = from(t);
    if (t === 'notices') {
      const then = q.then.bind(q);
      q.then = (ok: any, bad: any) => then((r: any) => {
        if (q.op === 'select' && afterFirstNoticeRead) { const h = afterFirstNoticeRead; afterFirstNoticeRead = null; h(); }
        return r;
      }).then(ok, bad);
    }
    return q;
  };
  const stubs = {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
    'https://esm.sh/@supabase/supabase-js@2': {
      createClient: (_u: string, key: string, opts: any) => key === 'anon-key'
        ? { auth: { getUser: async () => { const tok = String(opts?.global?.headers?.Authorization ?? '').replace(/^Bearer /, ''); const id = TOKENS[tok]; return { data: { user: id ? { id } : null } }; } } }
        : svc,
    },
    '../_shared/send-push.ts': { sendUserPushBulk: async (_svc: unknown, ids: string[], payload: unknown) => { pushCalls.push({ ids: [...ids].sort(), payload }); return { sent: ids.length }; } },
    '../_shared/safe-error.ts': { safeError: () => 'Something went wrong' },
    '../_shared/rate-limit.ts': { enforceRateLimit: async () => ({}), userSubject: (id: string) => id },
    '../_shared/notice-broadcast.ts': loadModule('supabase/functions/_shared/notice-broadcast.ts'),
  };
  loadModule(FN, stubs, source === null ? undefined : () => source);
  return handler;
}
async function call(h: (req: Request) => Promise<Response>, noticeId: unknown, who: string | null = 'admin', extra: Record<string, unknown> = {}, rawBody?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${who}`;
  const res = await h(new Request('http://fn/notify-community-notice', { method: 'POST', headers, body: rawBody ?? JSON.stringify({ notice_id: noticeId, ...extra }) }));
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
const resetClaims = () => must(`update notices set broadcast_at = null, broadcast_by = null where id <> '${FX.already.id}'`);
const claimed = (id: string) => scalar(`select (broadcast_at is not null)::text from notices where id='${id}'`) === 'true';
const expectedRecipients = [R1, R2, R3, R4].sort();
let NEW: (req: Request) => Promise<Response>, OLD: (req: Request) => Promise<Response>;

before(() => {
  let o = file(rd('supabase/tests/_support/attribution-prefix-schema.sql')); assert.doesNotMatch(o, /ERROR/i, o.slice(0, 500));
  o = file(`
    grant usage on schema public to anon, authenticated, service_role;
    create function public.is_admin() returns boolean language sql stable security definer set search_path to 'public' as $$ select exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or is_platform_owner = true)); $$;
    alter table notices add column lat numeric, add column lng numeric; alter table profiles add column display_name text, add column location_area text, add column push_token text;
    create table push_tokens (user_id uuid, token text);
    create table regions (id uuid primary key default gen_random_uuid(), slug text unique not null, name text not null, display_order int);
    create table jobs (id uuid primary key default gen_random_uuid(), title text, locality text, location text);
    create table runs (id uuid primary key default gen_random_uuid(), origin_region_id uuid references regions(id), destination_region_id uuid references regions(id));
    create table delivery_requests (id uuid primary key default gen_random_uuid(), destination_region_id uuid references regions(id), destination_address text);
    grant select on all tables in schema public to anon; grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
    insert into profiles (id, role, push_token) values ('${ADMIN}','admin',null), ('${MOD}','moderator',null), ('${MEMBER}','customer',null),
      ('${R1}','customer','ExponentPushToken[r1]'), ('${R2}','customer',null), ('${R3}','customer',null), ('${R4}','customer','ExponentPushToken[r4]');
    insert into push_tokens (user_id, token) values ('${R2}','t2'), ('${R3}','t3'), ('${R1}','t1b'), (null,'orphan');
    insert into local_businesses (id, owner_id, name, slug, can_publish_urgent) values ('${BIZ}','${ADMIN}','Garage','garage',true);
    alter table hubs disable trigger tg_zz_lock_hub_columns;
    insert into hubs (id, owner_id, name, slug, is_verified, payout_enabled) values ('${HUB}','${ADMIN}','Voe Hall','voe',true,true);
    alter table hubs enable trigger tg_zz_lock_hub_columns;`);
  assert.doesNotMatch(o, /ERROR/i, o.slice(0, 500));
  for (const m of ['20261121000000_event_notice_attribution', '20261127000000_canonical_geography_foundation', '20261127010000_geography_alias_ambiguity', '20261128000000_notices_structural_readiness', '20261128010000_notices_read_protection']) {
    o = file(rd(`supabase/migrations/${m}.sql`)); assert.doesNotMatch(o, /ERROR/i, `${m}: ${o.slice(0, 500)}`);
  }
  o = file(Object.values(FX).map((f) => `insert into notices (id, ${f.cols}) values ('${f.id}', ${f.vals});`).join('\n')); assert.doesNotMatch(o, /ERROR/i, o.slice(0, 500));
  NEW = build(null); OLD = build(original);
});

describe('the finding: what the ORIGINAL deployed function did (control)', () => {
  test('0.1 the original source is the deployed one and ignores lifecycle: it sends pending, withdrawn, resolved and scheduled urgent notices', async () => {
    assert.ok(original.includes('notify-community-notice'), 'original source retrieved from git');
    for (const k of LIFECYCLE_GAP) {
      resetClaims(); pushCalls.length = 0;
      const r = await call(OLD, FX[k].id);
      assert.equal(r.status, 200, `${k}: the original function sent it`); assert.equal(pushCalls.length, 1, k);
    }
    resetClaims(); pushCalls.length = 0;
  });
});

describe('the safeguard: ineligible notices never initiate a delivery', () => {
  for (const k of ['pending', 'withdrawn', 'resolved', 'scheduled', 'hidden', 'expired', 'notStarted', 'members', 'committee', 'community', 'already']) {
    test(`1.${k} ${FX[k].label}: refused, no push, nothing claimed`, async () => {
      resetClaims(); pushCalls.length = 0;
      const r = await call(NEW, FX[k].id);
      assert.ok(r.status >= 400, `${k}: refused (${r.status})`); assert.equal(pushCalls.length, 0, 'no delivery attempted');
      if (k !== 'already') assert.equal(claimed(FX[k].id), false, 'broadcast_at not claimed');
      assert.equal(scalar(`select (broadcast_by is null)::text from notices where id='${FX[k].id}'`), k === 'already' ? 'false' : 'true');
    });
  }
  test('1.messages: each lifecycle refusal says why, and the original messages are unchanged', async () => {
    const msg = async (k: string) => (await call(NEW, FX[k].id)).body?.error;
    assert.equal(await msg('pending'), 'That notice is not published'); assert.equal(await msg('withdrawn'), 'That notice is not published'); assert.equal(await msg('resolved'), 'That notice is not published');
    assert.equal(await msg('scheduled'), 'That notice has not started yet'); assert.equal(await msg('notStarted'), 'That notice has not started yet');
    assert.equal(await msg('hidden'), 'That notice is not public'); assert.equal(await msg('members'), 'That notice is not public'); assert.equal(await msg('expired'), 'That notice has expired');
    assert.equal(await msg('community'), 'Only urgent notices go island-wide');
    const already = await call(NEW, FX.already.id); assert.equal(already.status, 409); assert.deepEqual(already.body, { error: 'Already sent to everyone', sent: 0 });
  });
  test('1.request fields are not trusted: claiming status / severity / visibility / starts_at in the request body changes nothing', async () => {
    resetClaims(); pushCalls.length = 0;
    const r = await call(NEW, FX.pending.id, 'admin', { status: 'published', severity: 'urgent', visibility: 'public', is_hidden: false, starts_at: null, expires_at: null, force: true, broadcast_at: null });
    assert.equal(r.status, 400); assert.equal(pushCalls.length, 0); assert.equal(claimed(FX.pending.id), false);
  });
});

describe('request handling', () => {
  test('2.1 missing id -> 400, invalid id -> 404, unknown id -> 404, no delivery', async () => {
    pushCalls.length = 0;
    assert.equal((await call(NEW, undefined)).status, 400); assert.equal((await call(NEW, '')).status, 400);
    const bad = await call(NEW, 'not-a-uuid'); assert.equal(bad.status, 404); assert.equal(bad.body.error, 'Notice not found');
    assert.equal((await call(NEW, 'f9999999-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await call(NEW, "x'; delete from notices; --")).status, 404);
    assert.ok(Number(scalar('select count(*) from notices')) >= Object.keys(FX).length, 'table intact');
    assert.equal(pushCalls.length, 0);
  });
  test('2.2 unauthorised: no header, bad token and a non-admin member are refused; a moderator is too (admins only, unchanged)', async () => {
    pushCalls.length = 0; resetClaims();
    assert.equal((await call(NEW, FX.active.id, null)).status, 401); assert.equal((await call(NEW, FX.active.id, 'bad')).status, 401);
    assert.equal((await call(NEW, FX.active.id, 'member')).status, 403); assert.equal((await call(NEW, FX.active.id, 'mod')).status, 403);
    assert.equal(pushCalls.length, 0); assert.equal(claimed(FX.active.id), false);
  });
  test('2.3 the notice is deleted before processing (between the read and the claim): 404, no delivery', async () => {
    const id = nid(); must(`insert into notices (id, ${FX.active.cols}) values ('${id}', ${FX.active.vals})`);
    pushCalls.length = 0; afterFirstNoticeRead = () => must(`delete from notices where id='${id}'`);
    const r = await call(NEW, id); assert.equal(r.status, 404); assert.equal(pushCalls.length, 0);
  });
});

describe('atomic claim: a notice that stops being eligible after the first read is not sent', () => {
  for (const [label, sql] of [
    ['withdrawn', `set status='withdrawn'`], ['resolved', `set status='resolved'`], ['sent back to review', `set status='pending'`],
    ['hidden', `set is_hidden=true`], ['made members-only', `set visibility='members'`], ['expired', `set expires_at = now() - interval '1 second'`],
    ['rescheduled for later', `set starts_at = now() + interval '1 hour'`], ['downgraded from urgent', `set severity='community'`],
  ] as const) {
    test(`3.${label}: refused by the claim itself, no push`, async () => {
      const id = nid(); must(`insert into notices (id, ${FX.active.cols}) values ('${id}', ${FX.active.vals})`);
      pushCalls.length = 0; afterFirstNoticeRead = () => must(`update notices ${sql} where id='${id}'`);
      const r = await call(NEW, id); assert.equal(r.status, 409, label); assert.equal(r.body.error, 'That notice is no longer available to send');
      assert.equal(pushCalls.length, 0, 'no delivery'); assert.equal(claimed(id), false, 'not claimed');
    });
  }
  test('3.double-send: a retry of an eligible notice is still refused by the once-only claim', async () => {
    const id = nid(); must(`insert into notices (id, ${FX.active.cols}) values ('${id}', ${FX.active.vals})`);
    pushCalls.length = 0; const [a, b] = await Promise.all([call(NEW, id), call(NEW, id)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]); assert.equal(pushCalls.length, 1, 'exactly one delivery');
  });
});

describe('eligible notices: behaviour is unchanged from the deployed function', () => {
  for (const k of ['active', 'activeWindow', 'activeOffset', 'business']) {
    test(`4.${k} ${FX[k].label}: sent once, to the same recipients, with the same payload and response as the original`, async () => {
      resetClaims(); pushCalls.length = 0; const a = await call(OLD, FX[k].id); const oldPush = pushCalls.splice(0);
      resetClaims(); const b = await call(NEW, FX[k].id); const newPush = pushCalls.splice(0);
      assert.equal(b.status, 200); assert.deepEqual(b.body, a.body, 'identical response body'); assert.deepEqual(newPush, oldPush, 'identical delivery request');
      assert.equal(newPush.length, 1); assert.deepEqual(newPush[0].ids, expectedRecipients, 'profiles.push_token OR push_tokens, de-duplicated, orphans ignored');
      assert.deepEqual(newPush[0].payload, { module: 'notices', categoryId: 'notices.urgent', title: `⚠️ ${scalar(`select title from notices where id='${FX[k].id}'`)}`, body: newPush[0].payload.body, data: { screen: 'notices', notice_id: FX[k].id }, urgent: true });
      assert.equal(claimed(FX[k].id), true); assert.equal(scalar(`select broadcast_by from notices where id='${FX[k].id}'`), ADMIN);
      assert.equal(b.body.recipients, 4);
    });
  }
  test('4.body: locality prefix and 160-character truncation behave as before', async () => {
    const id = nid(); must(`insert into notices (id, ${P}) values ('${id}', true, 'urgent', 'long', '${'x'.repeat(300)}', 'Sumburgh')`);
    resetClaims(); pushCalls.length = 0; await call(NEW, id);
    assert.equal(pushCalls[0].payload.body, `Sumburgh: ${'x'.repeat(157)}…`);
  });
});

describe('boundaries and timestamps (the helper against explicit instants; the database is the authority)', () => {
  const T = Date.parse('2026-11-01T12:00:00.000Z');
  const mod = loadModule('supabase/functions/_shared/notice-broadcast.ts') as { broadcastRefusal: (n: any, now: number) => { error: string } | null };
  const base = { severity: 'urgent', visibility: 'public', is_hidden: false, status: 'published', starts_at: null, expires_at: null, broadcast_at: null };
  test('5.1 starts_at: live AT the start instant, not a millisecond before', () => {
    assert.equal(mod.broadcastRefusal({ ...base, starts_at: new Date(T).toISOString() }, T), null);
    assert.ok(mod.broadcastRefusal({ ...base, starts_at: new Date(T + 1).toISOString() }, T));
    assert.equal(mod.broadcastRefusal({ ...base, starts_at: new Date(T - 1).toISOString() }, T), null);
  });
  test('5.2 expires_at: not live AT the expiry instant (database: expires_at > now()), live a millisecond before', () => {
    assert.ok(mod.broadcastRefusal({ ...base, expires_at: new Date(T).toISOString() }, T));
    assert.equal(mod.broadcastRefusal({ ...base, expires_at: new Date(T + 1).toISOString() }, T), null);
  });
  test('5.3 missing optional timestamps are fine; unreadable ones fail closed', () => {
    assert.equal(mod.broadcastRefusal({ ...base }, T), null); assert.equal(mod.broadcastRefusal({ ...base, starts_at: '' , expires_at: undefined }, T), null);
    assert.ok(mod.broadcastRefusal({ ...base, starts_at: 'garbage' }, T)); assert.ok(mod.broadcastRefusal({ ...base, expires_at: 'garbage' }, T));
  });
  test('5.4 time zones: the same instant written with different UTC offsets gives the same answer', () => {
    for (const s of ['2026-11-01T12:00:00Z', '2026-11-01T13:00:00+01:00', '2026-11-01T17:00:00+05:00', '2026-11-01T07:00:00-05:00', '2026-11-01 12:00:00+00']) assert.equal(mod.broadcastRefusal({ ...base, starts_at: s }, T), null, s);
    for (const s of ['2026-11-01T12:00:00.001Z', '2026-11-01T13:00:00.001+01:00']) assert.ok(mod.broadcastRefusal({ ...base, starts_at: s }, T), s);
  });
  test('5.5 null / unknown flags fail closed (is_hidden null, status null, visibility null)', () => {
    for (const p of [{ is_hidden: null }, { status: null }, { visibility: null }, { status: 'draft' }]) assert.ok(mod.broadcastRefusal({ ...base, ...p }, T), JSON.stringify(p));
  });
  test('5.6 CONSISTENT WITH THE DATABASE: over a grid of states and offsets, eligible <=> visible to an anonymous reader under the "notices read" policy', () => {
    const rows: string[] = []; let k = 0;
    for (const status of ['published', 'pending', 'withdrawn', 'resolved']) for (const hidden of [false, true])
      for (const st of [null, -3600, 3600]) for (const ex of [null, -3600, 3600]) {
        if (st !== null && ex !== null && ex <= st) continue;
        rows.push(`('f3000000-0000-4000-8000-${String(++k).padStart(12, '0')}', '${status}', ${hidden}, ${st === null ? 'null' : `now() + interval '${st} seconds'`}, ${ex === null ? 'null' : `now() + interval '${ex} seconds'`})`);
      }
    must(`insert into notices (id, is_platform_notice, severity, title, status, is_hidden, starts_at, expires_at) select v.id::uuid, true, 'urgent', 't', v.status, v.hidden, v.st, v.ex from (values ${rows.join(',')}) as v(id, status, hidden, st, ex)`);
    const dbNow = Date.parse(scalar(`select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`));
    const grid = must(`select id || '|' || status || '|' || is_hidden || '|' || coalesce(starts_at::text,'') || '|' || coalesce(expires_at::text,'') from notices where id::text like 'f3000000-%'`).split('\n');
    const visible = new Set(must(`set role anon; select id from notices where id::text like 'f3000000-%'; reset role`).split('\n').filter((l) => /^f3/.test(l)));
    assert.equal(grid.length, rows.length);
    let eligible = 0;
    for (const line of grid) {
      const [id, status, hidden, st, ex] = line.split('|');
      const ok = mod.broadcastRefusal({ ...base, status, is_hidden: hidden === 't' || hidden === 'true', starts_at: st || null, expires_at: ex || null }, dbNow) === null;
      assert.equal(ok, visible.has(id), `${line}: helper says ${ok}, database policy says ${visible.has(id)}`);
      if (ok) eligible++;
    }
    assert.ok(eligible > 0 && eligible < grid.length, `grid exercises both outcomes (${eligible}/${grid.length} eligible)`);
  });
});

describe('compatibility with the Stage 3A.1 migration, and what remains', () => {
  test('6.1 the function reads and claims as the SERVICE ROLE: RLS (now public-only) does not stand in its way, and the claim touches only broadcast_*', () => {
    assert.ok(Number(must(`set role service_role; select count(*) from notices where status <> 'published'; reset role`).split('\n')[0]) > 0, 'service role still reads non-public rows');
    const src = rd(FN);
    assert.match(src, /\.update\(\{ broadcast_at: nowIso, broadcast_by: user\.id \}\)/); assert.equal((src.match(/\.update\(/g) ?? []).length, 1);
  });
  test('6.2 nothing in the database sends a notification when a notice is created or changed (imports stay silent)', () => {
    const triggers = must(`select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid='public.notices'::regclass and not tgisinternal`);
    assert.equal(triggers, 'aa_notices_attribution_guard,notices_lifecycle');
    assert.equal(Number(scalar(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('tg_notices_attribution_guard','tg_notices_lifecycle') and prosrc ~* '(net\\.http|pg_notify|http_request|push|notification)'`)), 0);
  });
  test('6.3 RISK R1 (characterisation): an official import that is otherwise eligible CAN be broadcast if an admin deliberately asks; no code path does it automatically', async () => {
    resetClaims(); pushCalls.length = 0; const r = await call(NEW, FX.imported.id);
    assert.equal(r.status, 200, 'documented, admin-initiated only'); assert.equal(pushCalls.length, 1);
    resetClaims();
  });
  test('6.4 the function only ever reads the notice id from the request', () => {
    const src = rd(FN);
    assert.match(src, /const \{ notice_id \} = await req\.json\(\);/);
    assert.doesNotMatch(src, /\b(body|payload)\.(status|starts_at|severity|visibility)\b/);
  });
});
