/**
 * offers-loyalty-tier-entitlement.node.test.ts — Offers and Loyalty are Pro,
 * and the stamps a customer already earned are not the shop's to take back.
 *
 * The last two paid capabilities, and the pair that forced the sharpest split
 * between "the business is trading" and "the customer holds something".
 *
 * Offers and the Loyalty programme are gated the same way as Bookings: create
 * and commercially edit need Pro, taking it down never does. Loyalty then adds
 * a second boundary the others do not have, because loyalty is the only paid
 * capability that MINTS customer value: local_loyalty_cards has no INSERT or
 * UPDATE policy for any client role, so every stamp arrives from a server path
 * — the Till, NFC, stamp-collect, and an AFTER trigger on wallet spends. The
 * card guard therefore does NOT exempt the service role. Exempting it would
 * exempt every award path there is.
 *
 * Only an increase is gated. Spending stamps, correcting a card and honouring
 * a reward all move the balance down, and a lapsed subscription is not a reason
 * to refuse any of them.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

const OWNER = 'f4f40001-1111-1111-1111-111111111111';
const CUST  = 'f4f40009-9999-9999-9999-999999999999';
const B = {
  pro:      'f4f40002-2222-2222-2222-222222222222',
  free:     'f4f40003-3333-3333-3333-333333333333',
  premium:  'f4f40004-4444-4444-4444-444444444444',
  lapsing:  'f4f40005-5555-5555-5555-555555555555',
  premNull: 'f4f40006-6666-6666-6666-666666666666',
  noTerms:  'f4f40007-7777-7777-7777-777777777777',
};
const OFFER = 'f4f4a001-1111-1111-1111-111111111111';
const PROG  = 'f4f4b001-1111-1111-1111-111111111111';
const CARD  = 'f4f4c001-1111-1111-1111-111111111111';

const FIXTURE = `
begin;
  insert into auth.users (id,email) values ('${OWNER}','ol-o@probe.invalid'),('${CUST}','ol-c@probe.invalid');
  insert into public.local_businesses (id,owner_id,name,category,address,is_active) values
    ('${B.pro}','${OWNER}','OL PRO','other','P',true),
    ('${B.free}','${OWNER}','OL FREE','other','P',true),
    ('${B.premium}','${OWNER}','OL PREM','other','P',true),
    ('${B.lapsing}','${OWNER}','OL LAPSING','other','P',true),
    ('${B.premNull}','${OWNER}','OL NULL','other','P',true),
    ('${B.noTerms}','${OWNER}','OL NOTERMS','other','P',true);
  update public.local_businesses set subscription_tier='pro', subscription_until=now()+interval '10 days'
    where id in ('${B.pro}','${B.lapsing}','${B.noTerms}');
  update public.local_businesses set subscription_tier='premium', subscription_until=now()+interval '10 days' where id='${B.premium}';
  update public.local_businesses set subscription_tier='premium', subscription_until=null where id='${B.premNull}';
  create temp table r(step text, outcome text) on commit drop;
  grant insert, select on r to authenticated, anon;
`;
const asServer = `reset role; select set_config('request.jwt.claims','',true);`;
const asUser = (id: string) => `
  reset role;
  select set_config('request.jwt.claims','{"sub":"${id}","role":"authenticated"}',true);
  set local role authenticated;`;
const asAnon = `
  reset role;
  select set_config('request.jwt.claims','',true);
  set local role anon;`;
// Deliberately NOT B.noTerms — that business exists to prove W3I still bites.
const acceptTerms = [B.pro, B.free, B.premium, B.lapsing, B.premNull].map((id) =>
  `select public.record_commercial_terms_acceptance('${id}'::uuid);`).join('\n');

const attempt = (step: string, stmt: string) => `
do $p$ begin ${stmt};
  insert into r values ('${step}','ALLOWED');
exception when others then insert into r values ('${step}','refused: '||left(sqlerrm,72)); end $p$;`;
const measure = (step: string, expr: string) => `
do $p$ begin insert into r values ('${step}', (${expr})::text); end $p$;`;
const END = `reset role; select * from r order by step; rollback;`;

type Rows = Record<string, unknown>[];
const outcome = (rows: Rows, step: string) => String(rows.find((r) => r.step === step)?.outcome ?? '(missing)');
const allowed = (rows: Rows, step: string) => assert.equal(outcome(rows, step), 'ALLOWED');
const refused = (rows: Rows, step: string) =>
  assert.ok(outcome(rows, step).startsWith('refused'), `${step} should have been refused, got: ${outcome(rows, step)}`);

const lapse = (id: string) =>
  `update public.local_businesses set subscription_until=now()-interval '1 hour' where id='${id}';`;
const restore = (id: string) =>
  `update public.local_businesses set subscription_until=now()+interval '10 days' where id='${id}';`;
const newOffer = (biz: string, id = 'gen_random_uuid()') =>
  `insert into public.local_offers (id,business_id,title,valid_until,is_active)
     values (${id === 'gen_random_uuid()' ? id : `'${id}'`},'${biz}','OL probe offer',now()+interval '30 days',true)`;
const newProgram = (biz: string, id = 'gen_random_uuid()') =>
  `insert into public.local_loyalty_programs (id,business_id,type,stamps_required,stamp_reward,is_active)
     values (${id === 'gen_random_uuid()' ? id : `'${id}'`},'${biz}','stamps',5,'A free coffee',true)`;

/* ── 1. Creating an Offer ─────────────────────────────────────────────────── */

