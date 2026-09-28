/**
 * loyalty-earning-atomicity.node.test.ts — two taps, one stamp.
 *
 * Earning a stamp or points was a read-then-write in TypeScript, in all four
 * live paths:
 *
 *   local-nfc-stamp        customer, NFC tile, 4-hour gap
 *   local-stamp-collect    customer, rotating business code, 4-hour gap
 *   loyalty-till  'stamp'  operator, 60-SECOND gap
 *   loyalty-till  'points' operator, NO gap — two awards are both legitimate
 *
 * Each reads the card, decides in the client, UPDATEs by id holding no lock,
 * then INSERTs a ledger row as a separate unchecked commit. So the gap check
 * is evaluated against a value another request may already have superseded,
 * the increment can be lost, and the ledger can record awards the card does
 * not carry.
 *
 * Production already shows that signature: the one live card holds 2 stamps
 * against 3 ledger rows and 0 redemptions. That drift is NOT repaired here and
 * nothing in this suite depends on it — every case runs on a clean fixture.
 *
 * The gap rules differ per path and are PRODUCT semantics, not bugs. This
 * suite preserves them exactly: it does not invent a dedupe rule for till
 * points, and it does not remove the 60-second one from till stamps.
 *
 * HOW THE CURRENT BEHAVIOUR IS EXECUTED
 *
 * The logic is in TypeScript, so what races is the sequence of statements the
 * deployed code sends. The replay issues exactly those, one connection per
 * statement, never wrapped in a transaction, with the read returning INTO THE
 * CLIENT and the writes carrying it as literals — because that is what
 * supabase-js does, and a sub-select would be strictly more atomic than the
 * code under test.
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. No production loyalty row is read or written.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const FN = join(REPO_ROOT, 'supabase/functions');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const REMINDERS = join(MIG, '20260721020000_loyalty_reminders.sql');
const TIERS = join(MIG, '20260721030000_loyalty_reward_tiers.sql');
const TIERGUARD = join(MIG, '20260922120000_offers_loyalty_tier_entitlement.sql');
const FIX = join(MIG, '20261005120000_loyalty_earning_atomic.sql');

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
async function rawAsync(body: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(PSQL, args(body), { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
    return stdout + stderr;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const value = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l)).pop() ?? '';
const scalar = (sql: string) => value(raw(sql));
const num = (sql: string) => Number(scalar(sql));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const OWNER = 'b0000000-0000-4000-8000-00000000000b';
const CUST  = 'c0000000-0000-4000-8000-00000000000c';
const BIZ   = 'd0000000-0000-4000-8000-00000000000d';
const PROG  = 'e0000000-0000-4000-8000-00000000000e';
const CARD  = 'f0000000-0000-4000-8000-00000000000f';

function schema(programType: 'stamps' | 'points') {
  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    'create table auth.users (id uuid primary key, email text);',
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $$;`,
    'create table public.profiles (id uuid primary key);',
    createTable(BASELINE, 'CREATE TABLE public.local_businesses ('),
    'alter table public.local_businesses add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.local_loyalty_programs ('),
    'alter table public.local_loyalty_programs add primary key (id);',
    slice(TIERS, 'alter table public.local_loyalty_programs', ';'),
    createTable(BASELINE, 'CREATE TABLE public.local_loyalty_cards ('),
    'alter table public.local_loyalty_cards add primary key (id);',
    // The uniqueness the first-card race turns on, from the live schema.
    'alter table public.local_loyalty_cards add constraint local_loyalty_cards_user_id_program_id_key unique (user_id, program_id);',
    slice(REMINDERS, 'alter table public.local_loyalty_cards\n  add column if not exists reward_reminded_at', ';'),
    slice(REMINDERS, 'alter table public.local_loyalty_cards\n  add column if not exists nudge_reminded_at', ';'),
    slice(TIERS, 'alter table public.local_loyalty_cards\n  add column if not exists tiers_redeemed_upto', ';'),
    createTable(BASELINE, 'CREATE TABLE public.local_loyalty_transactions ('),
    'alter table public.local_loyalty_transactions add primary key (id);',
    `create or replace function public.business_meets_tier(p_biz uuid, p_tier text)
       returns boolean language sql stable as $$ select true $$;`,
    slice(TIERGUARD, 'create or replace function public.local_loyalty_cards_tier_guard', '$$;'),
    `drop trigger if exists local_loyalty_cards_tier_guard on public.local_loyalty_cards;
     create trigger local_loyalty_cards_tier_guard before insert or update on public.local_loyalty_cards
       for each row execute function public.local_loyalty_cards_tier_guard();`,
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1200)}`);
  const p = raw(`insert into auth.users (id) values ('${OWNER}'), ('${CUST}');
    insert into public.profiles (id) values ('${OWNER}'), ('${CUST}');
    insert into public.local_businesses (id, owner_id, name, category, address)
      values ('${BIZ}','${OWNER}','Makkers','retail','Lerwick');
    insert into public.local_loyalty_programs (id, business_id, type, stamps_required, stamp_reward, points_per_pound, is_active)
      values ('${PROG}','${BIZ}','${programType}',5,'A free coffee',1,true);`);
  assert.doesNotMatch(p, /ERROR/i, `fixtures failed:\n${p.slice(0, 900)}`);
}

const fixFns = () => [
  slice(FIX, 'create or replace function public.loyalty_earn_stamp', '$$;'),
  slice(FIX, 'create or replace function public.loyalty_earn_points', '$$;'),
].join('\n');
function installFix(mutate: (sql: string) => string = (x) => x) {
  const out = raw(mutate(fixFns()));
  assert.doesNotMatch(out, /ERROR/i, `fix install failed:\n${out.slice(0, 900)}`);
}
const grantsBlock = () => slice(FIX, 'do $$\ndeclare fn text;', 'end $$;');

const earnStamp = (gap: number) =>
  value(raw(`select public.loyalty_earn_stamp('${CUST}', '${BIZ}', ${gap});`));
const earnPoints = (pts: number) =>
  value(raw(`select public.loyalty_earn_points('${CUST}', '${BIZ}', ${pts});`));

/** A holds the card lock for 600ms; B arrives 120ms in and must wait it out. */
async function raceRpc(call: string): Promise<string[]> {
  const a = rawAsync(`begin; select ${call}; select pg_sleep(0.6); commit;`);
  await sleep(120);
  const b = rawAsync(`select ${call};`);
  return Promise.all([a, b]);
}
const okCount = (outs: string[]) => outs.filter((o) => /"ok"\s*:\s*true/.test(o)).length;
/** Pretend the last award was a while ago, without touching anything else. */
const ageLastStamp = (seconds: number) =>
  raw(`update public.local_loyalty_cards set last_stamp_at = now() - interval '${seconds} seconds';`);
