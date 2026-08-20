/**
 * ticket-redemption.node.test.ts — one ticket admits one person, once.
 *
 * WHY THIS TEST EXISTS
 *
 * Three separate defects met on this surface, and all three were reproduced
 * against production on 2026-08-20 before being fixed:
 *
 *   1. THE RACE (C4). validate_and_checkin_ticket read the ticket, decided in
 *      plpgsql that it was redeemable, then updated it with no status predicate.
 *      Two connections scanning one QR both read 'valid' before either wrote:
 *      two result='valid' audit rows, two different scanner ids, one attendee
 *      admitted twice — and checked_in_by named the LOSER, because it wrote last.
 *
 *   2. AUTHORISATION FAILED OPEN. The ownership test joined events to
 *      local_businesses. For a user-organised or hub-organised event that join
 *      matched nothing, owns_event stayed NULL, and `IF NOT owns_event` is NULL
 *      rather than true — so the rejection never ran. A complete stranger
 *      redeemed tickets for user, hub and orphan events. 43 of the 53 real
 *      tickets in production belong to user-organised events.
 *
 *   3. BACKUP CODES WERE GLOBAL. The lookup matched on the code alone across
 *      every event, so one event's scanner could confirm another event's codes.
 *
 * WHAT IS ASSERTED
 *   · two simultaneous scans of one ticket produce exactly one admission
 *   · the winner is recorded, and exactly one result='valid' audit row exists
 *   · every organiser shape authorises the right people and nobody else
 *   · a ticket for one event cannot be spent at another
 *   · backup codes resolve only within the event being scanned
 *   · cancelled, refunded, pending and already-used tickets never admit
 *   · the privileged RPCs stay unreachable from a browser
 *
 * SAFETY
 * Everything except the concurrency test runs inside a transaction that is
 * always rolled back. The concurrency test cannot: proving that two
 * transactions contend requires rows both can see, so it creates a namespaced
 * fixture, commits it, races it, and removes it again in after(). The fixture
 * is re-cleaned on entry too, so an interrupted run cannot leave anything
 * behind that a later run would trip over.
 *
 * Run: npm test
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NIL = '00000000-0000-0000-0000-000000000000';

const EV_A = 'a5000004-0000-4000-8000-00000000000a';   // user-organised
const EV_B = 'a5000004-0000-4000-8000-00000000000b';   // user-organised, same organiser
const RACE_LABEL = 'S4CONC1';                     // one source for the ticket's token AND its code

function publicConfig(): { url: string; anonKey: string } | null {
  let url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  let anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anonKey) {
    try {
      for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
        const m = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.+)\s*$/);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1].endsWith('URL')) url ||= v; else anonKey ||= v;
      }
    } catch { /* handled below */ }
  }
  return url && anonKey ? { url, anonKey } : null;
}
const cfg = publicConfig();

/**
 * Deliberately throws rather than returning null on failure.
 *
 * An earlier suite in this repository swallowed query errors and reported the
 * test as SKIPPED. A change that broke the SQL then looked exactly like a
 * missing CLI, and the regression went unnoticed until the skip count moved.
 * A broken query here is a failure, and says why.
 */
function query(sql: string): Record<string, unknown> {
  // A leading "--" comment would be read as a CLI flag; the guard select avoids it.
  const wrapped = `select 1 as _guard where false;\n${sql}`;
  let out: string;
  try {
    out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', wrapped, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`supabase db query failed: ${err.stderr || err.stdout || err.message}`);
  }
  return lastRow(out);
}

/**
 * The CLI sometimes reports a SQL failure inside a JSON body and still exits 0.
 * Without this, a broken query yields an empty result and the assertions pass
 * against nothing.
 */
