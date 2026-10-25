/**
 * referral-disabled.node.test.ts — the referral programme is OFF for launch, and cannot pay anything while it is off.
 *
 * WHAT WAS WRONG (read-only audit, 8 Oct 2026): the programme pays £5 + £5 of spendable wallet balance when a referred member spends £3 or more.
 * It accepts A<->B rings and years-old accounts as "new" referees, a referee's spend at the REFERRER's business qualifies, a refund of the spend
 * keeps the reward, and the credit becomes a Stripe transfer to any business. It also books every reward twice in the ledger (wallet_credit
 * writes a 'refund' row, the trigger adds a 'topup' row) while the balance moves once, so wallet_reconciliation() drifts, and the qualification
 * trigger is not idempotent on its own. Production has 0 codes, 0 referrals, 0 rewards. Decision: ship with referrals OFF.
 * Migration 20261124000000 drops the qualification trigger and makes its function inert, makes ensure_referral_code raise, makes
 * apply_referral_code answer identically for every code and write nothing, locks profiles.referral_code against the user, and takes INSERT /
 * UPDATE / DELETE on referrals away from anon + authenticated.
 *
 * HOW IT PROVES IT: every migration EXCEPT the fix is replayed into a private database of the throwaway cluster (production's catalogue). The
 * old behaviour is demonstrated first (controls), then the real migration is applied and each guarantee is checked against the REAL wallet
 * functions. Mutation controls bring the old paths back and show the same checks catch them.
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users only; no Stripe, no money.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const FIX_NAME = '20261124000000_referrals_disabled_for_launch.sql';
const FIX = join(MIG, FIX_NAME);
const ORIGINAL = readFileSync(join(MIG, '20260721040000_referrals.sql'), 'utf8');
const UNAVAILABLE = "Referral rewards aren't available at the moment.";

let db: ReplayDb;
const rowsTag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !rowsTag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT/.test(l));
const lastRow = (o: string) => rowsOf(o).pop() ?? '';
const scalar = (sql: string) => lastRow(db.raw(sql));

const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] as const;
const U = Object.fromEntries(ids.map((k, i) => [k, `${(i + 1).toString(16)}${(i + 1).toString(16)}000000-0000-4000-8000-00000000000${i}`])) as Record<(typeof ids)[number], string>;
type Who = (typeof ids)[number] | 'anon' | 'service';
const roleSql = (who: Who) =>
  who === 'anon' ? 'set local role anon;' : who === 'service' ? 'set local role service_role;' : `set local request.jwt.claim.sub = '${U[who]}'; set local role authenticated;`;
const tryAs = (who: Who, sql: string) => db.raw(`begin; ${roleSql(who)} ${sql}; rollback;`);
const doAs = (who: Who, sql: string) => db.raw(`begin; ${roleSql(who)} ${sql}; commit;`);
const denied = (o: string) => /permission denied/i.test(o);
const rlsRefused = (o: string) => /row-level security/i.test(o);
const ok = (o: string) => !/ERROR|permission denied|row-level security/i.test(o);

const CODE: Record<string, string> = { A: 'AAAAAA', B: 'BBBBBB', C: 'CCCCCC', D: 'DDDDDD', E: 'EEEEEE', F: 'FFFFFF' };
const bal = (w: (typeof ids)[number]) => Number(scalar(`select coalesce((select balance_pence from public.local_wallet_balances where user_id='${U[w]}'),0)`));
const ledgerNet = (w: (typeof ids)[number]) => Number(scalar(`select coalesce(sum(amount_pence),0) from public.local_wallet_transactions where user_id='${U[w]}'`));
const ledgerRows = (w: (typeof ids)[number]) => Number(scalar(`select count(*) from public.local_wallet_transactions where user_id='${U[w]}'`));
const topup = (w: (typeof ids)[number], n: number, key: string) => db.raw(`select balance_pence from public.wallet_credit_with_ledger('${U[w]}',${n},'topup',null,'fixture top-up','${key}',null)`);
const spend = (w: (typeof ids)[number], n: number, key: string, biz = 'null') => lastRow(db.raw(`select balance_pence || '|' || insufficient || '|' || already_applied from public.wallet_debit_with_ledger('${U[w]}',${n},0,'spend',${biz},'fixture spend','${key}',null,false)`));
const refStatus = (referee: (typeof ids)[number]) => scalar(`select coalesce((select status from public.referrals where referee_id='${U[referee]}'),'(none)')`);
const referralRows = () => Number(scalar('select count(*) from public.referrals'));
const codeOf = (w: (typeof ids)[number]) => scalar(`select coalesce(referral_code,'(null)') from public.profiles where id='${U[w]}'`);
const addReferral = (referrer: (typeof ids)[number], referee: (typeof ids)[number], extra = '') => db.raw(`insert into public.referrals (referrer_id, referee_id, code ${extra ? ', ' + extra.split('=')[0] : ''}) values ('${U[referrer]}','${U[referee]}','${CODE[referrer] ?? 'X'}' ${extra ? ', ' + extra.split('=')[1] : ''})`);
/** what the OLD programme did: wallet value created by a referral, and the ledger/balance drift it leaves */
const rewardOutcome = (referrer: (typeof ids)[number], referee: (typeof ids)[number]) => ({ referrerLedgerDrift: ledgerNet(referrer) - bal(referrer), refereeLedgerDrift: ledgerNet(referee) - bal(referee), status: refStatus(referee) });