describe('creating an Offer needs Pro', () => {
  const rows = sql(FIXTURE + asUser(OWNER) + acceptTerms +
    attempt('pro',      newOffer(B.pro)) +
    attempt('premium',  newOffer(B.premium)) +
    attempt('free',     newOffer(B.free)) +
    attempt('null end', newOffer(B.premNull)) +
    asServer + lapse(B.lapsing) + asUser(OWNER) +
    attempt('lapsed',   newOffer(B.lapsing)) +
    attempt('no terms', newOffer(B.noTerms)) +
    END);

  test('1. Free cannot create', () => refused(rows, 'free'));
  test('2. Pro can create with current Terms', () => allowed(rows, 'pro'));
  test('3. Premium can create — it meets Pro', () => allowed(rows, 'premium'));
  test('4. an expired Pro cannot create', () => refused(rows, 'lapsed'));
  test('5. a stale paid tier whose date has passed cannot create', () => refused(rows, 'lapsed'));
  test('6. a paid tier with NULL expiry cannot create', () => refused(rows, 'null end'));

  test('7. Terms remain independently required', () => refused(rows, 'no terms'));
  test('8. tier does not replace W3I — the refusals are different refusals', () => {
    // B.noTerms genuinely holds Pro. If tier had swallowed the Terms check, this
    // would have been ALLOWED; if Terms had swallowed tier, 'free' would read
    // like a Terms failure.
    assert.match(outcome(rows, 'no terms'), /terms/i);
    assert.match(outcome(rows, 'free'), /Pro plan/);
    assert.doesNotMatch(outcome(rows, 'free'), /terms/i);
  });
});

/* ── 2. Living with an Offer after the plan ends ──────────────────────────── */