const anyCardStamps = () => num(`select coalesce(sum(stamps_collected),0)::text from public.local_loyalty_cards;`);
const anyCardPoints = () => num(`select coalesce(sum(points_balance),0)::text from public.local_loyalty_cards;`);

/** A card that already exists, with a chosen age on last_stamp_at. */
function card(opts: { stamps?: number; points?: number; lastStampAgoHours?: number | null }) {
  const last = opts.lastStampAgoHours == null
    ? 'null' : `now() - interval '${opts.lastStampAgoHours} hours'`;
  const o = raw(`delete from public.local_loyalty_transactions;
    delete from public.local_loyalty_cards;
    insert into public.local_loyalty_cards (id, user_id, program_id, business_id, stamps_collected, points_balance, total_redeemed, tiers_redeemed_upto, last_stamp_at)
    values ('${CARD}','${CUST}','${PROG}','${BIZ}',${opts.stamps ?? 0},${opts.points ?? 0},0,0,${last});`);
  assert.doesNotMatch(o, /ERROR/i, `card fixture failed:\n${o.slice(0, 800)}`);
}
function noCard() {
  const o = raw(`delete from public.local_loyalty_transactions; delete from public.local_loyalty_cards;`);
  assert.doesNotMatch(o, /ERROR/i, `reset failed:\n${o.slice(0, 400)}`);
}

/**
 * The deployed statements, replayed: read on its own connection, values into
 * the client, writes carrying them as literals.
 */
async function replay(read: string, write: (v: number[]) => string[] | null, gapMs: number): Promise<'awarded' | 'refused'> {
  const r = value(await rawAsync(read));
  const vals = r.split('|').map(Number);
  await sleep(gapMs);
  const stmts = write(vals);
  if (stmts === null) return 'refused';
  for (const s of stmts) await rawAsync(s);
  return 'awarded';
}

/** stamps_collected | points_balance | seconds since last_stamp_at (-1 = never). */
const readCard = `select stamps_collected || '|' || points_balance || '|' ||
  coalesce(round(extract(epoch from (now() - last_stamp_at)))::text, '-1')
  from public.local_loyalty_cards where id='${CARD}';`;

