/**
 * event-notice-attribution.node.test.ts — an event or notice belongs to ONE legitimate owner, and only that owner's CURRENT
 * controllers may write it.
 *
 * WHAT WAS WRONG
 *
 * events_owner_write was FOR ALL with no WITH CHECK, and `organiser_user_id = auth.uid()` authorised a write on its own. So any signed-in
 * user could publish an event attributed to ANY hub (a verified hub's event was auto-approved onto the islands calendar), publish a
 * standalone event, detach or re-point an event after publication, and — owning any business — attribute an event to a hub as well,
 * which moves the ticket payout to that hub while the attacker keeps ticket-type and refund rights through the business. Attribution to
 * another BUSINESS was refused only by commercial_terms_guard, a selling-terms check. A former owner kept edit / delete / scan rights
 * through organiser_user_id. notices had the same shape with publisher_user_id (and is_pinned / broadcast_* were client-writable).
 *
 * HOW IT PROVES IT
 *
 * The pre-fix production state (policies, triggers, functions copied verbatim from production introspection) is loaded from
 * _support/attribution-prefix-schema.sql. Every attack is run FIRST against that state and must SUCCEED (a control: the finding is real).
 * The REAL migration 20261121000000 is then applied, over seeded legacy data, and every attack must fail while every legitimate
 * request shape — exactly what build 147 and the web app send — still works. A final group removes each guard and shows the attack
 * works again (the tests are load-bearing).
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase. No Stripe, no network.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = readFileSync(join(REPO_ROOT, 'supabase/tests/_support/attribution-prefix-schema.sql'), 'utf8');
const MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20261121000000_event_notice_attribution.sql');
const MIGRATION = readFileSync(MIGRATION_PATH, 'utf8');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';

if (!DSN) throw new Error('PASS_PROOF_DSN is required (isolated database only) — run via `npm run test:isolated`');
if (/supabase/i.test(DSN)) throw new Error('refusing to run against a Supabase DSN');

function raw(sql: string): string {
  const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', timeout: 120_000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}
function file(sql: string): string {
  const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', timeout: 180_000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}
const scalar = (sql: string) => raw(sql).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

// ── the cast ──────────────────────────────────────────────────────────────────────────────────────
const U = {
  A: 'a0000000-0000-4000-8000-0000000000a1',   // ordinary customer who owns / administers nothing
  B: 'b0000000-0000-4000-8000-0000000000b1',   // owns BIZ_B (accepted the selling terms; own payout account)
  V: 'c0000000-0000-4000-8000-0000000000c1',   // owns BIZ_V — the victim business
  H: 'd0000000-0000-4000-8000-0000000000d1',   // OWNS HUB_V — the victim hub (verified, payout-ready)
  C: 'd0000000-0000-4000-8000-0000000000d2',   // COMMITTEE of HUB_V
  M: 'd0000000-0000-4000-8000-0000000000d3',   // plain MEMBER of HUB_V
  S: 'e0000000-0000-4000-8000-0000000000e1',   // platform admin
  O: 'f0000000-0000-4000-8000-0000000000f1',   // the person a business is later handed to
};
const BIZ_B = 'bb000000-0000-4000-8000-0000000000bb';
const BIZ_V = 'cc000000-0000-4000-8000-0000000000cc';
const HUB_V = 'dd000000-0000-4000-8000-0000000000dd';
const CAMP_V = 'ca000000-0000-4000-8000-0000000000ca';
const EV_LEGACY_A = 'e1000000-0000-4000-8000-000000000001';   // editorial, no creator
const EV_LEGACY_B = 'e1000000-0000-4000-8000-000000000002';   // entity-less, created by a customer ("Burra Regatta")
const EV_BIZ_V = 'e1000000-0000-4000-8000-000000000003';      // staff-created event on BIZ_V
const N_HUB = 'a1000000-0000-4000-8000-000000000001';         // the one existing hub notice (no publisher user)

function seed() {
  const out = file(`
    insert into profiles (id, role, stripe_account_id, stripe_payouts_enabled) values
      ('${U.A}','customer',null,false), ('${U.B}','customer','acct_B_own',true), ('${U.V}','customer','acct_V_own',true),
      ('${U.H}','customer','acct_H_own',true), ('${U.C}','customer',null,false), ('${U.M}','customer',null,false),
      ('${U.S}','admin',null,false), ('${U.O}','customer','acct_O_own',true);
    insert into local_businesses (id, owner_id, name, slug, can_publish_urgent) values
      ('${BIZ_B}','${U.B}','BIZ_B','biz-b', false), ('${BIZ_V}','${U.V}','BIZ_V','biz-v', true);
    insert into compliance_log values
      ('business.commercial_terms_accepted','${U.B}','v1','{"business_id":"${BIZ_B}"}'),
      ('business.commercial_terms_accepted','${U.V}','v1','{"business_id":"${BIZ_V}"}'),
      ('business.commercial_terms_accepted','${U.O}','v1','{"business_id":"${BIZ_B}"}');
    alter table hubs disable trigger tg_zz_lock_hub_columns;
    insert into hubs (id, owner_id, name, slug, is_verified, payout_enabled, stripe_account_id) values ('${HUB_V}','${U.H}','HUB_V','hub-v',true,true,'acct_H_hub');
    alter table hubs enable trigger tg_zz_lock_hub_columns;
    insert into hub_members (hub_id, user_id, role) values ('${HUB_V}','${U.C}','committee'), ('${HUB_V}','${U.M}','member');
    insert into hub_campaigns (id, hub_id, title) values ('${CAMP_V}','${HUB_V}','Roof fund');
    -- legacy production shapes
    insert into events (id, organiser_user_id, title, starts_at, status, description) values
      ('${EV_LEGACY_A}', null, 'Editorial: Up Helly Aa', now() + interval '30 days', 'published', 'imported'),
      ('${EV_LEGACY_B}', '${U.A}', 'Burra Regatta', now() - interval '60 days', 'published', 'historical');
    insert into events (id, organiser_user_id, organiser_business_id, title, starts_at, status, has_tickets) values
      ('${EV_BIZ_V}', '${U.S}', '${BIZ_V}', 'ZZ business event', now() + interval '10 days', 'published', true);
    insert into event_ticket_types (event_id, price_pence) values ('${EV_BIZ_V}', 500);
    insert into notices (id, publisher_hub_id, severity, title) values ('${N_HUB}', '${HUB_V}', 'info', 'OneShetland is getting ready to launch');
  `);
  assert.doesNotMatch(out, /ERROR/i, `seed failed:\n${out.slice(0, 1500)}`);
}

function freshPre() {
  const out = file(PREFIX);
  assert.doesNotMatch(out, /ERROR/i, `prefix schema failed:\n${out.slice(0, 1500)}`);
  seed();
}
function freshPost() { freshPre(); applyMigration(); }
function applyMigration() {
  const out = file(MIGRATION);
  assert.doesNotMatch(out, /ERROR/i, `migration failed:\n${out.slice(0, 2000)}`);
}

type Who = keyof typeof U | 'service' | 'anon';
/** Run one statement as a client role. INSERT/UPDATE/DELETE report the rows they touched. */
function attempt(who: Who, sql: string): { ok: boolean; rows: number; err: string } {
  const role = who === 'service' ? 'service_role' : who === 'anon' ? 'anon' : 'authenticated';
  const sub = who === 'service' || who === 'anon' ? '' : U[who];
  const wrapped = /^\s*(insert|update|delete)/i.test(sql)
    ? `with w as (${sql.replace(/;\s*$/, '')} returning 1) select 'ROWS='||count(*) from w`
    : sql;
  const out = raw(`set role ${role}; select set_config('request.jwt.claim.sub','${sub}',false); ${wrapped}; reset role;`);
  const err = out.split('\n').find((l) => /ERROR/.test(l)) ?? '';
  const m = out.match(/ROWS=(\d+)/);
  const rows = m ? Number(m[1]) : 0;
  return { ok: !err && (m ? rows > 0 : true), rows, err };
}
const allowed = (who: Who, sql: string) => attempt(who, sql).ok;
/** Run a SELECT as a client role and return its output. */
function readAs(who: Exclude<Who, 'service' | 'anon'>, sql: string): string {
  return raw(`set role authenticated; select set_config('request.jwt.claim.sub','${U[who]}',false); ${sql}; reset role;`);
}

