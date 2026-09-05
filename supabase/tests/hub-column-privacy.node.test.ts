/**
 * hub-column-privacy.node.test.ts — a Connect account id the internet can read.
 *
 * WHAT WAS WRONG
 *
 * public.hubs granted SELECT to anon and authenticated at TABLE level, and its
 * RLS policy ("hubs read": is_active = true OR owner_id = auth.uid()) filtered
 * ROWS only. Verified against production with the anon key: a signed-out caller
 * could select stripe_account_id for any active hub. It came back null solely
 * because no hub had completed Connect onboarding — the first hub to connect
 * would have published its live Stripe Connect account id.
 *
 * local_businesses had the same defect and the same fix, in two parts, in
 * 20260820220000 / 20260820230000. This proves the hub version of it.
 *
 * WHY A COLUMN REVOKE ALONE WOULD NOT DO
 *
 * In PostgreSQL a table-level SELECT covers every column, present and future.
 * `revoke select (stripe_account_id)` while the table grant stands changes
 * nothing. The table grant has to go, and the safe columns be granted back —
 * which is why `select *` becomes a permission error, and why the mobile client
 * had to stop asking for it before this can be applied.
 *
 * The first case below installs the OLD privileges and demonstrates the leak,
 * so the fix is measured against the defect rather than against an assumption.
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN that mentions Supabase. Run by
 * `npm run test:isolated`, which builds a throwaway PostgreSQL 17 and destroys
 * it. The schema and both migrations are read from the repository at run time,
 * so this exercises the real SQL that will be applied to production.
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
const PART_ONE = join(MIG, '20260928120000_hub_payout_ready_function.sql');
const PART_TWO = join(MIG, '20260928130000_hub_column_grants.sql');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');

const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';

const src = (p: string) => readFileSync(p, 'utf8');

/** psql's own output, errors included — a refusal is the result, not a crash. */
function raw(body: string): string {
  try {
    return execFileSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}
/** psql prints a command tag per statement; SET and RESET are not results. */
const TAG = /^(SET|RESET|BEGIN|COMMIT|UPDATE \d+|INSERT \d+ \d+|DO|CREATE .*|GRANT|REVOKE)$/;
/** The single value in psql output. Takes OUTPUT, not SQL. */
const value = (out: string) =>
  out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l)).pop() ?? '';
/** Run SQL and read its single value. */
const scalar = (sql: string) => value(raw(sql));

/** Run a statement as a client role, the way PostgREST would. */
const asRole = (role: string, sql: string, uid?: string) =>
  raw(`${uid ? `set local request.jwt.claim.sub = '${uid}'; ` : ''}set role ${role}; ${sql}; reset role;`);

const denied = (out: string) => /permission denied/i.test(out);

function createTable(file: string, opener: string): string {
  const s = src(file);
  const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone`);
  const open = s.indexOf('(', start);
  let depth = 0, end = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  return s.slice(start, end + 1) + ';';
}

const HUB = '77777777-7777-4777-8777-777777777777';
const OWNER = '88888888-8888-4888-8888-888888888888';
const STRANGER = '99999999-9999-4999-8999-999999999999';
const ACCT = 'acct_TESTLIVECONNECTID';

/** The privileges hubs had before the fix: table-wide SELECT for both clients. */
let preFixAccountRead = '';
let preFixSelectStar = '';

const OLD_GRANTS = `
  grant select on public.hubs to anon;
  grant select on public.hubs to authenticated;
  grant select on public.hubs to service_role;`;

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`. This suite must never touch the linked project.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');

  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    `do $r$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $r$;`,
    'grant usage on schema public to anon, authenticated, service_role;',
    // Supabase's auth.uid(), faithfully: the subject claim of the caller's JWT.
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    'grant usage on schema auth to anon, authenticated, service_role;',
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    createTable(BASELINE, 'CREATE TABLE public.hubs ('),
    'alter table public.hubs enable row level security;',
    // The real policy: rows only. This is the half that was doing all the work.
    `create policy "hubs read" on public.hubs for select
       using ((is_active = true) or (owner_id = auth.uid()));`,
    OLD_GRANTS,
    `insert into public.hubs (id, owner_id, name, slug, type, is_active, stripe_account_id, payout_enabled)
       values ('${HUB}', '${OWNER}', 'ZZ Privacy Proof Hub', 'zz-privacy-proof', 'club', true, '${ACCT}', true);`,
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `fixture did not build:\n${out.slice(0, 800)}`);

  // Measure the defect BEFORE anything is taken away, in the same hook, so no
  // test ordering can decide whether the "before" state was really observed.
  preFixAccountRead = value(asRole('anon', `select stripe_account_id from public.hubs where id='${HUB}'`));
  preFixSelectStar = asRole('anon', `select * from public.hubs where id='${HUB}'`);

  const one = raw(src(PART_ONE));
  assert.doesNotMatch(one, /ERROR/i, `part one failed:\n${one.slice(0, 600)}`);
  const two = raw(src(PART_TWO));
  assert.doesNotMatch(two, /ERROR/i, `part two failed:\n${two.slice(0, 600)}`);
});

describe('the defect, demonstrated before it is fixed', () => {
  test('with the old privileges, anon read the live Connect account id', () => {
    assert.equal(preFixAccountRead, ACCT,
      'the pre-fix state could not be reproduced — the proof would be meaningless');
  });

  test('and `select *` handed over everything', () => {
    assert.ok(!denied(preFixSelectStar), 'select * was already refused before the fix');
    assert.match(preFixSelectStar, new RegExp(ACCT), 'the account id was not in the row');
  });
});

describe('the fix is applied', () => {
  test('both migrations installed cleanly', () => {
    assert.equal(scalar(`select count(*)::text from pg_proc where proname='hub_payout_ready'`), '1');
  });
});

