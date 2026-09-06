/**
 * my-unclaimed-gifts.node.test.ts — a gift you own, that you could not see.
 *
 * WHAT WAS WRONG
 *
 * /account/gifts promised "When someone sends you a gift, it'll appear here
 * ready to claim". It could not. fetchMyGiftsReceived filtered on
 * claimed_by_user_id = auth.uid() and status in ('claimed','used'), and
 * book_gifts had SELECT policies for the business, the purchaser and the
 * CLAIMER — none for the recipient. A recipient became visible to themselves
 * only by claiming, which is what they came to the page to do. Lose the email
 * and there was no route to the gift at all.
 *
 * WHAT IS ASSERTED — against the real SQL, executed
 *   A  confirmed email matches      → the sent gift is listed, safe fields only
 *   B  a different confirmed email  → nothing
 *   C  matching but UNCONFIRMED     → nothing
 *   D  once claimed                 → gone from the unclaimed list
 *   E  expired                      → not offered as ready to claim
 *   F  no code, no payment id, no purchaser id, no verification record
 *   G  another account cannot claim it by id, and claiming is idempotent
 *
 * The listing is identity-based on purpose: only gift_recipient_ok's FIRST
 * branch (confirmed auth email). A gift claimable via an email challenge to
 * some other address stays a link-driven flow, so "gifts sent to you" cannot
 * quietly come to mean "addresses you once proved". Claiming still runs the
 * whole of gift_recipient_ok, both branches, because claim_gift_by_id delegates
 * to claim_gift rather than re-deciding anything.
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. Schema and functions are read from the real
 * migrations at run time. The live DEMO gift is never touched.
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
const VERIFY = join(MIG, '20260824100000_gift_recipient_verification.sql');
const NEW = join(MIG, '20260930120000_my_unclaimed_gifts.sql');

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
const value = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l)).pop() ?? '';
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l));
const scalar = (sql: string) => value(raw(sql));
/** Run as a client role with a JWT subject, the way PostgREST would. */
const asUser = (uid: string | null, sql: string) =>
  raw(`begin; ${uid ? `set local request.jwt.claim.sub = '${uid}';` : ''} set local role authenticated; ${sql}; commit;`);

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

const BIZ = '11111111-aaaa-4aaa-8aaa-111111111111';
const ITEM = '22222222-aaaa-4aaa-8aaa-222222222222';
const OWNER = '33333333-aaaa-4aaa-8aaa-333333333333';
const RECIP = '44444444-aaaa-4aaa-8aaa-444444444444';   // confirmed, matches
const OTHER = '55555555-aaaa-4aaa-8aaa-555555555555';   // confirmed, different
const UNCONF = '66666666-aaaa-4aaa-8aaa-666666666666';  // matches but unconfirmed
const GIFT = '77777777-aaaa-4aaa-8aaa-777777777777';
const GIFT_EXP = '88888888-aaaa-4aaa-8aaa-888888888888';
const CODE = 'SHTEST-000001';
const TO = 'recipient@example.com';

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
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    'create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);',
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    'create table public.local_businesses (id uuid primary key, owner_id uuid, name text, slug text);',
    createTable(BASELINE, 'CREATE TABLE public.book_unit_items ('),
    'alter table public.book_unit_items add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.book_services ('),
    'alter table public.book_services add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.book_gifts ('),
    'alter table public.book_gifts add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.book_unit_purchases ('),
    'alter table public.book_unit_purchases add primary key (id);',
    createTable(VERIFY, 'create table if not exists public.gift_recipient_verifications'),
    slice(VERIFY, 'create or replace function public.gift_recipient_ok', '$$;'),
    slice(VERIFY, 'create or replace function public.claim_gift(', '$$;'),
    'grant execute on function public.claim_gift(text) to authenticated, service_role;',
    src(NEW).replace(/^begin;$/m, '').replace(/^commit;$/m, ''),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `fixture did not build:\n${out.slice(0, 1000)}`);

  const seed = raw(`
    insert into auth.users (id, email, email_confirmed_at) values
      ('${OWNER}', 'owner@example.com', now()),
      ('${RECIP}', '  ${TO.toUpperCase()} ', now()),
      ('${OTHER}', 'someone.else@example.com', now()),
      ('${UNCONF}', '${TO}', null);
    insert into public.local_businesses (id, owner_id, name, slug)
      values ('${BIZ}', '${OWNER}', 'ZZ Gift Business', 'zz-gift-business');
    insert into public.book_unit_items (id, business_id, name, price_pence, uses_per_purchase, valid_days)
      values ('${ITEM}', '${BIZ}', 'ZZ 3 Session Pass', 300, 3, 30);
    insert into public.book_gifts (id, code, kind, status, business_id, unit_item_id, purchaser_id,
                                   purchaser_name, recipient_email, message, price_paid_pence, payment_intent_id)
      values ('${GIFT}', '${CODE}', 'unit', 'sent', '${BIZ}', '${ITEM}', '${OWNER}',
              'A Sender', '${TO}', 'Enjoy!', 300, 'pi_secret_should_never_leak');
    insert into public.book_gifts (id, code, kind, status, business_id, unit_item_id, purchaser_id,
                                   purchaser_name, recipient_email, price_paid_pence, expires_at)
      values ('${GIFT_EXP}', 'SHTEST-EXPIRE', 'unit', 'sent', '${BIZ}', '${ITEM}', '${OWNER}',
              'A Sender', '${TO}', 300, now() - interval '1 day');`);
  assert.doesNotMatch(seed, /ERROR/i, `seed failed:\n${seed.slice(0, 600)}`);
});