const PRE: Record<string, any> = {};

before(() => {
  db = createReplayDb('referraldisabled', { stopBefore: FIX_NAME });
  const all = ids.map((k) => `'${U[k]}'::uuid`).join(',');
  const seed = db.raw(`
    insert into auth.users (id, email) select x, x::text || '@x' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'u' from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set created_at = '2020-01-01' where id = '${U.G}';`);
  assert.doesNotMatch(seed, /ERROR/, seed);
  // codes exist already (set by the superuser) so a "valid code" can be tested with the programme off
  for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) db.raw(`update public.profiles set referral_code='${CODE[k]}' where id='${U[k]}'`);
  const run = (who: Who, sql: string) => doAs(who, sql);

  // ── the OLD programme, against the PRE-FIX database (controls) ──
  PRE.mint = lastRow(tryAs('H', 'select public.ensure_referral_code()'));
  PRE.apply = lastRow(run('B', `select public.apply_referral_code('${CODE.A}')`));
  PRE.ring = lastRow(run('A', `select public.apply_referral_code('${CODE.B}')`));
  PRE.oldAccount = lastRow(run('G', `select public.apply_referral_code('${CODE.C}')`));
  PRE.oracleValid = lastRow(tryAs('B', `select public.apply_referral_code('${CODE.C}')`));
  PRE.oracleInvalid = lastRow(tryAs('B', `select public.apply_referral_code('ZZZZZZ')`));
  PRE.vanity = lastRow(tryAs('I', `update public.profiles set referral_code='FREE5' where id='${U.I}' returning referral_code`));
  topup('B', 2000, 'preB'); topup('G', 2000, 'preG');
  PRE.spendB = spend('B', 300, 'preB300');
  PRE.balA = bal('A'); PRE.driftA = ledgerNet('A') - bal('A'); PRE.driftB = ledgerNet('B') - bal('B');
  PRE.rowsBefore = referralRows();

  PRE.apply2 = db.rawFile(FIX);
});

after(() => { db?.drop(); });

