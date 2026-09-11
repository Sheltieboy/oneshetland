/**
 * redemption-business-scope.node.test.ts — the business on screen is the
 * business the redemption operates against.
 *
 * WHAT WAS WRONG
 *
 * Three functions decided whether a merchant could redeem a customer's code,
 * and all three asked one question: "do you own the business this code belongs
 * to?" For an owner of one business that is the right question. For an owner of
 * two it is not — it cannot tell "I own that business" from "I am operating
 * that business right now", because no caller could say which business it was
 * acting as. app/local-verify.tsx passed no business id at all; it was the only
 * merchant route in the dashboard's counter block that didn't, and the website's
 * RedeemVerify had the same omission while every sibling on its page took one.
 *
 * So a merchant with Anderson & Co open could scan a reward issued by their
 * OTHER business and it would preview, and then redeem. The card, the ledger
 * and the consumption were all correct — the accounting was never wrong — but
 * the merchant was told another business's reward was theirs to give away.
 *
 * WHAT IS PROVED HERE, AND WHY IN A REAL DATABASE
 *
 * The fix is an optional p_business on preview_redemption,
 * loyalty_redeem_code_atomic and redeem_pass_atomic. Client filtering would not
 * be a fix, so the proof cannot be a source assertion: these tests install the
 * migration's own function bodies into a throwaway PostgreSQL and call them,
 * with two businesses under ONE owner — the case that was broken.
 *
 *   · same-business preview and redeem still work
 *   · a reward for the owner's OTHER business is refused, both ways round
 *   · the refusal is other_business, never already_used: a merchant must not be
 *     told a good reward has been spent
 *   · a business the caller does not own is refused, and reveals nothing
 *   · no business context behaves exactly as before, so an un-updated caller
 *     keeps working
 *   · a refused call consumes NOTHING — the code stays pending, the card and
 *     the pass keep their balances
 *   · every existing lock, status, expiry, kind and ownership check survives
 *   · the unscoped three-argument signatures are gone, so there is no overload
 *     left to fall back through
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. No production row is read or written.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase', 'migrations');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const BACKBONE = join(MIG, '20260721000000_loyalty_redemption_backbone.sql');
const TIERGUARD = join(MIG, '20260922120000_offers_loyalty_tier_entitlement.sql');
const REMINDERS = join(MIG, '20260721020000_loyalty_reminders.sql');
const TIERS = join(MIG, '20260721030000_loyalty_reward_tiers.sql');
const ATOMIC = join(MIG, '20261004120000_loyalty_redemption_atomic.sql');
const SCOPE = join(MIG, '20261011120000_redemption_business_scope.sql');

const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');
const args = (b: string) => [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', b];

function raw(body: string): string {
  try {
    return execFileSync(PSQL, args(body), { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const value = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l)).pop() ?? '';
const scalar = (sql: string) => value(raw(sql));
const num = (sql: string) => Number(scalar(sql));

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

/* ── The cast. ONE owner holds both businesses: the case that was broken. ──── */
const OWNER   = 'b0000000-0000-4000-8000-00000000000b';  // owns Anderson AND Demo
const STRANGE = 'a0000000-0000-4000-8000-00000000000a';  // owns neither
const CUST    = 'c0000000-0000-4000-8000-00000000000c';

const ANDERSON = 'd1000000-0000-4000-8000-000000000001';
const DEMO     = 'd2000000-0000-4000-8000-000000000002';
const OUTSIDE  = 'd3000000-0000-4000-8000-000000000003';  // the stranger's business

const PROG_A = 'e1000000-0000-4000-8000-000000000001';
const PROG_D = 'e2000000-0000-4000-8000-000000000002';
const CARD_A = 'f1000000-0000-4000-8000-000000000001';
const CARD_D = 'f2000000-0000-4000-8000-000000000002';
const RED_A  = '11000000-0000-4000-8000-000000000001';   // reward code, Anderson
const RED_D  = '12000000-0000-4000-8000-000000000002';   // reward code, Demo
const TOK_A  = '21000000-0000-4000-8000-000000000001';
const TOK_D  = '22000000-0000-4000-8000-000000000002';

const ITEM   = '31000000-0000-4000-8000-000000000001';
const PURCH  = '32000000-0000-4000-8000-000000000002';
const RED_P  = '33000000-0000-4000-8000-000000000003';   // pass code, Anderson
const TOK_P  = '34000000-0000-4000-8000-000000000004';