describe('an Offer that outlives the plan', () => {
  const rows = sql(FIXTURE + asUser(OWNER) + acceptTerms +
    attempt('create while Pro', newOffer(B.lapsing, OFFER)) +
    asServer + lapse(B.lapsing) + asUser(OWNER) +
    attempt('edit the title',   `update public.local_offers set title='changed' where id='${OFFER}'`) +
    attempt('extend the dates', `update public.local_offers set valid_until=now()+interval '90 days' where id='${OFFER}'`) +
    attempt('change the discount', `update public.local_offers set discount_value=99 where id='${OFFER}'`) +
    attempt('withdraw it',      `update public.local_offers set is_active=false where id='${OFFER}'`) +
    measure('is it withdrawn',  `select is_active from public.local_offers where id='${OFFER}'`) +
    attempt('put it back up',   `update public.local_offers set is_active=true where id='${OFFER}'`) +
    measure('is it back up',    `select is_active from public.local_offers where id='${OFFER}'`) +
    attempt('edit while withdrawn', `update public.local_offers set title='tidying up' where id='${OFFER}'`) +
    attempt('delete it',        `delete from public.local_offers where id='${OFFER}'`) +
    measure('is it gone',       `select count(*)=0 from public.local_offers where id='${OFFER}'`) +
    asServer + restore(B.lapsing) + asUser(OWNER) +
    attempt('create again once Pro returns', newOffer(B.lapsing)) +
    END);

  test('9. an under-tier live Offer cannot be commercially edited', () => {
    refused(rows, 'edit the title');
    refused(rows, 'extend the dates');
    refused(rows, 'change the discount');
  });
  test('10. withdrawal remains possible, and actually withdraws', () => {
    allowed(rows, 'withdraw it');
    assert.equal(outcome(rows, 'is it withdrawn'), 'false');
  });
  test('a withdrawn Offer cannot be quietly put back up', () => {
    refused(rows, 'put it back up');
    assert.equal(outcome(rows, 'is it back up'), 'false');
  });
  test('tidying up something already taken down is nobody’s business', () =>
    allowed(rows, 'edit while withdrawn'));
  test('11. DELETE semantics are unchanged', () => {
    allowed(rows, 'delete it');
    assert.equal(outcome(rows, 'is it gone'), 'true');
  });
  test('regaining Pro permits normal use again', () => allowed(rows, 'create again once Pro returns'));
});

/* ── 3. What a customer can see ───────────────────────────────────────────── */

describe('Offers disappear from the customer surface below tier', () => {
  const count = (biz: string) => `select count(*) from public.local_offers where business_id='${biz}'`;
  const rows = sql(FIXTURE + asServer +
    newOffer(B.lapsing, OFFER) + ';' +
    asAnon + measure('visitor, Pro', count(B.lapsing)) +
    asServer + lapse(B.lapsing) +
    asAnon + measure('visitor, lapsed', count(B.lapsing)) +
    asUser(OWNER) + measure('owner, lapsed', count(B.lapsing)) +
    asServer + `update public.local_offers set is_active=false where id='${OFFER}';` + restore(B.lapsing) +
    asAnon + measure('visitor, Pro but withdrawn', count(B.lapsing)) +
    END);

  test('12. the public customer surface hides an under-tier Offer', () => {
    assert.equal(outcome(rows, 'visitor, Pro'), '1', 'the control must show it, or the test proves nothing');
    assert.equal(outcome(rows, 'visitor, lapsed'), '0');
  });
  test('13. the owner still sees their own configuration', () =>
    assert.equal(outcome(rows, 'owner, lapsed'), '1'));
  test('a withdrawn Offer stays hidden even on a good plan', () =>
    assert.equal(outcome(rows, 'visitor, Pro but withdrawn'), '0'));
});

/* ── 4. The Loyalty programme ─────────────────────────────────────────────── */