describe('SIGNED OUT — anon', () => {
  test('still reads the legitimate public fields of an active hub', () => {
    const out = asRole('anon', `select name || '|' || type || '|' || slug from public.hubs where id='${HUB}'`);
    assert.ok(!denied(out), out.slice(0, 200));
    assert.match(out, /ZZ Privacy Proof Hub\|club\|zz-privacy-proof/);
  });

  test('cannot select stripe_account_id', () => {
    const out = asRole('anon', `select stripe_account_id from public.hubs where id='${HUB}'`);
    assert.ok(denied(out), `anon still read the Connect account id: ${out.slice(0, 200)}`);
    assert.doesNotMatch(out, new RegExp(ACCT), 'the account id appeared in the output');
  });

  test('cannot select * either, so a new column is private by default', () => {
    const out = asRole('anon', `select * from public.hubs where id='${HUB}'`);
    assert.ok(denied(out), 'select * still works — the table grant was not removed');
  });

  test('cannot select owner_id, so the hub → person mapping is not enumerable', () => {
    assert.ok(denied(asRole('anon', `select owner_id from public.hubs where id='${HUB}'`)));
  });

  test('payout_enabled stays readable — a readiness boolean, not a credential', () => {
    const out = asRole('anon', `select payout_enabled from public.hubs where id='${HUB}'`);
    assert.ok(!denied(out), out.slice(0, 200));
    assert.match(out, /^t$/m);
  });

  test('and cannot ask the function for it either', () => {
    assert.ok(denied(asRole('anon', `select public.hub_payout_ready('${HUB}')`)));
  });
});

describe('SIGNED IN, NOT AN ADMIN — authenticated', () => {
  test('cannot read another hub’s Connect account id', () => {
    const out = asRole('authenticated', `select stripe_account_id from public.hubs where id='${HUB}'`, STRANGER);
    assert.ok(denied(out), `a signed-in stranger read the account id: ${out.slice(0, 200)}`);
  });

  test('cannot select * either', () => {
    assert.ok(denied(asRole('authenticated', `select * from public.hubs where id='${HUB}'`, STRANGER)));
  });

  test('may read owner_id, which signed-in "is this mine?" checks need', () => {
    const out = asRole('authenticated', `select owner_id from public.hubs where id='${HUB}'`, STRANGER);
    assert.ok(!denied(out), out.slice(0, 200));
  });
});

describe('HUB OWNER — the authorised management path still works', () => {
  test('the owner gets the payout-ready boolean the admin screen needs', () => {
    const out = asRole('authenticated', `select public.hub_payout_ready('${HUB}')::text`, OWNER);
    assert.ok(!denied(out), out.slice(0, 200));
    assert.match(out, /^true$/m, 'a connected hub did not report ready');
  });

  test('but still cannot obtain the account id behind it', () => {
    assert.ok(denied(asRole('authenticated', `select stripe_account_id from public.hubs where id='${HUB}'`, OWNER)));
  });

  test('the boolean tracks the real condition, not just the flag', () => {
    raw(`update public.hubs set stripe_account_id = null where id='${HUB}'`);
    const off = value(asRole('authenticated', `select public.hub_payout_ready('${HUB}')::text`, OWNER));
    raw(`update public.hubs set stripe_account_id = '${ACCT}' where id='${HUB}'`);
    const on = value(asRole('authenticated', `select public.hub_payout_ready('${HUB}')::text`, OWNER));
    assert.equal(off, 'false', 'payout_enabled alone was treated as ready');
    assert.equal(on, 'true');
  });

  test('an unknown hub is not ready, and does not error', () => {
    assert.equal(value(asRole('authenticated',
      `select public.hub_payout_ready('00000000-0000-4000-8000-000000000000')::text`, OWNER)), 'false');
  });
});

describe('SERVICE ROLE — onboarding, webhook and payments unaffected', () => {
  test('retains the Connect account id it needs to charge and pay out', () => {
    const out = asRole('service_role', `select stripe_account_id from public.hubs where id='${HUB}'`);
    assert.ok(!denied(out), `service_role lost access: ${out.slice(0, 200)}`);
    assert.match(out, new RegExp(ACCT));
  });

  test('and may still execute the readiness function', () => {
    assert.ok(!denied(asRole('service_role', `select public.hub_payout_ready('${HUB}')`)));
  });
});

describe('the clients no longer ask for what they cannot have', () => {
  const code = (p: string) => src(p)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('mobile names its columns instead of select *', () => {
    const c = code(join(REPO_ROOT, 'lib/hubs-api.ts'));
    assert.doesNotMatch(c, /from\('hubs'\)\.select\('\*'\)/, "a select('*') on hubs would be a permission error");
    assert.match(c, /from\('hubs'\)\.select\(HUB_COLS\)/);
    assert.doesNotMatch(c, /stripe_account_id/, 'the client still models a column it may not read');
  });

  test('the web public projection carries neither protected column', () => {
    const c = code(join(WEB, 'lib/hubs-data.ts'));
    const cols = c.slice(c.indexOf('const HUB_COLS'), c.indexOf('const HUB_COLS') + 500);
    assert.doesNotMatch(cols, /stripe_account_id/, 'the account id is back in the public projection');
    assert.doesNotMatch(cols, /owner_id/, 'owner_id is not granted to anon, and these reads are anon');
  });

  test('the web admin read goes through the function, not the column', () => {
    const c = code(join(WEB, 'lib/hubs-server.ts'));
    assert.match(c, /rpc\("hub_payout_ready", \{ p_hub_id: hubId \}\)/);
    assert.doesNotMatch(c, /select\("stripe_account_id/, 'the admin screen would now get a permission error');
  });
});
