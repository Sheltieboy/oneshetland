/**
 * loyalty-redemption-atomicity.node.test.ts — one reward, two tills.
 *
 * WHAT IS BEING SETTLED
 *
 * local-redeem-verify hardened its `pass` branch with redeem_pass_atomic, and
 * left a comment naming exactly what the read-then-write it replaced had done:
 * "six concurrent verifies succeed against three credits — reproduced on
 * production fixtures". The other three kinds still carry that shape, and so
 * does the till.
 *
 * Redemption is not one path. Three entry points mutate a loyalty card:
 *
 *   local-redeem-verify   kinds 'reward' and 'points', code-based
 *   loyalty-till          action 'redeem_reward', operator-driven, no code
 *   local-redeem-reward   the customer redeeming their own card, no code
 *
 * All three read the card, decide in TypeScript, then UPDATE ... WHERE id,
 * taking no lock. The code path then flips the redemption row to 'consumed'
 * UNCONDITIONALLY — no `status = 'pending'` guard — AFTER the effect, with the
 * result unchecked. Nothing serialises anything.
 *
 * HOW THE CURRENT BEHAVIOUR IS EXECUTED HERE
 *
 * The logic under test lives in TypeScript, so there is no SQL function to
 * call. What actually races is the SEQUENCE OF STATEMENTS the deployed code
 * sends, each its own round trip and its own commit. So the reproduction
 * issues exactly those statements, in that order, from two concurrent psql
 * sessions with a real gap between the read and the write — one statement per
 * connection invocation, never wrapped in a transaction, because supabase-js
 * does not wrap them either.
 *
 * That is a replay of the deployed statements, not a JavaScript imitation of
 * the logic.
 *
 * Those statements are no longer in the source: 20261004120000 moved the whole
 * decision into the database, and the callers now go through it. The replay is
 * kept because a defect nobody can still reproduce is a defect nobody can
 * argue with — it is the "before" half of the proof, and the named tests below
 * assert that every caller has actually been moved, so the fix cannot be
 * quietly bypassed by a new one.
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
const BACKBONE = join(MIG, '20260721000000_loyalty_redemption_backbone.sql');
const TIERGUARD = join(MIG, '20260922120000_offers_loyalty_tier_entitlement.sql');
const REMINDERS = join(MIG, '20260721020000_loyalty_reminders.sql');
const TIERS = join(MIG, '20260721030000_loyalty_reward_tiers.sql');
const FIX = join(MIG, '20261004120000_loyalty_redemption_atomic.sql');

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

const OWNER = 'b0000000-0000-4000-8000-00000000000b';   // business owner / operator
const CUST  = 'c0000000-0000-4000-8000-00000000000c';   // card holder
const BIZ   = 'd0000000-0000-4000-8000-00000000000d';
const PROG  = 'e0000000-0000-4000-8000-00000000000e';
const CARD  = 'f0000000-0000-4000-8000-00000000000f';
const RED   = '10000000-0000-4000-8000-000000000010';

/** Schema from the real migrations, plus the tier guard that fires on the card. */
function schema(programType: 'stamps' | 'points') {
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
    // Columns the card gained after the baseline, from their own migrations.
    slice(REMINDERS, 'alter table public.local_loyalty_cards\n  add column if not exists reward_reminded_at', ';'),
    slice(REMINDERS, 'alter table public.local_loyalty_cards\n  add column if not exists nudge_reminded_at', ';'),
    slice(TIERS, 'alter table public.local_loyalty_cards\n  add column if not exists tiers_redeemed_upto', ';'),
    createTable(BASELINE, 'CREATE TABLE public.local_loyalty_transactions ('),
    'alter table public.local_loyalty_transactions add primary key (id);',
    createTable(BACKBONE, 'create table if not exists public.local_redemptions ('),
    // The tier gate is a whole entitlement system of its own; the guard only
    // needs it to answer, and every case here is a Pro business.
    `create or replace function public.business_meets_tier(p_biz uuid, p_tier text)
       returns boolean language sql stable as $$ select true $$;`,
    slice(TIERGUARD, 'create or replace function public.local_loyalty_cards_tier_guard', '$$;'),
    `drop trigger if exists local_loyalty_cards_tier_guard on public.local_loyalty_cards;
     create trigger local_loyalty_cards_tier_guard before insert or update on public.local_loyalty_cards
       for each row execute function public.local_loyalty_cards_tier_guard();`,
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1200)}`);
  const p = raw(`insert into auth.users (id) values ('${OWNER}'), ('${CUST}') on conflict do nothing;
    insert into public.local_businesses (id, owner_id, name, category, address) values ('${BIZ}','${OWNER}','Makkers','retail','Lerwick');
    insert into public.local_loyalty_programs (id, business_id, type, stamps_required, stamp_reward, points_per_pound, is_active)
      values ('${PROG}','${BIZ}','${programType}',5,'A free coffee',1,true);`);
  assert.doesNotMatch(p, /ERROR/i, `fixtures failed:\n${p.slice(0, 900)}`);
}

/** The atomic redemption functions, from the real migration. */
const fixFns = () => [
  slice(FIX, 'create or replace function public._loyalty_apply_reward', '$$;'),
  slice(FIX, 'create or replace function public._loyalty_spend_points', '$$;'),
  slice(FIX, 'create or replace function public.loyalty_redeem_code_atomic', '$$;'),
  slice(FIX, 'create or replace function public.loyalty_redeem_card_atomic', '$$;'),
].join('\n');
function installFix(mutate: (sql: string) => string = (x) => x) {
  const out = raw(mutate(fixFns()));
  assert.doesNotMatch(out, /ERROR/i, `fix install failed:\n${out.slice(0, 900)}`);
}
/** The migration's own privilege block, applied verbatim. */
const grantsBlock = () => slice(FIX, 'do $$\ndeclare fn text;', 'end $$;');

const redeemCode = (verifier: string, code: string) =>
  value(raw(`select public.loyalty_redeem_code_atomic('${verifier}', '${code}', null);`));
const redeemCard = (actor: string, cardId: string) =>
  value(raw(`select public.loyalty_redeem_card_atomic('${actor}', '${cardId}');`));

/** A holds the row lock for 600ms; B arrives 120ms in and must wait it out. */
async function raceRpc(call: string): Promise<string[]> {
  const a = rawAsync(`begin; select ${call}; select pg_sleep(0.6); commit;`);
  await sleep(120);
  const b = rawAsync(`select ${call};`);
  return Promise.all([a, b]);
}
const okCount = (outs: string[]) => outs.filter((o) => /"ok"\s*:\s*true/.test(o)).length;

/** A card at exactly the reward threshold, or with exactly one redemption's points. */
function card(stamps: number, points: number) {
  const o = raw(`delete from public.local_loyalty_transactions;
       delete from public.local_redemptions;
       delete from public.local_loyalty_cards;
       insert into public.local_loyalty_cards (id, user_id, program_id, business_id, stamps_collected, points_balance, total_redeemed, tiers_redeemed_upto)
       values ('${CARD}','${CUST}','${PROG}','${BIZ}',${stamps},${points},0,0);`);
  assert.doesNotMatch(o, /ERROR/i, `card fixture failed:\n${o.slice(0, 800)}`);
}
function pendingCode(kind: 'reward' | 'points', amount: number | null) {
  const o = raw(`insert into public.local_redemptions (id, business_id, user_id, kind, ref_id, code, status, amount, expires_at)
       values ('${RED}','${BIZ}','${CUST}','${kind}','${CARD}','ABC123','pending',${amount ?? 'null'}, now() + interval '10 minutes');`);
  assert.doesNotMatch(o, /ERROR/i, `code fixture failed:\n${o.slice(0, 800)}`);
}

/**
 * One deployed entry point's statements, replayed faithfully.
 *
 * The read happens on its own connection, the values come back INTO THE CLIENT,
 * and the writes then carry those values as literals — which is precisely what
 * supabase-js does, and precisely why it races. An earlier version of this used
 * a sub-select inside the UPDATE; that is strictly MORE atomic than the
 * deployed code, and it quietly under-reported the defect.
 */
async function replay(read: string, write: (v: number[]) => string[], gapMs: number): Promise<void> {
  const vals = value(await rawAsync(read)).split('|').map(Number);
  await sleep(gapMs);
  for (const stmt of write(vals)) await rawAsync(stmt);
}

const readCardStamps = `select stamps_collected || '|' || total_redeemed from public.local_loyalty_cards where id='${CARD}';`;
const readCardPoints = `select points_balance || '|' || total_redeemed from public.local_loyalty_cards where id='${CARD}';`;

/** local-redeem-verify kind 'reward' (consume=true) and loyalty-till redeem_reward (false). */
const writeReward = (consume: boolean) => (v: number[]): string[] => {
  const total = v[1];
  const out = [
    `update public.local_loyalty_cards set stamps_collected = 0, total_redeemed = ${total + 1},
       reward_reminded_at = null where id='${CARD}';`,
    `insert into public.local_loyalty_transactions (card_id, user_id, business_id, type, amount)
       values ('${CARD}','${CUST}','${BIZ}','reward',5);`,
  ];
  if (consume) {
    out.push(`update public.local_redemptions set status='consumed', consumed_at=now(), consumed_by='${OWNER}' where id='${RED}';`);
  }
  return out;
};
/** local-redeem-verify kind 'points'. */
const writePoints = (spend: number) => (v: number[]): string[] => [
  `update public.local_loyalty_cards set points_balance = ${v[0] - spend}, total_redeemed = ${v[1] + 1}
     where id='${CARD}';`,
  `insert into public.local_loyalty_transactions (card_id, user_id, business_id, type, amount)
     values ('${CARD}','${CUST}','${BIZ}','redeem',${spend});`,
  `update public.local_redemptions set status='consumed', consumed_at=now(), consumed_by='${OWNER}' where id='${RED}';`,
];

const rewards = () => num(`select count(*)::text from public.local_loyalty_transactions where type='reward';`);
const redeems = () => num(`select count(*)::text from public.local_loyalty_transactions where type='redeem';`);
const stamps = () => num(`select stamps_collected::text from public.local_loyalty_cards where id='${CARD}';`);
const points = () => num(`select points_balance::text from public.local_loyalty_cards where id='${CARD}';`);
const totalRedeemed = () => num(`select total_redeemed::text from public.local_loyalty_cards where id='${CARD}';`);
const consumed = () => num(`select count(*)::text from public.local_redemptions where status='consumed';`);

/* Each stage rebuilds, so state must be READ while it exists. */
const now = {
  rewardEffects: 0, rewardStamps: 0, rewardTotal: 0, rewardConsumed: 0,
  pointsEffects: 0, pointsBalance: 0, pointsTotal: 0,
  tillEffects: 0, tillStamps: 0, tillTotal: 0,
};
/** With the atomic functions installed. */
const fixed = {
  firstCode: '', secondCode: '', codeEffects: 0, codeConsumed: 0, codeStamps: 0, codeTotal: 0,
  raceCodeOk: 0, raceCodeEffects: 0, raceCodeConsumed: 0,
  racePointsOk: 0, racePointsEffects: 0, racePointsBalance: 0, racePointsTotal: 0,
  raceCardOk: 0, raceCardEffects: 0, raceCardStamps: 0, raceCardTotal: 0,
  raceRichOk: 0, raceRichEffects: 0, raceRichBalance: 0,
  expired: '', wrongBusiness: '', strangerCard: '', ownerCard: '', operatorCard: '', belowThreshold: '',
  notEnoughPoints: '', notEnoughBalance: 0,
};
const mut = { lockOk: 0, lockEffects: 0, pendingSecond: '', redLockOk: 0, redLockEffects: 0, redLockBalance: 0,
              thresholdOk: '', negativeBalance: 0, negativeOk: '' };
const priv: Record<string, string> = {};
const secdef: Record<string, string> = {};
const anchors = { cardLock: false, redLock: false, pendingGuard: false, threshold: false, insufficient: false };

/** The deployed source still has the shape this reproduction replays. */
const shape = { verifyUsesRpc: false, tillUsesRpc: false, selfUsesRpc: false, noRmwLeft: false, passStillAtomic: false };

before(async () => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');

  const verify = src(join(FN, 'local-redeem-verify/index.ts'));
  const till = src(join(FN, 'loyalty-till/index.ts'));
  const self = src(join(FN, 'local-redeem-reward/index.ts'));
  shape.verifyUsesRpc = verify.includes(`rpc('loyalty_redeem_code_atomic'`);
  shape.tillUsesRpc = till.includes(`rpc('loyalty_redeem_card_atomic'`);
  shape.selfUsesRpc = self.includes(`rpc('loyalty_redeem_card_atomic'`);
  shape.noRmwLeft = ![verify, till, self].some((f) => f.includes(`total_redeemed: (card.total_redeemed ?? 0) + 1`));
  shape.passStillAtomic = verify.includes(`rpc('redeem_pass_atomic'`);

  // ── A. REWARD CODE: two verifies of the same pending code ────────────────
  schema('stamps');
  card(5, 0);
  pendingCode('reward', null);
  await Promise.all([
    replay(readCardStamps, writeReward(true), 300),
    sleep(60).then(() => replay(readCardStamps, writeReward(true), 300)),
  ]);
  now.rewardEffects = rewards();
  now.rewardStamps = stamps();
  now.rewardTotal = totalRedeemed();
  now.rewardConsumed = consumed();

  // ── B. POINTS CODE: enough for one redemption, not two ───────────────────
  schema('points');
  card(0, 100);
  pendingCode('points', 100);
  await Promise.all([
    replay(readCardPoints, writePoints(100), 300),
    sleep(60).then(() => replay(readCardPoints, writePoints(100), 300)),
  ]);
  now.pointsEffects = redeems();
  now.pointsBalance = points();
  now.pointsTotal = totalRedeemed();

  // ── C. TILL REWARD: two operators, one full card, no code row ────────────
  schema('stamps');
  card(5, 0);
  await Promise.all([
    replay(readCardStamps, writeReward(false), 300),
    sleep(60).then(() => replay(readCardStamps, writeReward(false), 300)),
  ]);
  now.tillEffects = rewards();
  now.tillStamps = stamps();
  now.tillTotal = totalRedeemed();

  // ── FIXED: one reward code, sequential then concurrent ───────────────────
  schema('stamps'); installFix(); card(5, 0); pendingCode('reward', null);
  fixed.firstCode = redeemCode(OWNER, 'ABC123');
  fixed.secondCode = redeemCode(OWNER, 'ABC123');
  fixed.codeEffects = rewards();
  fixed.codeConsumed = consumed();
  fixed.codeStamps = stamps();
  fixed.codeTotal = totalRedeemed();

  schema('stamps'); installFix(); card(5, 0); pendingCode('reward', null);
  const rc = await raceRpc(`public.loyalty_redeem_code_atomic('${OWNER}', 'ABC123', null)`);
  fixed.raceCodeOk = okCount(rc);
  fixed.raceCodeEffects = rewards();
  fixed.raceCodeConsumed = consumed();

  // ── FIXED: points code, only enough for one ──────────────────────────────
  schema('points'); installFix(); card(0, 100); pendingCode('points', 100);
  const rp = await raceRpc(`public.loyalty_redeem_code_atomic('${OWNER}', 'ABC123', null)`);
  fixed.racePointsOk = okCount(rp);
  fixed.racePointsEffects = redeems();
  fixed.racePointsBalance = points();
  fixed.racePointsTotal = totalRedeemed();

  // ── FIXED: one code stays one effect even when the card could afford two ─
  schema('points'); installFix(); card(0, 200); pendingCode('points', 100);
  const rr = await raceRpc(`public.loyalty_redeem_code_atomic('${OWNER}', 'ABC123', null)`);
  fixed.raceRichOk = okCount(rr);
  fixed.raceRichEffects = redeems();
  fixed.raceRichBalance = points();

  // ── FIXED: till / self-redeem, no code row ───────────────────────────────
  schema('stamps'); installFix(); card(5, 0);
  const rk = await raceRpc(`public.loyalty_redeem_card_atomic('${OWNER}', '${CARD}')`);
  fixed.raceCardOk = okCount(rk);
  fixed.raceCardEffects = rewards();
  fixed.raceCardStamps = stamps();
  fixed.raceCardTotal = totalRedeemed();

  // ── FIXED: the checks that must survive ──────────────────────────────────
  schema('stamps'); installFix(); card(5, 0);
  raw(`insert into public.local_redemptions (id, business_id, user_id, kind, ref_id, code, status, expires_at)
       values ('${RED}','${BIZ}','${CUST}','reward','${CARD}','EXP123','pending', now() - interval '1 minute');`);
  fixed.expired = redeemCode(OWNER, 'EXP123');
  raw(`update public.local_redemptions set expires_at = now() + interval '10 minutes' where id='${RED}';`);
  fixed.wrongBusiness = redeemCode(CUST, 'EXP123');          // not the owner
  fixed.strangerCard = redeemCard('99999999-0000-4000-8000-000000000099', CARD);
  fixed.operatorCard = redeemCard(OWNER, CARD);              // business owner may
  card(5, 0);
  fixed.ownerCard = redeemCard(CUST, CARD);                  // card holder may
  card(4, 0);
  fixed.belowThreshold = redeemCard(OWNER, CARD);            // one short

  schema('points'); installFix(); card(0, 50); pendingCode('points', 100);
  fixed.notEnoughPoints = redeemCode(OWNER, 'ABC123');       // 50 held, 100 asked
  fixed.notEnoughBalance = points();

  // ── Privileges, from the migration's own grant block ────────────────────
  schema('stamps'); installFix();
  const g = raw(grantsBlock());
  assert.doesNotMatch(g, /ERROR/i, `grants failed:\n${g.slice(0, 600)}`);
  for (const fn of ['loyalty_redeem_code_atomic', 'loyalty_redeem_card_atomic',
                    '_loyalty_apply_reward', '_loyalty_spend_points']) {
    priv[fn] = scalar(
      `select string_agg(r || ':' || case when has_function_privilege(r, p.oid, 'execute') then 'yes' else 'no' end, ' ')
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
              unnest(array['anon','authenticated','service_role']) r
        where n.nspname='public' and p.proname = '${fn}';`);
    secdef[fn] = scalar(
      `select case when p.prosecdef then 'definer' else 'invoker' end || ' ' || coalesce(array_to_string(p.proconfig,','),'no-search-path')
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname = '${fn}';`);
  }

  // ── Mutations ────────────────────────────────────────────────────────────
  const cardLock = `  select * into v_card from public.local_loyalty_cards where id = p_card for update;`;
  const redLock = `   limit 1
   for update;`;
  const pendingGuard = `  if v_red.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;`;
  const threshold = `  if coalesce(v_card.stamps_collected, 0) < coalesce(v_prog.stamps_required, 999) then
    return jsonb_build_object('ok', false, 'error', 'not_ready');
  end if;`;
  const insufficient = `  if coalesce(v_card.points_balance, 0) < p_amount then
    return jsonb_build_object('ok', false, 'error', 'insufficient_points');
  end if;`;
  const f = fixFns();
  anchors.cardLock = f.includes(cardLock);
  anchors.redLock = f.includes(redLock);
  anchors.pendingGuard = f.includes(pendingGuard);
  anchors.threshold = f.includes(threshold);
  anchors.insufficient = f.includes(insufficient);

  // M1 — the card row lock removed.
  schema('stamps'); installFix((x) => x.replace(cardLock, cardLock.replace(' for update', ''))); card(5, 0);
  const m1 = await raceRpc(`public.loyalty_redeem_card_atomic('${OWNER}', '${CARD}')`);
  mut.lockOk = okCount(m1);
  mut.lockEffects = rewards();

  // M2 — the pending-status guard removed: the same code redeems twice.
  schema('stamps'); installFix((x) => x.replace(pendingGuard, '')); card(5, 0); pendingCode('reward', null);
  redeemCode(OWNER, 'ABC123');
  raw(`update public.local_loyalty_cards set stamps_collected = 5 where id='${CARD}';`);
  mut.pendingSecond = redeemCode(OWNER, 'ABC123');

  // M3 — the redemption row lock removed.
  //
  // On a card that can only afford ONE redemption the card lock already stops
  // the second, so that case proves nothing about this lock. The redemption
  // lock earns its place when the CARD could afford two: only it can say that
  // one code is one effect. A points card holding 200 with a 100-point code is
  // exactly that shape.
  schema('points'); installFix((x) => x.replace(redLock, '   limit 1;')); card(0, 200); pendingCode('points', 100);
  const m3 = await raceRpc(`public.loyalty_redeem_code_atomic('${OWNER}', 'ABC123', null)`);
  mut.redLockOk = okCount(m3);
  mut.redLockEffects = redeems();
  mut.redLockBalance = points();

  // M4 — the threshold check removed: an incomplete card pays out.
  schema('stamps'); installFix((x) => x.replace(threshold, '')); card(4, 0);
  mut.thresholdOk = redeemCard(OWNER, CARD);

  // M5 — the balance check removed: points go below zero.
  schema('points'); installFix((x) => x.replace(insufficient, '')); card(0, 50); pendingCode('points', 100);
  mut.negativeOk = redeemCode(OWNER, 'ABC123');
  mut.negativeBalance = points();
});

describe('every redemption caller now goes through the database', () => {
  test('local-redeem-verify uses loyalty_redeem_code_atomic', () => {
    assert.ok(shape.verifyUsesRpc);
  });
  test('loyalty-till uses loyalty_redeem_card_atomic', () => {
    assert.ok(shape.tillUsesRpc);
  });
  test('local-redeem-reward uses loyalty_redeem_card_atomic', () => {
    assert.ok(shape.selfUsesRpc);
  });
  test('no caller still computes total_redeemed in TypeScript', () => {
    assert.ok(shape.noRmwLeft, 'a read-modify-write survived; the invariant can still be bypassed');
  });
  test('the pass kind keeps its own atomic path', () => {
    assert.ok(shape.passStillAtomic);
  });
});

describe('THE DEFECT, AS IT WAS — A. one reward code, two verifies', () => {
  test('both verifies apply the reward', () => {
    assert.equal(now.rewardEffects, 2, 'expected the defect: two reward effects from one code');
  });
  test('and total_redeemed records only one of them', () => {
    assert.equal(now.rewardTotal, 1);
  });
  test('the card is left at zero either way', () => {
    assert.equal(now.rewardStamps, 0);
  });
  test('one redemption row, consumed once, having paid out twice', () => {
    assert.equal(now.rewardConsumed, 1);
  });
});

describe('THE DEFECT, AS IT WAS — B. one points code, two verifies', () => {
  test('both verifies spend the points', () => {
    assert.equal(now.pointsEffects, 2, 'expected the defect: two points redemptions from one code');
  });
  test('the balance is only debited once, so points are given away', () => {
    assert.equal(now.pointsBalance, 0);
    assert.equal(now.pointsTotal, 1);
  });
});

describe('THE DEFECT, AS IT WAS — C. one full card, two till redemptions', () => {
  test('both operators redeem the same reward', () => {
    assert.equal(now.tillEffects, 2, 'expected the defect: two rewards from one card');
  });
  test('the card resets once and records one redemption', () => {
    assert.equal(now.tillStamps, 0);
    assert.equal(now.tillTotal, 1);
  });
});

describe('FIXED — one reward code applies exactly once', () => {
  test('the first verify succeeds', () => {
    assert.match(fixed.firstCode, /"ok"\s*:\s*true/);
  });
  test('a second sequential verify is rejected as already used', () => {
    assert.match(fixed.secondCode, /already_used/);
  });
  test('exactly one effect, one consumed code, card reset once', () => {
    assert.equal(fixed.codeEffects, 1);
    assert.equal(fixed.codeConsumed, 1);
    assert.equal(fixed.codeStamps, 0);
    assert.equal(fixed.codeTotal, 1);
  });
  test('two concurrent verifies: exactly one wins', () => {
    assert.equal(fixed.raceCodeOk, 1);
    assert.equal(fixed.raceCodeEffects, 1);
    assert.equal(fixed.raceCodeConsumed, 1);
  });
});

describe('FIXED — points cannot be overspent', () => {
  test('two concurrent verifies of one code: exactly one wins', () => {
    assert.equal(fixed.racePointsOk, 1);
    assert.equal(fixed.racePointsEffects, 1);
  });
  test('the balance is debited once and never goes negative', () => {
    assert.equal(fixed.racePointsBalance, 0);
    assert.ok(fixed.racePointsBalance >= 0);
    assert.equal(fixed.racePointsTotal, 1);
  });
});

describe('FIXED — one code is one effect, even on a card that could afford two', () => {
  test('exactly one of two concurrent verifies wins', () => {
    assert.equal(fixed.raceRichOk, 1);
    assert.equal(fixed.raceRichEffects, 1);
  });
  test('and only one code’s worth of points is spent', () => {
    assert.equal(fixed.raceRichBalance, 100);
  });
});

describe('FIXED — the till cannot redeem one card twice', () => {
  test('two concurrent operators: exactly one succeeds', () => {
    assert.equal(fixed.raceCardOk, 1);
    assert.equal(fixed.raceCardEffects, 1);
  });
  test('stamps finish at zero and total_redeemed rises exactly once', () => {
    assert.equal(fixed.raceCardStamps, 0);
    assert.equal(fixed.raceCardTotal, 1);
  });
});

describe('FIXED — the checks that must survive', () => {
  test('an expired code is refused', () => {
    assert.match(fixed.expired, /expired/);
  });
  test('a code for someone else’s business is refused', () => {
    assert.match(fixed.wrongBusiness, /not_your_business/);
  });
  test('a stranger cannot redeem a card', () => {
    assert.match(fixed.strangerCard, /not_yours/);
  });
  test('the business owner and the card holder both may', () => {
    assert.match(fixed.operatorCard, /"ok"\s*:\s*true/);
    assert.match(fixed.ownerCard, /"ok"\s*:\s*true/);
  });
  test('a card one stamp short is refused', () => {
    assert.match(fixed.belowThreshold, /not_ready/);
  });
  test('a code asking more points than the card holds is refused', () => {
    assert.match(fixed.notEnoughPoints, /insufficient_points/);
    assert.equal(fixed.notEnoughBalance, 50, 'the balance must be untouched by a refusal');
  });
});

describe('the suite is anchored to the real migration', () => {
  test('the card row lock is where the mutation expects it', () => { assert.ok(anchors.cardLock); });
  test('the redemption row lock is where the mutation expects it', () => { assert.ok(anchors.redLock); });
  test('the pending-status guard is where the mutation expects it', () => { assert.ok(anchors.pendingGuard); });
  test('the reward threshold check is where the mutation expects it', () => { assert.ok(anchors.threshold); });
  test('the points balance check is where the mutation expects it', () => { assert.ok(anchors.insufficient); });
});

describe('mutations — each protection is load-bearing', () => {
  test('M1 removing the card row lock lets two redemptions both succeed', () => {
    assert.equal(mut.lockOk, 2);
    assert.equal(mut.lockEffects, 2);
  });
  test('M2 removing the pending guard lets one code redeem twice', () => {
    assert.match(mut.pendingSecond, /"ok"\s*:\s*true/);
  });
  test('M3 removing the redemption row lock lets one code spend twice', () => {
    assert.equal(mut.redLockOk, 2);
    assert.equal(mut.redLockEffects, 2);
    assert.equal(mut.redLockBalance, 0, 'both halves of a 200-point card were spent on one code');
  });
  test('M4 removing the threshold check pays out an incomplete card', () => {
    assert.match(mut.thresholdOk, /"ok"\s*:\s*true/);
  });
  test('M5 removing the balance check drives points below zero', () => {
    assert.match(mut.negativeOk, /"ok"\s*:\s*true/);
    assert.equal(mut.negativeBalance, -50);
  });
});

describe('privileges — the migration locks its own functions down', () => {
  for (const fn of ['loyalty_redeem_code_atomic', 'loyalty_redeem_card_atomic',
                    '_loyalty_apply_reward', '_loyalty_spend_points']) {
    test(`${fn} is service_role only`, () => {
      assert.equal(priv[fn], 'anon:no authenticated:no service_role:yes');
    });
    test(`${fn} is SECURITY DEFINER with a pinned search_path`, () => {
      assert.match(secdef[fn], /^definer search_path=public, pg_temp$/);
    });
  }
});