const listFor = (uid: string | null) =>
  rowsOf(asUser(uid, `select gift_id::text || '|' || product_name || '|' || business_name || '|' || coalesce(sender_name,'-') from public.my_unclaimed_gifts()`));

describe('A — the recipient, matched on their confirmed email', () => {
  test('the sent gift is listed', () => {
    const rows = listFor(RECIP);
    assert.equal(rows.length, 1, `expected exactly one gift, got ${rows.length}: ${rows.join(' / ')}`);
    assert.match(rows[0], new RegExp(`^${GIFT}\\|ZZ 3 Session Pass\\|ZZ Gift Business\\|A Sender$`));
  });

  test('matching survives case and whitespace, as gift_recipient_ok does', () => {
    // The seeded account's email is '  RECIPIENT@EXAMPLE.COM ' — same rule.
    assert.equal(listFor(RECIP).length, 1);
  });

  test('the display fields it returns are the ones the card needs', () => {
    const cols = rowsOf(raw(`select string_agg(column_name, ',' order by ordinal_position)
                               from information_schema.columns
                              where table_name = 'my_unclaimed_gifts'`));
    const shape = scalar(`select pg_get_function_result('public.my_unclaimed_gifts'::regproc)`);
    for (const f of ['gift_id', 'kind', 'product_name', 'business_name', 'sender_name', 'message', 'expires_at']) {
      assert.match(shape, new RegExp(f), `${f} is missing from the result`);
    }
    void cols;
  });
});

describe('B — a different account sees nothing', () => {
  test('another confirmed email gets an empty list', () => {
    assert.deepEqual(listFor(OTHER), []);
  });

  test('and signed out gets nothing', () => {
    assert.deepEqual(listFor(null), []);
  });
});

describe('C — a matching but UNCONFIRMED address sees nothing', () => {
  test('an unconfirmed email proves nothing', () => {
    assert.deepEqual(listFor(UNCONF), [],
      'an unconfirmed address was treated as identity');
  });
});

describe('E — an expired gift is not offered', () => {
  test('the expired gift is absent even for the right recipient', () => {
    const rows = listFor(RECIP);
    assert.equal(rows.length, 1);
    assert.doesNotMatch(rows[0], new RegExp(GIFT_EXP), 'an expired gift was offered as ready to claim');
  });
});