describe('0 · before the fix the programme paid, and booked it twice (controls)', () => {
  test('ensure_referral_code minted a code', () => assert.match(PRE.mint, /^[0-9A-F]{6}$/));
  test('apply_referral_code attached a referral, and accepted an A<->B ring and a 2020 account', () => {
    assert.match(PRE.apply, /"ok": true/); assert.match(PRE.ring, /"ok": true/); assert.match(PRE.oldAccount, /"ok": true/);
  });
  test('it was a code-existence oracle (valid and invalid answered differently)', () => assert.notEqual(PRE.oracleValid, PRE.oracleInvalid));
  test('a user could rewrite their own referral_code', () => assert.equal(PRE.vanity, 'FREE5'));
  test('a £3 wallet spend by the referee paid the referrer £5 …', () => assert.equal(PRE.balA, 500));
  test('… and the ledger recorded it twice while the balance moved once (drift of £5 per party)', () => { assert.equal(PRE.driftA, 500); assert.equal(PRE.driftB, 500); });
});

describe('1 · the migration', () => {
  test('applied clean with its own end-state assertions', () => assert.doesNotMatch(PRE.apply2, /ERROR/i, PRE.apply2));
  test('is re-runnable', () => assert.doesNotMatch(db.rawFile(FIX), /ERROR/i));
  test('the catalogue: no trigger calls tg_referral_qualify, and the function is inert', () => {
    assert.equal(scalar(`select count(*) from pg_trigger t join pg_proc p on p.oid=t.tgfoid where p.proname='tg_referral_qualify' and not t.tgisinternal`), '0');
    assert.equal(scalar(`select count(*) from pg_trigger where tgrelid='public.local_wallet_transactions'::regclass and tgname='referral_qualify'`), '0');
    assert.doesNotMatch(scalar(`select prosrc from pg_proc where proname='tg_referral_qualify'`), /wallet_credit|referrals|insert/i);
  });
});