/** local-nfc-stamp / local-stamp-collect / till stamp: gap decided in the client. */
const writeStamp = (gapSeconds: number) => (v: number[]): string[] | null => {
  const since = v[2];
  if (since >= 0 && since < gapSeconds) return null;      // the client-side gap check
  return [
    `update public.local_loyalty_cards set stamps_collected = ${v[0] + 1},
       last_stamp_at = now(), nudge_reminded_at = null where id='${CARD}';`,
    `insert into public.local_loyalty_transactions (card_id, user_id, business_id, type, amount)
       values ('${CARD}','${CUST}','${BIZ}','stamp',1);`,
  ];
};
/** till points: no gap at all — two operator awards are both legitimate. */
const writePoints = (pts: number) => (v: number[]): string[] | null => [
  `update public.local_loyalty_cards set points_balance = ${v[1] + pts}, last_stamp_at = now() where id='${CARD}';`,
  `insert into public.local_loyalty_transactions (card_id, user_id, business_id, type, amount, note)
     values ('${CARD}','${CUST}','${BIZ}','points_earn',${pts},'Earned at till');`,
];
/** get-or-create, as every caller does it: SELECT, then a plain INSERT. */
const firstCardSteps = async (): Promise<string> => {
  const existing = value(await rawAsync(`select id from public.local_loyalty_cards where user_id='${CUST}' and program_id='${PROG}';`));
  await sleep(200);
  if (existing) return 'found';
  const ins = await rawAsync(`insert into public.local_loyalty_cards (user_id, program_id, business_id, stamps_collected, points_balance)
    values ('${CUST}','${PROG}','${BIZ}',0,0) returning id;`);
  return /ERROR/i.test(ins) ? 'insert_failed' : 'created';
};

const stamps = () => num(`select coalesce(stamps_collected,0)::text from public.local_loyalty_cards where id='${CARD}';`);
const points = () => num(`select coalesce(points_balance,0)::text from public.local_loyalty_cards where id='${CARD}';`);
const ledgerStamps = () => num(`select count(*)::text from public.local_loyalty_transactions where type='stamp';`);
const ledgerPoints = () => num(`select coalesce(sum(amount),0)::text from public.local_loyalty_transactions where type='points_earn';`);
const ledgerPointRows = () => num(`select count(*)::text from public.local_loyalty_transactions where type='points_earn';`);
const cardCount = () => num(`select count(*)::text from public.local_loyalty_cards;`);

/* Each stage rebuilds, so state must be READ while it exists. */
const now = {
  nfcAwarded: 0, nfcStamps: 0, nfcLedger: 0,
  qrAwarded: 0, qrStamps: 0, qrLedger: 0,
  tillAwarded: 0, tillStamps: 0, tillLedger: 0,
  ptsAwarded: 0, ptsBalance: 0, ptsLedger: 0, ptsRows: 0,
  firstCards: 0, firstOutcomes: '' as string,
};
const fixed = {
  custOk: 0, custStamps: 0, custLedger: 0,
  seqFirst: '', seqSecond: '', seqThird: '', seqStamps: 0, seqLedger: 0,
  tillOk: 0, tillStamps: 0, tillLedger: 0,
  tillSeqStamps: 0, tillSeqLedger: 0,
  ptsOk: 0, ptsBalance: 0, ptsLedger: 0, ptsRows: 0,
  firstCards: 0, firstOk: 0, firstStamps: 0, firstLedger: 0,
  firstCustCards: 0, firstCustOk: 0, firstCustStamps: 0, firstCustLedger: 0, firstCustSecond: '', firstCustLastStamp: 0,
  firstTillCards: 0, firstTillOk: 0, firstTillStamps: 0, firstTillLedger: 0, firstTillSecond: '',
  ledgerFailStamps: 0, ledgerFailRows: 0, cardFailRows: 0, cardFailStamps: 0,
  stampOnPoints: '', pointsOnStamps: '',
};
const priv: Record<string, string> = {};
const callers = { nfc: false, qr: false, tillStamp: false, tillPoints: false, noRmw: false };
const anchors = { upsertLock: false, atomicInc: false, gapUnderLock: false, typeFilter: false, ledgerInsert: false };
const mut = {
  m1Ok: 0, m1Stamps: 0, m1Ledger: 0,
  m2Stamps: 0, m2Ledger: 0,
  m3Stamps: 0, m3Ledger: 0,
  m4: '', m5Outcomes: '', m5Cards: 0,
};

