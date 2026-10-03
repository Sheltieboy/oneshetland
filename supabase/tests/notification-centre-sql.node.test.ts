/**
 * notification-centre-sql.node.test.ts — the Notification Centre's rules, proved against real SQL.
 *
 * WHAT WAS WRONG
 *
 * Quiet hours silently erased notifications. should_notify() refuses for two reasons — the user MUTED a
 * module, or it is QUIET HOURS — and the push sender logs both as 'skipped_pref'. The inbox hides
 * 'skipped_pref' (an opt-out) and shows 'skipped_quiet' (held back while you slept, still something that
 * happened for you) — but nothing ever wrote 'skipped_quiet'. So a refund, a booking cancellation or a
 * ticket confirmation arriving inside someone's quiet hours was neither pushed nor recorded. Migration
 * 20261031010000 reclassifies it at the door with a trigger, for every sender at once.
 *
 * WHAT IS ASSERTED — against the real functions, policies and trigger, executed
 *   A  a skip inside quiet hours is kept in the inbox and counted unread; a muted module and a master-off
 *      user stay hidden opt-outs; other statuses are never rewritten
 *   B  should_notify itself: master switch, module switch, quiet hours (incl. across midnight), urgent
 *   C  reads are self-only (another user, and signed-out, see nothing)
 *   D  clients cannot fabricate, edit or delete a notification, and cannot touch another user's
 *   E  mark-read / mark-all-read / unread count: own rows only, idempotent, count == visible unread
 *   F  preferences are self-only to read and to write
 *   G  should_notify (which reveals another user's settings) is service-role only
 *   H  payloads are made openable by the already-shipped app build (merchant and employer notices)
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by `npm run test:isolated`.
 * Schema and functions are read from the real migrations at run time. Production is never touched.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const SPINE = join(MIG, '20260627000000_notifications_spine.sql');
const SERVICE_ONLY = join(MIG, '20261031000000_should_notify_service_only.sql');
const QUIET = join(MIG, '20261031010000_quiet_hours_stay_in_inbox.sql');
const ROUTES = join(MIG, '20261031020000_notification_routes_for_shipped_build.sql');

const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');

function raw(body: string): string {
  try {
    return execFileSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l));
const scalar = (sql: string) => rowsOf(raw(sql)).pop() ?? '';
const asUser = (uid: string | null, sql: string) =>
  raw(`begin; ${uid ? `set local request.jwt.claim.sub = '${uid}';` : ''} set local role ${uid ? 'authenticated' : 'anon'}; ${sql}; commit;`);
const asService = (sql: string) => raw(`begin; set local role service_role; ${sql}; commit;`);

function slice(file: string, opener: string, closer: string): string {
  const s = src(file);
  const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone from ${file}`);
  const end = s.indexOf(closer, start);
  assert.notEqual(end, -1, `no end for ${opener}`);
  return s.slice(start, end + closer.length);
}
function createTable(file: string, opener: string): string {
  const s = src(file);
  const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone`);
  const open = s.indexOf('(', start);
  let d = 0, end = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } }
  }
  return s.slice(start, end + 1) + ';';
}
const policies = (table: string) =>
  [...src(BASELINE).matchAll(new RegExp(`CREATE POLICY "[^"]+" ON public\\.${table}[^;]*;`, 'g'))].map((m) => m[0]);

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const Q = 'cccccccc-3333-4333-8333-cccccccccccc';   // quiet hours around now
const M = 'dddddddd-4444-4444-8444-dddddddddddd';   // wallet module muted
const O = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';   // master switch off

const LONDON = `(now() at time zone 'Europe/London')::time`;

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');

  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    `do $r$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $r$;`,
    'alter role service_role bypassrls;   -- as on Supabase: the senders are not subject to row security',
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    'create table auth.users (id uuid primary key, email text);',
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    'create table public.profiles (id uuid primary key);',
    'create table public.local_businesses (id uuid primary key, owner_id uuid);',
    'create table public.book_bookings (id uuid primary key, business_id uuid);',
    createTable(BASELINE, 'CREATE TABLE public.notification_log ('),
    'alter table public.notification_log add primary key (id);',
    'alter table public.notification_log add foreign key (user_id) references public.profiles(id) on delete cascade;',
    createTable(BASELINE, 'CREATE TABLE public.notification_preferences ('),
    'alter table public.notification_preferences add primary key (user_id);',
    'alter table public.notification_preferences add foreign key (user_id) references public.profiles(id) on delete cascade;',
    slice(SPINE, 'ALTER TABLE public.notification_preferences', ';'),
    slice(SPINE, 'ALTER TABLE public.notification_log', ';'),
    slice(SPINE, 'CREATE OR REPLACE FUNCTION public.should_notify', '$$;'),
    slice(SPINE, 'CREATE OR REPLACE FUNCTION public.mark_notifications_read', '$$;'),
    slice(SPINE, 'CREATE OR REPLACE FUNCTION public.unread_notification_count', '$$;'),
    'alter table public.notification_log enable row level security;',
    'alter table public.notification_preferences enable row level security;',
    ...policies('notification_log'), ...policies('notification_preferences'),
    // What Supabase grants by default: broad table rights, with row security as the only gate. The proofs
    // below depend on RLS, not on the absence of a GRANT.
    'grant all on all tables in schema public to anon, authenticated, service_role;',
    'grant execute on all functions in schema public to anon, authenticated, service_role, public;',
    src(SERVICE_ONLY),
    src(QUIET),
    src(ROUTES),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `fixture did not build:\n${out.slice(0, 1500)}`);

  const seed = raw(`
    insert into public.profiles (id) values ('${A}'), ('${B}'), ('${Q}'), ('${M}'), ('${O}');
    insert into public.notification_preferences (user_id, enabled, quiet_hours_start, quiet_hours_end) values
      ('${Q}', true, (${LONDON} - interval '1 hour')::time, (${LONDON} + interval '1 hour')::time);
    insert into public.notification_preferences (user_id, enabled, wallet_enabled) values ('${M}', true, false);
    insert into public.notification_preferences (user_id, enabled) values ('${O}', false);`);
  assert.doesNotMatch(seed, /ERROR/i, `seed failed:\n${seed.slice(0, 600)}`);
});

const put = (uid: string, category: string, status: string, title = 't') =>
  asService(`insert into public.notification_log (user_id, category, title, body, status) values ('${uid}', '${category}', '${title}', 'b', '${status}')`);
const statusOf = (uid: string, title: string) =>
  scalar(`select status from public.notification_log where user_id='${uid}' and title='${title}'`);

describe('A — quiet hours no longer erase a notification', () => {
  test('THE DEFECT: a skip during quiet hours is kept in the inbox (skipped_quiet), not discarded as an opt-out', () => {
    put(Q, 'wallet.refunded', 'skipped_pref', 'quiet-refund');
    assert.equal(statusOf(Q, 'quiet-refund'), 'skipped_quiet');
  });

  test('and it is visible to the user and counted unread', () => {
    const rows = rowsOf(asUser(Q, `select title from public.notification_log where status in ('sent','no_token','skipped_quiet')`));
    assert.ok(rows.includes('quiet-refund'));
    assert.equal(rowsOf(asUser(Q, 'select public.unread_notification_count()')).pop(), '1');
  });

  test('a muted module stays a hidden opt-out', () => {
    put(M, 'wallet.refunded', 'skipped_pref', 'muted');
    assert.equal(statusOf(M, 'muted'), 'skipped_pref');
    assert.equal(rowsOf(asUser(M, 'select public.unread_notification_count()')).pop(), '0');
  });

  test('a user with the master switch off stays a hidden opt-out', () => {
    put(O, 'wallet.refunded', 'skipped_pref', 'master-off');
    assert.equal(statusOf(O, 'master-off'), 'skipped_pref');
  });

  test('a muted module is judged by its category prefix, not by other modules', () => {
    put(M, 'bookings.cancelled', 'skipped_pref', 'other-module');   // bookings is ON for M, so only quiet hours could refuse it
    assert.equal(statusOf(M, 'other-module'), 'skipped_quiet');
  });

  test('a user with no preferences row is never silently reclassified', () => {
    put(A, 'wallet.refunded', 'skipped_pref', 'no-prefs');
    assert.equal(statusOf(A, 'no-prefs'), 'skipped_pref');
  });

  test('sent, no_token and error rows are never rewritten', () => {
    for (const s of ['sent', 'no_token', 'error']) {
      put(Q, 'wallet.topup', s, `keep-${s}`);
      assert.equal(statusOf(Q, `keep-${s}`), s);
    }
  });

  test('end to end: the sender\'s own decision (should_notify) lands as quiet, not lost', () => {
    const sent = scalar(`insert into public.notification_log (user_id, category, title, body, status)
      select '${Q}', 'events.tickets_confirmed', 'e2e-quiet', 'b',
             case when public.should_notify('${Q}', 'events', false) then 'sent' else 'skipped_pref' end
      returning status`);
    assert.equal(sent, 'skipped_quiet');
  });
});

describe('B — should_notify decisions', () => {
  const sn = (uid: string, mod: string, urgent = false) =>
    scalar(`select public.should_notify('${uid}', '${mod}', ${urgent})`);
  test('inside quiet hours: held back; urgent bypasses', () => {
    assert.equal(sn(Q, 'events'), 'f');
    assert.equal(sn(Q, 'notices', true), 't');
  });
  test('quiet hours that wrap across midnight', () => {
    // A window that starts 1h from now and ends 1h before now covers the other 22 hours (wraps midnight),
    // so "now" is OUTSIDE it; the mirror image (start 1h before, end 1h after, written reversed) is inside.
    raw(`insert into public.profiles values ('99999999-9999-4999-8999-999999999999') on conflict do nothing;
         insert into public.notification_preferences (user_id, enabled, quiet_hours_start, quiet_hours_end)
         values ('99999999-9999-4999-8999-999999999999', true, (${LONDON} + interval '1 hour')::time, (${LONDON} - interval '1 hour')::time)
         on conflict (user_id) do update set quiet_hours_start = excluded.quiet_hours_start, quiet_hours_end = excluded.quiet_hours_end`);
    assert.equal(sn('99999999-9999-4999-8999-999999999999', 'events'), 't', 'now is outside a window that ends before it and starts after it');
  });
  test('muted module and master-off are refused; unmuted modules pass; no row means opted in', () => {
    assert.equal(sn(M, 'wallet'), 'f');
    assert.equal(sn(M, 'events'), 't');
    assert.equal(sn(O, 'events'), 'f');
    assert.equal(sn(A, 'wallet'), 't');
  });
  test('an urgent send still respects an explicit mute', () => {
    assert.equal(sn(M, 'wallet', true), 'f');
  });
});

describe('C — reads are self-only', () => {
  before(() => { put(A, 'wallet.topup', 'sent', 'a-private'); put(B, 'wallet.topup', 'sent', 'b-private'); });
  test('a user sees only their own rows', () => {
    const a = rowsOf(asUser(A, 'select title from public.notification_log'));
    assert.ok(a.includes('a-private') && !a.includes('b-private'));
    const b = rowsOf(asUser(B, 'select title from public.notification_log'));
    assert.ok(b.includes('b-private') && !b.includes('a-private'));
  });
  test('asking for another user\'s history by id returns nothing', () => {
    assert.deepEqual(rowsOf(asUser(A, `select title from public.notification_log where user_id = '${B}'`)), []);
  });
  test('a signed-out caller sees nothing and counts nothing', () => {
    assert.deepEqual(rowsOf(asUser(null, 'select title from public.notification_log')), []);
    assert.equal(rowsOf(asUser(null, 'select public.unread_notification_count()')).pop(), '0');
  });
});

describe('D — clients cannot fabricate or alter notifications', () => {
  test('inserting a notification (for yourself or anyone) is refused', () => {
    for (const uid of [A, B]) {
      const out = asUser(A, `insert into public.notification_log (user_id, category, title, body, status) values ('${uid}', 'wallet.refunded', 'fake', 'Your refund', 'sent')`);
      assert.match(out, /row-level security|permission denied/i);
    }
    assert.equal(scalar(`select count(*) from public.notification_log where title='fake'`), '0');
  });
  test('editing or deleting your own notification text, status or owner changes nothing', () => {
    asUser(A, `update public.notification_log set title = 'hacked', status = 'sent', user_id = '${B}' where user_id = '${A}'`);
    asUser(A, `delete from public.notification_log where user_id = '${A}'`);
    assert.equal(scalar(`select count(*) from public.notification_log where title='hacked'`), '0');
    assert.equal(scalar(`select title from public.notification_log where title='a-private'`), 'a-private');
  });
  test('another user\'s rows cannot be altered or removed', () => {
    asUser(A, `update public.notification_log set read_at = now() where user_id = '${B}'; delete from public.notification_log where user_id = '${B}'`);
    assert.equal(scalar(`select count(*) from public.notification_log where title='b-private' and read_at is null`), '1');
  });
  test('the service role (the senders) can write', () => {
    put(B, 'wallet.topup', 'sent', 'service-write');
    assert.equal(statusOf(B, 'service-write'), 'sent');
  });
});

describe('E — unread counts and read state', () => {
  const unread = (uid: string) => rowsOf(asUser(uid, 'select public.unread_notification_count()')).pop();
  const visibleUnread = (uid: string) =>
    rowsOf(asUser(uid, `select count(*) from public.notification_log where read_at is null and status in ('sent','no_token','skipped_quiet')`)).pop();

  test('the badge count equals the unread rows the inbox shows — never the hidden ones', () => {
    put(A, 'wallet.payment', 'no_token', 'a-2'); put(A, 'wallet.payment', 'error', 'a-hidden-error'); put(A, 'wallet.payment', 'skipped_pref', 'a-hidden-pref');
    assert.equal(unread(A), visibleUnread(A));
    assert.ok(Number(unread(A)) >= 2);
  });
  test('marking one read lowers the count by exactly one, and marking it again does nothing', () => {
    const before = Number(unread(A));
    const id = scalar(`select id from public.notification_log where title='a-private'`);
    asUser(A, `select public.mark_notifications_read(array['${id}'::uuid])`);
    assert.equal(Number(unread(A)), before - 1);
    asUser(A, `select public.mark_notifications_read(array['${id}'::uuid])`);
    assert.equal(Number(unread(A)), before - 1);
  });
  test('a user cannot mark another user\'s notification read by passing its id', () => {
    const bid = scalar(`select id from public.notification_log where title='b-private'`);
    asUser(A, `select public.mark_notifications_read(array['${bid}'::uuid])`);
    assert.equal(scalar(`select read_at is null from public.notification_log where id='${bid}'`), 't');
  });
  test('mark all read clears the caller\'s unread and nobody else\'s', () => {
    const bBefore = unread(B);
    asUser(A, 'select public.mark_notifications_read()');
    assert.equal(unread(A), '0');
    assert.equal(unread(B), bBefore);
    assert.ok(Number(bBefore) >= 1);
  });
  test('read_at is set once and not rewritten by a second mark-all', () => {
    const t1 = scalar(`select max(read_at)::text from public.notification_log where user_id='${A}'`);
    asUser(A, 'select public.mark_notifications_read()');
    assert.equal(scalar(`select max(read_at)::text from public.notification_log where user_id='${A}'`), t1);
  });
});

describe('F — preferences are self-only', () => {
  test('another user\'s preferences cannot be read', () => {
    assert.deepEqual(rowsOf(asUser(A, `select user_id from public.notification_preferences where user_id = '${Q}'`)), []);
  });
  test('you can read and write your own', () => {
    asUser(A, `insert into public.notification_preferences (user_id, enabled) values ('${A}', true) on conflict (user_id) do update set enabled = true`);
    assert.equal(rowsOf(asUser(A, `select enabled from public.notification_preferences where user_id='${A}'`)).pop(), 't');
  });
  test('you cannot write another user\'s preferences, create them, or silence them', () => {
    const create = asUser(A, `insert into public.notification_preferences (user_id, enabled) values ('${B}', false)`);
    assert.match(create, /row-level security/i);
    asUser(A, `update public.notification_preferences set enabled = false where user_id = '${Q}'`);
    assert.equal(scalar(`select enabled from public.notification_preferences where user_id='${Q}'`), 't');
  });
});

describe('G — should_notify is not a probe for other people\'s settings', () => {
  test('signed-out and signed-in clients are refused', () => {
    for (const who of [null, A]) {
      assert.match(asUser(who, `select public.should_notify('${Q}', 'events', false)`), /permission denied/i);
    }
  });
  test('the service role (the senders) still can', () => {
    assert.equal(rowsOf(asService(`select public.should_notify('${Q}', 'events', false)`)).pop(), 'f');
  });
  test('the trigger function is not callable by clients either', () => {
    assert.match(asUser(A, 'select public.notification_log_classify_skip()'), /permission denied|trigger functions can only be called as triggers/i);
  });
});

describe('H — notifications the shipped app build can open', () => {
  const OWN1 = 'f1f1f1f1-1111-4111-8111-f1f1f1f1f1f1';   // owns exactly one business
  const OWN2 = 'f2f2f2f2-2222-4222-8222-f2f2f2f2f2f2';   // owns two
  const BIZ1 = 'b1b1b1b1-1111-4111-8111-b1b1b1b1b1b1';
  const BIZ2A = 'b2b2b2b2-aaaa-4aaa-8aaa-b2b2b2b2b2aa';
  const BIZ2B = 'b2b2b2b2-bbbb-4bbb-8bbb-b2b2b2b2b2bb';
  const BK_2B = '0b0b0b0b-bbbb-4bbb-8bbb-0b0b0b0b0b0b';   // a booking at OWN2's second business
  const BK_X  = '0c0c0c0c-cccc-4ccc-8ccc-0c0c0c0c0c0c';   // a booking at someone else's business
  const NOBODY = 'f3f3f3f3-3333-4333-8333-f3f3f3f3f3f3';
  const SHIFT = '5a5a5a5a-5555-4555-8555-5a5a5a5a5a5a';

  before(() => {
    const r = raw(`
      insert into public.profiles values ('${OWN1}'), ('${OWN2}'), ('${NOBODY}');
      insert into public.local_businesses values ('${BIZ1}', '${OWN1}'), ('${BIZ2A}', '${OWN2}'), ('${BIZ2B}', '${OWN2}');
      insert into public.book_bookings values ('${BK_2B}', '${BIZ2B}'), ('${BK_X}', '${BIZ1}');`);
    assert.doesNotMatch(r, /ERROR/i, r);
  });
  const post = (uid: string, category: string, data: object, title: string) =>
    asService(`insert into public.notification_log (user_id, category, title, body, status, data)
               values ('${uid}', '${category}', '${title}', 'b', 'sent', '${JSON.stringify(data)}'::jsonb)`);
  const dataOf = (title: string) => JSON.parse(scalar(`select data::text from public.notification_log where title='${title}'`));

  test('THE DEFECT: a merchant sale notice (no id) gets the owner\'s only business, so build 144 can open it', () => {
    post(OWN1, 'business.sale', { screen: 'local-business-dashboard' }, 'sale');
    assert.deepEqual(dataOf('sale'), { screen: 'local-business-dashboard', business_id: BIZ1 });
  });
  test('a booking notice goes to the booking\'s own business even when the owner has several', () => {
    post(OWN2, 'business.new_booking', { screen: 'local-business-dashboard', booking_id: BK_2B }, 'booking');
    assert.equal(dataOf('booking').business_id, BIZ2B);
    assert.equal(dataOf('booking').booking_id, BK_2B);
  });
  test('an owner of several businesses and no precise id is NOT guessed at', () => {
    post(OWN2, 'business.payment_received', { screen: 'local-business-dashboard' }, 'multi');
    assert.deepEqual(dataOf('multi'), { screen: 'local-business-dashboard' });
  });
  test('a booking at somebody else\'s business is never used to route', () => {
    post(OWN2, 'business.new_booking', { screen: 'local-business-dashboard', booking_id: BK_X }, 'foreign');
    assert.equal(dataOf('foreign').business_id, undefined);
  });
  test('a user with no business, or a malformed booking id, is left alone', () => {
    post(NOBODY, 'business.sale', { screen: 'local-business-dashboard' }, 'nobiz');
    post(OWN1, 'business.new_booking', { screen: 'local-business-dashboard', booking_id: 'not-a-uuid' }, 'badid');
    assert.deepEqual(dataOf('nobiz'), { screen: 'local-business-dashboard' });
    assert.equal(dataOf('badid').business_id, BIZ1, 'falls back to the only business, never errors');
  });
  test('an existing business_id is never overwritten', () => {
    post(OWN1, 'business.sale', { screen: 'local-business-dashboard', business_id: BIZ2A }, 'keep');
    assert.equal(dataOf('keep').business_id, BIZ2A);
  });
  test('THE DEFECT: the employer\'s broken screen is dropped when a shift is known, so the shift opens', () => {
    post(OWN1, 'shifts.withdrawn', { screen: 'employer-applications', shift_id: SHIFT }, 'emp-shift');
    assert.deepEqual(dataOf('emp-shift'), { shift_id: SHIFT });
  });
  test('without a shift id the employer gets the Shifts tab, never a missing screen', () => {
    post(OWN1, 'shifts.new_application', { screen: 'employer-applications' }, 'emp-none');
    post(OWN1, 'shifts.worker_checked_in', { screen: 'my-posted-shifts' }, 'chk-none');
    assert.deepEqual(dataOf('emp-none'), { screen: 'shifts' });
    assert.deepEqual(dataOf('chk-none'), { screen: 'shifts' });
  });
  test('every other notification is passed through untouched', () => {
    for (const [i, d] of [{ screen: 'local-wallet' }, { screen: 'my-event-tickets', order_id: 'o' }, { hub_id: 'h' }, { screen: 'business-orders', business_id: 'b' }].entries()) {
      post(OWN1, 'wallet.topup', d, `plain-${i}`);
      assert.deepEqual(dataOf(`plain-${i}`), d);
    }
    asService(`insert into public.notification_log (user_id, category, title, body, status) values ('${OWN1}', 'games.streak', 'nodata', 'b', 'sent')`);
    assert.equal(scalar(`select data is null from public.notification_log where title='nodata'`), 't');
  });
  test('the routing function is not callable by clients', () => {
    assert.match(asUser(A, 'select public.notification_log_route_compat()'), /permission denied|trigger functions can only be called as triggers/i);
  });
  test('the backfill fixes notifications that are already in the inbox', () => {
    raw(`insert into public.notification_log (user_id, category, title, body, status, data) values
         ('${OWN1}', 'business.sale', 'old-sale', 'b', 'sent', '{"screen":"local-business-dashboard"}'::jsonb);`);
    // inserted as superuser, so the trigger already fixed it; re-break it and re-run the backfill statements
    raw(`update public.notification_log set data = '{"screen":"local-business-dashboard"}'::jsonb where title='old-sale'`);
    const mig = readFileSync(ROUTES, 'utf8');
    raw(mig.slice(mig.indexOf('update public.notification_log n')));
    assert.equal(dataOf('old-sale').business_id, BIZ1);
  });
});
