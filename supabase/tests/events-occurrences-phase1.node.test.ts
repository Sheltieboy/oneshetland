/**
 * events-occurrences-phase1.node.test.ts — ISOLATED Postgres only (PASS_PROOF_DSN, the throwaway cluster). Fake users, no Stripe, no network, no notifications.
 *
 * Replays every REAL migration except the three Phase-1 files (20261230000000/010000/020000) into a private database, seeds production-shaped events BEFORE the
 * Phase-1 migrations, applies them, and proves: occurrence sync + is_dated_run, existing rows unchanged, ticketing safety (triggers, races, reserve_ticket_basket),
 * the RLS matrix, ordinary-member submissions with staff moderation, community attribution, contributor self-service (immediate / moderated / trusted), rollback.
 * Mutation controls rebuild the database with ONE guard weakened and show the same probe then fails.
 *
 * Run: ISOLATED_ONLY=events-occurrences-phase1 npm run test:isolated        (registered in scripts/isolated-pg.mjs; never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(ROOT, 'supabase/migrations');
const ROLL = join(ROOT, 'supabase/rollbacks');
const M1 = '20261230000000_event_occurrences.sql', M2 = '20261230010000_event_member_submissions.sql', M3 = '20261230020000_event_contributor_self_service.sql';
const STOP = '20261230000000';

const id = (n: number) => `${n.toString(16).padStart(2, '0')}000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
const U = { ADMIN: id(1), MOD: id(2), SUB: id(3), OTH: id(4), BIZ: id(5), HUBA: id(6), TRU: id(7), BIZ2: id(8) } as const;
type Who = keyof typeof U | 'anon' | 'nobody' | 'service';
const BZ = id(0x21), BZ2 = id(0x22), HUB = id(0x23);
const E_BIZ = id(0x31), E_HUB = id(0x32), E_PLAT = id(0x33), E_BIZ_TICKETED = id(0x34), E_BIZ2 = id(0x35), E_BIZ_SOLD = id(0x36);
const TT = id(0x41);

/** A refund-shaped transaction (types FOR UPDATE, then UPDATE events) overlapping a sale of the same event. */
async function refundVsSale(e: Env): Promise<{ deadlock: boolean; err: string }> {
  const refund = e.db.bg(`begin; select 1 from event_ticket_types where event_id='${E_BIZ_TICKETED}' order by id for update; select pg_sleep(1.5); update events set tickets_sold = coalesce(tickets_sold, 0) where id='${E_BIZ_TICKETED}'; commit`);
  await new Promise((res) => setTimeout(res, 400));
  const sale = await e.db.bg(`select public.reserve_ticket_basket('${E_BIZ_TICKETED}','${U.OTH}','[{"ticket_type_id":"${TT}","token_hash":"${'b'.repeat(40)}"}]'::jsonb,500,0,'{}'::jsonb,'req-lockorder-001')`);
  const rf = await refund;
  const err = `${rf.stderr}${sale.stderr}`.trim();
  return { deadlock: /deadlock detected/.test(err), err };
}

const COVER = (uid: string) => `https://nkrtmakxygkvxuxriiil.supabase.co/storage/v1/object/public/event-media/${uid}/events/poster.jpg`;

const day = (n: number, h = 19) => { const d = new Date(Date.now() + n * 86400_000); d.setUTCHours(h, 0, 0, 0); return d.toISOString().replace('.000Z', 'Z'); };
const rowsTag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (o: string) => o.split('\n').map((l) => l.trim()).filter((l) => l && !rowsTag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^WARNING|^NOTICE/.test(l));
const last = (o: string) => rowsOf(o).pop() ?? '';
const failed = (o: string) => /ERROR/.test(o);
const okq = (o: string) => !/ERROR|permission denied|row-level security/i.test(o);

class Env {
  db!: ReplayDb;
  name: string;
  constructor(name: string) { this.name = name; }
  roleSql(who: Who) {
    if (who === 'anon') return 'set local role anon;';
    if (who === 'nobody') return 'set local role authenticated;';                // signed in role, NO uid: the NULL auth.uid() case
    if (who === 'service') return 'set local role service_role;';
    return `set local request.jwt.claim.sub = '${U[who]}'; set local role authenticated;`;
  }
  try(who: Who, sql: string) { return this.db.raw(`begin; ${this.roleSql(who)} ${sql}; rollback;`); }
  do(who: Who, sql: string) { return this.db.raw(`begin; ${this.roleSql(who)} ${sql}; commit;`); }
  q(sql: string) { return last(this.db.raw(sql)); }
  sup(sql: string) { return this.db.raw(sql); }
  /** submit as `who`; returns the id or '' */
  submit(who: Who, over: Record<string, unknown> = {}, req = crypto.randomUUID(), age = true) {
    const o = this.do(who, `select public.submit_event_submission($j$${JSON.stringify(this.payload(who, over, req))}$j$::jsonb)`);
    const sid = (last(o).match(/^[0-9a-f-]{36}$/) ?? [''])[0];
    // tests make many submissions as one person: age each one out of the rolling-24h window (the window itself is tested explicitly)
    if (sid && age) this.sup(`update public.event_submissions set created_at = now() - interval '30 hours' where id='${sid}'`);
    return { out: o, id: sid };
  }
  payload(who: Who, over: Record<string, unknown>, req: string) {
    const uid = who in U ? U[who as keyof typeof U] : id(9);
    return { request_id: req, organiser_name: 'Lerwick Players', title: 'Harvest Show', description: 'An evening of songs and sketches in the village hall.', category: 'theatre_performing_arts',
      venue: 'Town Hall', locality: 'Lerwick', price_text: '£8', contact_info: 'players@example.org', ticket_url: 'https://tickets.example.org/harvest', cover_url: COVER(uid),
      occurrences: [{ starts_at: day(10) }], adult_confirmed: true, ...over };
  }
  approve(sid: string, who: Who = 'ADMIN') { return this.do(who, `select public.admin_review_event_submission('${sid}','approve',null)`); }
  eventOf(sid: string) { return this.q(`select event_id from public.event_submissions where id='${sid}'`); }
  /** an approved community event owned (as contributor) by `who`; `dates` = day offsets */
  community(who: Who, dates: number[], extra: Record<string, unknown> = {}) {
    const s = this.submit(who, { occurrences: dates.map((n) => ({ starts_at: day(n) })), ...extra });
    assert.ok(s.id, s.out); const a = this.approve(s.id); assert.ok(okq(a), a);
    return { sid: s.id, eid: this.eventOf(s.id) };
  }
}

const SEED = `
  insert into auth.users (id, email) select x, x::text || '@x.invalid' from unnest(array[${Object.values(U).map((u) => `'${u}'::uuid`).join(',')}]) x on conflict do nothing;
  insert into profiles (id, role) values ('${U.ADMIN}','admin'),('${U.MOD}','moderator'),('${U.SUB}','customer'),('${U.OTH}','customer'),('${U.BIZ}','customer'),('${U.HUBA}','customer'),('${U.TRU}','customer'),('${U.BIZ2}','customer')
    on conflict (id) do update set role = excluded.role;
  insert into local_businesses (id, owner_id, name, slug, category, address) values ('${BZ}','${U.BIZ}','ZZ Biz','zz-biz','retail','1 Street'),('${BZ2}','${U.BIZ2}','ZZ Biz2','zz-biz2','retail','2 Street');
  insert into compliance_log (user_id, user_email, event_type, document_version, metadata) values ('${U.BIZ}','x@x.invalid','business.commercial_terms_accepted', public.commercial_terms_version(), '{"business_id":"${BZ}"}');
  alter table hubs disable trigger tg_zz_lock_hub_columns;
  insert into hubs (id, owner_id, name, slug) values ('${HUB}','${U.HUBA}','ZZ Hub','zz-hub');
  alter table hubs enable trigger tg_zz_lock_hub_columns;
  insert into events (id, organiser_user_id, organiser_business_id, title, starts_at, ends_at, status) values ('${E_BIZ}','${U.BIZ}','${BZ}','Biz plain', now() + interval '5 days', now() + interval '5 days 2 hours', 'published');
  insert into events (id, organiser_user_id, organiser_hub_id, hub_visibility, title, starts_at, status) values ('${E_HUB}','${U.HUBA}','${HUB}','members','Hub members only', now() + interval '6 days', 'published');
  insert into events (id, organiser_user_id, title, starts_at, status, is_platform_event) values ('${E_PLAT}', null, 'OneShetland official', now() + interval '7 days', 'published', true);
  insert into events (id, organiser_user_id, organiser_business_id, title, starts_at, status, has_tickets) values ('${E_BIZ_TICKETED}','${U.BIZ}','${BZ}','Biz ticketed', now() + interval '8 days', 'published', true);
  insert into event_ticket_types (id, event_id, name, price_pence, quantity_available) values ('${TT}','${E_BIZ_TICKETED}','General', 500, 100);
  insert into events (id, organiser_user_id, organiser_business_id, title, starts_at, status, has_tickets) values ('${E_BIZ_SOLD}','${U.BIZ}','${BZ}','Biz sold', now() + interval '9 days', 'published', true);
  insert into events (id, organiser_user_id, organiser_business_id, title, starts_at, status) values ('${E_BIZ2}','${U.BIZ2}','${BZ2}','Biz without terms', now() + interval '9 days', 'published');
`;
const LEGACY_COLS = `id, organiser_user_id, organiser_business_id, organiser_hub_id, title, description, category, venue, starts_at, ends_at, status, is_hidden, has_tickets, is_platform_event, hub_visibility, calendar_approved, tickets_sold, capacity, cover_url, price_text, ticket_url`;