describe('F — nothing secret leaves the database', () => {
  const shape = () => scalar(`select pg_get_function_result('public.my_unclaimed_gifts'::regproc)`);

  for (const forbidden of ['code', 'payment_intent_id', 'purchaser_id', 'recipient_email', 'claimed_by_user_id', 'token_hash']) {
    test(`the result carries no ${forbidden}`, () => {
      assert.doesNotMatch(shape(), new RegExp(`\\b${forbidden}\\b`), `${forbidden} is exposed to the client`);
    });
  }

  test('the claim code never appears in any returned value', () => {
    const out = asUser(RECIP, `select * from public.my_unclaimed_gifts()`);
    assert.doesNotMatch(out, new RegExp(CODE), 'the raw gift code reached the caller');
    assert.doesNotMatch(out, /pi_secret_should_never_leak/, 'a payment intent id reached the caller');
  });

  test('anon may not execute it at all', () => {
    assert.equal(scalar(`select has_function_privilege('anon','public.my_unclaimed_gifts()','execute')::text`), 'false');
    assert.equal(scalar(`select has_function_privilege('authenticated','public.my_unclaimed_gifts()','execute')::text`), 'true');
  });

  test('both functions are definer with a pinned search_path', () => {
    for (const fn of ['my_unclaimed_gifts()', 'claim_gift_by_id(uuid)']) {
      const d = raw(`select pg_get_functiondef('public.${fn}'::regprocedure)`);
      assert.match(d, /SECURITY DEFINER/i, `${fn} is not definer`);
      assert.match(d, /SET search_path TO ['"]?public/i, `${fn} has no pinned search_path`);
    }
  });
});

describe('G — claiming from the list', () => {
  test('a stranger cannot claim it by id', () => {
    const out = asUser(OTHER, `select public.claim_gift_by_id('${GIFT}'::uuid)`);
    assert.match(out, /gift_recipient_verification_required/,
      'an unrelated account got past the recipient gate');
    assert.equal(scalar(`select coalesce(claimed_by_user_id::text,'null') from public.book_gifts where id='${GIFT}'`), 'null');
  });

  test('an unknown id is refused without saying whether it exists', () => {
    const out = asUser(RECIP, `select public.claim_gift_by_id('00000000-0000-4000-8000-000000000000'::uuid)`);
    assert.match(out, /gift_not_found/);
  });

  test('signed out is refused', () => {
    assert.match(asUser(null, `select public.claim_gift_by_id('${GIFT}'::uuid)`), /auth_required/);
  });

  test('the recipient can, and the gift becomes used', () => {
    const out = asUser(RECIP, `select public.claim_gift_by_id('${GIFT}'::uuid)`);
    assert.doesNotMatch(out, /ERROR/i, out.slice(0, 300));
    assert.equal(scalar(`select status from public.book_gifts where id='${GIFT}'`), 'used');
    assert.equal(scalar(`select claimed_by_user_id::text from public.book_gifts where id='${GIFT}'`), RECIP);
  });

  test('exactly one pass was created', () => {
    assert.equal(scalar(`select count(*)::text from public.book_unit_purchases where gift_id='${GIFT}'`), '1');
    assert.equal(scalar(`select uses_remaining::text from public.book_unit_purchases where gift_id='${GIFT}'`), '3');
    assert.equal(scalar(`select owner_id::text from public.book_unit_purchases where gift_id='${GIFT}'`), RECIP);
  });

  test('claiming again is idempotent — no second pass', () => {
    asUser(RECIP, `select public.claim_gift_by_id('${GIFT}'::uuid)`);
    assert.equal(scalar(`select count(*)::text from public.book_unit_purchases where gift_id='${GIFT}'`), '1');
  });
});

describe('D — once claimed, it leaves the unclaimed list', () => {
  test('the recipient no longer sees it as ready to claim', () => {
    assert.deepEqual(listFor(RECIP), [],
      'a claimed gift is still being offered as ready to claim');
  });

  test('but the row is still there, claimed, for the history path', () => {
    assert.equal(scalar(`select status from public.book_gifts where id='${GIFT}'`), 'used');
    assert.equal(scalar(`select count(*)::text from public.book_gifts
                          where claimed_by_user_id='${RECIP}' and status in ('claimed','used')`), '1');
  });
});

/* ── The web side, so the RPC is actually reached and the code never is ────── */

const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const code = (p: string) => src(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the web reads it through the RPC, and claims without the code', () => {
  const data = () => code(join(WEB, 'lib/passes-data.ts'));
  const client = () => code(join(WEB, 'app/account/gifts/GiftsClient.tsx'));

  test('the listing calls my_unclaimed_gifts, not the table', () => {
    const d = data();
    const fn = d.slice(d.indexOf('export async function fetchMyReadyToClaimGifts'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    assert.match(body, /rpc\("my_unclaimed_gifts"\)/);
    assert.doesNotMatch(body, /from\("book_gifts"\)/, 'the table has no recipient policy — this would return nothing');
  });

  test('claiming goes by id, never by code', () => {
    const d = data();
    const fn = d.slice(d.indexOf('export async function claimGiftById'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    assert.match(body, /rpc\("claim_gift_by_id", \{ p_gift_id: giftId \}\)/);
    assert.doesNotMatch(body, /claim_gift"/, 'the by-code RPC must not be called with a client-held code');
  });

  test('the ready-to-claim type carries no secret', () => {
    const d = data();
    const t = d.slice(d.indexOf('export type ReadyToClaimGift'), d.indexOf('export async function fetchMyReadyToClaimGifts'));
    for (const forbidden of ['code', 'payment_intent_id', 'purchaser_id', 'recipient_email']) {
      assert.doesNotMatch(t, new RegExp(`\\b${forbidden}\\b`), `${forbidden} is modelled on the client`);
    }
  });

  test('the page shows the card, its CTA, and the required fields', () => {
    const c = client();
    assert.match(c, /Ready to claim/);
    assert.match(c, /Claim gift/);
    assert.match(c, /g\.product_name/);
    assert.match(c, /g\.sender_name/);
    assert.match(c, /g\.business_name/);
    assert.match(c, /claimGiftById\(g\.gift_id\)/);
  });

  test('the empty state accounts for ready-to-claim gifts', () => {
    assert.match(client(), /gifts\.length === 0 && readyToClaim\.length === 0 \? \(/,
      'the empty state would show while a claimable gift is listed');
  });

  test('a claim re-reads rather than moving the card locally', () => {
    const c = client();
    assert.match(c, /await claimGiftById\(g\.gift_id\);[\s\S]{0,320}fetchMyReadyToClaimGifts\(\)/);
    assert.doesNotMatch(c, /setReadyToClaim\(readyToClaim\.filter/, 'the outcome must come from the database');
  });
});