function build() {
  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $$;`,
    'create table auth.users (id uuid primary key, email text);',
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    createTable(BASELINE, 'CREATE TABLE public.local_businesses ('),
    'alter table public.local_businesses add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.local_loyalty_programs ('),
    'alter table public.local_loyalty_programs add primary key (id);',
    slice(TIERS, 'alter table public.local_loyalty_programs', ';'),
    createTable(BASELINE, 'CREATE TABLE public.local_loyalty_cards ('),
    'alter table public.local_loyalty_cards add primary key (id);',
    slice(REMINDERS, 'alter table public.local_loyalty_cards\n  add column if not exists reward_reminded_at', ';'),
    slice(REMINDERS, 'alter table public.local_loyalty_cards\n  add column if not exists nudge_reminded_at', ';'),
    slice(TIERS, 'alter table public.local_loyalty_cards\n  add column if not exists tiers_redeemed_upto', ';'),
    createTable(BASELINE, 'CREATE TABLE public.local_loyalty_transactions ('),
    'alter table public.local_loyalty_transactions add primary key (id);',
    createTable(BACKBONE, 'create table if not exists public.local_redemptions ('),
    createTable(BASELINE, 'CREATE TABLE public.book_unit_items'),
    'alter table public.book_unit_items add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.book_unit_purchases'),
    'alter table public.book_unit_purchases add primary key (id);',
    `create or replace function public.business_meets_tier(p_biz uuid, p_tier text)
       returns boolean language sql stable as $$ select true $$;`,
    slice(TIERGUARD, 'create or replace function public.local_loyalty_cards_tier_guard', '$$;'),
    `drop trigger if exists local_loyalty_cards_tier_guard on public.local_loyalty_cards;
     create trigger local_loyalty_cards_tier_guard before insert or update on public.local_loyalty_cards
       for each row execute function public.local_loyalty_cards_tier_guard();`,
    // The shared effects come from the atomic migration, unchanged by this one.
    slice(ATOMIC, 'create or replace function public._loyalty_apply_reward', '$$;'),
    slice(ATOMIC, 'create or replace function public._loyalty_spend_points', '$$;'),
    // The three under test, from the scope migration's own text.
    slice(SCOPE, 'create or replace function public.preview_redemption', '$$;'),
    slice(SCOPE, 'create or replace function public.loyalty_redeem_code_atomic', '$$;'),
    slice(SCOPE, 'create or replace function public.redeem_pass_atomic', '$$;'),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1500)}`);

  const f = raw(`
    insert into auth.users (id) values ('${OWNER}'),('${STRANGE}'),('${CUST}') on conflict do nothing;
    insert into public.local_businesses (id, owner_id, name, category, address) values
      ('${ANDERSON}','${OWNER}','Anderson & Co','retail','Lerwick'),
      ('${DEMO}','${OWNER}','DEMO — Subscription Test Co','retail','Lerwick'),
      ('${OUTSIDE}','${STRANGE}','Someone Else Ltd','retail','Brae');
    insert into public.local_loyalty_programs (id, business_id, type, stamps_required, stamp_reward, points_per_pound, is_active) values
      ('${PROG_A}','${ANDERSON}','stamps',5,'A free coffee',1,true),
      ('${PROG_D}','${DEMO}','stamps',5,'A free tea',1,true);
    insert into public.local_loyalty_cards (id, user_id, business_id, program_id, stamps_collected, points_balance) values
      ('${CARD_A}','${CUST}','${ANDERSON}','${PROG_A}',5,0),
      ('${CARD_D}','${CUST}','${DEMO}','${PROG_D}',5,0);
    insert into public.book_unit_items (id, business_id, name, price_pence, uses_per_purchase)
      values ('${ITEM}','${ANDERSON}','3-Session Pass',3000,3);
    insert into public.book_unit_purchases (id, item_id, business_id, owner_id, paid_amount_pence, uses_remaining)
      values ('${PURCH}','${ITEM}','${ANDERSON}','${CUST}',3000,3);
  `);
  assert.doesNotMatch(f, /ERROR/i, `fixtures failed:\n${f.slice(0, 1200)}`);
}