// ── request shapes ────────────────────────────────────────────────────────────────────────────────
const inDays = (n: number) => `now() + interval '${n} days'`;
/** Mobile app/event-create.tsx → createEvent: { organiser_user_id: userId, ...input } with organiser_business_id XOR organiser_hub_id. */
const mobileBusinessEvent = (uid: string, biz: string, title = 'mobile biz event') =>
  `insert into events (organiser_user_id, organiser_business_id, title, description, category, status, venue, starts_at, has_tickets, cover_url, gallery_urls, price_text)
   values ('${uid}','${biz}','${title}','d','Music','published','Hall',${inDays(5)},true,null,'{}','Free')`;
const mobileHubEvent = (uid: string, hub: string, title = 'mobile hub event', vis = 'islands') =>
  `insert into events (organiser_user_id, organiser_hub_id, hub_visibility, title, description, status, starts_at, has_tickets)
   values ('${uid}','${hub}','${vis}','${title}','d','published',${inDays(5)},false)`;
/** Web lib/events-manage-client.ts buildEventRow: organiser_business_id: businessId, organiser_hub_id: null. */
const webBusinessEvent = (uid: string, biz: string, title = 'web biz event') =>
  `insert into events (organiser_user_id, organiser_business_id, organiser_hub_id, title, status, starts_at, has_tickets)
   values ('${uid}','${biz}',null,'${title}','published',${inDays(6)},false)`;
/** Web lib/hubs-client.ts createHubEvent. */
const webHubEvent = (uid: string, hub: string, title = 'web hub event') =>
  `insert into events (organiser_user_id, organiser_hub_id, hub_visibility, title, status, starts_at) values ('${uid}','${hub}','hub','${title}','published',${inDays(6)})`;
/** Mobile hubs-api createHubNotice (every key the app sends; none is publisher_user_id). */
const mobileHubNotice = (hub: string, extra = '', cols = '') =>
  `insert into notices (publisher_hub_id, severity, visibility, title, body, image_url, category, locality, expires_at, campaign_id, event_id ${cols})
   values ('${hub}','community','public','mobile hub notice',null,null,null,null,null,null,null ${extra})`;
/** Web hubs-client createNotice. */
const webHubNotice = (hub: string) =>
  `insert into notices (publisher_hub_id, severity, visibility, title, body, image_url, expires_at) values ('${hub}','community','public','web hub notice',null,null,null)`;