function lastRow(out: string): Record<string, unknown> {
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) {
    throw new Error(`supabase db query returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  }
  const rows = parsed.rows ?? [];
  return rows[rows.length - 1] ?? {};
}

async function queryAsync(sql: string): Promise<Record<string, unknown>> {
  const wrapped = `select 1 as _guard where false;\n${sql}`;
  const { stdout } = await execFileAsync('npx',
    ['supabase', 'db', 'query', '--linked', wrapped, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000 });
  return lastRow(stdout);
}

/* ── Shared fixture SQL ──────────────────────────────────────────────────────
   Two user-organised events belonging to one organiser, plus the people who
   should and should not be able to scan them. Profiles are picked by id so the
   selection is a total order — picking by created_at returned the same row
   twice when timestamps tied. */
const PEOPLE = `
create temp table people as select
  (select id from public.profiles where coalesce(role,'')<>'admin' and coalesce(is_platform_owner,false)=false order by id offset 0 limit 1) as u_org,
  (select id from public.profiles where coalesce(role,'')<>'admin' and coalesce(is_platform_owner,false)=false order by id offset 1 limit 1) as u_other,
  (select id from public.profiles where role='admin' order by id limit 1) as u_admin;`;

const FIXTURE = `${PEOPLE}
insert into public.events (id, title, starts_at, organiser_user_id)
select '${EV_A}','__S4TEST__ A', now()+interval '7 days', u_org from people
on conflict (id) do update set organiser_user_id = excluded.organiser_user_id;
insert into public.events (id, title, starts_at, organiser_user_id)
select '${EV_B}','__S4TEST__ B', now()+interval '7 days', u_org from people
on conflict (id) do update set organiser_user_id = excluded.organiser_user_id;
insert into public.event_ticket_types (id, event_id, name, price_pence, quantity_available, quantity_sold, is_active, per_order_max)
values ('a5000004-0000-4000-8000-0000000000ea','${EV_A}','__S4TEST__ tt',1000,500,0,true,10),
       ('a5000004-0000-4000-8000-0000000000eb','${EV_B}','__S4TEST__ tt',1000,500,0,true,10)
on conflict (id) do nothing;
insert into public.event_ticket_orders (id, event_id, buyer_id, status, total_pence, platform_fee_pence, tickets_count, client_request_id)
select 'a5000004-0000-4000-8000-0000000000fa','${EV_A}', u_org,'paid',1000,0,1,'__S4TEST__a' from people
on conflict (id) do nothing;
insert into public.event_ticket_orders (id, event_id, buyer_id, status, total_pence, platform_fee_pence, tickets_count, client_request_id)
select 'a5000004-0000-4000-8000-0000000000fb','${EV_B}', u_org,'paid',1000,0,1,'__S4TEST__b' from people
on conflict (id) do nothing;`;

/** Mints tickets tagged S4T-<label>, with raw token '__S4TEST__<label>'. */
function mintTickets(specs: Array<[label: string, event: string, type: string, order: string, status: string]>): string {
  return specs.map(([l, e, t, o, s]) => `
insert into public.event_tickets (order_id, event_id, ticket_type_id, holder_id, validation_token_hash, backup_code, status, price_pence)
select '${o}','${e}','${t}', p.u_org, encode(sha256('__S4TEST__${l}'::bytea),'hex'), 'S4T-${l}', '${s}', 1000 from people p;`).join('\n');
}

const TT_A = 'a5000004-0000-4000-8000-0000000000ea';
const TT_B = 'a5000004-0000-4000-8000-0000000000eb';
const OR_A = 'a5000004-0000-4000-8000-0000000000fa';
const OR_B = 'a5000004-0000-4000-8000-0000000000fb';

// ── 1. Concurrency: the whole point of Step 4 ───────────────────────────────

describe('two simultaneous scans of one ticket', () => {
  const TOKEN = `__S4TEST__${RACE_LABEL}`;
  let ticketId = '';
  let scannerA = '';
  let scannerB = '';

  const cleanup = () => query(`
    delete from public.event_checkins
      where event_id in ('${EV_A}','${EV_B}')
         or ticket_id in (select id from public.event_tickets where backup_code like 'S4T-%');
    delete from public.event_tickets where backup_code like 'S4T-%';
    delete from public.event_ticket_orders where id in ('${OR_A}','${OR_B}');
    delete from public.event_ticket_types where id in ('${TT_A}','${TT_B}');
    delete from public.events where id in ('${EV_A}','${EV_B}');
    select 1;`);

  before(() => {
    cleanup();                                   // heal anything an interrupted run left
    const r = query(`${FIXTURE}
${mintTickets([[RACE_LABEL, EV_A, TT_A, OR_A, 'valid']])}
select (select id from public.event_tickets where backup_code='S4T-${RACE_LABEL}')::text as ticket_id,
       (select u_org::text from people)   as scanner_a,
       (select u_admin::text from people) as scanner_b;`);
    ticketId = String(r.ticket_id);
    scannerA = String(r.scanner_a);
    scannerB = String(r.scanner_b);
    assert.match(ticketId, /^[0-9a-f-]{36}$/, 'fixture ticket was not created');
    assert.notEqual(scannerA, scannerB, 'the two entrances must be two different people');
  });

  after(cleanup);

  test('exactly one entrance admits the attendee', async () => {
    // A redeems and then holds its transaction open. B starts while A is still
    // uncommitted, so B is GUARANTEED to read the pre-commit row — the exact
    // interleaving the old code lost. B's conditional UPDATE blocks on A's row
    // lock and, once released, re-tests status against the committed row.
    const a = queryAsync(`begin;
create temp table ra as select public.validate_and_checkin_ticket('${TOKEN}','${EV_A}','${scannerA}') r;
select pg_sleep(6);
select r->>'result' as res from ra;
commit;`);
    const b = queryAsync(`select pg_sleep(3);
select public.validate_and_checkin_ticket('${TOKEN}','${EV_A}','${scannerB}')->>'result' as res;`);

    const [ra, rb] = await Promise.all([a, b]);
    const results = [String(ra.res), String(rb.res)];
    const wins = results.filter((x) => x === 'valid').length;

    assert.equal(wins, 1,
      `TICKET REDEEMED ${wins} TIMES by simultaneous scans — expected exactly one. Got ${JSON.stringify(results)}`);
    assert.ok(results.includes('already_used'),
      `the losing entrance must be told the ticket is already used, got ${JSON.stringify(results)}`);

    const state = query(`select t.status,
      (t.checked_in_by is not null) as scanner_recorded,
      (select count(*) from public.event_checkins c where c.ticket_id=t.id and c.result='valid')::int  as valid_rows,
      (select count(*) from public.event_checkins c where c.ticket_id=t.id and c.result='already_used')::int as already_rows,
      (select count(distinct c.scanner_id) from public.event_checkins c where c.ticket_id=t.id and c.result='valid')::int as winners
      from public.event_tickets t where t.id='${ticketId}';`);

    assert.equal(state.status, 'used', 'the ticket should end up spent exactly once');
    assert.equal(state.scanner_recorded, true, 'no scanner was recorded against the redemption');
    assert.equal(state.valid_rows, 1,
      `AUDIT TRAIL WRONG: ${state.valid_rows} result=valid rows for one ticket — a redemption was logged twice`);
    assert.equal(state.winners, 1, 'more than one scanner is recorded as having admitted this ticket');
    assert.equal(state.already_rows, 1, 'the losing scan should be recorded as already_used');
  });

  test('a third, later scan is still refused', () => {
    const r = query(`select public.validate_and_checkin_ticket('${TOKEN}','${EV_A}','${scannerA}')->>'result' as res;`);
    assert.equal(r.res, 'already_used', 'a ticket became redeemable again after being spent');
  });

  test('the winning redemption is still the only one in the audit trail', () => {
    const r = query(`select (select count(*) from public.event_checkins where ticket_id='${ticketId}' and result='valid')::int as n;`);
    assert.equal(r.n, 1, 'repeat scans added further result=valid rows');
  });
});

// ── 2. Everything else, inside one rolled-back transaction ──────────────────

type Case = { area: string; case_name: string; expected: string; actual: string; verdict: string };

describe('redemption rules', () => {
  let rows: Case[] = [];

  before(() => {
    const sql = `begin;
${FIXTURE}
${mintTickets([
      ['V1', EV_A, TT_A, OR_A, 'valid'],
      ['V2', EV_A, TT_A, OR_A, 'valid'],
      ['V3', EV_A, TT_A, OR_A, 'valid'],
      ['V4', EV_A, TT_A, OR_A, 'valid'],
      ['CAN', EV_A, TT_A, OR_A, 'cancelled'],
      ['REF', EV_A, TT_A, OR_A, 'refunded'],
      ['PEN', EV_A, TT_A, OR_A, 'pending_payment'],
      ['USE', EV_A, TT_A, OR_A, 'used'],
      ['B1', EV_B, TT_B, OR_B, 'valid'],
    ])}
create temp table results (n int generated always as identity, area text, case_name text, expected text, actual text);

insert into results (area, case_name, expected, actual)
select 'authorisation', c.name, c.expect,
       public.validate_and_checkin_ticket('__S4TEST__'||c.tok, c.ev, c.who)->>'result'
from people p, lateral (values
  ('organiser scans own event',            'valid',          'V1', '${EV_A}'::uuid, p.u_org),
  ('unrelated authenticated user',         'not_authorised', 'V2', '${EV_A}'::uuid, p.u_other),
  ('platform admin',                       'valid',          'V2', '${EV_A}'::uuid, p.u_admin),
  ('null scanner identity',                'not_authorised', 'V3', '${EV_A}'::uuid, null::uuid),
  ('nonexistent event',                    'not_authorised', 'V3', '${NIL}'::uuid, p.u_org)
) c(name, expect, tok, ev, who);

insert into results (area, case_name, expected, actual)
select 'wrong event', 'Event A ticket presented at Event B', 'wrong_event',
       public.validate_and_checkin_ticket('__S4TEST__V3','${EV_B}', p.u_org)->>'result' from people p;

insert into results (area, case_name, expected, actual)
select 'ticket state', c.name, c.expect,
       public.validate_and_checkin_ticket('__S4TEST__'||c.tok,'${EV_A}', p.u_org)->>'result'
from people p, lateral (values
  ('cancelled never admits',       'cancelled',          'CAN'),
  ('refunded never admits',        'refunded',           'REF'),
  ('unpaid never admits',          'payment_incomplete', 'PEN'),
  ('already used never re-admits', 'already_used',       'USE'),
  ('unknown token',                'not_found',          'NOSUCH')
) c(name, expect, tok);

insert into results (area, case_name, expected, actual)
select 'backup codes', c.name, c.expect, public.validate_backup_code(c.code, c.ev, c.who)->>'result'
from people p, lateral (values
  ('code redeems within its own event',      'valid',          'S4T-V4',  '${EV_A}'::uuid, p.u_org),
  ('code for Event A refused at Event B',    'not_found',      'S4T-V4',  '${EV_B}'::uuid, p.u_org),
  ('code for Event B refused at Event A',    'not_found',      'S4T-B1',  '${EV_A}'::uuid, p.u_org),
  ('de-dashed code still resolves',          'already_used',   'S4TV4',   '${EV_A}'::uuid, p.u_org),
  ('stranger cannot probe for codes',        'not_authorised', 'S4T-V4',  '${EV_A}'::uuid, p.u_other)
) c(name, expect, code, ev, who);

insert into results (area, case_name, expected, actual)
select 'audit trail', 'one result=valid row per admitted ticket', '1',
  (select count(*)::text from public.event_checkins c join public.event_tickets t on t.id=c.ticket_id
    where t.backup_code='S4T-V1' and c.result='valid');

insert into results (area, case_name, expected, actual)
select 'audit trail', 'a refused scan is recorded, not silently dropped', 'true',
  (exists (select 1 from public.event_checkins c join public.event_tickets t on t.id=c.ticket_id
            where t.backup_code='S4T-CAN' and c.result='cancelled'))::text;

insert into results (area, case_name, expected, actual)
select 'can_scan_event', c.name, c.expect, public.can_scan_event(c.ev, c.who)::text
from people p, lateral (values
  ('organiser of a user event',  'true',  '${EV_A}'::uuid, p.u_org),
  ('stranger, user event',       'false', '${EV_A}'::uuid, p.u_other),
  ('null event id',              'false', null::uuid,      p.u_org),
  ('null user id',               'false', '${EV_A}'::uuid, null::uuid),
  ('event that does not exist',  'false', '${NIL}'::uuid,  p.u_org)
) c(name, expect, ev, who);

insert into results (area, case_name, expected, actual)
select 'backup generator', 'every one of 200 codes is a full XXXX-XXXX', '200',
  (select count(*)::text from (select public.generate_ticket_backup_code() c from generate_series(1,200)) g
    where g.c ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$');

insert into results (area, case_name, expected, actual)
select 'backup generator', 'codes are not repeating', 'true',
  (select (count(distinct c) > 190)::text from (select public.generate_ticket_backup_code() c from generate_series(1,200)) g);

select n, area, case_name, expected, actual,
       case when expected is not distinct from actual then 'PASS' else 'FAIL' end as verdict
  from results order by n;
rollback;`;

    const wrapped = `select 1 as _guard where false;\n${sql}`;
    let out: string;
    try {
      out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', wrapped, '--output-format', 'json'],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message?: string };
      throw new Error(`redemption matrix failed to run: ${err.stderr || err.stdout || err.message}`);
    }
    const parsed = JSON.parse(out) as { rows?: Case[]; _tag?: string; error?: unknown };
    if (parsed._tag === 'Error' || parsed.error) {
      throw new Error(`redemption matrix returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
    }
    rows = (parsed.rows ?? []).filter((r) => r.verdict);
    assert.equal(rows.length, 25, `expected all 25 matrix cases to run, got ${rows.length}`);
  });

  for (const area of ['authorisation', 'wrong event', 'ticket state', 'backup codes', 'audit trail', 'can_scan_event', 'backup generator']) {
    test(area, () => {
      const mine = rows.filter((r) => r.area === area);
      assert.ok(mine.length > 0, `no cases ran for "${area}"`);
      const failed = mine.filter((r) => r.verdict !== 'PASS');
      if (failed.length) {
        assert.fail(`REDEMPTION REGRESSION in ${area}:\n` +
          failed.map((f) => `  • ${f.case_name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`).join('\n'));
      }
    });
  }
});