/** Fresh pending codes before each assertion, so tests never depend on order. */
function arm() {
  const out = raw(`
    delete from public.local_redemptions;
    update public.local_loyalty_cards set stamps_collected = 5, tiers_redeemed_upto = 0, total_redeemed = 0;
    update public.book_unit_purchases set uses_remaining = 3, fully_used_at = null where id='${PURCH}';
    delete from public.local_loyalty_transactions;
    insert into public.local_redemptions (id, business_id, user_id, kind, ref_id, code, token, status, detail, expires_at) values
      ('${RED_A}','${ANDERSON}','${CUST}','reward','${CARD_A}','AAAA','${TOK_A}','pending','{"title":"A free coffee"}', now() + interval '15 min'),
      ('${RED_D}','${DEMO}','${CUST}','reward','${CARD_D}','DDDD','${TOK_D}','pending','{"title":"A free tea"}', now() + interval '15 min'),
      ('${RED_P}','${ANDERSON}','${CUST}','pass','${PURCH}','PPPP','${TOK_P}','pending','{"title":"3-Session Pass"}', now() + interval '15 min');
  `);
  assert.doesNotMatch(out, /ERROR/i, `arm failed:\n${out.slice(0, 900)}`);
}

const q = (v: string | null) => (v === null ? 'null' : `'${v}'::uuid`);
const preview = (verifier: string, token: string, biz: string | null) =>
  scalar(`select public.preview_redemption('${verifier}'::uuid, null, '${token}', ${q(biz)})::text`);
const redeemCode = (verifier: string, token: string, biz: string | null) =>
  scalar(`select public.loyalty_redeem_code_atomic('${verifier}'::uuid, null, '${token}'::uuid, ${q(biz)})::text`);
const redeemPass = (verifier: string, token: string, biz: string | null) =>
  scalar(`select public.redeem_pass_atomic('${verifier}'::uuid, null, '${token}', ${q(biz)})::text`);

const err = (j: string) => { try { return JSON.parse(j).error ?? null; } catch { return `UNPARSEABLE:${j}`; } };
const ok = (j: string) => { try { return JSON.parse(j).ok === true; } catch { return false; } };

const status = (id: string) => scalar(`select status from public.local_redemptions where id='${id}'`);
const stamps = (card: string) => num(`select stamps_collected from public.local_loyalty_cards where id='${card}'`);
const uses = () => num(`select uses_remaining from public.book_unit_purchases where id='${PURCH}'`);

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');
  build();
});

/* ── 1. The business you are standing in ──────────────────────────────────── */

describe('same business: nothing changed', () => {
  test('Anderson reward + Anderson context previews', () => {
    arm();
    const p = preview(OWNER, TOK_A, ANDERSON);
    assert.ok(ok(p), `preview refused: ${p}`);
    assert.equal(JSON.parse(p).title, 'A free coffee');
    assert.equal(JSON.parse(p).business_id, ANDERSON, 'the preview does not say which business it is for');
  });

  test('and redeems, consuming exactly once', () => {
    arm();
    assert.ok(ok(redeemCode(OWNER, TOK_A, ANDERSON)));
    assert.equal(status(RED_A), 'consumed');
    assert.equal(stamps(CARD_A), 0, 'the card was not reset by the redemption');
    // Replay, with the same context.
    assert.equal(err(redeemCode(OWNER, TOK_A, ANDERSON)), 'already_used');
    assert.equal(num(`select count(*) from public.local_loyalty_transactions where type='reward'`), 1,
      'the reward was applied more than once');
  });

  test('an Anderson pass + Anderson context spends one use', () => {
    arm();
    assert.ok(ok(redeemPass(OWNER, TOK_P, ANDERSON)));
    assert.equal(uses(), 2);
    assert.equal(err(redeemPass(OWNER, TOK_P, ANDERSON)), 'already_used');
    assert.equal(uses(), 2, 'the replay spent a second use');
  });
});

/* ── 2. The other business — the defect ───────────────────────────────────── */