const evId = (title: string) => scalar(`select id from events where title='${title}'`);
const evCount = (where: string) => Number(scalar(`select count(*) from events where ${where}`));

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('BEFORE the migration — the finding is real (controls)', () => {
  before(freshPre);

  test('any signed-in user can publish an event for ANY hub — and a verified hub auto-approves it onto the islands calendar', () => {
    assert.ok(allowed('A', mobileHubEvent(U.A, HUB_V, 'spoof hub', 'islands')));
    assert.equal(scalar(`select calendar_approved::text from events where title='spoof hub'`), 'true');
  });
  test('any signed-in user can publish a standalone event, with nobody as organiser attributed', () => {
    assert.ok(allowed('A', `insert into events (organiser_user_id, title, starts_at, status) values ('${U.A}','standalone',${inDays(3)},'published')`));
  });
  test('an event\'s attribution can be re-pointed or detached after publication', () => {
    assert.ok(allowed('B', mobileBusinessEvent(U.B, BIZ_B, 'b event')));
    assert.ok(allowed('B', `update events set organiser_hub_id='${HUB_V}', hub_visibility='hub' where title='b event'`));
    assert.ok(allowed('B', `update events set organiser_business_id=null, organiser_hub_id=null where title='b event'`));
  });
  test('business + hub together: the payout goes to the VICTIM hub while the attacker keeps ticket-type and refund rights', () => {
    assert.ok(allowed('B', `insert into events (id, organiser_user_id, organiser_business_id, organiser_hub_id, hub_visibility, title, starts_at, status, has_tickets)
      values ('e2000000-0000-4000-8000-000000000001','${U.B}','${BIZ_B}','${HUB_V}','hub','both',${inDays(5)},'published',true)`));
    assert.ok(allowed('B', `insert into event_ticket_types (event_id, price_pence) values ('e2000000-0000-4000-8000-000000000001', 2500)`));
    assert.equal(scalar(`select account_id from _event_payout_resolve('e2000000-0000-4000-8000-000000000001')`), 'acct_H_hub');
    assert.equal(scalar(`select can_refund_event_orders('e2000000-0000-4000-8000-000000000001','${U.B}')::text`), 'true');
  });
  test('a former business owner still deletes the event and still passes can_scan_event', () => {
    raw(`update local_businesses set owner_id='${U.O}' where id='${BIZ_B}'`);
    assert.equal(scalar(`select can_scan_event('${evId('both')}','${U.B}')::text`), 'true');
    assert.ok(allowed('B', `delete from events where title='both'`));
  });
  test('notices: publisher_user_id=self authorises ANY hub / business, pinning and broadcasting, and re-pointing', () => {
    assert.ok(allowed('A', `insert into notices (publisher_hub_id, publisher_user_id, title) values ('${HUB_V}','${U.A}','spoof hub notice')`));
    assert.ok(allowed('A', `insert into notices (publisher_business_id, publisher_user_id, title) values ('${BIZ_V}','${U.A}','spoof biz notice')`));
    assert.ok(allowed('A', `insert into notices (publisher_user_id, title, is_pinned, broadcast_at, broadcast_by) values ('${U.A}','pinned',true,now(),'${U.A}')`));
    assert.ok(allowed('A', `update notices set publisher_hub_id='${HUB_V}' where title='pinned'`));
    assert.ok(allowed('A', `insert into notices (publisher_user_id, title, event_id) values ('${U.A}','x','${EV_BIZ_V}')`));
  });
  test('control: the normal client shape (no publisher_user_id) on someone else\'s hub was already refused', () => {
    assert.equal(allowed('A', mobileHubNotice(HUB_V)), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('migration over legacy data', () => {
  let beforeEvents = ''; let beforeNotices = '';
  const evCols = (excl: string) => scalar(`select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='events' and column_name <> '${excl}'`);
  const noCols = (excl: string) => scalar(`select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='notices' and column_name <> '${excl}'`);
  const evFp = (cols: string) => scalar(`select md5(string_agg(to_jsonb(e)::text, '|' order by id)) from (select ${cols} from events) e`);
  const noFp = (cols: string) => scalar(`select md5(string_agg(to_jsonb(n)::text, '|' order by id)) from (select ${cols} from notices) n`);
  before(() => {
    freshPre();
    beforeEvents = evFp(evCols('')); beforeNotices = noFp(noCols(''));
    applyMigration();
  });

  test('every entity-less event is grandfathered as platform-managed legacy; business events stay business events; nothing else changes', () => {
    assert.equal(evCount(`is_platform_event and organiser_business_id is null and organiser_hub_id is null`), 2);
    assert.equal(evCount(`not is_platform_event and organiser_business_id is not null`), 1);
    assert.equal(evCount(`not is_platform_event and organiser_business_id is null and organiser_hub_id is null`), 0);
    assert.equal(evFp(evCols('is_platform_event')), beforeEvents, 'every pre-existing event column (including updated_at) is byte-identical');
    assert.equal(noFp(noCols('is_platform_notice')), beforeNotices, 'the existing notice is byte-identical');
    assert.equal(scalar(`select count(*) from notices where not is_platform_notice and publisher_hub_id='${HUB_V}'`), '1');
  });
  test('the legacy creator (a customer) gets no authority from organiser_user_id; legacy events are readable by everyone, writable by staff only', () => {
    assert.equal(attempt('A', `update events set title='hijack' where id='${EV_LEGACY_B}'`).ok, false);
    assert.equal(attempt('A', `delete from events where id='${EV_LEGACY_B}'`).ok, false);
    assert.ok(allowed('S', `update events set description='edited by staff' where id='${EV_LEGACY_B}'`));
    assert.equal(scalar(`select count(*) from events where is_platform_event and not is_hidden`), '2');
  });
  test('the existing hub notice is untouched and valid', () => {
    assert.equal(scalar(`select title from notices where id='${N_HUB}'`), 'OneShetland is getting ready to launch');
  });
  test('the migration refuses to run if a row has both entities (pre-flight)', () => {
    freshPre();
    raw(`alter table events disable trigger user; insert into events (id, title, starts_at, organiser_business_id, organiser_hub_id) values ('e3000000-0000-4000-8000-000000000001','both',now(),'${BIZ_V}','${HUB_V}')`);
    assert.match(file(MIGRATION), /BOTH a business and a hub/);
  });
  test('the migration refuses to run if a notice is entity-less (never auto-promotes a personal notice to platform)', () => {
    freshPre();
    raw(`insert into notices (publisher_user_id, title) values ('${U.A}','personal')`);
    assert.match(file(MIGRATION), /both or neither of business\/hub/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('AFTER the migration — events', () => {
  beforeEach(freshPost);

  test('1/25. a business owner creates a business event (build 147 + web shapes)', () => {
    assert.ok(allowed('B', mobileBusinessEvent(U.B, BIZ_B)));
    assert.ok(allowed('B', webBusinessEvent(U.B, BIZ_B)));
    assert.equal(scalar(`select organiser_user_id from events where title='mobile biz event'`), U.B);
  });
  test('2. another user cannot create an event for that business', () => {
    assert.equal(allowed('A', mobileBusinessEvent(U.A, BIZ_B, 'x')), false);
    assert.equal(allowed('V', mobileBusinessEvent(U.V, BIZ_B, 'x')), false);
  });
  test('3/4. the hub owner and a committee member create hub events (build 147 + web shapes)', () => {
    assert.ok(allowed('H', mobileHubEvent(U.H, HUB_V, 'owner hub event')));
    assert.ok(allowed('C', mobileHubEvent(U.C, HUB_V, 'committee hub event')));
    assert.ok(allowed('H', webHubEvent(U.H, HUB_V)));
  });
  test('5/9. an ordinary hub member / stranger cannot create a hub event or spoof the hub', () => {
    assert.equal(allowed('M', mobileHubEvent(U.M, HUB_V, 'x')), false);
    assert.equal(allowed('A', mobileHubEvent(U.A, HUB_V, 'x')), false);
    assert.equal(allowed('B', mobileHubEvent(U.B, HUB_V, 'x')), false);
  });
  test('6. an ordinary user cannot create a standalone event, with or without organiser_user_id', () => {
    assert.equal(allowed('A', `insert into events (organiser_user_id, title, starts_at, status) values ('${U.A}','s',${inDays(2)},'published')`), false);
    assert.equal(allowed('A', `insert into events (title, starts_at, status) values ('s2',${inDays(2)},'published')`), false);
    assert.equal(allowed('B', `insert into events (organiser_user_id, title, starts_at, status, is_platform_event) values ('${U.B}','s3',${inDays(2)},'published', true)`), false);
  });
  test('7. an ordinary user cannot set is_platform_event, on insert or update', () => {
    assert.equal(allowed('B', `insert into events (organiser_user_id, organiser_business_id, title, starts_at, is_platform_event) values ('${U.B}','${BIZ_B}','p',${inDays(2)}, true)`), false);
    assert.ok(allowed('B', mobileBusinessEvent(U.B, BIZ_B, 'upd target')));
    assert.equal(allowed('B', `update events set is_platform_event=true, organiser_business_id=null where title='upd target'`), false);
  });
  test('8. spoofing organiser_business_id fails (insert and update)', () => {
    assert.equal(allowed('A', mobileBusinessEvent(U.A, BIZ_V, 'x')), false);
    assert.ok(allowed('B', mobileBusinessEvent(U.B, BIZ_B, 'upd target')));
    assert.equal(allowed('B', `update events set organiser_business_id='${BIZ_V}' where title='upd target'`), false);
  });
  test('10. business + hub together is impossible — for a client, for staff and for the service role (CHECK)', () => {
    const both = (uid: string) => `insert into events (organiser_user_id, organiser_business_id, organiser_hub_id, hub_visibility, title, starts_at, status) values ('${uid}','${BIZ_B}','${HUB_V}','hub','both',${inDays(2)},'published')`;
    assert.equal(allowed('B', both(U.B)), false);
    assert.equal(allowed('S', both(U.S)), false);
    assert.match(attempt('service', both(U.S)).err, /events_attribution_exclusive|violates check/);
    assert.match(attempt('service', `insert into events (title, starts_at, status) values ('neither',${inDays(2)},'published')`).err, /events_attribution_exclusive|violates check/);
  });
  test('11. an owner cannot change attribution after creation (business->hub, detach, hub->business)', () => {
    assert.ok(allowed('B', mobileBusinessEvent(U.B, BIZ_B, 'upd target')));
    assert.ok(allowed('H', mobileHubEvent(U.H, HUB_V, 'owner hub event')));
    assert.equal(allowed('B', `update events set organiser_hub_id='${HUB_V}', organiser_business_id=null where title='upd target'`), false);
    assert.equal(allowed('B', `update events set organiser_business_id=null where title='upd target'`), false);
    assert.equal(allowed('H', `update events set organiser_business_id='${BIZ_B}', organiser_hub_id=null where title='owner hub event'`), false);
  });
  test('12. organiser_user_id cannot be changed into an authority (or used as one)', () => {
    assert.ok(allowed('B', mobileBusinessEvent(U.B, BIZ_B, 'upd target')));
    assert.ok(allowed('B', `update events set organiser_user_id='${U.A}', title='renamed' where title='upd target'`));
    assert.equal(scalar(`select organiser_user_id from events where title='renamed'`), U.B, 'the update is accepted but the creator stamp does not move');
    assert.equal(allowed('A', `update events set title='mine now' where title='renamed'`), false);
  });
  test('the app\'s normal updates and deletes still work (status change, edit incl. the web re-send of business + null hub, delete)', () => {
    assert.ok(allowed('B', mobileBusinessEvent(U.B, BIZ_B, 'renamed')));
    assert.ok(allowed('H', mobileHubEvent(U.H, HUB_V, 'owner hub event')));
    assert.ok(allowed('B', `update events set status='cancelled' where title='renamed'`));
    assert.ok(allowed('B', `update events set organiser_business_id='${BIZ_B}', organiser_hub_id=null, title='web edit' where title='renamed'`));
    assert.ok(allowed('H', `update events set title='hub edit', status='published' where title='owner hub event'`));
    assert.ok(allowed('B', `delete from events where title='web edit'`));
  });
  test('13. a former business owner loses every right (update, delete, scan, hidden-draft read); the new owner gains them', () => {
    assert.ok(allowed('B', mobileBusinessEvent(U.B, BIZ_B, 'handover')));
    raw(`update events set status='draft' where title='handover'`);
    raw(`update local_businesses set owner_id='${U.O}' where id='${BIZ_B}'`);
    const id = evId('handover');
    assert.equal(allowed('B', `update events set title='still mine' where id='${id}'`), false);
    assert.equal(allowed('B', `delete from events where id='${id}'`), false);
    assert.equal(scalar(`select can_scan_event('${id}','${U.B}')::text`), 'false');
    assert.match(readAs('B', `select 'SEEN='||count(*) from events where id='${id}'`), /SEEN=0/, 'a hidden draft is not readable by the former owner');
    assert.equal(scalar(`select can_scan_event('${id}','${U.O}')::text`), 'true');
    assert.ok(allowed('O', `update events set title='new owner' where id='${id}'`));
  });
  test('14. a removed committee member loses rights; the hub owner keeps authority through hubs.owner_id even without a membership row', () => {
    assert.ok(allowed('C', mobileHubEvent(U.C, HUB_V, 'committee made')));
    const id = evId('committee made');
    raw(`delete from hub_members where hub_id='${HUB_V}' and user_id='${U.C}'`);
    assert.equal(allowed('C', `update events set title='still' where id='${id}'`), false);
    assert.equal(allowed('C', `delete from events where id='${id}'`), false);
    assert.equal(scalar(`select can_scan_event('${id}','${U.C}')::text`), 'false');
    raw(`delete from hub_members where hub_id='${HUB_V}' and user_id='${U.H}'`);
    assert.ok(allowed('H', `update events set title='owner still' where id='${id}'`));
    assert.equal(scalar(`select can_scan_event('${id}','${U.H}')::text`), 'true');
  });
  test('15/16/17. staff and the service role create platform events; legacy events stay manageable by staff only', () => {
    assert.ok(allowed('S', `insert into events (organiser_user_id, title, starts_at, status, is_platform_event) values ('${U.S}','staff editorial',${inDays(3)},'published', true)`));
    assert.ok(allowed('service', `insert into events (title, starts_at, status, is_platform_event) values ('service editorial',${inDays(3)},'published', true)`));
    assert.ok(allowed('S', `update events set title='edited' where id='${EV_LEGACY_A}'`));
    assert.equal(allowed('A', `update events set title='x' where id='${EV_LEGACY_A}'`), false);
    assert.equal(allowed('B', `delete from events where id='${EV_LEGACY_A}'`), false);
  });
  test('18/19. ticket types follow the event\'s CURRENT entity; the payout resolves from that single entity', () => {
    assert.ok(allowed('B', mobileBusinessEvent(U.B, BIZ_B, 'biz ev')));
    assert.ok(allowed('H', mobileHubEvent(U.H, HUB_V, 'hub ev')));
    const own = evId('biz ev'); const hubEv = evId('hub ev');
    assert.ok(allowed('B', `insert into event_ticket_types (event_id, price_pence) values ('${own}', 1000)`));
    assert.equal(allowed('A', `insert into event_ticket_types (event_id, price_pence) values ('${own}', 1)`), false);
    assert.equal(allowed('V', `update event_ticket_types set price_pence=1 where event_id='${own}'`), false);
    assert.equal(scalar(`select account_id from _event_payout_resolve('${own}')`), 'acct_B_own', 'a business event pays the business\'s account');
    assert.ok(allowed('H', `insert into event_ticket_types (event_id, price_pence) values ('${hubEv}', 700)`));
    assert.equal(allowed('B', `insert into event_ticket_types (event_id, price_pence) values ('${hubEv}', 700)`), false);
    assert.equal(scalar(`select account_id from _event_payout_resolve('${hubEv}')`), 'acct_H_hub', 'a hub event pays the hub\'s account');
    raw(`update events set status='draft' where id='${own}'`);
    assert.match(readAs('B', `select 'TT='||count(*) from event_ticket_types where event_id='${own}'`), /TT=[1-9]/, 'the owner still sees ticket types of an unpublished event');
  });
  test('20/22/23/24. scan and refund authority is current entity authority only', () => {
    assert.ok(allowed('C', mobileHubEvent(U.C, HUB_V, 'committee made')));
    const ev = evId('committee made');
    assert.equal(scalar(`select can_scan_event('${ev}','${U.C}')::text`), 'true', 'committee scan while a committee member');
    raw(`delete from hub_members where hub_id='${HUB_V}' and user_id='${U.C}'`);
    assert.equal(scalar(`select can_scan_event('${ev}','${U.C}')::text`), 'false', 'the creator stamp alone confers nothing');
    assert.equal(scalar(`select can_refund_event_orders('${ev}','${U.H}')::text`), 'true', 'hub owner refunds');
    assert.equal(scalar(`select can_refund_event_orders('${ev}','${U.C}')::text`), 'false', 'committee never refunds');
    assert.equal(scalar(`select can_refund_event_orders('${EV_BIZ_V}','${U.V}')::text`), 'true', 'business owner refunds');
    assert.equal(scalar(`select can_refund_event_orders('${EV_BIZ_V}','${U.S}')::text`), 'true', 'staff refunds');
    assert.equal(scalar(`select can_refund_event_orders('${EV_BIZ_V}','${U.A}')::text`), 'false');
  });
  test('anon has no write access to events or notices', () => {
    assert.equal(allowed('anon', `insert into events (title, starts_at, status, is_platform_event) values ('anon',${inDays(2)},'published', true)`), false);
    assert.match(attempt('anon', `delete from notices where true`).err, /permission denied/);
    assert.equal(scalar(`select count(*) from information_schema.role_table_grants where table_name in ('events','notices') and grantee='anon' and privilege_type in ('INSERT','UPDATE','DELETE')`), '0');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('AFTER the migration — notices', () => {
  beforeEach(freshPost);

  test('25/28/40. the hub owner and a committee member publish hub notices (build 147 and web shapes, incl. campaign and event links)', () => {
    assert.ok(allowed('H', mobileHubNotice(HUB_V)));
    assert.ok(allowed('C', webHubNotice(HUB_V)));
    assert.ok(allowed('H', `insert into notices (publisher_hub_id, severity, visibility, title, campaign_id) values ('${HUB_V}','community','public','campaign notice','${CAMP_V}')`));
    assert.ok(allowed('H', mobileHubEvent(U.H, HUB_V, 'noticed event')));
    assert.ok(allowed('H', `insert into notices (publisher_hub_id, severity, visibility, title, event_id) values ('${HUB_V}','community','members','event notice',(select id from events where title='noticed event'))`));
    assert.equal(scalar(`select publisher_user_id from notices where title='mobile hub notice'`), U.H, 'publisher_user_id is server-stamped');
  });
  test('26/29/31/32. a stranger / plain member cannot publish for a hub or a business', () => {
    assert.equal(allowed('A', mobileHubNotice(HUB_V)), false);
    assert.equal(allowed('M', mobileHubNotice(HUB_V)), false);
    assert.equal(allowed('B', mobileHubNotice(HUB_V)), false);
    assert.equal(allowed('A', `insert into notices (publisher_business_id, title) values ('${BIZ_V}','x')`), false);
  });
  test('27/30. a business owner publishes a business notice; publisher_user_id=self cannot bypass ownership', () => {
    assert.ok(allowed('B', `insert into notices (publisher_business_id, severity, visibility, title) values ('${BIZ_B}','community','public','biz notice')`));
    for (const sql of [
      `insert into notices (publisher_hub_id, publisher_user_id, title) values ('${HUB_V}','${U.A}','x')`,
      `insert into notices (publisher_business_id, publisher_user_id, title) values ('${BIZ_V}','${U.A}','x')`,
      `insert into notices (publisher_business_id, publisher_user_id, title) values ('${BIZ_V}','${U.B}','x')`,
    ]) assert.equal(allowed('A', sql), false, sql);
  });
  test('33/34/35. no business+hub, no standalone notice, no platform notice for a client', () => {
    assert.equal(allowed('H', `insert into notices (publisher_hub_id, publisher_business_id, title) values ('${HUB_V}','${BIZ_V}','x')`), false);
    assert.equal(allowed('A', `insert into notices (publisher_user_id, title) values ('${U.A}','personal')`), false);
    assert.equal(allowed('A', `insert into notices (title, is_platform_notice) values ('platform',true)`), false);
    assert.equal(allowed('H', `insert into notices (publisher_hub_id, title, is_platform_notice) values ('${HUB_V}','platform',true)`), false);
  });
  test('36. attribution is immutable for an ordinary user; a user who lost the entity cannot edit or delete', () => {
    assert.ok(allowed('H', mobileHubNotice(HUB_V)));
    assert.ok(allowed('C', webHubNotice(HUB_V)));
    assert.equal(allowed('H', `update notices set publisher_hub_id=null, publisher_business_id='${BIZ_V}' where title='mobile hub notice'`), false);
    assert.equal(allowed('H', `update notices set is_platform_notice=true, publisher_hub_id=null where title='mobile hub notice'`), false);
    assert.ok(allowed('H', `update notices set title='mobile hub notice edited' where title='mobile hub notice'`));
    raw(`delete from hub_members where hub_id='${HUB_V}' and user_id='${U.C}'`);
    assert.equal(allowed('C', `delete from notices where title='web hub notice'`), false);
    assert.equal(allowed('C', `update notices set title='x' where title='web hub notice'`), false);
    assert.ok(allowed('H', `delete from notices where title='web hub notice'`));
  });
  test('37/38. ordinary users cannot set is_pinned / is_hidden / broadcast_at / broadcast_by (insert or update)', () => {
    assert.ok(allowed('H', mobileHubNotice(HUB_V)));
    assert.ok(allowed('H', `update notices set title='mobile hub notice edited' where title='mobile hub notice'`));
    for (const col of ['is_pinned', 'is_hidden']) {
      assert.equal(allowed('H', `insert into notices (publisher_hub_id, title, ${col}) values ('${HUB_V}','x',true)`), false, col);
      assert.equal(allowed('H', `update notices set ${col}=true where title='mobile hub notice edited'`), false, col);
    }
    assert.equal(allowed('H', `insert into notices (publisher_hub_id, title, broadcast_at) values ('${HUB_V}','x',now())`), false);
    assert.equal(allowed('H', `insert into notices (publisher_hub_id, title, broadcast_by) values ('${HUB_V}','x','${U.H}')`), false);
    assert.equal(allowed('H', `update notices set broadcast_at=now() where title='mobile hub notice edited'`), false);
  });
  test('a notice cannot link to another publisher\'s event or campaign', () => {
    assert.equal(allowed('H', `insert into notices (publisher_hub_id, title, event_id) values ('${HUB_V}','x','${EV_BIZ_V}')`), false);
    raw(`insert into hubs (id, owner_id, name) values ('ff000000-0000-4000-8000-0000000000f1','${U.A}','A hub')`);
    raw(`insert into hub_campaigns (id, hub_id, title) values ('ca000000-0000-4000-8000-0000000000cb','ff000000-0000-4000-8000-0000000000f1','other')`);
    assert.equal(allowed('H', `insert into notices (publisher_hub_id, title, campaign_id) values ('${HUB_V}','x','ca000000-0000-4000-8000-0000000000cb')`), false);
  });
  test('urgent still needs a can_publish_urgent business owner (or staff)', () => {
    assert.equal(allowed('B', `insert into notices (publisher_business_id, severity, title) values ('${BIZ_B}','urgent','x')`), false);
    assert.ok(allowed('V', `insert into notices (publisher_business_id, severity, title) values ('${BIZ_V}','urgent','urgent ok')`));
    assert.equal(allowed('H', `insert into notices (publisher_hub_id, severity, title) values ('${HUB_V}','urgent','x')`), false);
  });
  test('39. staff and the service role still publish platform notices (broadcast fields included)', () => {
    assert.ok(allowed('S', `insert into notices (title, is_platform_notice, is_pinned) values ('staff platform',true,true)`));
    assert.ok(allowed('service', `insert into notices (title, is_platform_notice) values ('service platform',true)`));
    assert.ok(allowed('service', `update notices set broadcast_at=now(), broadcast_by='${U.S}' where title='staff platform'`));
    assert.ok(allowed('S', `insert into notices (publisher_hub_id, title) values ('${HUB_V}','staff hub')`));
    assert.match(attempt('service', `insert into notices (title) values ('neither')`).err, /notices_attribution_exclusive|violates check/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('entity deletion never leaves public standalone content', () => {
  before(freshPost);

  test('41/42. a business or hub that owns events cannot be deleted out from under them (RESTRICT) and no row becomes standalone', () => {
    assert.match(raw(`delete from local_businesses where id='${BIZ_V}'`), /violates foreign key constraint|events_organiser_business_id_fkey/);
    assert.ok(allowed('H', mobileHubEvent(U.H, HUB_V, 'hub owned')));
    assert.match(raw(`delete from hubs where id='${HUB_V}'`), /violates foreign key constraint|events_organiser_hub_id_fkey/);
    assert.equal(evCount(`not is_platform_event and organiser_business_id is null and organiser_hub_id is null`), 0);
  });
  test('once its events are removed the entity can go, and its notices go with it (cascade) — never standalone', () => {
    raw(`delete from event_ticket_types where event_id in (select id from events where organiser_business_id='${BIZ_V}')`);
    raw(`delete from events where organiser_business_id='${BIZ_V}'`);
    raw(`insert into notices (publisher_business_id, title) values ('${BIZ_V}','biz notice')`);
    assert.doesNotMatch(raw(`delete from local_businesses where id='${BIZ_V}'`), /ERROR/);
    assert.equal(scalar(`select count(*) from notices where title='biz notice'`), '0');
    raw(`delete from events where organiser_hub_id='${HUB_V}'`);
    assert.doesNotMatch(raw(`delete from hubs where id='${HUB_V}'`), /ERROR/);
    assert.equal(scalar(`select count(*) from notices where publisher_hub_id is null and publisher_business_id is null and not is_platform_notice`), '0');
  });
  test('a deleted USER does not strand content: organiser_user_id / publisher_user_id go null, ownership is the entity', () => {
    freshPost();
    assert.ok(allowed('H', mobileHubEvent(U.H, HUB_V, 'hub owned')));
    assert.ok(allowed('H', mobileHubNotice(HUB_V)));
    raw(`alter table hubs disable trigger tg_zz_lock_hub_columns; update hubs set owner_id='${U.C}' where id='${HUB_V}'; alter table hubs enable trigger tg_zz_lock_hub_columns`);
    raw(`delete from hub_members where user_id='${U.H}'`);
    raw(`delete from profiles where id='${U.H}'`);
    assert.equal(scalar(`select count(*) from events where title='hub owned' and organiser_user_id is null and organiser_hub_id='${HUB_V}'`), '1');
    assert.equal(scalar(`select count(*) from notices where title='mobile hub notice' and publisher_user_id is null and publisher_hub_id='${HUB_V}'`), '1');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('load-bearing: removing a guard brings the attack back', () => {
  const spoofEvent = () => allowed('A', mobileHubEvent(U.A, HUB_V, 'spoof'));
  const spoofNotice = () => allowed('A', `insert into notices (publisher_hub_id, publisher_user_id, title) values ('${HUB_V}','${U.A}','spoof')`);

  test('baseline: with everything in place both spoofs fail', () => { freshPost(); assert.equal(spoofEvent(), false); assert.equal(spoofNotice(), false); });

  test('the events guard AND the events policy are each independently sufficient — only removing BOTH reopens the hole', () => {
    freshPost(); raw(`alter table events disable trigger aa_events_attribution_guard`);
    assert.equal(spoofEvent(), false, 'policy alone still refuses');
    freshPost(); raw(`drop policy events_insert on events; create policy events_insert on events for insert to authenticated with check (auth.uid() is not null)`);
    assert.equal(spoofEvent(), false, 'guard alone still refuses');
    freshPost(); raw(`alter table events disable trigger aa_events_attribution_guard; drop policy events_insert on events; create policy events_insert on events for insert to authenticated with check (auth.uid() is not null)`);
    assert.equal(spoofEvent(), true, 'both removed => spoof works (the tests above are load-bearing)');
  });
  test('the notices guard and policy likewise', () => {
    freshPost(); raw(`alter table notices disable trigger aa_notices_attribution_guard`);
    assert.equal(spoofNotice(), false);
    freshPost(); raw(`alter table notices disable trigger aa_notices_attribution_guard; drop policy "notices insert" on notices; create policy "notices insert" on notices for insert to authenticated with check (publisher_user_id = auth.uid())`);
    assert.equal(spoofNotice(), true);
  });
  test('the shared ownership check is the heart: if controls_event_entity always said yes, both spoofs work', () => {
    freshPost(); raw(`create or replace function public.controls_event_entity(p_business uuid, p_hub uuid) returns boolean language sql as $$ select true $$`);
    assert.equal(spoofEvent(), true); assert.equal(spoofNotice(), true);
  });
  test('immutability: without the update guard an owner can re-point an event / notice; with it they cannot', () => {
    freshPost(); assert.ok(allowed('B', mobileBusinessEvent(U.B, BIZ_B, 'mine')));
    assert.equal(allowed('B', `update events set organiser_business_id=null, organiser_hub_id='${HUB_V}', hub_visibility='hub' where title='mine'`), false);
    raw(`alter table events disable trigger aa_events_attribution_guard`);
    raw(`drop policy events_update on events; create policy events_update on events for update to authenticated using (auth.uid() is not null) with check (auth.uid() is not null)`);
    raw(`alter table events drop constraint events_attribution_exclusive`);
    assert.equal(allowed('B', `update events set organiser_business_id=null, organiser_hub_id='${HUB_V}', hub_visibility='hub' where title='mine'`), true);
  });
  test('can_scan_event: re-adding the organiser_user_id branch lets a former creator scan again', () => {
    freshPost(); assert.ok(allowed('B', mobileBusinessEvent(U.B, BIZ_B, 'old')));
    raw(`update local_businesses set owner_id='${U.O}' where id='${BIZ_B}'`);
    const id = evId('old'); assert.equal(scalar(`select can_scan_event('${id}','${U.B}')::text`), 'false');
    raw(`create or replace function can_scan_event(p_event_id uuid, p_user_id uuid) returns boolean language sql security definer as $$ select exists (select 1 from events where id=p_event_id and organiser_user_id=p_user_id) $$`);
    assert.equal(scalar(`select can_scan_event('${id}','${U.B}')::text`), 'true');
  });
  test('the FK RESTRICT is what stops an entity delete from orphaning events (SET NULL would hit the CHECK instead — also refused, never silent)', () => {
    freshPost();
    raw(`alter table events drop constraint events_organiser_hub_id_fkey; alter table events add constraint events_organiser_hub_id_fkey foreign key (organiser_hub_id) references hubs(id) on delete set null`);
    assert.ok(allowed('H', mobileHubEvent(U.H, HUB_V, 'x')));
    assert.match(raw(`delete from hubs where id='${HUB_V}'`), /events_attribution_exclusive|violates/);
  });
});

describe('static', () => {
  test('the migration keeps the invariants: CHECKs, both guards, per-command policies, RESTRICT, can_scan_event without organiser_user_id', () => {
    for (const re of [
      /constraint events_attribution_exclusive|add constraint events_attribution_exclusive/, /notices_attribution_exclusive/,
      /create trigger aa_events_attribution_guard/, /create trigger aa_notices_attribution_guard/,
      /create policy events_insert on public\.events for insert to authenticated with check/,
      /create policy events_update on public\.events for update to authenticated\s+using[\s\S]*?with check/,
      /on delete restrict/, /revoke insert, update, delete on public\.events, public\.notices from anon/,
    ]) assert.match(MIGRATION, re);
    const scan = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.can_scan_event'));
    assert.doesNotMatch(scan.replace(/--.*$/gm, ''), /organiser_user_id/);
  });
});