describe('running a Loyalty programme needs Pro', () => {
  const rows = sql(FIXTURE + asUser(OWNER) + acceptTerms +
    attempt('pro',      newProgram(B.pro)) +
    attempt('premium',  newProgram(B.premium)) +
    attempt('free',     newProgram(B.free)) +
    attempt('null end', newProgram(B.premNull)) +
    attempt('no terms', newProgram(B.noTerms)) +
    attempt('create while Pro', newProgram(B.lapsing, PROG)) +
    asServer + lapse(B.lapsing) + asUser(OWNER) +
    attempt('change the rules',  `update public.local_loyalty_programs set stamps_required=3 where id='${PROG}'`) +
    attempt('change the reward', `update public.local_loyalty_programs set stamp_reward='two coffees' where id='${PROG}'`) +
    attempt('stop it',           `update public.local_loyalty_programs set is_active=false where id='${PROG}'`) +
    measure('is it stopped',     `select is_active from public.local_loyalty_programs where id='${PROG}'`) +
    attempt('restart it',        `update public.local_loyalty_programs set is_active=true where id='${PROG}'`) +
    measure('is it restarted',   `select is_active from public.local_loyalty_programs where id='${PROG}'`) +
    asServer + restore(B.lapsing) + asUser(OWNER) +
    attempt('restart once Pro returns', `update public.local_loyalty_programs set is_active=true where id='${PROG}'`) +
    END);

  test('15. Free cannot create a programme', () => refused(rows, 'free'));
  test('16. Pro can create with current Terms', () => allowed(rows, 'pro'));
  test('17. Premium can create', () => allowed(rows, 'premium'));
  test('18. an expired or dateless paid tier cannot create', () => {
    refused(rows, 'null end');
    refused(rows, 'change the rules');
  });
  test('19. current Terms are still required', () => {
    refused(rows, 'no terms');
    assert.match(outcome(rows, 'no terms'), /terms/i);
  });
  test('20. an under-tier business cannot modify or restart the programme', () => {
    refused(rows, 'change the rules');
    refused(rows, 'change the reward');
    refused(rows, 'restart it');
    assert.equal(outcome(rows, 'is it restarted'), 'false');
  });
  test('21. stopping the programme remains possible', () => {
    allowed(rows, 'stop it');
    assert.equal(outcome(rows, 'is it stopped'), 'false');
  });
  test('28. regaining Pro permits operation again', () => allowed(rows, 'restart once Pro returns'));
});

/* ── 5. Minting customer value ────────────────────────────────────────────── */

describe('new Loyalty value cannot be minted below tier', () => {
  // Every statement here runs with NO jwt and as the table owner — the closest
  // this harness gets to the service key the Till and NFC functions hold. If
  // the guard exempted server paths, every one of these would be ALLOWED.
  const rows = sql(FIXTURE + asServer +
    newProgram(B.lapsing, PROG) + ';' +
    `insert into public.local_loyalty_cards (id,user_id,program_id,business_id,stamps_collected)
       values ('${CARD}','${CUST}','${PROG}','${B.lapsing}',4);` +
    `insert into public.local_loyalty_transactions (card_id,user_id,business_id,type,amount)
       values ('${CARD}','${CUST}','${B.lapsing}','stamp',4);` +
    attempt('award while Pro', `update public.local_loyalty_cards set stamps_collected=5 where id='${CARD}'`) +
    lapse(B.lapsing) +
    attempt('award a stamp',        `update public.local_loyalty_cards set stamps_collected=6 where id='${CARD}'`) +
    attempt('award points',         `update public.local_loyalty_cards set points_balance=50 where id='${CARD}'`) +
    attempt('open a card with value', `insert into public.local_loyalty_cards (user_id,program_id,business_id,stamps_collected)
       values ('${OWNER}','${PROG}','${B.lapsing}',1)`) +
    attempt('open an empty card',   `insert into public.local_loyalty_cards (user_id,program_id,business_id,stamps_collected)
       values ('${OWNER}','${PROG}','${B.lapsing}',0)`) +
    attempt('write a stamp to the ledger', `insert into public.local_loyalty_transactions (card_id,user_id,business_id,type,amount)
       values ('${CARD}','${CUST}','${B.lapsing}','stamp',1)`) +
    attempt('write a points_earn to the ledger', `insert into public.local_loyalty_transactions (card_id,user_id,business_id,type,amount)
       values ('${CARD}','${CUST}','${B.lapsing}','points_earn',10)`) +
    measure('stamps after all that', `select stamps_collected from public.local_loyalty_cards where id='${CARD}'`) +
    restore(B.lapsing) +
    attempt('award once Pro returns', `update public.local_loyalty_cards set stamps_collected=6 where id='${CARD}'`) +
    END);

  test('the control passes — a Pro business can award', () => allowed(rows, 'award while Pro'));
  test('23. new earning is refused below tier', () => {
    refused(rows, 'award a stamp');
    refused(rows, 'award points');
  });
  test('24. the direct award path cannot bypass, service role included', () => {
    refused(rows, 'open a card with value');
    refused(rows, 'write a stamp to the ledger');
    refused(rows, 'write a points_earn to the ledger');
  });
  test('an empty card is not value, and is not blocked', () => allowed(rows, 'open an empty card'));
  test('nothing was minted while the refusals happened', () =>
    assert.equal(outcome(rows, 'stamps after all that'), '5'));
  test('28. earning resumes once Pro returns', () => allowed(rows, 'award once Pro returns'));
});