before(async () => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');

  // ── A. NFC stamp: two taps, both starting outside the 4-hour gap ─────────
  schema('stamps'); card({ stamps: 2, lastStampAgoHours: 9 });
  const a = await Promise.all([
    replay(readCard, writeStamp(14400), 300),
    sleep(60).then(() => replay(readCard, writeStamp(14400), 300)),
  ]);
  now.nfcAwarded = a.filter((x) => x === 'awarded').length;
  now.nfcStamps = stamps();
  now.nfcLedger = ledgerStamps();

  // ── B. QR / business-code stamp: identical shape, same 4-hour gap ────────
  schema('stamps'); card({ stamps: 2, lastStampAgoHours: 9 });
  const b = await Promise.all([
    replay(readCard, writeStamp(14400), 300),
    sleep(60).then(() => replay(readCard, writeStamp(14400), 300)),
  ]);
  now.qrAwarded = b.filter((x) => x === 'awarded').length;
  now.qrStamps = stamps();
  now.qrLedger = ledgerStamps();

  // ── C. Till stamp: 60-second gap, two operators at once ─────────────────
  schema('stamps'); card({ stamps: 2, lastStampAgoHours: 9 });
  const c = await Promise.all([
    replay(readCard, writeStamp(60), 300),
    sleep(60).then(() => replay(readCard, writeStamp(60), 300)),
  ]);
  now.tillAwarded = c.filter((x) => x === 'awarded').length;
  now.tillStamps = stamps();
  now.tillLedger = ledgerStamps();

  // ── D. Till points: no gap, so BOTH awards are legitimate ───────────────
  schema('points'); card({ points: 10, lastStampAgoHours: 9 });
  const d = await Promise.all([
    replay(readCard, writePoints(5), 300),
    sleep(60).then(() => replay(readCard, writePoints(5), 300)),
  ]);
  now.ptsAwarded = d.filter((x) => x === 'awarded').length;
  now.ptsBalance = points();
  now.ptsLedger = ledgerPoints();
  now.ptsRows = ledgerPointRows();

  // ── E. First card: two first-time awards at once ────────────────────────
  schema('stamps'); noCard();
  const e = await Promise.all([firstCardSteps(), sleep(50).then(() => firstCardSteps())]);
  now.firstCards = cardCount();
  now.firstOutcomes = e.sort().join(',');

  // Every live earning caller must actually go through the primitive; an
  // invariant one path can still bypass is not an invariant.
  const nfc = src(join(FN, 'local-nfc-stamp/index.ts'));
  const qr = src(join(FN, 'local-stamp-collect/index.ts'));
  const till = src(join(FN, 'loyalty-till/index.ts'));
  callers.nfc = nfc.includes(`rpc('loyalty_earn_stamp'`);
  callers.qr = qr.includes(`rpc('loyalty_earn_stamp'`);
  callers.tillStamp = till.includes(`rpc('loyalty_earn_stamp'`);
  callers.tillPoints = till.includes(`rpc('loyalty_earn_points'`);
  // Not a grep for a variable name — an earlier version of this matched a
  // readyTier() argument and reported a write that was not there. The claim is
  // that no earning caller writes the card or the ledger at all any more.
  callers.noRmw = ![nfc, qr, till].some((f) =>
    /from\('local_loyalty_cards'\)[\s\S]{0,80}\.update\(/.test(f)
    || f.includes("from('local_loyalty_transactions').insert"));

  // ══ FIXED ═══════════════════════════════════════════════════════════════
  // CUSTOMER STAMP: two concurrent taps, both allowed at the start.
  schema('stamps'); installFix(); card({ stamps: 2, lastStampAgoHours: 9 });
  const fa = await raceRpc(`public.loyalty_earn_stamp('${CUST}', '${BIZ}', 14400)`);
  fixed.custOk = okCount(fa);
  fixed.custStamps = stamps();
  fixed.custLedger = ledgerStamps();

  // CUSTOMER STAMP, sequential: allowed, refused inside the gap, allowed after.
  schema('stamps'); installFix(); card({ stamps: 0, lastStampAgoHours: null });
  fixed.seqFirst = earnStamp(14400);
  fixed.seqSecond = earnStamp(14400);
  ageLastStamp(14401);
  fixed.seqThird = earnStamp(14400);
  fixed.seqStamps = stamps();
  fixed.seqLedger = ledgerStamps();

  // TILL STAMP: two operators at once, inside the sixty-second rule.
  schema('stamps'); installFix(); card({ stamps: 2, lastStampAgoHours: 9 });
  const fc = await raceRpc(`public.loyalty_earn_stamp('${CUST}', '${BIZ}', 60)`);
  fixed.tillOk = okCount(fc);
  fixed.tillStamps = stamps();
  fixed.tillLedger = ledgerStamps();

  // TILL STAMP: two awards genuinely outside the gap — both must land.
  schema('stamps'); installFix(); card({ stamps: 0, lastStampAgoHours: null });
  earnStamp(60); ageLastStamp(61); earnStamp(60);
  fixed.tillSeqStamps = stamps();
  fixed.tillSeqLedger = ledgerStamps();

  // TILL POINTS: no gap, so both concurrent awards are legitimate and kept.
  schema('points'); installFix(); card({ points: 10, lastStampAgoHours: 9 });
  const fd = await raceRpc(`public.loyalty_earn_points('${CUST}', '${BIZ}', 5)`);
  fixed.ptsOk = okCount(fd);
  fixed.ptsBalance = points();
  fixed.ptsLedger = ledgerPoints();
  fixed.ptsRows = ledgerPointRows();

  // FIRST CARD: two first-time awards at once, no gap so neither is refused.
  schema('stamps'); installFix(); noCard();
  const fe = await raceRpc(`public.loyalty_earn_stamp('${CUST}', '${BIZ}', 0)`);
  fixed.firstOk = okCount(fe);
  fixed.firstCards = cardCount();
  fixed.firstStamps = anyCardStamps();
  fixed.firstLedger = ledgerStamps();

  // FIRST CARD, REAL CUSTOMER GAP: the four-hour rule when no card exists yet.
  //
  // The stage above deliberately passes gap 0 to isolate conflict handling.
  // That leaves the question this one answers: when the card is created by the
  // race itself, does the loser observe the winner's last_stamp_at, or does a
  // brand-new row let both through?
  schema('stamps'); installFix(); noCard();
  const fg = await raceRpc(`public.loyalty_earn_stamp('${CUST}', '${BIZ}', 14400)`);
  fixed.firstCustOk = okCount(fg);
  fixed.firstCustSecond = fg.find((o) => !/"ok"\s*:\s*true/.test(o)) ?? '';
  fixed.firstCustCards = cardCount();
  fixed.firstCustStamps = anyCardStamps();
  fixed.firstCustLedger = ledgerStamps();
  fixed.firstCustLastStamp = num(
    `select count(*)::text from public.local_loyalty_cards where last_stamp_at is not null;`);

  // FIRST CARD, REAL TILL GAP: the same question with the sixty-second rule.
  schema('stamps'); installFix(); noCard();
  const fh = await raceRpc(`public.loyalty_earn_stamp('${CUST}', '${BIZ}', 60)`);
  fixed.firstTillOk = okCount(fh);
  fixed.firstTillSecond = fh.find((o) => !/"ok"\s*:\s*true/.test(o)) ?? '';
  fixed.firstTillCards = cardCount();
  fixed.firstTillStamps = anyCardStamps();
  fixed.firstTillLedger = ledgerStamps();

  // ROLLBACK: a failing ledger insert must take the card increment with it.
  schema('stamps'); installFix(); card({ stamps: 2, lastStampAgoHours: 9 });
  raw(`create function public.boom() returns trigger language plpgsql as $b$
       begin raise exception 'ledger is down'; end $b$;
       create trigger boom before insert on public.local_loyalty_transactions
         for each row execute function public.boom();`);
  earnStamp(0);
  fixed.ledgerFailStamps = stamps();
  fixed.ledgerFailRows = ledgerStamps();
  raw(`drop trigger boom on public.local_loyalty_transactions;`);

  // ROLLBACK: a failing card update must leave no ledger row behind.
  schema('stamps'); installFix(); card({ stamps: 2, lastStampAgoHours: 9 });
  raw(`create function public.boom2() returns trigger language plpgsql as $b$
       begin raise exception 'card is down'; end $b$;
       create trigger boom2 before update on public.local_loyalty_cards
         for each row execute function public.boom2();`);
  earnStamp(0);
  fixed.cardFailRows = ledgerStamps();
  fixed.cardFailStamps = stamps();
  raw(`drop trigger boom2 on public.local_loyalty_cards;`);

  // TYPE: a stamp cannot land on a points programme, or points on a stamps one.
  schema('points'); installFix(); noCard();
  fixed.stampOnPoints = earnStamp(0);
  schema('stamps'); installFix(); noCard();
  fixed.pointsOnStamps = earnPoints(5);

  // ── Privileges, from the migration's own grant block ─────────────────────
  schema('stamps'); installFix();
  const g = raw(grantsBlock());
  assert.doesNotMatch(g, /ERROR/i, `grants failed:\n${g.slice(0, 600)}`);
  for (const fn of ['loyalty_earn_stamp', 'loyalty_earn_points']) {
    priv[fn] = scalar(
      `select string_agg(r || ':' || case when has_function_privilege(r, p.oid, 'execute') then 'yes' else 'no' end, ' ')
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
              unnest(array['anon','authenticated','service_role']) r
        where n.nspname='public' and p.proname = '${fn}';`);
  }

  // ══ MUTATIONS ═══════════════════════════════════════════════════════════
  const upsert = `  insert into public.local_loyalty_cards (user_id, program_id, business_id, stamps_collected, points_balance)
  values (p_user, v_prog.id, p_business, 0, 0)
  on conflict (user_id, program_id)
    do update set business_id = public.local_loyalty_cards.business_id
  returning * into v_card;`;
  const atomicInc = `     set stamps_collected = coalesce(stamps_collected, 0) + 1,`;
  const gapCheck = `  if p_min_gap_seconds > 0 and v_card.last_stamp_at is not null then`;
  const typeFilter = ` and type = 'stamps'`;
  const ledgerIns = `  insert into public.local_loyalty_transactions (card_id, user_id, business_id, type, amount, note)
  values (v_card.id, p_user, p_business, 'stamp', 1, null);`;
  const f = fixFns();
  anchors.upsertLock = f.includes(upsert);
  anchors.atomicInc = f.includes(atomicInc);
  anchors.gapUnderLock = f.includes(gapCheck);
  anchors.typeFilter = f.includes(typeFilter);
  anchors.ledgerInsert = f.includes(ledgerIns);

  const unlockedRead = `  select * into v_card from public.local_loyalty_cards
   where user_id = p_user and program_id = v_prog.id;`;

  // M1 — the card lock removed: the gap is decided on a stale read again.
  schema('stamps'); installFix((x) => x.replace(upsert, unlockedRead)); card({ stamps: 2, lastStampAgoHours: 9 });
  const m1 = await raceRpc(`public.loyalty_earn_stamp('${CUST}', '${BIZ}', 14400)`);
  mut.m1Ok = okCount(m1);
  mut.m1Stamps = stamps();
  mut.m1Ledger = ledgerStamps();

  // M2 — the lock removed AND the increment computed from the stale read.
  // M1 shows the gap collapsing; this shows the increment being lost as well,
  // which is a different failure the atomic increment is what prevents.
  schema('stamps');
  installFix((x) => x.replace(upsert, unlockedRead)
                     .replace(atomicInc, `     set stamps_collected = coalesce(v_card.stamps_collected, 0) + 1,`));
  card({ stamps: 2, lastStampAgoHours: 9 });
  await raceRpc(`public.loyalty_earn_stamp('${CUST}', '${BIZ}', 14400)`);
  mut.m2Stamps = stamps();
  mut.m2Ledger = ledgerStamps();

  // M3 — the ledger insert dropped: the card moves with nothing recording it.
  schema('stamps'); installFix((x) => x.replace(ledgerIns, '')); card({ stamps: 2, lastStampAgoHours: 9 });
  earnStamp(0);
  mut.m3Stamps = stamps();
  mut.m3Ledger = ledgerStamps();

  // M4 — programme-type validation removed: a stamp lands on a points card.
  schema('points'); installFix((x) => x.replace(typeFilter, '')); noCard();
  mut.m4 = earnStamp(0);

  // M5 — first-card conflict handling removed.
  schema('stamps');
  installFix((x) => x.replace(upsert, upsert
    .replace(`  on conflict (user_id, program_id)
    do update set business_id = public.local_loyalty_cards.business_id
`, '')));
  noCard();
  const m5 = await raceRpc(`public.loyalty_earn_stamp('${CUST}', '${BIZ}', 0)`);
  mut.m5Outcomes = String(okCount(m5));
  mut.m5Cards = cardCount();
});