describe('the owner of both businesses cannot cross-redeem', () => {
  test('Anderson reward + DEMO context is refused', () => {
    arm();
    assert.equal(err(preview(OWNER, TOK_A, DEMO)), 'other_business');
    assert.equal(err(redeemCode(OWNER, TOK_A, DEMO)), 'other_business');
  });

  test('DEMO reward + Anderson context is refused', () => {
    arm();
    assert.equal(err(preview(OWNER, TOK_D, ANDERSON)), 'other_business');
    assert.equal(err(redeemCode(OWNER, TOK_D, ANDERSON)), 'other_business');
  });

  test('an Anderson pass + DEMO context is refused', () => {
    arm();
    assert.equal(err(preview(OWNER, TOK_P, DEMO)), 'other_business');
    assert.equal(err(redeemPass(OWNER, TOK_P, DEMO)), 'other_business');
  });

  test('a refusal consumes NOTHING', () => {
    arm();
    redeemCode(OWNER, TOK_A, DEMO);
    redeemCode(OWNER, TOK_D, ANDERSON);
    redeemPass(OWNER, TOK_P, DEMO);
    assert.equal(status(RED_A), 'pending');
    assert.equal(status(RED_D), 'pending');
    assert.equal(status(RED_P), 'pending');
    assert.equal(stamps(CARD_A), 5, 'the Anderson card moved');
    assert.equal(stamps(CARD_D), 5, 'the DEMO card moved');
    assert.equal(uses(), 3, 'the pass lost a use');
    assert.equal(num(`select count(*) from public.local_loyalty_transactions`), 0,
      'a refused redemption wrote a ledger row');
  });

  test('and the refused code still works for its OWN business afterwards', () => {
    arm();
    assert.equal(err(redeemCode(OWNER, TOK_A, DEMO)), 'other_business');
    assert.ok(ok(redeemCode(OWNER, TOK_A, ANDERSON)), 'the refusal poisoned a good reward');
  });

  test('it is never reported as already used', () => {
    arm();
    for (const j of [preview(OWNER, TOK_A, DEMO), redeemCode(OWNER, TOK_A, DEMO), redeemPass(OWNER, TOK_P, DEMO)]) {
      assert.notEqual(err(j), 'already_used', 'a merchant would be told a good reward was spent');
      assert.notEqual(err(j), 'expired');
    }
  });
});

/* ── 3. Contexts the caller has no claim to ───────────────────────────────── */

describe('an unowned business context', () => {
  test('is refused, even for a code the caller does own', () => {
    arm();
    assert.equal(err(preview(OWNER, TOK_A, OUTSIDE)), 'not_your_business');
    assert.equal(err(redeemCode(OWNER, TOK_A, OUTSIDE)), 'not_your_business');
    assert.equal(err(redeemPass(OWNER, TOK_P, OUTSIDE)), 'not_your_business');
    assert.equal(status(RED_A), 'pending');
  });

  test('a business id that does not exist is refused the same way', () => {
    arm();
    const GHOST = '00000000-0000-4000-8000-0000000000ff';
    assert.equal(err(preview(OWNER, TOK_A, GHOST)), 'not_your_business');
    assert.equal(err(redeemCode(OWNER, TOK_A, GHOST)), 'not_your_business');
  });

  test('a stranger cannot redeem with their own valid context', () => {
    arm();
    assert.equal(err(preview(STRANGE, TOK_A, OUTSIDE)), 'not_found', 'the preview leaked a stranger’s code');
    assert.equal(err(redeemCode(STRANGE, TOK_A, OUTSIDE)), 'not_your_business');
    assert.equal(status(RED_A), 'pending');
  });

  test('and the context check runs before any code is read', () => {
    arm();
    // A context they do not own plus a code that does not exist: the answer
    // must be about the context, never about the code.
    const GONE = '99999999-9999-4999-8999-999999999999';
    assert.equal(err(preview(OWNER, GONE, OUTSIDE)), 'not_your_business');
    assert.equal(err(redeemCode(OWNER, GONE, OUTSIDE)), 'not_your_business');
  });
});

/* ── 4. Backward safety ───────────────────────────────────────────────────── */

describe('no context behaves exactly as it did before', () => {
  test('an un-updated caller previewing without a business still works', () => {
    arm();
    assert.ok(ok(preview(OWNER, TOK_A, null)));
    assert.ok(ok(preview(OWNER, TOK_D, null)), 'the owner’s other business stopped working');
  });

  test('and redeeming without a business still works', () => {
    arm();
    assert.ok(ok(redeemCode(OWNER, TOK_A, null)));
    assert.equal(status(RED_A), 'consumed');
  });

  test('a stranger is still refused without a business', () => {
    arm();
    assert.equal(err(preview(STRANGE, TOK_A, null)), 'not_found');
    assert.equal(err(redeemCode(STRANGE, TOK_A, null)), 'not_your_business');
    assert.equal(err(redeemPass(STRANGE, TOK_P, null)), 'not_your_business');
  });
});

/* ── 5. Everything that was already right ─────────────────────────────────── */