/* ── 6. What the customer keeps ───────────────────────────────────────────── */

describe('a downgrade does not reach the customer', () => {
  const rows = sql(FIXTURE + asServer +
    newProgram(B.lapsing, PROG) + ';' +
    `insert into public.local_loyalty_cards (id,user_id,program_id,business_id,stamps_collected)
       values ('${CARD}','${CUST}','${PROG}','${B.lapsing}',5);` +
    `insert into public.local_loyalty_transactions (card_id,user_id,business_id,type,amount)
       values ('${CARD}','${CUST}','${B.lapsing}','stamp',5);` +
    lapse(B.lapsing) +
    measure('stamps still held',  `select stamps_collected from public.local_loyalty_cards where id='${CARD}'`) +
    measure('ledger rows kept',   `select count(*) from public.local_loyalty_transactions where card_id='${CARD}'`) +
    measure('card still there',   `select count(*) from public.local_loyalty_cards where id='${CARD}'`) +
    attempt('redeem the reward',  `update public.local_loyalty_cards
       set stamps_collected=0, total_redeemed=coalesce(total_redeemed,0)+1 where id='${CARD}'`) +
    attempt('record the reward',  `insert into public.local_loyalty_transactions (card_id,user_id,business_id,type,amount)
       values ('${CARD}','${CUST}','${B.lapsing}','reward',5)`) +
    attempt('spend points',       `insert into public.local_loyalty_transactions (card_id,user_id,business_id,type,amount)
       values ('${CARD}','${CUST}','${B.lapsing}','redeem',10)`) +
    attempt('correct a card down', `update public.local_loyalty_cards set stamps_collected=0 where id='${CARD}'`) +
    measure('redeemed count',     `select total_redeemed from public.local_loyalty_cards where id='${CARD}'`) +
    END);

  test('25. existing customer state survives the downgrade', () => {
    assert.equal(outcome(rows, 'stamps still held'), '5');
    assert.equal(outcome(rows, 'card still there'), '1');
  });
  test('26. existing history is not deleted', () =>
    assert.equal(outcome(rows, 'ledger rows kept'), '1'));
  test('27. redemption and remediation survive the downgrade', () => {
    allowed(rows, 'redeem the reward');
    allowed(rows, 'record the reward');
    allowed(rows, 'spend points');
    allowed(rows, 'correct a card down');
    assert.equal(outcome(rows, 'redeemed count'), '1');
  });
});

/* ── 7. The wallet-spend award path ───────────────────────────────────────── */

describe('a lapsed plan stops the points, not the payment', () => {
  const points = `select coalesce(sum(points_balance),0) from public.local_loyalty_cards where business_id='${B.lapsing}'`;
  const spend = (n: number) => `insert into public.local_wallet_transactions (user_id,business_id,type,amount_pence)
       values ('${CUST}','${B.lapsing}','spend',${n})`;
  const rows = sql(FIXTURE + asServer +
    `insert into public.local_loyalty_programs (id,business_id,type,points_per_pound,is_active)
       values ('${PROG}','${B.lapsing}','points',10,true);` +
    attempt('spend while Pro', spend(500)) +
    measure('points while Pro', points) +
    lapse(B.lapsing) +
    attempt('spend once lapsed', spend(500)) +
    measure('points once lapsed', points) +
    measure('both payments landed',
      `select count(*) from public.local_wallet_transactions where business_id='${B.lapsing}' and type='spend'`) +
    END);

  test('the control passes — a Pro shop awards points on a spend', () => {
    allowed(rows, 'spend while Pro');
    assert.equal(outcome(rows, 'points while Pro'), '50');
  });
  test('the payment still completes once the plan lapses', () => {
    allowed(rows, 'spend once lapsed');
    assert.equal(outcome(rows, 'both payments landed'), '2',
      'a loyalty rule must never roll back a customer payment');
  });
  test('but no new points are minted', () =>
    assert.equal(outcome(rows, 'points once lapsed'), '50'));

  test('the award trigger skips rather than raises', () => {
    const [row] = sql(`select pg_get_functiondef('public.tg_loyalty_earn_points'::regproc) as d;`);
    const def = String(row.d);
    assert.match(def, /business_meets_tier\(new\.business_id, 'pro'\)/);
    // The tier branch must return, not raise. A raise here would abort the
    // wallet insert this trigger hangs off.
    assert.match(def, /if not public\.business_meets_tier\(new\.business_id, 'pro'\) then\s*\n\s*return new;/);
  });
});