// ── 3. None of it is reachable from a browser ───────────────────────────────

describe('the redemption RPCs stay server-only', () => {
  before(() => {
    if (!cfg) throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (or provide a .env).');
  });

  const denied: Array<[string, Record<string, unknown>]> = [
    ['validate_and_checkin_ticket',       { p_raw_token: 'x', p_event_id: NIL, p_scanner_id: NIL }],
    ['validate_and_checkin_ticket_by_id', { p_ticket_id: NIL, p_event_id: NIL, p_scanner_id: NIL }],
    ['validate_backup_code',              { p_backup_code: 'AAAA-AAAA', p_event_id: NIL, p_scanner_id: NIL }],
    ['redeem_ticket_atomic',              { p_ticket_id: NIL, p_event_id: NIL, p_scanner_id: NIL }],
    ['can_scan_event',                    { p_event_id: NIL, p_user_id: NIL }],
    ['scan_attempt_limit_exceeded',       { p_scanner_id: NIL, p_event_id: NIL }],
    ['generate_ticket_backup_code',       {}],
    // Was granted to PUBLIC and anon, and answered the anon key with live
    // ticket-sales figures for any event id. Now authorised inside the function.
    ['get_event_scanner_stats',           { p_event_id: NIL }],
  ];

  for (const [fn, body] of denied) {
    test(`anon cannot call ${fn}`, async () => {
      const res = await fetch(`${cfg!.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.notEqual(res.status, 404,
        `${fn}: signature drifted — this probe stopped testing anything. Update the arguments.`);
      assert.equal(res.status, 401,
        `SECURITY REGRESSION: ${fn} answered the public anon key with HTTP ${res.status}`);
    });
  }

  test('the edge function refuses a request with no session', async () => {
    const res = await fetch(`${cfg!.url}/functions/v1/validate-event-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: NIL, raw_token: 'x' }),
    });
    assert.equal(res.status, 401, `expected 401 without a session, got ${res.status}`);
  });

  test('a scanner_id in the request body cannot buy an identity', async () => {
    // The body is destructured for exactly three fields, so this is inert —
    // but assert it, because the whole audit trail depends on it staying inert.
    const res = await fetch(`${cfg!.url}/functions/v1/validate-event-ticket`, {
      method: 'POST',
      headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: NIL, raw_token: 'x', scanner_id: NIL, user_id: NIL, p_scanner_id: NIL }),
    });
    assert.equal(res.status, 401,
      `a forged scanner identity in the body produced HTTP ${res.status} instead of a refusal`);
  });
});