describe('the existing guards survive the new parameter', () => {
  test('a consumed code is still already_used, with a context', () => {
    arm();
    raw(`update public.local_redemptions set status='consumed' where id='${RED_A}'`);
    assert.equal(err(preview(OWNER, TOK_A, ANDERSON)), 'already_used');
    assert.equal(err(redeemCode(OWNER, TOK_A, ANDERSON)), 'already_used');
  });

  test('an expired code is still expired, with a context', () => {
    arm();
    raw(`update public.local_redemptions set expires_at = now() - interval '1 min' where id='${RED_A}'`);
    assert.equal(err(preview(OWNER, TOK_A, ANDERSON)), 'expired');
    assert.equal(err(redeemCode(OWNER, TOK_A, ANDERSON)), 'expired');
  });

  test('the wrong kind is still refused by each spender', () => {
    arm();
    assert.equal(err(redeemCode(OWNER, TOK_P, ANDERSON)), 'wrong_kind', 'the reward spender took a pass code');
    assert.equal(err(redeemPass(OWNER, TOK_A, ANDERSON)), 'wrong_kind', 'the pass spender took a reward code');
  });

  test('a used-up pass is still refused', () => {
    arm();
    raw(`update public.book_unit_purchases set uses_remaining = 0 where id='${PURCH}'`);
    assert.equal(err(preview(OWNER, TOK_P, ANDERSON)), 'no_uses_left');
    assert.equal(err(redeemPass(OWNER, TOK_P, ANDERSON)), 'no_uses_left');
  });

  test('a card with no reward ready is still not_ready', () => {
    arm();
    raw(`update public.local_loyalty_cards set stamps_collected = 1 where id='${CARD_A}'`);
    assert.equal(err(redeemCode(OWNER, TOK_A, ANDERSON)), 'not_ready');
    assert.equal(status(RED_A), 'pending', 'a not_ready refusal consumed the code');
  });

  test('a malformed token is still no-match, not a crash', () => {
    arm();
    assert.equal(err(preview(OWNER, 'not-a-uuid', ANDERSON)), 'not_found');
    assert.equal(err(redeemPass(OWNER, 'not-a-uuid', ANDERSON)), 'not_found');
  });

  test('the preview still writes nothing, even now it takes a context', () => {
    arm();
    const before = scalar(`select md5(string_agg(id::text || status, ',' order by id)) from public.local_redemptions`);
    const cards = scalar(`select md5(string_agg(id::text || stamps_collected, ',' order by id)) from public.local_loyalty_cards`);
    preview(OWNER, TOK_A, ANDERSON);
    preview(OWNER, TOK_D, DEMO);
    preview(OWNER, TOK_A, DEMO);
    preview(OWNER, TOK_P, ANDERSON);
    assert.equal(scalar(`select md5(string_agg(id::text || status, ',' order by id)) from public.local_redemptions`), before);
    assert.equal(scalar(`select md5(string_agg(id::text || stamps_collected, ',' order by id)) from public.local_loyalty_cards`), cards);
    assert.equal(uses(), 3);
  });
});

/* ── 6. There is no unscoped signature left to fall through ───────────────── */

describe('the old contract is gone, not shadowed', () => {
  test('each function exists exactly once, with four arguments', () => {
    for (const [name, n] of [['preview_redemption', 4], ['loyalty_redeem_code_atomic', 4], ['redeem_pass_atomic', 4]] as const) {
      const rows = raw(`select p.pronargs from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public' and p.proname='${name}' order by 1`)
        .split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l));
      assert.deepEqual(rows, [String(n)], `${name} has signatures ${rows.join('/')} — an unscoped overload survives`);
    }
  });

  test('the migration drops each three-argument form explicitly', () => {
    const sql = src(SCOPE);
    assert.match(sql, /drop function if exists public\.preview_redemption\(uuid, text, text\);/);
    assert.match(sql, /drop function if exists public\.loyalty_redeem_code_atomic\(uuid, text, uuid\);/);
    assert.match(sql, /drop function if exists public\.redeem_pass_atomic\(uuid, text, text\);/);
  });

  test('and re-grants the new signatures to service_role only', () => {
    const out = raw(src(SCOPE).slice(src(SCOPE).indexOf('do $$\ndeclare fn text;')).split('end $$;')[0] + 'end $$;');
    assert.doesNotMatch(out, /ERROR/i, `grants failed:\n${out.slice(0, 600)}`);
    for (const name of ['preview_redemption', 'loyalty_redeem_code_atomic', 'redeem_pass_atomic']) {
      const who = scalar(`select coalesce(string_agg(g, ','), 'none') from (
        select unnest(array['anon','authenticated','public']) g) s
        where has_function_privilege(g, (select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='${name}'), 'EXECUTE')`);
      assert.equal(who, 'none', `${name} is executable by ${who}`);
      assert.equal(scalar(`select has_function_privilege('service_role', (select p.oid from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${name}'), 'EXECUTE')::text`),
        'true', `${name} is not executable by service_role`);
    }
  });
});