/* ── 8. Loyalty on the customer surface ───────────────────────────────────── */

describe('Loyalty disappears from the customer surface below tier', () => {
  const count = `select count(*) from public.local_loyalty_programs where business_id='${B.lapsing}'`;
  const rows = sql(FIXTURE + asServer +
    newProgram(B.lapsing, PROG) + ';' +
    `update public.local_businesses set nfc_token='ol-probe-token' where id='${B.lapsing}';` +
    asAnon + measure('visitor, Pro', count) +
    asServer + measure('nfc tile, Pro',
      `select count(*) from public.resolve_nfc_tile('ol-probe-token') where has_loyalty`) +
    lapse(B.lapsing) +
    asAnon + measure('visitor, lapsed', count) +
    asUser(OWNER) + measure('owner, lapsed', count) +
    asServer + measure('nfc tile, lapsed',
      `select count(*) from public.resolve_nfc_tile('ol-probe-token') where has_loyalty`) +
    END);

  test('22. public Loyalty presentation disappears below effective tier', () => {
    assert.equal(outcome(rows, 'visitor, Pro'), '1', 'the control must show it');
    assert.equal(outcome(rows, 'visitor, lapsed'), '0');
  });
  test('the owner keeps their own programme configuration', () =>
    assert.equal(outcome(rows, 'owner, lapsed'), '1'));
  test('the NFC tile stops advertising it too', () => {
    assert.equal(outcome(rows, 'nfc tile, Pro'), '1', 'the control must show it');
    assert.equal(outcome(rows, 'nfc tile, lapsed'), '0');
  });
});

/* ── 9. Deployed shape ────────────────────────────────────────────────────── */