describe('THE DEFECT, AS IT IS — A. NFC stamp, two taps at once', () => {
  test('both taps pass the four-hour gap check', () => {
    assert.equal(now.nfcAwarded, 2);
  });
  test('but the card gains only one stamp — an increment is lost', () => {
    assert.equal(now.nfcStamps, 3);
  });
  test('while the ledger records two', () => {
    assert.equal(now.nfcLedger, 2);
  });
  test('so card and ledger disagree, exactly as production does', () => {
    assert.notEqual(now.nfcStamps - 2, now.nfcLedger);
  });
});

describe('THE DEFECT, AS IT IS — B. QR stamp, two scans at once', () => {
  test('both scans award', () => {
    assert.equal(now.qrAwarded, 2);
  });
  test('one increment is lost and the ledger disagrees', () => {
    assert.equal(now.qrStamps, 3);
    assert.equal(now.qrLedger, 2);
  });
});

describe('THE DEFECT, AS IT IS — C. till stamp, two operators at once', () => {
  test('both pass the sixty-second gap check', () => {
    assert.equal(now.tillAwarded, 2);
  });
  test('one increment is lost and the ledger disagrees', () => {
    assert.equal(now.tillStamps, 3);
    assert.equal(now.tillLedger, 2);
  });
});

describe('THE DEFECT, AS IT IS — D. till points, two legitimate awards', () => {
  test('both awards are legitimate — there is no gap rule here', () => {
    assert.equal(now.ptsAwarded, 2);
  });
  test('but only one is kept: the balance rises by 5, not 10', () => {
    assert.equal(now.ptsBalance, 15);
  });
  test('while the ledger correctly records both', () => {
    assert.equal(now.ptsLedger, 10);
    assert.equal(now.ptsRows, 2);
  });
});