describe('2 · the client contract (build 147 and the web)', () => {
  test('1. build 147: ensure_referral_code() raises the controlled message; apply_referral_code returns {ok:false, error}', () => {
    const e = tryAs('A', 'select public.ensure_referral_code()');
    assert.match(e, /Referral rewards aren't available at the moment\./);
    const r = JSON.parse(lastRow(tryAs('B', `select public.apply_referral_code('${CODE.A}')`)));
    assert.equal(r.ok, false); assert.equal(r.error, UNAVAILABLE); assert.equal(typeof r.error, 'string');
  });
  test('2. web: the same two RPCs behave identically (it reads error.message and res.ok / res.error)', () => {
    const r = JSON.parse(lastRow(tryAs('C', `select public.apply_referral_code('anything')`)));
    assert.deepEqual(r, { ok: false, error: UNAVAILABLE });
    assert.match(tryAs('C', 'select public.ensure_referral_code(' + `'${U.C}'::uuid)`), /Referral rewards aren't available/);
  });
  test('the referral list query both clients run still works (an empty list, own rows only)', () => {
    assert.ok(ok(tryAs('A', `select id, status, referrer_reward_pence, created_at from public.referrals where referrer_id='${U.A}' order by created_at desc`)));
    assert.equal(lastRow(tryAs('anon', 'select count(*) from public.referrals')), '0');
  });
  test('the app source in this repo calls only these RPCs, with these argument shapes, and shows res.error / the thrown message', () => {
    const lib = join(REPO_ROOT, 'lib/referrals.ts'); const screen = join(REPO_ROOT, 'app/referrals.tsx');
    if (!existsSync(lib) || !existsSync(screen)) return;
    const l = readFileSync(lib, 'utf8'); const s = readFileSync(screen, 'utf8');
    assert.match(l, /rpc\('ensure_referral_code'\)/); assert.match(l, /rpc\('apply_referral_code',\s*\{\s*p_code:/);
    assert.doesNotMatch(l, /rpc\('(?!ensure_referral_code|apply_referral_code)/);
    assert.match(s, /res\.ok/); assert.match(s, /res\.error/); assert.match(s, /catch \(e\)/);
    assert.match(s, /if \(!data\) return;/, 'Share is inert when the code could not load');
  });
});

describe('3 · no code is minted, no referral is created, no oracle', () => {
  test('3. ensure_referral_code mints nothing — for a user, a user naming another user, and the service role', () => {
    const before = scalar('select count(referral_code) from public.profiles');
    for (const who of ['J', 'service'] as Who[]) {
      assert.match(tryAs(who, 'select public.ensure_referral_code()'), /aren't available/);
      assert.match(tryAs(who, `select public.ensure_referral_code('${U.J}'::uuid)`), /aren't available/);
    }
    assert.equal(codeOf('J'), '(null)');
    assert.equal(scalar('select count(referral_code) from public.profiles'), before);
  });
  test('4-5. apply with a valid code and with an invalid code create no referral', () => {
    const rows = referralRows();
    for (const c of [CODE.A, CODE.F, 'ZZZZZZ', '', '  ' + CODE.A.toLowerCase() + ' ', 'x'.repeat(500)]) {
      doAs('J', `select public.apply_referral_code('${c}')`);
    }
    assert.equal(referralRows(), rows); assert.equal(refStatus('J'), '(none)');
  });
  test('6. no existence oracle: every input gets the byte-identical answer (new user, already-referred user, own code, lower-case, empty)', () => {
    const answers = new Set<string>();
    for (const [who, c] of [['J', CODE.A], ['J', 'ZZZZZZ'], ['J', ''], ['B', CODE.C], ['B', 'ZZZZZZ'], ['A', CODE.A], ['A', CODE.A.toLowerCase()], ['G', CODE.F]] as [Who, string][]) {
      answers.add(lastRow(tryAs(who, `select public.apply_referral_code('${c}')`)));
    }
    assert.equal(answers.size, 1, [...answers].join(' / '));
    assert.equal([...answers][0], `{"ok": false, "error": "${UNAVAILABLE}"}`);
  });
  test('7-10. A cannot refer B, an A<->B ring, self-referral and an old account cannot be created', () => {
    const rows = referralRows();
    doAs('J', `select public.apply_referral_code('${CODE.A}')`);            // J refers via A's code
    doAs('A', `select public.apply_referral_code('${CODE.D}')`);            // A applies D's code (D is not yet a referee of A)
    doAs('D', `select public.apply_referral_code('${CODE.A}')`);            // ring D<->A
    doAs('A', `select public.apply_referral_code('${CODE.A}')`);            // self
    doAs('G', `select public.apply_referral_code('${CODE.E}')`);            // the 2020 account
    assert.equal(referralRows(), rows);
    for (const k of ['J', 'D', 'G']) assert.ok(!['pending', 'rewarded'].includes(refStatus(k as any)) || k === 'G' && refStatus('G') === 'pending' /* G was attached by the OLD code in the controls */);
  });
  test('the unauthenticated case still answers "auth required"', () => assert.match(tryAs('anon', `select public.apply_referral_code('${CODE.A}')`), /auth required|permission denied/));
});

describe('4 · profiles.referral_code is server-managed', () => {
  test('11. a user cannot change, clear, or copy a referral_code; the update itself still succeeds (silent restore)', () => {
    assert.equal(codeOf('B'), CODE.B);
    for (const set of [`'FREE5'`, 'null', `'${CODE.A}'`, `'a'`]) {
      assert.ok(ok(tryAs('B', `update public.profiles set referral_code = ${set} where id='${U.B}'`)), set);
      doAs('B', `update public.profiles set referral_code = ${set} where id='${U.B}'`);
      assert.equal(codeOf('B'), CODE.B, `set ${set}`);
    }
    assert.equal(codeOf('A'), CODE.A);
  });
  test('ordinary profile editing is unaffected, and the older locks still hold', () => {
    doAs('B', `update public.profiles set full_name='Bee Edited', role='admin' where id='${U.B}'`);
    assert.equal(scalar(`select full_name || '|' || role from public.profiles where id='${U.B}'`), 'Bee Edited|customer');
  });
  test('19a. service_role and migrations/superuser can still manage it', () => {
    assert.ok(ok(doAs('service', `update public.profiles set referral_code='SVC123' where id='${U.J}'`)));
    assert.equal(codeOf('J'), 'SVC123');
    db.raw(`update public.profiles set referral_code=null where id='${U.J}'`);
    assert.equal(codeOf('J'), '(null)');
  });
});

describe('5 · direct table access stays shut', () => {
  test('12-14. INSERT / UPDATE / DELETE on referrals are denied to anon and authenticated (at the privilege level now)', () => {
    addReferral('C', 'E');
    for (const who of ['anon', 'A', 'C', 'E'] as Who[]) {
      assert.ok(denied(tryAs(who, `insert into public.referrals (referrer_id, referee_id, code, status, referrer_reward_pence) values ('${U.A}','${U.J}','X','rewarded',99999)`)), `${who} insert`);
      assert.ok(denied(tryAs(who, `update public.referrals set status='rewarded', referrer_reward_pence=99999`)), `${who} update`);
      assert.ok(denied(tryAs(who, `delete from public.referrals`)), `${who} delete`);
    }
    db.raw(`delete from public.referrals where referee_id='${U.E}'`);
  });
  test('wallet credits and ledger rows still cannot be written directly', () => {
    assert.ok(denied(tryAs('B', `insert into public.local_wallet_transactions (user_id,type,amount_pence) values ('${U.B}','topup',9999)`)));
    assert.ok(denied(tryAs('B', `select public.wallet_credit('${U.B}', 9999)`)));
    assert.ok(denied(tryAs('B', `select * from public.wallet_credit_with_ledger('${U.B}',9999,'topup',null,'x',null,null)`)));
    assert.ok(denied(tryAs('B', `update public.local_wallet_balances set balance_pence = 999999 where user_id='${U.B}'`)));
  });
  test('19b. service_role can still maintain referrals (select / insert / update / delete) for the future redesign', () => {
    assert.ok(ok(tryAs('service', `insert into public.referrals (referrer_id, referee_id, code) values ('${U.C}','${U.E}','X')`)));
    assert.ok(ok(tryAs('service', `update public.referrals set status='void' where referee_id='${U.B}'`)));
    assert.ok(ok(tryAs('service', `delete from public.referrals where referee_id='${U.G}'`)));
    assert.equal(scalar(`select (has_table_privilege('service_role','public.referrals','INSERT') and has_table_privilege('service_role','public.referrals','UPDATE'))`), 't');
  });
  test('the users can still READ their own referral rows (RLS select policy untouched)', () => {
    assert.equal(lastRow(tryAs('B', `select count(*) from public.referrals where referee_id='${U.B}'`)), '1');
    assert.equal(scalar(`select count(*) from pg_policies where tablename='referrals'`), '1');
  });
});

describe('6 · a qualifying wallet spend can no longer pay a referral', () => {
  test('15. a pending referral exists (legacy / future state); a £3+ spend by the referee changes nothing but the spend', () => {
    addReferral('C', 'D');
    topup('D', 5000, 'dTop');
    const balC = bal('C'), rowsC = ledgerRows('C');
    assert.equal(spend('D', 300, 'd300'), '4700|false|false');
    assert.equal(spend('D', 1000, 'd1000'), '3700|false|false');
    assert.equal(refStatus('D'), 'pending');
    assert.equal(bal('C'), balC); assert.equal(ledgerRows('C'), rowsC);
    assert.equal(bal('D'), 3700);
    assert.equal(scalar(`select rewarded_at is null from public.referrals where referee_id='${U.D}'`), 't');
  });
  test('18. no duplicate or referral ledger rows: exactly the topup and the two spends exist for the referee', () => {
    assert.equal(ledgerRows('D'), 3);
    assert.equal(scalar(`select count(*) from public.local_wallet_transactions where user_id in ('${U.C}','${U.D}','${U.E}','${U.F}') and (description like 'Referral reward%' or description like 'Wallet credit (legacy path%')`), '0', 'only the pre-fix control rows (users A and B) carry reward entries');
    assert.equal(ledgerNet('D') - bal('D'), 0, 'ledger and balance agree');
    assert.equal(scalar(`select count(*) from public.wallet_reconciliation() where user_id in ('${U.C}','${U.D}') and delta_pence <> 0`), '0', 'wallet_reconciliation reports no drift for them');
  });
  test('17. the trigger cannot change a balance: a raw spend row inserted by any writer moves no balance and adds no row', () => {
    const [bc, bd, rc, rd] = [bal('C'), bal('D'), ledgerRows('C'), ledgerRows('D')];
    db.raw(`insert into public.local_wallet_transactions (user_id,type,amount_pence,description) values ('${U.D}','spend',-5000,'raw writer')`);
    assert.equal(bal('C'), bc); assert.equal(bal('D'), bd); assert.equal(ledgerRows('C'), rc); assert.equal(ledgerRows('D'), rd + 1);
    assert.equal(refStatus('D'), 'pending');
  });
  test('16. concurrent spends — through the real debit function AND as raw concurrent ledger writers — pay nothing', async () => {
    addReferral('E', 'F');
    topup('F', 9000, 'fTop');
    const [be, bf] = [bal('E'), bal('F')];
    const a = db.bg(`begin; select * from public.wallet_debit_with_ledger('${U.F}',300,0,'spend',null,'c1','cc1',null,false); select pg_sleep(1.2); commit;`);
    await new Promise((r) => setTimeout(r, 250));
    const b = db.bg(`begin; select * from public.wallet_debit_with_ledger('${U.F}',300,0,'spend',null,'c2','cc2',null,false); commit;`);
    const c = db.bg(`begin; insert into public.local_wallet_transactions(user_id,type,amount_pence,description) values ('${U.F}','spend',-300,'race1'); select pg_sleep(1.2); commit;`);
    await new Promise((r) => setTimeout(r, 250));
    const d = db.bg(`begin; insert into public.local_wallet_transactions(user_id,type,amount_pence,description) values ('${U.F}','spend',-300,'race2'); commit;`);
    await Promise.all([a, b, c, d]);
    assert.equal(bal('E'), be, 'the referrer was not paid'); assert.equal(refStatus('F'), 'pending');
    assert.equal(bal('F'), bf - 600, 'only the two real debits moved the referee\'s balance');
    assert.equal(ledgerRows('E'), 0);
  });
  test('20. ordinary wallet behaviour is unchanged: top-up, spend, idempotent replay, insufficient funds, refund credit', () => {
    topup('H', 1000, 'hTop');
    assert.equal(spend('H', 300, 'h300'), '700|false|false');
    assert.equal(spend('H', 300, 'h300'), '700|false|true', 'the same idempotency key is applied once');
    assert.equal(spend('H', 5000, 'hBig').split('|')[1], 'true', 'insufficient funds is still reported');
    assert.equal(lastRow(db.raw(`select balance_pence from public.wallet_credit_with_ledger('${U.H}',300,'refund',null,'refund','h300r',(select id from public.local_wallet_transactions where idempotency_key='h300'))`)), '1000');
    assert.equal(ledgerNet('H') - bal('H'), 0);
    assert.equal(ledgerRows('H'), 3);
  });
});

describe('7 · mutation controls: the old paths, if they come back, are caught by the same checks', () => {
  const block = (re: RegExp) => { const m = ORIGINAL.match(re); assert.ok(m, `could not extract ${re}`); return m![0]; };
  const OLD_QUALIFY = () => block(/create or replace function public\.tg_referral_qualify\(\)[\s\S]*?end \$\$;/);
  const OLD_TRIGGER = () => block(/create trigger referral_qualify[\s\S]*?;/);
  const OLD_APPLY = () => block(/create or replace function public\.apply_referral_code\(p_code text\)[\s\S]*?end \$\$;/);
  const restore = () => assert.doesNotMatch(db.rawFile(FIX), /ERROR/i, 'restoring the migration');

  test('21a. re-enabling the old qualification path pays out AND leaves the ledger/balance drift — the accounting checks fail', () => {
    db.raw(`${OLD_QUALIFY()} ${OLD_TRIGGER()}`);
    try {
      addReferral('A', 'I');                       // A refers I
      topup('I', 2000, 'iTop');
      const balA = bal('A');
      spend('I', 300, 'i300');
      assert.equal(bal('A') - balA, 500, 'the old trigger credits the referrer');
      assert.equal(refStatus('I'), 'rewarded');
      assert.equal(rewardOutcome('A', 'I').refereeLedgerDrift, 500, 'and books the reward twice');
      assert.ok(Number(scalar(`select count(*) from public.local_wallet_transactions where description like 'Referral reward%'`)) >= 2);
      assert.equal(Number(scalar(`select count(*) from public.wallet_reconciliation() where user_id = '${U.I}' and delta_pence <> 0`)), 1, 'wallet_reconciliation flags the drift');
    } finally { restore(); }
    assert.equal(scalar(`select count(*) from pg_trigger where tgname='referral_qualify'`), '0');
  });
  test('21b. with the old trigger back, concurrent raw writers double-pay (the latent race) — the concurrency check catches it', async () => {
    db.raw(`${OLD_QUALIFY()} ${OLD_TRIGGER()}`);
    try {
      db.raw(`update public.referrals set status='pending', rewarded_at=null where referee_id='${U.F}'`);
      const be = bal('E');
      const c = db.bg(`begin; insert into public.local_wallet_transactions(user_id,type,amount_pence,description) values ('${U.F}','spend',-300,'race3'); select pg_sleep(1.2); commit;`);
      await new Promise((r) => setTimeout(r, 250));
      const d = db.bg(`begin; insert into public.local_wallet_transactions(user_id,type,amount_pence,description) values ('${U.F}','spend',-300,'race4'); commit;`);
      await Promise.all([c, d]);
      assert.equal(bal('E') - be, 1000, 'two payouts for one referral');
    } finally { restore(); }
  });
  test('21c. re-enabling the old apply_referral_code creates referrals again and restores the oracle', () => {
    db.raw(OLD_APPLY());
    try {
      const rows = referralRows();
      assert.match(lastRow(doAs('J', `select public.apply_referral_code('${CODE.B}')`)), /"ok": true/);
      assert.equal(referralRows(), rows + 1);
      assert.notEqual(lastRow(tryAs('J', `select public.apply_referral_code('ZZZZZZ')`)), lastRow(tryAs('J', `select public.apply_referral_code('${CODE.C}')`)));
    } finally { restore(); db.raw(`delete from public.referrals where referee_id='${U.J}'`); }
    assert.equal(lastRow(tryAs('J', `select public.apply_referral_code('${CODE.B}')`)), '{"ok": false, "error": "Referral rewards aren\'t available at the moment."}');
  });
  test('21d. removing the referral_code lock lets a user rewrite their code again', () => {
    const full = db.raw(`select pg_get_functiondef('public.tg_profiles_lock_sensitive'::regproc)`);
    assert.match(full, /referral_code\s*:=\s*old\.referral_code/);
    db.raw(full.replace(/\s*new\.referral_code\s*:=\s*old\.referral_code;[^\n]*\n/, '\n').trim().replace(/^\s*/, '') + ';');
    try {
      doAs('B', `update public.profiles set referral_code='HACKED' where id='${U.B}'`);
      assert.equal(codeOf('B'), 'HACKED', 'without the lock the user can rewrite the code');
    } finally { restore(); db.raw(`update public.profiles set referral_code='${CODE.B}' where id='${U.B}'`); }
    doAs('B', `update public.profiles set referral_code='HACKED2' where id='${U.B}'`);
    assert.equal(codeOf('B'), CODE.B);
  });
  test('after every mutation the migration restores the disabled state', () => {
    assert.match(tryAs('A', 'select public.ensure_referral_code()'), /aren't available/);
    assert.equal(scalar(`select count(*) from pg_trigger where tgname='referral_qualify'`), '0');
    assert.ok(denied(tryAs('B', `delete from public.referrals`)));
  });
});