describe('deployed shape', () => {
  test('four guards, all BEFORE, none on DELETE', () => {
    const rows = sql(`
      select t.tgname, c.relname as tbl,
             case when (t.tgtype & 2)<>0 then 'BEFORE' else 'AFTER' end as timing,
             (t.tgtype & 4)<>0 as on_insert, (t.tgtype & 16)<>0 as on_update, (t.tgtype & 8)<>0 as on_delete
        from pg_trigger t join pg_class c on c.oid=t.tgrelid
       where t.tgname in ('local_offers_tier_guard','local_loyalty_programs_tier_guard',
                          'local_loyalty_cards_tier_guard','local_loyalty_transactions_tier_guard')
         and not t.tgisinternal order by t.tgname;`);
    assert.equal(rows.length, 4);
    for (const r of rows) {
      assert.equal(r.timing, 'BEFORE', `${r.tgname} must be BEFORE to compare OLD and NEW`);
      assert.equal(r.on_delete, false, `${r.tgname} must not be wired to DELETE`);
      assert.equal(r.on_insert, true);
    }
    const byName = Object.fromEntries(rows.map((r) => [r.tgname, r]));
    assert.equal(byName['local_offers_tier_guard']?.tbl, 'local_offers');
    assert.equal(byName['local_loyalty_programs_tier_guard']?.tbl, 'local_loyalty_programs');
    assert.equal(byName['local_loyalty_cards_tier_guard']?.tbl, 'local_loyalty_cards');
    assert.equal(byName['local_loyalty_transactions_tier_guard']?.tbl, 'local_loyalty_transactions');
  });

  test('W3I still fires first — triggers run in alphabetical order', () => {
    const rows = sql(`
      select c.relname as tbl, t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
       where not t.tgisinternal and c.relname in ('local_offers','local_loyalty_programs')
       order by c.relname, t.tgname;`);
    for (const tbl of ['local_offers', 'local_loyalty_programs']) {
      const names = rows.filter((r) => r.tbl === tbl).map((r) => String(r.tgname));
      assert.ok(names.includes('commercial_terms_guard'), `${tbl} lost its W3I guard`);
      assert.ok(names.indexOf('commercial_terms_guard') < names.indexOf(`${tbl}_tier_guard`),
        'Terms must be decided before tier');
    }
  });

  test('the card guard does NOT exempt the service role', () => {
    const [row] = sql(`select pg_get_functiondef('public.local_loyalty_cards_tier_guard'::regproc) as d;`);
    const def = String(row.d);
    assert.doesNotMatch(def, /auth\.uid\(\)\s+is\s+null/,
      'every award path is a server path; exempting them exempts everything');
  });

  test('the programme and Offer guards do exempt it, because RLS covers them', () => {
    for (const fn of ['local_offers_tier_guard', 'local_loyalty_programs_tier_guard']) {
      const [row] = sql(`select pg_get_functiondef('public.${fn}'::regproc) as d;`);
      assert.match(String(row.d), /v_uid is null then return new/);
    }
    // ...and that is only safe while the write policies still demand an owner.
    const rows = sql(`
      select tablename, with_check from pg_policies
       where schemaname='public' and tablename in ('local_offers','local_loyalty_programs')
         and cmd='ALL';`);
    assert.equal(rows.length, 2);
    for (const r of rows) assert.match(String(r.with_check), /is_business_owner/);
  });

  test('there is still no client write policy on the customer-value tables', () => {
    const rows = sql(`
      select tablename, cmd from pg_policies
       where schemaname='public' and tablename in ('local_loyalty_cards','local_loyalty_transactions')
         and cmd <> 'SELECT';`);
    assert.deepEqual(rows, [], 'a client write policy here would need its own guard');
  });

  test('both public policies ask the predicate, not a stored column', () => {
    const rows = sql(`
      select tablename, policyname, qual from pg_policies
       where schemaname='public'
         and policyname in ('Anyone can read active offers','Anyone can read active loyalty programs');`);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.match(String(r.qual), /business_meets_tier/);
      assert.doesNotMatch(String(r.qual), /subscription_tier/,
        'the configured tier is not the effective tier');
    }
  });

  test('all four guards use the one shared predicate', () => {
    for (const fn of ['local_offers_tier_guard', 'local_loyalty_programs_tier_guard',
                      'local_loyalty_cards_tier_guard', 'local_loyalty_transactions_tier_guard']) {
      const [row] = sql(`select pg_get_functiondef('public.${fn}'::regproc) as d;`);
      const def = String(row.d);
      assert.match(def, /business_meets_tier/, `${fn} must not invent a second tier formula`);
      assert.doesNotMatch(def, /subscription_until/, `${fn} must not reimplement expiry`);
    }
  });

  test('the customer is never told about the plan', () => {
    for (const fn of ['local_loyalty_cards_tier_guard', 'local_loyalty_transactions_tier_guard']) {
      const [row] = sql(`select pg_get_functiondef('public.${fn}'::regproc) as d;`);
      const def = String(row.d);
      const message = def.slice(def.indexOf('raise exception'));
      // Both boundaries, or "programme" trips the "Pro" branch.
      assert.doesNotMatch(message, /\b(Pro|Premium|plan|plans|subscription|billing|expired?|upgrade)\b/i);
    }
  });
});

/* ── 10. Nothing else moved ───────────────────────────────────────────────── */