describe('THE DEFECT, AS IT IS — E. first card, two awards at once', () => {
  test('the unique constraint holds: only one card exists', () => {
    assert.equal(now.firstCards, 1);
  });
  test('but the loser gets a raw insert failure, not its award', () => {
    assert.equal(now.firstOutcomes, 'created,insert_failed');
  });
});

describe('FIXED — customer stamp, the gap decided under the lock', () => {
  test('two concurrent taps: exactly one wins', () => {
    assert.equal(fixed.custOk, 1);
  });
  test('one stamp added, one ledger row', () => {
    assert.equal(fixed.custStamps, 3);
    assert.equal(fixed.custLedger, 1);
  });
});

describe('FIXED — customer stamp, sequential', () => {
  test('the first is allowed', () => {
    assert.match(fixed.seqFirst, /"ok"\s*:\s*true/);
  });
  test('a second inside four hours is refused, and says how long to wait', () => {
    assert.match(fixed.seqSecond, /too_soon/);
    assert.match(fixed.seqSecond, /wait_seconds/);
  });
  test('and the next one after the gap is allowed', () => {
    assert.match(fixed.seqThird, /"ok"\s*:\s*true/);
  });
  test('two awards, two stamps, two ledger rows', () => {
    assert.equal(fixed.seqStamps, 2);
    assert.equal(fixed.seqLedger, 2);
  });
});