// ── 4. Guessing a backup code is bounded ────────────────────────────────────

describe('backup-code guessing is limited', () => {
  const EV_RL1 = 'a5000004-0000-4000-8000-0000000000r1'.replace('r1', 'c1');
  const EV_RL2 = 'a5000004-0000-4000-8000-0000000000r2'.replace('r2', 'c2');
  let r: Record<string, unknown> = {};

  before(() => {
    // The limit counts not_found rows per (scanner, event) inside a window, so
    // the check needs a clean event of its own. All of it is rolled back.
    r = query(`begin;
create temp table pp as select
  (select id from public.profiles where coalesce(role,'')<>'admin' and coalesce(is_platform_owner,false)=false order by id limit 1) u_org;
insert into public.events (id, title, starts_at, organiser_user_id)
select '${EV_RL1}','__S4RL__ a', now()+interval '7 days', u_org from pp;
insert into public.events (id, title, starts_at, organiser_user_id)
select '${EV_RL2}','__S4RL__ b', now()+interval '7 days', u_org from pp;

create temp table x1 as select public.validate_backup_code('ZZZZ-ZZZZ','${EV_RL1}',(select u_org from pp))->>'result' res;
insert into public.event_checkins (ticket_id, event_id, scanner_id, result)
select null,'${EV_RL1}',(select u_org from pp),'not_found' from generate_series(1,18);
create temp table x2 as select public.validate_backup_code('YYYY-YYYY','${EV_RL1}',(select u_org from pp))->>'result' res;
create temp table x3 as select public.validate_backup_code('XXXX-XXXX','${EV_RL1}',(select u_org from pp))->>'result' res;
create temp table x4 as select public.validate_backup_code('XXXX-XXXX','${EV_RL2}',(select u_org from pp))->>'result' res;

select (select res from x1) as first_miss, (select res from x2) as twentieth_miss,
       (select res from x3) as over_limit, (select res from x4) as other_event,
       (select count(*)::int from public.event_checkins where event_id='${EV_RL1}') as rows_logged;
rollback;`);
  });

  test('a normal run of unrecognised codes is not throttled', () => {
    assert.equal(r.first_miss, 'not_found');
    assert.equal(r.twentieth_miss, 'not_found',
      'the limit bit too early — a door mistyping a few codes would be locked out');
  });

  test('sustained guessing is refused', () => {
    assert.equal(r.over_limit, 'rate_limited',
      'backup codes can still be guessed without limit');
  });

  test('one door cannot throttle another', () => {
    assert.equal(r.other_event, 'not_found',
      'hitting the limit at one event blocked the same person scanning a different one');
  });

  test('a refused attempt is not itself logged', () => {
    // Otherwise an attacker inflates the very table that measures them, and the
    // window never drains.
    assert.equal(r.rows_logged, 20,
      `expected 20 logged misses, found ${r.rows_logged} — the throttled attempt was recorded`);
  });
});