describe('the rest of the platform is where it was', () => {
  test('29-32. the other four capabilities keep their own guards', () => {
    const rows = sql(`
      select t.tgname from pg_trigger t
       where not t.tgisinternal
         and t.tgname in ('local_businesses_bookings_tier_guard','book_bookings_tier_guard',
                          'products_tier_guard','book_unit_items_tier_guard',
                          'local_businesses_wallet_tier_guard')
       order by t.tgname;`);
    assert.deepEqual(rows.map((r) => r.tgname).sort(),
      ['book_bookings_tier_guard', 'book_unit_items_tier_guard',
       'local_businesses_bookings_tier_guard', 'local_businesses_wallet_tier_guard',
       'products_tier_guard'],
      'Bookings, Products, Passes and Wallet must be untouched');
  });

  test('33. customer Wallet value is untouched by this slice', () => {
    const [row] = sql(`
      select coalesce(sum(balance_pence),0) as pence, count(*) as rows from public.local_wallet_balances;`);
    // Recorded at the Wallet slice and unchanged since. If this ever moves, it
    // moved for a reason that has nothing to do with entitlement.
    assert.equal(String(row.pence), '1800');
    assert.equal(String(row.rows), '4');
  });

  test('34. Work, Jobs and Shifts gained nothing', () => {
    const rows = sql(`
      select distinct c.relname as tbl from pg_trigger t join pg_class c on c.oid=t.tgrelid
       where not t.tgisinternal and position('business_meets_tier' in pg_get_functiondef(t.tgfoid)) > 0
       order by c.relname;`);
    const tables = rows.map((r) => String(r.tbl));
    for (const t of tables) assert.doesNotMatch(t, /job|shift|applicant|lead|work/i);
    assert.deepEqual(tables.sort(),
      ['book_bookings', 'book_unit_items', 'local_businesses', 'local_loyalty_cards',
       'local_loyalty_programs', 'local_loyalty_transactions', 'local_offers',
       // Not Wallet enforcement. tg_loyalty_earn_points is a LOYALTY award path
       // that happens to hang off a wallet insert, and it now skips the award
       // below tier instead of awarding. Wallet's own guard is on
       // local_businesses and is untouched by this slice.
       'local_wallet_transactions',
       'products'],
      'this is the complete list of tier-enforced tables');
  });

  test('35. no Business 2.0 capability or onboarding UI was introduced', () => {
    for (const p of ['app/business/capabilities', 'app/business/onboarding', 'components/business/CapabilityCard.tsx']) {
      assert.equal(existsSync(join(WEB, p)), false, `${p} belongs to a later task`);
    }
  });

  test('the existing management tier gates are untouched', () => {
    assert.match(readWeb('app/business/[id]/manage/offers/page.tsx'), /tierUnlocks\(/);
    assert.match(readWeb('app/business/[id]/manage/loyalty/page.tsx'), /tierUnlocks\(/);
  });

  test('both canonical tier maps still say Pro, and still agree', () => {
    const grab = (s: string) => s.slice(s.indexOf('TIER_FEATURES: Record'), s.indexOf('};', s.indexOf('TIER_FEATURES: Record')));
    const web = grab(readWeb('lib/listing-tiers.ts'));
    const mob = grab(read('lib/listing-tiers.ts'));
    assert.equal(web, mob, 'the two tier maps must not drift');
    assert.match(web, /offers:\s*"pro"/);
    assert.match(web, /loyalty:\s*"pro"/);
  });

  test('no client recomputes the expiry for these two capabilities', () => {
    // Scoped to the offer fetch on purpose. home-data.ts does read
    // subscription_until elsewhere, to rank which businesses get featured on
    // the homepage — that is a separate, older question and not this boundary.
    const src = readWeb('lib/home-data.ts');
    const fetchOffers = src.slice(src.indexOf('async function fetchOffers'),
                                  src.indexOf('async function fetchNotices'));
    assert.ok(fetchOffers.includes('local_offers'), 'the slice must be the offer fetch');
    assert.doesNotMatch(fetchOffers, /subscription_until|subscription_tier/,
      "the offer fetch must read the server's answer, not date arithmetic");
  });
});