describe('FIXED — till stamp keeps its own sixty-second rule', () => {
  test('two operators at once: one wins, as the existing rule intends', () => {
    assert.equal(fixed.tillOk, 1);
    assert.equal(fixed.tillStamps, 3);
    assert.equal(fixed.tillLedger, 1);
  });
  test('two awards genuinely outside the gap both land', () => {
    assert.equal(fixed.tillSeqStamps, 2);
    assert.equal(fixed.tillSeqLedger, 2);
  });
});

describe('FIXED — till points: both legitimate awards are kept', () => {
  test('no gap rule is invented — both succeed', () => {
    assert.equal(fixed.ptsOk, 2);
  });
  test('the balance rises by both, and the ledger agrees', () => {
    assert.equal(fixed.ptsBalance, 20);
    assert.equal(fixed.ptsLedger, 10);
    assert.equal(fixed.ptsRows, 2);
  });
});

describe('FIXED — first-card creation with no dedupe/gap semantics', () => {
  // Gap 0 deliberately. This case exists to prove that creating the card under
  // contention does not LOSE a valid award; it says nothing about the gap
  // rules, which have their own cases below.
  test('two simultaneous first-time awards create exactly one card', () => {
    assert.equal(fixed.firstCards, 1);
  });
  test('and neither award is lost', () => {
    assert.equal(fixed.firstOk, 2);
    assert.equal(fixed.firstStamps, 2);
    assert.equal(fixed.firstLedger, 2);
  });
});

/*
 * These two cases were missing until a review asked the obvious question: the
 * no-gap case above proves conflict handling, so what happens to the REAL gap
 * rules when the card is created by the race itself?
 *
 * The answer, measured rather than reasoned: the loser is refused. The ON
 * CONFLICT arbiter has to resolve the conflicting row before it can act, so it
 * waits for the winner's transaction; the statement that reads the card
 * afterwards takes a fresh snapshot and sees the winner's last_stamp_at.
 *
 * Worth recording honestly: swapping DO UPDATE for DO NOTHING plus an unlocked
 * read produces the same result in every case here, so the row lock cannot be
 * shown to be load-bearing FOR THE GAP by these tests. DO UPDATE is kept
 * because it states the intent and holds the row explicitly, rather than
 * relying on statement-snapshot timing — not because a test proves it.
 */