function build(name: string, mutate?: { file: string; find: string | RegExp; replace: string }[]): { env: Env; before: string } {
  const env = new Env(name);
  env.db = createReplayDb(name, { stopBefore: STOP });
  // Supabase hands every new function to anon/authenticated by default; reproduce it so a missing REVOKE is visible
  env.sup(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated;`);
  const s = env.sup(SEED); assert.doesNotMatch(s, /ERROR/, s);
  env.sup(`insert into event_ticket_orders (id, event_id, buyer_id, status) values ('${id(0x51)}','${E_BIZ_SOLD}','${U.OTH}','paid')`);
  const before = env.q(`select md5(string_agg(t::text, '|' order by id)) from (select ${LEGACY_COLS} from events) t`);
  const dir = mkdtempSync(join(tmpdir(), 'evocc-'));
  try {
    for (const f of [M1, M2, M3]) {
      let sql = readFileSync(join(MIG, f), 'utf8');
      for (const m of (mutate ?? []).filter((x) => x.file === f)) { const n = sql.replace(m.find as any, m.replace); assert.notEqual(n, sql, `mutation did not apply: ${String(m.find).slice(0, 60)}`); sql = n; }
      const p = join(dir, f); writeFileSync(p, sql);
      const o = env.db.rawFile(p); assert.doesNotMatch(o.replace(/NOTICE.*/g, ''), /ERROR/, `${f}:\n${o.slice(0, 1200)}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return { env, before };
}

let E: Env, BEFORE = '';
const openSwitch = () => E.sup(`insert into admin_config (key, value, category) values ('events.member_submissions','open','events') on conflict (key) do update set value='open'`);
const closeSwitch = () => E.sup(`delete from admin_config where key='events.member_submissions'`);
const notifCount = () => Number(E.q('select count(*) from notification_log'));
let NOTIF0 = 0;

before(() => { const b = build('evocc'); E = b.env; BEFORE = b.before; NOTIF0 = notifCount(); });
after(() => { try { E?.db.drop(); } catch { /* */ } });

describe('existing rows and schema', () => {
  test('existing events are byte-identical, with the new columns at their defaults', () => {
    assert.equal(E.q(`select md5(string_agg(t::text, '|' order by id)) from (select ${LEGACY_COLS} from events) t`), BEFORE);
    assert.equal(E.q(`select count(*) from events where is_dated_run or organiser_name is not null or source is not null or submission_id is not null`), '0');
    assert.equal(E.q(`select count(*) from event_occurrences`), '0');
    assert.equal(E.q(`select count(*) from pg_indexes where indexname='idx_events_starts_at'`), '1');
  });
  test('a staff-created platform event stays OFFICIAL (is_platform_event, source null)', () => {
    assert.equal(E.q(`select is_platform_event::text || '/' || coalesce(source,'null') from events where id='${E_PLAT}'`), 'true/null');
  });
  test('the attribution CHECK and the events policies are unchanged', () => {
    assert.match(E.q(`select pg_get_constraintdef(oid) from pg_constraint where conname='events_attribution_exclusive'`), /is_platform_event AND \(organiser_business_id IS NULL\) AND \(organiser_hub_id IS NULL\)/);
    // the five original policies are untouched; the only addition is the contributor's read of their OWN community event (migration 3)
    assert.equal(E.q(`select count(*) from pg_policies where tablename='events' and policyname <> 'events_contributor_read'`), '5');
    assert.equal(E.q(`select string_agg(policyname,',') from pg_policies where tablename='events' and policyname = 'events_contributor_read'`), 'events_contributor_read');
  });
  test('an ordinary member cannot insert an event directly, nor an occurrence, nor a submission row', () => {
    assert.ok(failed(E.try('OTH', `insert into events (organiser_user_id, title, starts_at, status, is_platform_event) values ('${U.OTH}','x',now()+interval '1 day','published', true)`)));
    assert.ok(failed(E.try('OTH', `insert into events (organiser_user_id, title, starts_at, status) values ('${U.OTH}','x',now()+interval '1 day','published')`)));
    assert.ok(failed(E.try('OTH', `insert into event_occurrences (event_id, starts_at) values ('${E_BIZ}', now() + interval '20 days')`)));
    assert.match(E.try('OTH', `insert into event_submissions (submitter_id, organiser_name, title, description, category, venue, occurrences, adult_confirmed, request_id) values ('${U.OTH}','a','b','c','other','v','[{}]',true,gen_random_uuid())`), /permission denied/);
    assert.match(E.try('OTH', `update event_submissions set status='approved'`), /permission denied/);
    assert.match(E.try('OTH', `delete from event_submissions`), /permission denied/);
  });
});

describe('occurrence sync and is_dated_run', () => {
  const o = [day(20, 18), day(21, 18), day(22, 18)];
  const ev = () => E.q(`select to_char(starts_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') || '|' || coalesce(to_char(ends_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'') || '|' || is_dated_run from events where id='${E_BIZ}'`);
  test('insert / update / cancel / delete keep the parent in step; a run is never a continuous span', () => {
    E.sup(`insert into event_occurrences (id, event_id, starts_at, ends_at) values ('${id(0x61)}','${E_BIZ}','${o[0]}','${day(20, 20)}')`);
    assert.equal(ev(), `${o[0]}|${day(20, 20)}|false`, 'one row: a plain one-off, not a run');
    E.sup(`insert into event_occurrences (id, event_id, starts_at, ends_at) values ('${id(0x62)}','${E_BIZ}','${o[1]}','${day(21, 20)}'),('${id(0x63)}','${E_BIZ}','${o[2]}',null)`);
    assert.equal(ev(), `${o[0]}|${o[2]}|true`, 'earliest start; latest end = coalesce(ends_at, starts_at)');
    E.sup(`update event_occurrences set status='cancelled' where id='${id(0x61)}'`);
    assert.equal(ev(), `${o[1]}|${o[2]}|true`, 'a cancelled first night no longer starts the event');
    E.sup(`update event_occurrences set ends_at = '${day(22, 23)}' where id='${id(0x63)}'`);
    assert.equal(ev(), `${o[1]}|${day(22, 23)}|true`);
    E.sup(`update event_occurrences set status='cancelled'`);
    assert.equal(ev(), `${o[0]}|${o[2] === o[2] ? day(22, 23) : ''}|true`, 'all cancelled: earliest of all, latest of all');
    E.sup(`update event_occurrences set status='scheduled' where id='${id(0x62)}'`);
    assert.equal(ev().split('|')[0], o[1]);
    E.sup(`delete from event_occurrences where id in ('${id(0x62)}','${id(0x63)}')`);
    assert.equal(E.q(`select is_dated_run from events where id='${E_BIZ}'`), 'f', 'one row left: no longer a run');
    E.sup(`delete from event_occurrences where event_id='${E_BIZ}'`);
    assert.equal(E.q(`select count(*) from events where id='${E_BIZ}'`), '1', 'the event row is never lost');
  });
  test('moving an occurrence to another event is refused; deleting the parent cascades cleanly', () => {
    E.sup(`insert into event_occurrences (id, event_id, starts_at) values ('${id(0x64)}','${E_BIZ}','${o[0]}')`);
    assert.match(E.sup(`update event_occurrences set event_id='${E_PLAT}' where id='${id(0x64)}'`), /cannot be moved/);
    E.sup(`insert into events (id, organiser_user_id, organiser_business_id, title, starts_at, status) values ('${id(0x65)}','${U.BIZ}','${BZ}','tmp',now()+interval '3 days','draft');
           insert into event_occurrences (event_id, starts_at) values ('${id(0x65)}', now() + interval '4 days'), ('${id(0x65)}', now() + interval '5 days')`);
    assert.ok(okq(E.sup(`delete from events where id='${id(0x65)}'`)));
    E.sup(`delete from event_occurrences where event_id='${E_BIZ}'`);
  });
  test('unique (event_id, starts_at) and ends_at > starts_at', () => {
    E.sup(`insert into event_occurrences (event_id, starts_at) values ('${E_BIZ}','${o[0]}')`);
    assert.match(E.sup(`insert into event_occurrences (event_id, starts_at) values ('${E_BIZ}','${o[0]}')`), /duplicate key/);
    assert.match(E.sup(`insert into event_occurrences (event_id, starts_at, ends_at) values ('${E_BIZ}','${o[1]}','${o[0]}')`), /ends_after_starts/);
    E.sup(`delete from event_occurrences where event_id='${E_BIZ}'`);
  });
});

describe('who can write occurrences (RLS matrix) and the sync trigger under real roles', () => {
  const cleanup = () => E.sup(`delete from event_occurrences where event_id in ('${E_BIZ}','${E_HUB}','${E_PLAT}','${E_BIZ2}')`);
  test('owner of the business, hub admin and staff can; other members, anon and a NULL uid cannot', () => {
    const ins = (ev: string, d: number) => `insert into event_occurrences (event_id, starts_at) values ('${ev}', '${day(d)}')`;
    assert.ok(okq(E.do('BIZ', ins(E_BIZ, 30))), 'business owner');
    assert.ok(okq(E.do('BIZ', ins(E_BIZ, 31))));
    assert.equal(E.q(`select is_dated_run from events where id='${E_BIZ}'`), 't', 'the sync ran for the OWNER (definer path passes the attribution guard)');
    assert.ok(okq(E.do('HUBA', ins(E_HUB, 30))), 'hub owner/admin');
    assert.ok(okq(E.do('ADMIN', ins(E_PLAT, 30))), 'staff on a platform event');
    assert.ok(okq(E.do('MOD', ins(E_PLAT, 31))), 'moderator too');
    assert.equal(E.q(`select is_dated_run from events where id='${E_PLAT}'`), 't');
    for (const w of ['OTH', 'SUB', 'BIZ2', 'HUBA'] as Who[]) assert.ok(failed(E.try(w, ins(E_BIZ, 40))), `${w} cannot write a business event`);
    assert.ok(failed(E.try('BIZ', ins(E_PLAT, 40))), 'a business owner cannot write a platform event');
    assert.ok(failed(E.try('anon', ins(E_BIZ, 40))));
    assert.ok(failed(E.try('nobody', ins(E_BIZ, 40))), 'NULL auth.uid()');
    E.do('OTH', `update event_occurrences set status='cancelled' where event_id='${E_BIZ}'`);
    assert.equal(E.q(`select count(*) from event_occurrences where status='cancelled'`), '0', 'a non-owner update changed nothing');
    assert.equal(E.do('OTH', `delete from event_occurrences where event_id='${E_BIZ}'`).includes('ERROR'), false);
    assert.equal(E.q(`select count(*) from event_occurrences where event_id='${E_BIZ}'`), '2', 'a non-owner delete removed nothing');
    cleanup();
  });
  test('the owner edits and cancels; the sync works for them; direct parent time edits are refused while occurrences exist', () => {
    E.do('BIZ', `insert into event_occurrences (id, event_id, starts_at) values ('${id(0x66)}','${E_BIZ}','${day(30)}'),('${id(0x67)}','${E_BIZ}','${day(31)}')`);
    assert.ok(okq(E.do('BIZ', `update event_occurrences set status='cancelled' where id='${id(0x66)}'`)));
    assert.equal(E.q(`select to_char(starts_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') from events where id='${E_BIZ}'`), day(31));
    assert.match(E.try('BIZ', `update events set starts_at = starts_at + interval '1 day' where id='${E_BIZ}'`), /dated occurrences/);
    assert.ok(okq(E.do('BIZ', `update events set title='renamed' where id='${E_BIZ}'`)), 'other edits still work');
    assert.match(E.try('BIZ', `update events set is_dated_run=false where id='${E_BIZ}'`), /^(?![\s\S]*ERROR)/);
    assert.equal(E.q(`select is_dated_run from events where id='${E_BIZ}'`), 't', 'a client cannot forge is_dated_run');
    cleanup(); E.sup(`update events set title='Biz plain' where id='${E_BIZ}'`);
  });
  test('a client-inserted event cannot start life as a dated run', () => {
    E.do('BIZ', `insert into events (id, organiser_user_id, organiser_business_id, title, starts_at, status, is_dated_run) values ('${id(0x68)}','${U.BIZ}','${BZ}','forge',now()+interval '3 days','draft',true)`);
    assert.equal(E.q(`select is_dated_run from events where id='${id(0x68)}'`), 'f');
    E.sup(`delete from events where id='${id(0x68)}'`);
  });
  test('read follows the parent: a hub members-only event hides its occurrences from the public', () => {
    E.sup(`insert into event_occurrences (event_id, starts_at) values ('${E_HUB}','${day(30)}'),('${E_BIZ}','${day(30)}')`);
    assert.equal(last(E.try('anon', `select count(*) from event_occurrences`)), '1', 'anon sees only the public event');
    assert.equal(last(E.try('OTH', `select count(*) from event_occurrences`)), '1');
    assert.equal(last(E.try('HUBA', `select count(*) from event_occurrences`)), '2', 'the hub admin sees both');
    assert.equal(last(E.try('ADMIN', `select count(*) from event_occurrences`)), '2');
    E.sup(`update events set status='draft' where id='${E_BIZ}'`);
    assert.equal(last(E.try('anon', `select count(*) from event_occurrences`)), '0', 'a hidden parent hides its dates');
    E.sup(`update events set status='published' where id='${E_BIZ}'`); cleanup();
  });
  test('characterisation: a business that has not accepted the selling terms cannot change dates (same as editing the event)', () => {
    const o = E.try('BIZ2', `insert into event_occurrences (event_id, starts_at) values ('${E_BIZ2}','${day(30)}'), ('${E_BIZ2}','${day(31)}')`);
    assert.match(o, /Accept the business & selling terms/);
  });
});

describe('ticketing safety', () => {
  const sold = id(0x70);
  test('an event with 2+ live occurrences cannot get an active ticket type; a cancelled one does not count', () => {
    E.sup(`insert into event_occurrences (event_id, starts_at) values ('${E_BIZ}','${day(30)}'),('${E_BIZ}','${day(31)}')`);
    assert.match(E.sup(`insert into event_ticket_types (event_id, name, price_pence) values ('${E_BIZ}','Adult',500)`), /more than one date/);
    assert.match(E.try('BIZ', `insert into event_ticket_types (event_id, name, price_pence) values ('${E_BIZ}','Adult',500)`), /more than one date/);
    E.sup(`update event_occurrences set status='cancelled' where event_id='${E_BIZ}' and starts_at='${day(31)}'`);
    assert.ok(okq(E.sup(`insert into event_ticket_types (id, event_id, name, price_pence, is_active) values ('${sold}','${E_BIZ}','Adult',500,false)`)), 'one live date: allowed (inactive here)');
    assert.match(E.sup(`update event_occurrences set status='scheduled' where event_id='${E_BIZ}'`), /^(?![\s\S]*ERROR)/, 'an INACTIVE type does not block a second date');
    assert.match(E.sup(`update event_ticket_types set is_active = true where id='${sold}'`), /more than one date/, 'reactivation is blocked while it is a run');
    E.sup(`delete from event_ticket_types where id='${sold}'; delete from event_occurrences where event_id='${E_BIZ}'`);
  });
  test('an event with an active ticket type, a ticket or an order cannot gain a second date; a first date is fine', () => {
    assert.ok(okq(E.sup(`insert into event_occurrences (id, event_id, starts_at) values ('${id(0x71)}','${E_BIZ_TICKETED}','${day(30)}')`)));
    assert.match(E.sup(`insert into event_occurrences (event_id, starts_at) values ('${E_BIZ_TICKETED}','${day(31)}')`), /sells tickets through OneShetland/);
    assert.match(E.try('BIZ', `insert into event_occurrences (event_id, starts_at) values ('${E_BIZ_TICKETED}','${day(31)}')`), /sells tickets/);
    assert.match(E.sup(`insert into event_occurrences (event_id, starts_at) values ('${E_BIZ_SOLD}','${day(30)}'),('${E_BIZ_SOLD}','${day(31)}')`), /sells tickets/, 'a paid order, no type, still blocks');
    E.sup(`update event_ticket_types set is_active=false where id='${TT}'`);
    assert.ok(okq(E.sup(`insert into event_occurrences (event_id, starts_at) values ('${E_BIZ_TICKETED}','${day(31)}')`)), 'inactive types with no sales do not block');
    E.sup(`delete from event_occurrences where event_id in ('${E_BIZ_TICKETED}','${E_BIZ_SOLD}')`);
    E.sup(`update event_ticket_types set is_active=true where id='${TT}'`);
  });
  test('has_tickets and an external ticket_url are not gated', () => {
    E.sup(`update events set has_tickets=true, ticket_url='https://tickets.example.org/x' where id='${E_BIZ}'`);
    assert.ok(okq(E.sup(`insert into event_occurrences (event_id, starts_at) values ('${E_BIZ}','${day(30)}'),('${E_BIZ}','${day(31)}')`)));
    assert.ok(okq(E.sup(`update events set has_tickets=true where id='${E_BIZ}'`)));
    E.sup(`delete from event_occurrences where event_id='${E_BIZ}'; update events set has_tickets=false, ticket_url=null where id='${E_BIZ}'`);
  });
  test('reserve_ticket_basket raises MULTI_PERFORMANCE for a run, and still sells a one-off', () => {
    const basket = (ev: string, req: string) => `select public.reserve_ticket_basket('${ev}','${U.OTH}','[{"ticket_type_id":"${TT}","token_hash":"${'a'.repeat(40)}"}]'::jsonb,500,0,'{}'::jsonb,'${req}')`;
    { const o = E.sup(basket(E_BIZ_TICKETED, 'req-one-off-0001')); assert.ok(okq(o), o); }
    // make the ticketed event a run behind the triggers' back (a superuser bypass), as old data or a bug might: the sale path must still refuse
    E.sup(`alter table event_occurrences disable trigger tg_event_occurrences_guard; insert into event_occurrences (event_id, starts_at) values ('${E_BIZ_TICKETED}','${day(30)}'),('${E_BIZ_TICKETED}','${day(31)}'); alter table event_occurrences enable trigger tg_event_occurrences_guard`);
    assert.match(E.sup(basket(E_BIZ_TICKETED, 'req-run-000002')), /MULTI_PERFORMANCE/);
    assert.ok(okq(E.sup(basket(E_BIZ_TICKETED, 'req-one-off-0001'))), 'a retry of an order placed BEFORE it became a run is still answered');
    E.sup(`delete from event_occurrences where event_id='${E_BIZ_TICKETED}'`);
  });
  test('race: adding a second date while a ticket type is being created — exactly one wins', async () => {
    E.sup(`insert into event_occurrences (event_id, starts_at) values ('${E_BIZ}','${day(30)}')`);
    const a = E.db.bg(`begin; insert into event_ticket_types (event_id, name, price_pence) values ('${E_BIZ}','Race',100); select pg_sleep(1.5); commit`);
    await new Promise((r) => setTimeout(r, 400));
    const b = await E.db.bg(`insert into event_occurrences (event_id, starts_at) values ('${E_BIZ}','${day(31)}')`);
    const ra = await a;
    const created = Number(E.q(`select count(*) from event_ticket_types where event_id='${E_BIZ}'`)), occ = Number(E.q(`select count(*) from event_occurrences where event_id='${E_BIZ}'`));
    assert.ok(!/ERROR/.test(ra.stderr), 'the ticket type commits first');
    assert.match(b.stderr, /sells tickets/, 'the second date is refused once it sees the committed type');
    assert.deepEqual([created, occ], [1, 1]);
    E.sup(`delete from event_ticket_types where event_id='${E_BIZ}'; delete from event_occurrences where event_id='${E_BIZ}'`);
  });
  test('race: the other order — a second date in flight blocks the ticket type', async () => {
    E.sup(`insert into event_occurrences (event_id, starts_at) values ('${E_BIZ}','${day(30)}')`);
    const a = E.db.bg(`begin; insert into event_occurrences (event_id, starts_at) values ('${E_BIZ}','${day(31)}'); select pg_sleep(1.5); commit`);
    await new Promise((r) => setTimeout(r, 400));
    const b = await E.db.bg(`insert into event_ticket_types (event_id, name, price_pence) values ('${E_BIZ}','Race2',100)`);
    await a;
    assert.match(b.stderr, /more than one date/);
    assert.equal(E.q(`select count(*) from event_ticket_types where event_id='${E_BIZ}'`), '0');
    E.sup(`delete from event_occurrences where event_id='${E_BIZ}'`);
  });
  test('lock order: a refund and a sale of the same event never deadlock', async () => {
    // refund_event_tickets_for_payment() locks ticket types FIRST, then UPDATEs the event row (tickets_sold). reserve_ticket_basket() takes a lock on the
    // event row before locking the types. A lock that conflicts with that UPDATE (FOR SHARE) would make the two wait for each other forever.
    const r = await refundVsSale(E);
    assert.equal(r.deadlock, false, `deadlock detected: ${r.err}`);
    assert.equal(r.err, '', `both statements should finish cleanly, got: ${r.err}`);
  });
  test('reserve_ticket_basket keeps its live signature and permissions: server role only, SECURITY DEFINER, search_path=public, one overload', () => {
    const fn = `'public.reserve_ticket_basket(uuid,uuid,jsonb,integer,integer,jsonb,text)'::regprocedure`;
    assert.equal(E.q(`select count(*) from pg_proc where proname='reserve_ticket_basket' and pronamespace='public'::regnamespace`), '1', 'no second overload');
    assert.equal(E.q(`select prosecdef from pg_proc where oid=${fn}`), 't');
    assert.match(E.q(`select proconfig::text from pg_proc where oid=${fn}`), /search_path=public/);
    assert.equal(E.q(`select pg_get_function_result(${fn.replace('::regprocedure', '::regprocedure::oid')})`), 'jsonb');
    for (const role of ['anon', 'authenticated']) assert.equal(E.q(`select has_function_privilege('${role}', ${fn}, 'execute')`), 'f', `${role} must not be able to execute it (live: only postgres and service_role)`);
    assert.equal(E.q(`select has_function_privilege('service_role', ${fn}, 'execute')`), 't');
  });
  test('the REAL refund function and the corrected reserve_ticket_basket coexist: the refund frees a seat, an overlapping sale takes one, counters stay exact', async () => {
    const basket = (req: string, hash: string) => `select public.reserve_ticket_basket('${E_BIZ_TICKETED}','${U.OTH}','[{"ticket_type_id":"${TT}","token_hash":"${hash.repeat(40)}"}]'::jsonb,500,0,'{}'::jsonb,'${req}')->>'order_id'`;
    const order = E.q(basket('req-real-refund-1', 'd'));
    assert.match(order, /^[0-9a-f-]{36}$/, `the first sale must succeed: ${order}`);
    E.sup(`update event_ticket_orders set status='paid', paid_at=now(), stripe_payment_intent_id='pi_lockorder_real' where id='${order}'; update event_tickets set status='valid' where order_id='${order}'`);
    const before = Number(E.q(`select quantity_sold from event_ticket_types where id='${TT}'`));
    const refundTx = E.db.bg(`begin; select public.refund_event_tickets_for_payment('pi_lockorder_real', true); select pg_sleep(1.2); commit`);
    await new Promise((res) => setTimeout(res, 300));
    const sale = await E.db.bg(basket('req-real-refund-2', 'e'));
    const rf = await refundTx;
    assert.doesNotMatch(`${rf.stderr}${sale.stderr}`, /ERROR|deadlock/i, `refund: ${rf.stderr} sale: ${sale.stderr}`);
    assert.equal(Number(E.q(`select quantity_sold from event_ticket_types where id='${TT}'`)), before, 'one seat freed by the refund, one taken by the sale');
    assert.equal(E.q(`select status from event_ticket_orders where stripe_payment_intent_id='pi_lockorder_real'`), 'refunded');
  });
});

describe('member submissions: switch, validation, limits, idempotency', () => {
  test('closed by default; ordinary members refused; staff may submit for acceptance testing', () => {
    assert.equal(E.q(`select count(*) from admin_config where key='events.member_submissions'`), '0', 'no config row is inserted');
    assert.equal(E.q(`select public.event_submissions_open()`), 'f');
    assert.match(E.submit('SUB').out, /not open yet/);
    { const a = E.submit('ADMIN'); assert.ok(a.id, a.out); }
    for (const v of ['closed', 'OPEN-ish', 'true', '']) { E.sup(`insert into admin_config (key,value,category) values ('events.member_submissions','${v}','events') on conflict (key) do update set value='${v}'`); assert.match(E.submit('SUB').out, /not open yet/, v); }
    E.sup(`update admin_config set value=' OPEN ' where key='events.member_submissions'`);
    assert.ok(E.submit('SUB').id, "exactly 'open' (trimmed, any case) opens it");
    E.sup(`delete from event_submissions`); openSwitch();
  });
  test('NULL caller, anon and signed-out are refused; anon has no EXECUTE on any new function', () => {
    const p = `$j$${JSON.stringify(E.payload('SUB', {}, crypto.randomUUID()))}$j$::jsonb`;
    assert.match(E.try('nobody', `select public.submit_event_submission(${p})`), /Please sign in/);
    assert.match(E.try('anon', `select public.submit_event_submission(${p})`), /permission denied/);
    assert.match(E.try('nobody', `select public.withdraw_event_submission('${id(1)}')`), /Please sign in/);
    assert.match(E.try('nobody', `select public.admin_review_event_submission('${id(1)}','approve',null)`), /Please sign in/);
    assert.match(E.try('nobody', `select * from public.admin_event_submission_counts()`), /Please sign in/);
    const exposed = E.q(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p where p.pronamespace='public'::regnamespace and has_function_privilege('anon', p.oid, 'execute')
       and p.proname in ('submit_event_submission','withdraw_event_submission','admin_review_event_submission','admin_set_occurrence_status','admin_event_submission_counts','admin_list_event_submissions','event_submissions_open','event_category_label','event_clean_field','event_validate_occurrences','event_submission_ts','event_submission_text_problem',
       'event_has_ticketing','event_has_occurrences','tg_event_occurrences_sync','tg_event_occurrences_guard','tg_events_occurrence_guard','tg_event_ticket_types_run_guard','report_performance_cancelled','report_performance_restored','set_performance_note','report_event_cancelled','report_event_restored','request_event_change','withdraw_event_change','admin_review_event_change','admin_set_organiser_trust','admin_list_event_changes','admin_event_change_counts','event_log','is_event_contributor','event_apply_change','is_trusted_organiser','event_has_future_date','event_current_future_dates','event_dates_ticket_problem','event_clean_note','tg_event_submissions_touch')`);
    assert.equal(exposed, '', `anon can execute: ${exposed}`);
    assert.equal(E.q(`select count(*) from information_schema.table_privileges where grantee='anon' and table_name in ('event_occurrences','event_submissions','event_change_requests','event_organiser_trust','event_change_log') and privilege_type <> 'SELECT'`), '0');
    assert.equal(E.q(`select has_table_privilege('anon','event_submissions','select') or has_table_privilege('anon','event_change_log','select') or has_table_privilege('anon','event_organiser_trust','select')`), 'f');
  });
  const bad: [string, Record<string, unknown>, RegExp][] = [
    ['past date', { occurrences: [{ starts_at: day(-1) }] }, /future/],
    ['61 occurrences', { occurrences: Array.from({ length: 61 }, (_, i) => ({ starts_at: day(2 + i) })) }, /up to 60/],
    ['no occurrences', { occurrences: [] }, /at least one date/],
    ['span over 400 days', { occurrences: [{ starts_at: day(5) }, { starts_at: day(420) }] }, /400 days/],
    ['end before start', { occurrences: [{ starts_at: day(5), ends_at: day(4) }] }, /after its start/],
    ['no time zone', { occurrences: [{ starts_at: '2099-01-01T10:00:00' }] }, /time zone/],
    ['duplicate start', { occurrences: [{ starts_at: day(5) }, { starts_at: day(5) }] }, /twice/],
    ['link in description', { description: 'Tickets at https://evil.example/x' }, /Links are not allowed/],
    ['bare domain in description', { description: 'See shetlandevents.com for more' }, /Web addresses/],
    ['phone in description', { description: 'Call 01595 693000 to book' }, /Phone numbers/],
    ['email in description', { description: 'Write to me@example.org' }, /Email addresses/],
    ['link in title', { title: 'www.free-stuff.example' }, /Links are not allowed/],
    ['bad category', { category: 'music' }, /category/],
    ['missing category', { category: undefined }, /category/],
    ['adult not confirmed', { adult_confirmed: false }, /18 or over/],
    ['adult missing', { adult_confirmed: undefined }, /18 or over/],
    ['http ticket link', { ticket_url: 'http://tickets.example.org' }, /https/],
    ['cover from elsewhere', { cover_url: 'https://evil.example/poster.jpg' }, /Upload the picture/],
    ["someone else's cover", { cover_url: COVER(id(0x99)) }, /Upload the picture/],
    ['blank title', { title: '   ' }, /title/],
    ['lat without lng', { lat: 60.1 }, /both a latitude/],
    ['number as text field', { venue: 5 }, /must be text/],
    ['note with link', { occurrences: [{ starts_at: day(5), note: 'see http://x.example' }] }, /Links/],
    ['no request id', { request_id: undefined }, /request id/],
  ];
  for (const [name, over, re] of bad) test(`rejects: ${name}`, () => {
    const o = E.do('SUB', `select public.submit_event_submission($j$${JSON.stringify({ ...E.payload('SUB', {}, crypto.randomUUID()), ...over })}$j$::jsonb)`);
    assert.match(o, re, o);
    assert.equal(E.q(`select count(*) from event_submissions where submitter_id='${U.SUB}'`), '0');
  });
  test('a date such as 12-11-2026 in a description is not mistaken for a phone number; a normal submission stores a normalised row', () => {
    const s = E.submit('SUB', { description: 'Doors 7pm on 12-11-2026, tickets £8.', locality: null, ticket_url: null, occurrences: [{ starts_at: day(30, 20) }, { starts_at: day(9, 18), note: 'Preview night' }] });
    assert.ok(s.id, s.out);
    assert.equal(E.q(`select occurrences -> 0 ->> 'note' from event_submissions where id='${s.id}'`), 'Preview night', 'sorted by start');
    assert.equal(E.q(`select status || '/' || adult_confirmed from event_submissions where id='${s.id}'`), 'pending/true');
    E.sup(`delete from event_submissions`);
  });
  test('limits: 3 pending, 10 per rolling 24h, global cap; withdrawn frees a slot', () => {
    const ids = [1, 2, 3].map(() => E.submit('SUB').id); assert.ok(ids.every(Boolean));
    assert.match(E.submit('SUB').out, /3 submissions waiting/);
    assert.ok(E.submit('OTH').id, 'another person is unaffected');
    assert.equal(last(E.do('SUB', `select public.withdraw_event_submission('${ids[0]}')`)), 'withdrawn');
    assert.ok(E.submit('SUB').id, 'a slot is free again');
    E.sup(`delete from event_submissions`);
    E.sup(`insert into event_submissions (submitter_id, status, organiser_name, title, description, category, venue, occurrences, adult_confirmed, request_id)
           select '${U.SUB}', 'rejected', 'a','t','d','other','v','[{"starts_at":"${day(5)}"}]', true, gen_random_uuid() from generate_series(1,10)`);
    assert.match(E.submit('SUB').out, /10 submissions in any 24 hours/);
    E.sup(`update event_submissions set created_at = now() - interval '25 hours'`);
    assert.ok(E.submit('SUB').id, 'older than 24h no longer counts');
    E.sup(`delete from event_submissions`);
    E.sup(`insert into event_submissions (submitter_id, status, organiser_name, title, description, category, venue, occurrences, adult_confirmed, request_id)
           select '${U.OTH}', 'pending', 'a','t','d','other','v','[{"starts_at":"${day(5)}"}]', true, gen_random_uuid() from generate_series(1,500)`);
    assert.match(E.submit('SUB').out, /lot of submissions waiting/);
    E.sup(`delete from event_submissions`);
  });
  test('idempotent on request_id; concurrent duplicates make one row', async () => {
    const req = crypto.randomUUID();
    const a = E.submit('SUB', {}, req), b = E.submit('SUB', { title: 'different retry body' }, req);
    assert.equal(a.id, b.id); assert.equal(E.q(`select count(*) from event_submissions`), '1');
    E.sup(`delete from event_submissions`);
    const sql = `set local request.jwt.claim.sub='${U.SUB}'; set local role authenticated; select public.submit_event_submission($j$${JSON.stringify(E.payload('SUB', {}, req))}$j$::jsonb)`;
    await Promise.all([E.db.bg(`begin; ${sql}; commit`), E.db.bg(`begin; ${sql}; commit`), E.db.bg(`begin; ${sql}; commit`)]);
    assert.equal(E.q(`select count(*) from event_submissions`), '1');
    E.sup(`delete from event_submissions`);
  });
  test('submission RLS: owner reads own; others and anon do not; staff read all; no direct writes', () => {
    const s = E.submit('SUB'); assert.ok(s.id);
    assert.equal(last(E.try('SUB', `select count(*) from event_submissions`)), '1');
    assert.equal(last(E.try('OTH', `select count(*) from event_submissions`)), '0');
    assert.equal(last(E.try('MOD', `select count(*) from event_submissions`)), '1');
    assert.match(E.try('anon', `select count(*) from event_submissions`), /permission denied/);
    assert.equal(last(E.try('nobody', `select count(*) from event_submissions`)), '0');
    E.sup(`delete from event_submissions`);
  });
});

describe('moderation: approve, reject, changes, withdraw', () => {
  test('a submitter cannot approve, reject or see the queue; withdraw is owner-only and pending/changes_requested-only', () => {
    const s = E.submit('SUB').id;
    for (const w of ['SUB', 'OTH', 'BIZ', 'HUBA'] as Who[]) {
      assert.match(E.try(w, `select public.admin_review_event_submission('${s}','approve',null)`), /Only OneShetland staff/, w);
      assert.match(E.try(w, `select * from public.admin_event_submission_counts()`), /Only OneShetland staff/, w);
    }
    assert.match(E.try('OTH', `select public.withdraw_event_submission('${s}')`), /cannot withdraw/);
    assert.equal(E.q(`select status from event_submissions where id='${s}'`), 'pending');
    assert.equal(E.q(`select count(*) from events where source='community_submission'`), '0');
    E.sup(`delete from event_submissions`);
  });
  test('approve: ONE community event, platform-owned, published, no tickets; single date => no occurrence rows', () => {
    const s = E.submit('SUB', { occurrences: [{ starts_at: day(12), ends_at: day(12, 21) }] }).id;
    const o = E.approve(s); assert.ok(okq(o), o);
    const ev = E.eventOf(s); assert.match(ev, /^[0-9a-f-]{36}$/);
    assert.equal(E.q(`select concat_ws('|', is_platform_event, source, organiser_name, status, is_hidden, has_tickets, coalesce(organiser_business_id::text,'-'), coalesce(organiser_hub_id::text,'-'), organiser_user_id = '${U.SUB}', category, is_dated_run, submission_id = '${s}') from events where id='${ev}'`),
      't|community_submission|Lerwick Players|published|f|f|-|-|t|Theatre & Performing Arts|f|t');
    assert.equal(E.q(`select count(*) from event_occurrences where event_id='${ev}'`), '0');
    assert.equal(E.q(`select status || '|' || (event_id = '${ev}') || '|' || (reviewed_by = '${U.ADMIN}') from event_submissions where id='${s}'`), 'approved|true|true');
  });
  test('double approve creates one event (sequential and concurrent)', async () => {
    const s = E.submit('SUB').id;
    const a = E.approve(s), b = E.approve(s, 'MOD');
    assert.match(b, /"duplicate": true/); assert.equal(E.q(`select count(*) from events where submission_id='${s}'`), '1');
    const s2 = E.submit('OTH').id;
    const sql = `set local request.jwt.claim.sub='${U.ADMIN}'; set local role authenticated; select public.admin_review_event_submission('${s2}','approve',null)`;
    await Promise.all([E.db.bg(`begin; ${sql}; commit`), E.db.bg(`begin; ${sql}; commit`)]);
    assert.equal(E.q(`select count(*) from events where submission_id='${s2}'`), '1');
    void a;
  });
  test('a run creates occurrence rows, the parent spans them and is flagged a dated run; the submitter gets NO write access', () => {
    const { eid } = E.community('SUB', [20, 21, 27]);
    assert.equal(E.q(`select count(*) from event_occurrences where event_id='${eid}'`), '3');
    assert.equal(E.q(`select is_dated_run from events where id='${eid}'`), 't');
    assert.equal(E.q(`select to_char(starts_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') from events where id='${eid}'`), day(20));
    assert.equal(E.q(`select to_char(ends_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') from events where id='${eid}'`), day(27));
    for (const sql of [`update events set title='hack' where id='${eid}'`, `update events set status='draft' where id='${eid}'`, `update events set is_featured=true where id='${eid}'`, `update events set is_hidden=true where id='${eid}'`,
      `delete from events where id='${eid}'`]) {
      E.do('SUB', sql);
    }
    assert.equal(E.q(`select title || '|' || status || '|' || is_featured from events where id='${eid}'`), 'Harvest Show|published|false', 'RLS stopped every direct write');
    assert.ok(failed(E.try('SUB', `insert into event_occurrences (event_id, starts_at) values ('${eid}', now() + interval '90 days')`)));
    assert.ok(failed(E.try('SUB', `update event_occurrences set status='cancelled' where event_id='${eid}'`)) || E.q(`select count(*) from event_occurrences where status='cancelled' and event_id='${eid}'`) === '0');
  });
  test('community event never lacks an organiser name: approval, constraint and client writes', () => {
    assert.match(E.sup(`insert into events (title, starts_at, status, is_platform_event, source) values ('x', now(), 'draft', true, 'community_submission')`), /events_community_needs_organiser/);
    assert.match(E.sup(`insert into events (title, starts_at, status, is_platform_event, source, organiser_name) values ('x', now(), 'draft', true, 'community_submission', '   ')`), /events_(community_needs_organiser|organiser_name_check)/);
    assert.match(E.sup(`insert into events (title, starts_at, status, is_platform_event, source, organiser_name) values ('x', now(), 'draft', false, 'community_submission', 'A')`), /violates check/);
    assert.match(E.sup(`insert into events (title, starts_at, status, is_platform_event, source, organiser_name) values ('x', now(), 'draft', true, 'official', 'A')`), /events_source_check/);
    // a blank organiser name cannot even be submitted, so approval cannot see one
    assert.match(E.do('SUB', `select public.submit_event_submission($j$${JSON.stringify(E.payload('SUB', { organiser_name: '  ' }, crypto.randomUUID()))}$j$::jsonb)`), /organiser name/);
    // a business owner cannot dress their own event up as a community event or rename an organiser
    E.do('BIZ', `update events set source='community_submission', organiser_name='Fake Group', submission_id=null where id='${E_BIZ}'`);
    assert.equal(E.q(`select coalesce(source,'-') || '|' || coalesce(organiser_name,'-') from events where id='${E_BIZ}'`), '-|-');
  });
  test('reject and changes_requested need a reason (<=500); decided submissions cannot be re-decided; withdraw rules', () => {
    const s = E.submit('SUB').id;
    assert.match(E.do('ADMIN', `select public.admin_review_event_submission('${s}','reject',null)`), /Give a reason/);
    assert.match(E.do('ADMIN', `select public.admin_review_event_submission('${s}','changes_requested','  ')`), /Give a reason/);
    assert.match(E.do('ADMIN', `select public.admin_review_event_submission('${s}','reject','${'x'.repeat(501)}')`), /500 characters/);
    assert.match(E.do('ADMIN', `select public.admin_review_event_submission('${s}','maybe','r')`), /Decision must be/);
    assert.match(E.do('ADMIN', `select public.admin_review_event_submission('${s}','changes_requested','Please add the venue address')`), /changes_requested/);
    assert.equal(E.q(`select review_reason from event_submissions where id='${s}'`), 'Please add the venue address');
    assert.equal(E.q(`select count(*) from events where submission_id='${s}'`), '0');
    assert.match(E.do('ADMIN', `select public.admin_review_event_submission('${s}','approve',null)`), /can no longer be decided/);
    assert.equal(last(E.do('SUB', `select public.withdraw_event_submission('${s}')`)), 'withdrawn', 'changes_requested can be withdrawn');
    assert.equal(last(E.do('SUB', `select public.withdraw_event_submission('${s}')`)), 'withdrawn', 'idempotent');
    E.sup(`delete from event_submissions where status = 'pending'`);
    const r = E.submit('SUB').id; assert.ok(r); { const rj = E.do('ADMIN', `select public.admin_review_event_submission('${r}','reject','Not suitable')`); assert.ok(okq(rj), rj); }
    assert.match(E.do('SUB', `select public.withdraw_event_submission('${r}')`), /already been decided/);
    assert.equal(E.q(`select status from event_submissions where id='${r}'`), 'rejected');
  });
  test('approval refuses a submission whose every date has passed', () => {
    const s = E.submit('SUB').id; E.sup(`update event_submissions set occurrences = '[{"starts_at":"2020-01-01T10:00:00Z"}]' where id='${s}'`);
    assert.match(E.approve(s), /Every date on this submission has passed/);
    assert.equal(E.q(`select status from event_submissions where id='${s}'`), 'pending');
  });
  test('queue counts and list are staff-only and correct', () => {
    E.sup(`delete from event_submissions where status in ('pending','changes_requested')`);
    E.submit('SUB'); E.submit('OTH');
    assert.match(last(E.do('MOD', `select pending || '|' || changes_requested from public.admin_event_submission_counts()`)), /^2\|0$/);
    assert.equal(last(E.do('ADMIN', `select count(*) from public.admin_list_event_submissions('pending', 50)`)), '2');
    assert.match(E.try('OTH', `select * from public.admin_list_event_submissions()`), /Only OneShetland staff/);
  });
  test('admin_set_occurrence_status is staff-only', () => {
    const { eid } = E.community('SUB', [40, 41]);
    const oc = E.q(`select id from event_occurrences where event_id='${eid}' order by starts_at limit 1`);
    assert.match(E.try('SUB', `select public.admin_set_occurrence_status('${oc}','cancelled','x')`), /Only OneShetland staff/);
    assert.match(E.try('nobody', `select public.admin_set_occurrence_status('${oc}','cancelled','x')`), /Please sign in/);
    assert.ok(okq(E.do('MOD', `select public.admin_set_occurrence_status('${oc}','cancelled','Cast illness')`)));
    assert.equal(E.q(`select to_char(starts_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') from events where id='${eid}'`), day(41), 'parent follows the cancellation');
  });
});

describe('contributor self-service', () => {
  const log = (eid: string) => E.q(`select string_agg(action || ':' || actor_kind, ',' order by id) from event_change_log where event_id='${eid}'`);
  test('Tier A: only the original contributor; others, anon and NULL uid are denied', () => {
    const { eid } = E.community('SUB', [30]);
    for (const w of ['OTH', 'BIZ', 'HUBA', 'BIZ2'] as Who[]) assert.match(E.try(w, `select public.report_event_cancelled('${eid}','x')`), /cannot change that event/, w);
    assert.match(E.try('MOD', `select public.report_event_cancelled('${eid}','x')`), /cannot change that event/, 'staff use the admin path, not the contributor one');
    assert.match(E.try('nobody', `select public.report_event_cancelled('${eid}','x')`), /Please sign in/);
    assert.match(E.try('anon', `select public.report_event_cancelled('${eid}','x')`), /permission denied/);
    // not a community event at all: a business event and an official platform event
    for (const ev of [E_BIZ, E_PLAT]) assert.match(E.try('SUB', `select public.report_event_cancelled('${ev}','x')`), /cannot change that event/);
    assert.equal(E.q(`select status from events where id='${eid}'`), 'published');
  });
  test('Tier A: cancel a one-off with no occurrence rows, restore within 24h; note rules; idempotent', () => {
    const { eid } = E.community('SUB', [31]);
    assert.match(E.do('SUB', `select public.report_event_cancelled('${eid}','Hall flooded, see http://x.example')`), /Links/);
    assert.ok(okq(E.do('SUB', `select public.report_event_cancelled('${eid}','Hall flooded')`)));
    assert.equal(E.q(`select status || '|' || is_hidden from events where id='${eid}'`), 'cancelled|true');
    assert.match(E.do('SUB', `select public.report_event_cancelled('${eid}','again')`), /"duplicate": true/);
    assert.ok(okq(E.do('SUB', `select public.report_event_restored('${eid}')`)));
    assert.equal(E.q(`select status || '|' || is_hidden from events where id='${eid}'`), 'published|false');
    assert.equal(log(eid), 'event_cancelled:contributor,event_restored:contributor');
    E.do('SUB', `select public.report_event_cancelled('${eid}',null)`);
    E.sup(`update event_change_log set created_at = now() - interval '25 hours' where event_id='${eid}'`);
    assert.match(E.do('SUB', `select public.report_event_restored('${eid}')`), /within 24 hours/, 'window closed');
  });
  test('Tier A: restore is refused once staff has acted since', () => {
    const { eid } = E.community('SUB', [32, 33]);
    const oc = E.q(`select id from event_occurrences where event_id='${eid}' order by starts_at limit 1`);
    E.do('SUB', `select public.report_performance_cancelled('${oc}','x')`);
    E.do('ADMIN', `select public.admin_set_occurrence_status('${oc}','cancelled','confirmed by staff')`);
    assert.match(E.do('SUB', `select public.report_performance_restored('${oc}')`), /within 24 hours/);
    assert.equal(E.q(`select status from event_occurrences where id='${oc}'`), 'cancelled');
  });
  test('Tier A: cancelling one performance of a run leaves the others, updates the parent; cancelling the last cancels the event; restore reverses it', () => {
    const { eid } = E.community('SUB', [34, 35, 36]);
    const oc = E.q(`select string_agg(id::text, ',' order by starts_at) from event_occurrences where event_id='${eid}'`).split(',');
    assert.ok(okq(E.do('SUB', `select public.report_performance_cancelled('${oc[0]}','Cast illness')`)));
    assert.equal(E.q(`select string_agg(status, ',' order by starts_at) from event_occurrences where event_id='${eid}'`), 'cancelled,scheduled,scheduled');
    assert.equal(E.q(`select to_char(starts_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') || '|' || status from events where id='${eid}'`), `${day(35)}|published`);
    assert.equal(E.q(`select note from event_occurrences where id='${oc[0]}'`), 'Cast illness');
    E.do('SUB', `select public.report_performance_cancelled('${oc[1]}',null)`); E.do('SUB', `select public.report_performance_cancelled('${oc[2]}',null)`);
    assert.equal(E.q(`select status from events where id='${eid}'`), 'cancelled', 'no live performance left');
    assert.ok(okq(E.do('SUB', `select public.report_performance_restored('${oc[2]}')`)));
    assert.equal(E.q(`select status from events where id='${eid}'`), 'published');
    assert.ok(okq(E.do('SUB', `select public.set_performance_note('${oc[1]}','Doors 6.30')`)));
    assert.equal(E.q(`select note from event_occurrences where id='${oc[1]}'`), 'Doors 6.30');
    for (const w of ['OTH', 'BIZ', 'HUBA'] as Who[]) assert.match(E.try(w, `select public.report_performance_cancelled('${oc[1]}','x')`), /cannot change that performance/);
  });
  test('Tier A: a past performance is immutable; an event with no future date cannot be cancelled', () => {
    const { eid } = E.community('SUB', [37, 38]);
    const oc = E.q(`select id from event_occurrences where event_id='${eid}' order by starts_at limit 1`);
    E.sup(`alter table event_occurrences disable trigger user; update event_occurrences set starts_at = now() - interval '2 days' where id='${oc}'; alter table event_occurrences enable trigger user`);
    for (const f of [`report_performance_cancelled('${oc}','x')`, `set_performance_note('${oc}','x')`]) assert.match(E.do('SUB', `select public.${f}`), /already started/);
    const { eid: e2 } = E.community('SUB', [39]);
    E.sup(`alter table events disable trigger user; update events set starts_at = now() - interval '3 days' where id='${e2}'; alter table events enable trigger user`);
    assert.match(E.do('SUB', `select public.report_event_cancelled('${e2}','x')`), /already taken place/);
  });
  test('Tier A: an archived event cannot be touched by its contributor', () => {
    const { eid } = E.community('SUB', [42]);
    E.sup(`update events set status='archived' where id='${eid}'`);
    assert.match(E.try('SUB', `select public.report_event_cancelled('${eid}','x')`), /cannot change that event/);
    assert.match(E.try('SUB', `select public.request_event_change('${eid}','{"venue":"x"}'::jsonb, gen_random_uuid())`), /cannot change that event/);
  });
  test('Tier B: a change is pending, invisible to the public, until staff approves; then applied atomically; double approve is idempotent', () => {
    const { eid } = E.community('SUB', [43]);
    const req = crypto.randomUUID();
    const r = E.do('SUB', `select public.request_event_change('${eid}', $j$${JSON.stringify({ title: 'Harvest Show 2', venue: 'Museum', occurrences: [{ starts_at: day(44) }, { starts_at: day(45) }] })}$j$::jsonb, '${req}')`);
    assert.match(r, /"status": "pending"/);
    const cid = E.q(`select id from event_change_requests where event_id='${eid}'`);
    assert.equal(E.q(`select title || '|' || venue from events where id='${eid}'`), 'Harvest Show|Town Hall', 'nothing applied yet');
    assert.equal(E.q(`select kind from event_change_requests where id='${cid}'`), 'mixed');
    assert.match(E.do('SUB', `select public.request_event_change('${eid}', '{"title":"Harvest Show 2"}'::jsonb, '${req}')`), /"duplicate": true/, 'idempotent on request id');
    assert.equal(E.q(`select count(*) from event_change_requests where event_id='${eid}'`), '1');
    assert.match(E.try('SUB', `select public.admin_review_event_change('${cid}','approve',null)`), /Only OneShetland staff/);
    assert.match(E.try('nobody', `select public.admin_review_event_change('${cid}','approve',null)`), /Please sign in/);
    assert.ok(okq(E.do('MOD', `select public.admin_review_event_change('${cid}','approve',null)`)));
    assert.equal(E.q(`select title || '|' || venue || '|' || is_dated_run from events where id='${eid}'`), 'Harvest Show 2|Museum|true');
    assert.equal(E.q(`select count(*) from event_occurrences where event_id='${eid}'`), '2', 'a one-off became a run');
    assert.match(E.do('ADMIN', `select public.admin_review_event_change('${cid}','approve',null)`), /"duplicate": true/);
    assert.equal(E.q(`select count(*) from event_occurrences where event_id='${eid}'`), '2');
    assert.match(log(eid), /change_requested:contributor,change_approved:staff/);
    // the contributor can read their own history; another member cannot
    assert.ok(Number(last(E.try('SUB', `select count(*) from event_change_log where event_id='${eid}'`))) >= 2);
    assert.equal(last(E.try('OTH', `select count(*) from event_change_log where event_id='${eid}'`)), '0');
    assert.equal(last(E.try('OTH', `select count(*) from event_change_requests`)), '0');
  });
  test('Tier B: a stale approval re-validates against current state and fails without half-applying', () => {
    const { eid } = E.community('SUB', [46]);
    E.do('SUB', `select public.request_event_change('${eid}', $j$${JSON.stringify({ title: 'Stale title', occurrences: [{ starts_at: day(47) }] })}$j$::jsonb, gen_random_uuid())`);
    const cid = E.q(`select id from event_change_requests where event_id='${eid}'`);
    E.sup(`update event_change_requests set payload = jsonb_set(payload, '{occurrences}', '[{"starts_at":"2020-05-05T10:00:00Z"}]') where id='${cid}'`);   // time passes: the proposed date is now in the past
    assert.match(E.do('ADMIN', `select public.admin_review_event_change('${cid}','approve',null)`), /Dates must be in the future/);
    assert.equal(E.q(`select title from events where id='${eid}'`), 'Harvest Show', 'atomic: the title did not apply either');
    assert.equal(E.q(`select status from event_change_requests where id='${cid}'`), 'pending');
    assert.match(E.do('ADMIN', `select public.admin_review_event_change('${cid}','reject',null)`), /Give a reason/);
    assert.ok(okq(E.do('ADMIN', `select public.admin_review_event_change('${cid}','reject','Dates have passed')`)));
    assert.match(E.do('SUB', `select public.withdraw_event_change('${cid}')`), /already been decided/);
  });
  test('Tier B: validation, no-ops, field whitelist, limits, withdraw', () => {
    const { eid } = E.community('SUB', [48]);
    const rq = (p: unknown, who: Who = 'SUB', ev = eid) => E.do(who, `select public.request_event_change('${ev}', $j$${JSON.stringify(p)}$j$::jsonb, gen_random_uuid())`);
    assert.match(rq({ venue: 'Town Hall' }), /Nothing has changed/, 'no-op');
    assert.match(rq({ occurrences: [{ starts_at: day(48) }] }), /Nothing has changed/, 'same dates is a no-op too');
    assert.match(rq({ status: 'cancelled' }), /cannot change "status"/);
    for (const k of ['is_hidden', 'is_featured', 'source', 'organiser_name', 'organiser_user_id', 'is_platform_event', 'has_tickets', 'category']) assert.match(rq({ [k]: 'x' }), /cannot change/, k);
    assert.match(rq({ description: 'Call 07123456789' }), /Phone numbers/);
    assert.match(rq({ ticket_url: 'http://insecure.example' }), /https/);
    assert.match(rq({ cover_url: COVER(id(0x98)) }), /Upload the picture/);
    assert.match(rq({ occurrences: Array.from({ length: 61 }, (_, i) => ({ starts_at: day(50 + i % 30, 1 + (i % 20)) })) }), /up to 60|400 days|twice/);
    assert.match(rq({ occurrences: [{ starts_at: day(-3) }] }), /future/);
    assert.match(rq({ venue: 'x' }, 'OTH'), /cannot change that event/);
    assert.match(rq({ venue: 'x' }, 'nobody'), /Please sign in/);
    for (let i = 0; i < 5; i++) assert.ok(okq(rq({ venue: `Place ${i}` })), `pending ${i}`);
    assert.match(rq({ venue: 'Place 6' }), /5 changes waiting/);
    const first = E.q(`select id from event_change_requests where event_id='${eid}' order by created_at limit 1`);
    assert.match(E.try('OTH', `select public.withdraw_event_change('${first}')`), /cannot withdraw/);
    assert.equal(last(E.do('SUB', `select public.withdraw_event_change('${first}')`)), 'withdrawn');
    assert.ok(okq(rq({ venue: 'Place 7' })), 'a slot freed');
    // per-user daily cap
    E.sup(`delete from event_change_requests; insert into event_change_requests (event_id, requester_id, status, kind, payload, request_id) select '${eid}','${U.SUB}','rejected','details','{"venue":"a"}', gen_random_uuid() from generate_series(1,20)`);
    assert.match(rq({ venue: 'Place 9' }), /20 change requests/);
    E.sup(`delete from event_change_requests`);
  });
  test('Tier B: a second date is refused for an event with sold tickets or an active type; allowed otherwise', () => {
    const { eid } = E.community('SUB', [51]);
    E.sup(`insert into event_ticket_types (event_id, name, price_pence) values ('${eid}','Door',500)`);
    assert.match(E.do('SUB', `select public.request_event_change('${eid}', $j$${JSON.stringify({ occurrences: [{ starts_at: day(51) }, { starts_at: day(52) }] })}$j$::jsonb, gen_random_uuid())`), /sells tickets/);
    // approve-time re-check: the request is made while unticketed, tickets appear, then staff approve
    const { eid: e2 } = E.community('SUB', [53]);
    E.do('SUB', `select public.request_event_change('${e2}', $j$${JSON.stringify({ occurrences: [{ starts_at: day(53) }, { starts_at: day(54) }] })}$j$::jsonb, gen_random_uuid())`);
    const cid = E.q(`select id from event_change_requests where event_id='${e2}'`);
    E.sup(`insert into event_ticket_types (event_id, name, price_pence) values ('${e2}','Door',500)`);
    assert.match(E.do('ADMIN', `select public.admin_review_event_change('${cid}','approve',null)`), /sells tickets/);
    assert.equal(E.q(`select count(*) from event_occurrences where event_id='${e2}'`), '0');
  });
  test('the contributor can still READ their own event, its dates and history after it is cancelled and hidden; nobody else can', () => {
    const { eid } = E.community('SUB', [40, 41]);
    assert.ok(okq(E.do('SUB', `select public.report_event_cancelled('${eid}','dry')`)));
    assert.equal(E.q(`select is_hidden from events where id='${eid}'`), 't', 'cancelling hides the event for the public');
    assert.equal(E.try('SUB', `select count(*) from events where id='${eid}'`).trim().split('\n').pop(), '1', 'the contributor still sees it');
    assert.equal(E.try('SUB', `select count(*) from event_occurrences where event_id='${eid}'`).trim().split('\n').pop(), '2', 'and its dates');
    for (const w of ['OTH', 'BIZ', 'HUBA', 'BIZ2', 'anon'] as Who[]) assert.equal(E.try(w, `select count(*) from events where id='${eid}'`).trim().split('\n').pop(), '0', `${w} must not see it`);
    assert.equal(E.try('SUB', `select count(*) from events where id='${E_PLAT}' and is_hidden`).trim().split('\n').pop(), '0');
    // read only: the contributor still cannot write the event or its dates
    E.try('SUB', `update events set title='hijack' where id='${eid}'`);
    assert.notEqual(E.q(`select title from events where id='${eid}'`), 'hijack');
    assert.ok(failed(E.try('SUB', `insert into event_occurrences (event_id, starts_at) values ('${eid}', now() + interval '70 days')`)));
    assert.match(E.try('anon', `select public.is_my_community_event('${eid}')`), /permission denied/);
  });
  test('my_event_organiser_trusted tells the caller about their own trust only', () => {
    assert.equal(E.try('TRU', `select public.my_event_organiser_trusted()`).trim().split('\n').pop(), 'f');
    E.sup(`select public.set_config_dummy()`.replace('select public.set_config_dummy()', `insert into event_organiser_trust (user_id, trusted, set_by) values ('${U.TRU}', true, '${U.ADMIN}') on conflict (user_id) do update set trusted = true`));
    assert.equal(E.try('TRU', `select public.my_event_organiser_trusted()`).trim().split('\n').pop(), 't');
    assert.equal(E.try('OTH', `select public.my_event_organiser_trusted()`).trim().split('\n').pop(), 'f', 'someone else is not trusted by TRU being trusted');
    assert.match(E.try('anon', `select public.my_event_organiser_trusted()`), /permission denied/);
    assert.equal(E.try('nobody', `select public.my_event_organiser_trusted()`).trim().split('\n').pop(), 'f');
    E.sup(`delete from event_organiser_trust where user_id='${U.TRU}'`);
  });
  test('Tier C: untrusted by default; trust is staff-only and cannot be self-granted; a trusted organiser auto-applies the permitted fields only', () => {
    const { eid } = E.community('TRU', [60]);
    const rq = (p: unknown) => E.do('TRU', `select public.request_event_change('${eid}', $j$${JSON.stringify(p)}$j$::jsonb, gen_random_uuid())`);
    assert.match(rq({ description: 'Updated words about the show.' }), /"status": "pending"/, 'untrusted: moderated');
    assert.match(E.try('TRU', `select public.admin_set_organiser_trust('${U.TRU}', true, 'me')`), /Only OneShetland staff/);
    assert.match(E.try('nobody', `select public.admin_set_organiser_trust('${U.TRU}', true, 'me')`), /Please sign in/);
    assert.match(E.try('TRU', `insert into event_organiser_trust (user_id, trusted) values ('${U.TRU}', true)`), /permission denied/);
    assert.match(E.try('TRU', `update event_organiser_trust set trusted = true`), /permission denied/);
    assert.match(E.try('TRU', `select count(*) from event_organiser_trust`), /^(?![\s\S]*ERROR)/);
    assert.equal(last(E.try('TRU', `select count(*) from event_organiser_trust`)), '0');
    assert.match(E.try('anon', `select count(*) from event_organiser_trust`), /permission denied/);
    E.do('ADMIN', `select public.admin_set_organiser_trust('${U.TRU}', true, 'Known to the hall committee')`);
    assert.equal(E.q(`select public.is_trusted_organiser('${U.TRU}')`), 't');
    assert.equal(last(E.try('ADMIN', `select count(*) from event_organiser_trust`)), '1');
    const r1 = rq({ description: 'Brand new description for the show.', venue: 'Clickimin Centre', contact_info: 'call 01595 000000', occurrences: [{ starts_at: day(61) }, { starts_at: day(62) }], ticket_url: 'https://tickets.example.org/new' });
    assert.match(r1, /"status": "auto_approved"/, r1);
    assert.equal(E.q(`select venue || '|' || is_dated_run from events where id='${eid}'`), 'Clickimin Centre|true');
    assert.equal(E.q(`select count(*) from event_change_requests where event_id='${eid}' and status='auto_approved'`), '1');
    assert.match(log(eid), /change_auto_approved:trusted_auto/);
    assert.match(rq({ title: 'New title' }), /"status": "pending"/, 'title stays moderated');
    assert.match(rq({ cover_url: COVER(U.TRU).replace('poster', 'poster2') }), /"status": "pending"/, 'poster stays moderated');
    assert.match(rq({ price_text: '£12' }), /"status": "pending"/, 'price text stays moderated');
    assert.match(rq({ venue: 'Somewhere', title: 'T2' }), /"status": "pending"/, 'a mixed request with one moderated field is moderated whole');
    assert.equal(E.q(`select venue from events where id='${eid}'`), 'Clickimin Centre');
    assert.equal(last(E.do('MOD', `select auto_approved_7d from public.admin_event_change_counts()`)), '1');
    assert.equal(last(E.do('MOD', `select count(*) from public.admin_list_event_changes('auto_approved', 10)`)), '1');
    E.sup(`delete from event_change_requests where status = 'pending'`);
    E.do('ADMIN', `select public.admin_set_organiser_trust('${U.TRU}', false, 'revoked')`);
    assert.match(rq({ description: 'After revocation the words change again.' }), /"status": "pending"/, 'revoked');
  });
  test('Tier C: trust never auto-changes the date of an event that sells tickets', () => {
    const { eid } = E.community('TRU', [63]);
    E.do('ADMIN', `select public.admin_set_organiser_trust('${U.TRU}', true, null)`);
    E.sup(`insert into event_ticket_types (event_id, name, price_pence) values ('${eid}','Door',500)`);
    assert.match(E.do('TRU', `select public.request_event_change('${eid}', $j$${JSON.stringify({ occurrences: [{ starts_at: day(64) }] })}$j$::jsonb, gen_random_uuid())`), /"status": "pending"/);
  });
  test('the contributor cannot reach status / is_hidden / featured / ownership / source through any function', () => {
    const { eid } = E.community('SUB', [65]);
    E.do('ADMIN', `select public.admin_set_organiser_trust('${U.SUB}', true, null)`);
    for (const p of [{ status: 'draft' }, { is_hidden: true }, { is_featured: true }, { organiser_user_id: U.OTH }, { source: null }, { organiser_name: 'x' }, { organiser_business_id: BZ }]) {
      assert.match(E.do('SUB', `select public.request_event_change('${eid}', $j$${JSON.stringify(p)}$j$::jsonb, gen_random_uuid())`), /cannot change/, JSON.stringify(p));
    }
    assert.equal(E.q(`select concat_ws('|', status, is_hidden, is_featured, organiser_user_id = '${U.SUB}', source, organiser_name) from events where id='${eid}'`), 'published|f|f|t|community_submission|Lerwick Players');
    // and an applied change leaves status / ownership / source exactly as they were
    E.do('SUB', `select public.request_event_change('${eid}', '{"description":"Longer text about the evening."}'::jsonb, gen_random_uuid())`);
    assert.equal(E.q(`select concat_ws('|', status, is_hidden, is_featured, is_platform_event, source, organiser_name, organiser_business_id is null, organiser_hub_id is null) from events where id='${eid}'`), 'published|f|f|t|community_submission|Lerwick Players|t|t');
  });
  test('other members, business owners and hub admins cannot read someone else\'s change history', () => {
    const { eid } = E.community('SUB', [66]);
    E.do('SUB', `select public.report_event_cancelled('${eid}',null)`);
    for (const w of ['OTH', 'BIZ', 'HUBA', 'anon'] as Who[]) assert.ok(['0', ''].includes(last(E.try(w, `select count(*) from event_change_log where event_id='${eid}'`)).replace(/.*permission denied.*/, '')), w);
    assert.equal(last(E.try('MOD', `select count(*) from event_change_log where event_id='${eid}'`)), '1');
  });
});

describe('existing business / hub permissions are unchanged, and nothing contacts anyone', () => {
  test('business owner and hub admin still create and edit their own events; others still cannot', () => {
    assert.ok(okq(E.do('BIZ', `insert into events (id, organiser_user_id, organiser_business_id, title, starts_at, status) values ('${id(0x80)}','${U.BIZ}','${BZ}','mine',now()+interval '3 days','draft')`)));
    assert.ok(okq(E.do('HUBA', `insert into events (id, organiser_user_id, organiser_hub_id, hub_visibility, title, starts_at, status) values ('${id(0x81)}','${U.HUBA}','${HUB}','hub','hubs',now()+interval '3 days','draft')`)));
    assert.ok(failed(E.try('OTH', `insert into events (organiser_user_id, organiser_business_id, title, starts_at, status) values ('${U.OTH}','${BZ}','steal',now()+interval '3 days','draft')`)));
    assert.match(E.try('BIZ', `update events set is_platform_event=true where id='${id(0x80)}'`), /ERROR|row-level/);
    assert.ok(failed(E.try('BIZ', `insert into events (organiser_user_id, title, starts_at, status, is_platform_event) values ('${U.BIZ}','plat',now()+interval '3 days','draft',true)`)));
    assert.ok(okq(E.do('ADMIN', `insert into events (title, starts_at, status, is_platform_event) values ('staff official',now()+interval '3 days','published',true)`)));
    assert.equal(E.q(`select source is null from events where title='staff official'`), 't');
  });
  test('only an EXPLICIT staff marker makes an event OneShetland-organised: curated platform events, business events and clients can never carry it', () => {
    // 1. nothing existing is marked: every seeded platform and business event has source NULL, so none can read as OneShetland-organised
    assert.equal(E.q(`select count(*) from events where source is not null and submission_id is null`), '0', 'no seeded platform/business event is marked');
    assert.equal(E.q(`select count(*) from events where id in ('${E_PLAT}','${E_BIZ}','${E_BIZ_TICKETED}') and source is null`), '3');
    // 2. staff may mark a platform-owned event; the marker needs no organiser_name
    assert.ok(okq(E.sup(`insert into events (title, starts_at, status, is_platform_event, source) values ('marked official', now() + interval '5 days', 'draft', true, 'oneshetland')`)));
    // 3. a business- or hub-owned event can never carry it, and neither can an unknown value
    assert.match(E.sup(`insert into events (title, starts_at, status, is_platform_event, organiser_business_id, source) values ('x', now(), 'draft', false, '${BZ}', 'oneshetland')`), /events_oneshetland_is_platform/);
    assert.match(E.sup(`insert into events (title, starts_at, status, is_platform_event, source) values ('x', now(), 'draft', true, 'official')`), /events_source_check/);
    // 4. a signed-in business owner cannot set it (the guard clears client-set source), nor can an ordinary member insert anything
    E.do('BIZ', `insert into events (id, title, starts_at, status, organiser_business_id, source) values ('${id(0xa1)}','client tried', now() + interval '6 days', 'draft', '${BZ}', 'oneshetland')`);
    assert.notEqual(E.q(`select coalesce(source,'(null)') from events where id='${id(0xa1)}'`), 'oneshetland', 'a client can never set the marker');
    // 5. approving a community submission produces community, never the OneShetland marker
    assert.equal(E.q(`select count(*) from events where source = 'oneshetland' and submission_id is not null`), '0');
    E.sup(`delete from events where title in ('marked official','client tried')`);
  });
  test('no notification_log rows, no emails: the whole flow wrote none', () => {
    assert.equal(notifCount(), NOTIF0);
    assert.equal(E.q(`select count(*) from pg_trigger t join pg_proc p on p.oid=t.tgfoid where t.tgrelid in ('event_occurrences'::regclass,'event_submissions'::regclass,'event_change_requests'::regclass,'event_organiser_trust'::regclass) and not t.tgisinternal and pg_get_functiondef(p.oid) ~* 'notification_log|net\\.http|email'`), '0');
    const src = readFileSync(join(MIG, M1), 'utf8') + readFileSync(join(MIG, M2), 'utf8') + readFileSync(join(MIG, M3), 'utf8');
    assert.doesNotMatch(src.replace(/--.*$/gm, ''), /notification_log|net\.http_post|send_email/i);
  });
});

describe('rollback restores the prior schema without losing event rows', () => {
  test('rolling back all three files in reverse removes every new object, keeps every event row and reserve_ticket_basket works again', () => {
    const b = build('evoccrb'); const e = b.env;
    try {
      e.sup(`insert into admin_config (key,value,category) values ('events.member_submissions','open','events')`);
      const s = e.submit('SUB'); e.approve(s.id);
      const nEvents = e.q('select count(*) from events');
      for (const f of ['20261230020000_event_contributor_self_service', '20261230010000_event_member_submissions', '20261230000000_event_occurrences']) {
        const o = e.db.rawFile(join(ROLL, `${f}.rollback.sql`)); assert.doesNotMatch(o.replace(/NOTICE.*/g, ''), /ERROR/, `${f}: ${o.slice(0, 800)}`);
      }
      assert.equal(e.q('select count(*) from events'), nEvents, 'no event row lost');
      assert.equal(e.q(`select count(*) from information_schema.columns where table_name='events' and column_name in ('is_dated_run','organiser_name','source','submission_id')`), '0');
      assert.equal(e.q(`select count(*) from pg_class where relname in ('event_occurrences','event_submissions','event_change_requests','event_organiser_trust','event_change_log')`), '0');
      assert.equal(e.q(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('submit_event_submission','request_event_change','event_has_ticketing','tg_event_occurrences_sync','report_event_cancelled','event_category_label')`), '0');
      assert.equal(e.q(`select count(*) from pg_trigger where tgrelid='public.events'::regclass and not tgisinternal`), '3', 'only the three original triggers remain');
      assert.doesNotMatch(e.q(`select pg_get_functiondef('public.reserve_ticket_basket(uuid,uuid,jsonb,integer,integer,jsonb,text)'::regprocedure)`) + e.sup(`select prosrc from pg_proc where proname='reserve_ticket_basket'`), /MULTI_PERFORMANCE/);
      assert.ok(okq(e.sup(`insert into events (title, starts_at, status, is_platform_event) values ('after rollback', now(), 'draft', true)`)));
      // and the migrations apply again on top of the rolled-back schema
      for (const f of [M1, M2, M3]) { const o = e.db.rawFile(join(MIG, f)); assert.doesNotMatch(o.replace(/NOTICE.*/g, ''), /ERROR/, `${f} re-apply`); }
    } finally { e.db.drop(); }
  });
});

// ── mutation controls: weaken ONE guard, rebuild, and the same probe must now FAIL ───────────────────────────────────────────────────────────────
describe('mutation controls (each weakens one guard and shows the probe catches it)', () => {
  const run = (name: string, mut: Parameters<typeof build>[1], probe: (e: Env) => boolean | Promise<boolean>) => test(`MUTATION ${name}`, async () => {
    const b = build(`evmut${Math.abs([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`, mut);
    try {
      assert.equal(await probe(b.env), false, 'with the guard weakened the guarantee must be BROKEN (probe returns false), proving the real test would catch it');
    } finally { b.env.db.drop(); }
  });
  const runOcc = (e: Env, evt = E_BIZ) => e.sup(`insert into event_occurrences (id, event_id, starts_at) values ('${id(0x91)}','${evt}','${day(20)}'),('${id(0x92)}','${evt}','${day(21)}'); update event_occurrences set status='cancelled' where id='${id(0x91)}'`);

  run('sync includes cancelled occurrences in the parent start', [{ file: M1, find: '(v_live = 0 or status <> \'cancelled\')', replace: 'true' }],
    (e) => { runOcc(e); return e.q(`select to_char(starts_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') from events where id='${E_BIZ}'`) === day(21); });
  run('sync never sets is_dated_run', [{ file: M1, find: 'v_dated := v_n >= 2;', replace: 'v_dated := false;' }],
    (e) => { runOcc(e); return e.q(`select is_dated_run from events where id='${E_BIZ}'`) === 't'; });
  run('no ticket-type gate', [{ file: M1, find: 'create trigger tg_event_ticket_types_run_guard', replace: 'create trigger tg_zz_disabled_guard' }, { file: M1, find: /on public\.event_ticket_types\n  for each row execute function public\.tg_event_ticket_types_run_guard\(\);/, replace: 'on public.event_ticket_types\n  for each row when (false) execute function public.tg_event_ticket_types_run_guard();' }],
    (e) => { e.sup(`insert into event_occurrences (event_id, starts_at) values ('${E_BIZ}','${day(20)}'),('${E_BIZ}','${day(21)}')`); return failed(e.sup(`insert into event_ticket_types (event_id, name, price_pence) values ('${E_BIZ}','Adult',500)`)); });
  run('occurrence guard ignores sold events', [{ file: M1, find: 'if public.event_has_ticketing(new.event_id) then', replace: 'if false then' }],
    (e) => { e.sup(`insert into event_occurrences (event_id, starts_at) values ('${E_BIZ_TICKETED}','${day(20)}')`); return failed(e.sup(`insert into event_occurrences (event_id, starts_at) values ('${E_BIZ_TICKETED}','${day(21)}')`)); });
  run('reserve_ticket_basket does not refuse runs', [{ file: M3, find: /(o\.status <> 'cancelled'\) >= )2( then\n    raise exception 'MULTI_PERFORMANCE)/, replace: '$199$2' }],
    (e) => { e.sup(`alter table event_occurrences disable trigger tg_event_occurrences_guard; insert into event_occurrences (event_id, starts_at) values ('${E_BIZ_TICKETED}','${day(20)}'),('${E_BIZ_TICKETED}','${day(21)}')`);
      return /MULTI_PERFORMANCE/.test(e.sup(`select public.reserve_ticket_basket('${E_BIZ_TICKETED}','${U.OTH}','[{"ticket_type_id":"${TT}","token_hash":"${'a'.repeat(40)}"}]'::jsonb,500,0,'{}'::jsonb,'req-mut-000001')`)); });
  run('reserve_ticket_basket takes a lock that conflicts with the refund path (FOR SHARE)', [{ file: M3, find: 'where id = p_event_id for key share;', replace: 'where id = p_event_id for share;' }],
    async (e) => !(await refundVsSale(e)).deadlock);
  run('submission switch ignored', [{ file: M2, find: 'not public.attribution_staff() and not public.event_submissions_open()', replace: 'false' }],
    (e) => /not open yet/.test(e.submit('SUB').out));
  run('review function skips the staff check', [{ file: M2, find: /if not public\.attribution_staff\(\) then raise exception 'Only OneShetland staff can review submissions'/, replace: "if false then raise exception 'Only OneShetland staff can review submissions'" }],
    (e) => { e.sup(`insert into admin_config (key,value,category) values ('events.member_submissions','open','events')`); const s = e.submit('SUB'); return /Only OneShetland staff/.test(e.do('OTH', `select public.admin_review_event_submission('${s.id}','approve',null)`)); });
  run('anon keeps EXECUTE on submit', [{ file: M2, find: /\ngrant execute on function public\.event_category_label\(text\) to authenticated, service_role;/, replace: '\ngrant execute on function public.submit_event_submission(jsonb) to anon;\ngrant execute on function public.event_category_label(text) to authenticated, service_role;' }],
    (e) => e.q(`select has_function_privilege('anon','public.submit_event_submission(jsonb)','execute')`) === 'f');
  run('double approve is not idempotent', [{ file: M2, find: "if p_decision = 'approve' and s.status = 'approved' then", replace: 'if false then' }],
    (e) => { e.sup(`insert into admin_config (key,value,category) values ('events.member_submissions','open','events')`); const s = e.submit('SUB'); e.approve(s.id); const o = e.approve(s.id); return !failed(o) && /"duplicate": true/.test(o); });
  run('community event without organiser name allowed', [{ file: M2, find: /alter table public\.events add constraint events_community_needs_organiser check\n  \(source is distinct from 'community_submission' or \(is_platform_event and organiser_name is not null and btrim\(organiser_name\) <> ''\)\);/, replace: 'select 1;' }],
    (e) => failed(e.sup(`insert into events (title, starts_at, status, is_platform_event, source) values ('x', now(), 'draft', true, 'community_submission')`)));
  run('the OneShetland marker is allowed on a business event', [{ file: M2, find: /alter table public\.events add constraint events_oneshetland_is_platform check \(source is distinct from 'oneshetland' or is_platform_event\);/, replace: 'select 1;' }],
    (e) => failed(e.sup(`insert into events (title, starts_at, status, is_platform_event, organiser_business_id, source) values ('x', now(), 'draft', false, '${BZ}', 'oneshetland')`)));
  run('the contributor read policy exposes every hidden event', [{ file: M3, find: 'create policy events_contributor_read on public.events for select to authenticated using (public.is_my_community_event(id));', replace: 'create policy events_contributor_read on public.events for select to authenticated using (true);' }],
    (e) => { e.sup(`insert into admin_config (key,value,category) values ('events.member_submissions','open','events')`); const { eid } = e.community('SUB', [40]); e.do('SUB', `select public.report_event_cancelled('${eid}','dry')`); return e.try('OTH', `select count(*) from events where id='${eid}'`).trim().split('\n').pop() === '0'; });
  run('clients can forge is_dated_run', [{ file: M2, find: '  new.is_dated_run := old.is_dated_run;\n  if not public.attribution_staff()', replace: '  if not public.attribution_staff()' }],
    (e) => { e.do('BIZ', `update events set is_dated_run = true where id='${E_BIZ}'`); return e.q(`select is_dated_run from events where id='${E_BIZ}'`) === 'f'; });
  run('contributor check ignores who the contributor is', [{ file: M3, find: '       and s.event_id = e.id and s.submitter_id = auth.uid());', replace: '       and s.event_id = e.id);' }],
    (e) => { e.sup(`insert into admin_config (key,value,category) values ('events.member_submissions','open','events')`); const s = e.submit('SUB'); e.approve(s.id); const ev = e.eventOf(s.id); return /cannot change that event/.test(e.try('OTH', `select public.report_event_cancelled('${ev}','x')`)); });
  run('trust can be self-granted', [{ file: M3, find: /if not public\.attribution_staff\(\) then raise exception 'Only OneShetland staff can do this' using errcode = '42501'; end if;\n  if p_user is null/, replace: 'if p_user is null' }],
    (e) => /Only OneShetland staff/.test(e.try('SUB', `select public.admin_set_organiser_trust('${U.SUB}', true, 'me')`)));
  run('stale change approval skips re-validation', [{ file: M3, find: "v_list := public.event_validate_occurrences(p -> 'occurrences', now());", replace: "v_list := p -> 'occurrences';" }],
    (e) => { e.sup(`insert into admin_config (key,value,category) values ('events.member_submissions','open','events')`); const s = e.submit('SUB'); e.approve(s.id); const ev = e.eventOf(s.id);
      e.do('SUB', `select public.request_event_change('${ev}', $j$${JSON.stringify({ occurrences: [{ starts_at: day(60) }] })}$j$::jsonb, gen_random_uuid())`);
      const cid = e.q(`select id from event_change_requests`); e.sup(`update event_change_requests set payload = '{"occurrences":[{"starts_at":"2020-05-05T10:00:00Z"}]}' where id='${cid}'`);
      return /Dates must be in the future/.test(e.do('ADMIN', `select public.admin_review_event_change('${cid}','approve',null)`)); });
  run('restore ignores a staff action in between', [{ file: M3, find: "if not found or l.action <> 'performance_cancelled' or l.occurrence_id is distinct from o.id or l.actor_kind <> 'contributor' or", replace: 'if not found or false or' }],
    (e) => { e.sup(`insert into admin_config (key,value,category) values ('events.member_submissions','open','events')`); const s = e.submit('SUB', { occurrences: [{ starts_at: day(30) }, { starts_at: day(31) }] }); e.approve(s.id); const ev = e.eventOf(s.id);
      const oc = e.q(`select id from event_occurrences where event_id='${ev}' order by starts_at limit 1`); e.do('SUB', `select public.report_performance_cancelled('${oc}','x')`);
      e.do('ADMIN', `select public.admin_set_occurrence_status('${oc}','cancelled','staff')`); return /within 24 hours/.test(e.do('SUB', `select public.report_performance_restored('${oc}')`)); });
});