describe('FIXED — first card under the real customer four-hour rule', () => {
  test('exactly one card exists', () => {
    assert.equal(fixed.firstCustCards, 1);
  });
  test('exactly one call succeeds; the other is refused as too soon', () => {
    assert.equal(fixed.firstCustOk, 1);
    assert.match(fixed.firstCustSecond, /too_soon/);
  });
  test('one stamp, one ledger row, last_stamp_at set once', () => {
    assert.equal(fixed.firstCustStamps, 1);
    assert.equal(fixed.firstCustLedger, 1);
    assert.equal(fixed.firstCustLastStamp, 1);
  });
});

describe('FIXED — first card under the real till sixty-second rule', () => {
  test('exactly one card exists', () => {
    assert.equal(fixed.firstTillCards, 1);
  });
  test('exactly one call succeeds; the other is refused as too soon', () => {
    assert.equal(fixed.firstTillOk, 1);
    assert.match(fixed.firstTillSecond, /too_soon/);
  });
  test('one stamp and one ledger row', () => {
    assert.equal(fixed.firstTillStamps, 1);
    assert.equal(fixed.firstTillLedger, 1);
  });
});

describe('FIXED — card and ledger commit together or not at all', () => {
  test('a failing ledger insert takes the card increment with it', () => {
    assert.equal(fixed.ledgerFailStamps, 2, 'the card kept an increment the ledger never recorded');
    assert.equal(fixed.ledgerFailRows, 0);
  });
  test('a failing card update leaves no ledger row behind', () => {
    assert.equal(fixed.cardFailRows, 0);
    assert.equal(fixed.cardFailStamps, 2);
  });
});

describe('FIXED — stamps and points stay apart', () => {
  test('a stamp cannot be awarded on a points programme', () => {
    assert.match(fixed.stampOnPoints, /no_stamp_program/);
  });
  test('points cannot be awarded on a stamps programme', () => {
    assert.match(fixed.pointsOnStamps, /no_points_program/);
  });
});

describe('privileges — the migration locks its own functions down', () => {
  for (const fn of ['loyalty_earn_stamp', 'loyalty_earn_points']) {
    test(`${fn} is service_role only`, () => {
      assert.equal(priv[fn], 'anon:no authenticated:no service_role:yes');
    });
  }
});

describe('the suite is anchored to the real migration', () => {
  test('the create-or-lock upsert is where the mutations expect it', () => { assert.ok(anchors.upsertLock); });
  test('the self-referential increment is where the mutations expect it', () => { assert.ok(anchors.atomicInc); });
  test('the gap check is inside the function, after the lock', () => { assert.ok(anchors.gapUnderLock); });
  test('the programme-type filter is where the mutation expects it', () => { assert.ok(anchors.typeFilter); });
  test('the ledger insert is where the mutation expects it', () => { assert.ok(anchors.ledgerInsert); });
});

describe('mutations — each protection is load-bearing', () => {
  test('M1 removing the card lock lets both taps pass a one-tap gap', () => {
    assert.equal(mut.m1Ok, 2);
    assert.equal(mut.m1Ledger, 2);
  });
  test('M2 also computing the increment from the stale read loses one', () => {
    assert.equal(mut.m2Stamps, 3, 'two awards, one increment — the lost update is back');
    assert.equal(mut.m2Ledger, 2);
  });
  test('M3 dropping the ledger insert moves the card with nothing recording it', () => {
    assert.equal(mut.m3Stamps, 3);
    assert.equal(mut.m3Ledger, 0);
  });
  test('M4 removing the type filter stamps a points programme', () => {
    assert.match(mut.m4, /"ok"\s*:\s*true/);
  });
  test('M5 removing conflict handling loses one first-time award', () => {
    assert.equal(mut.m5Cards, 1);
    assert.notEqual(mut.m5Outcomes, '2');
  });
});

describe('every earning caller now goes through the database', () => {
  test('local-nfc-stamp uses loyalty_earn_stamp', () => { assert.ok(callers.nfc); });
  test('local-stamp-collect uses loyalty_earn_stamp', () => { assert.ok(callers.qr); });
  test('loyalty-till stamp uses loyalty_earn_stamp', () => { assert.ok(callers.tillStamp); });
  test('loyalty-till points uses loyalty_earn_points', () => { assert.ok(callers.tillPoints); });
  test('no caller still writes a client-computed balance', () => {
    assert.ok(callers.noRmw, 'a read-modify-write survived; the invariant can still be bypassed');
  });
});
