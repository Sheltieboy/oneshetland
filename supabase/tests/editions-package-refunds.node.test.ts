/**
 * editions-package-refunds.node.test.ts — ISOLATED Postgres only. In-product refunds for PACKAGE orders: administrators only, validated, idempotent, audited; the existing worker queue and
 * the existing edition_refund_order path do the rest (a full refund voids the entitlement and the Edition stops being public; a partial refund leaves it live).
 * Run: ISOLATED_ONLY=editions-package-refunds npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Env, seed, enter, draftEdition } from './_support/editions-env.ts';

let E: Env;
let S: ReturnType<typeof seed>;
let BIZ_ORG = '', ED = '', PAID = '', FREE = '';
const flag = (k: string, v: string) => E.sup(`insert into admin_config (key, value, category) values ('${k}','${v}','features') on conflict (key) do update set value='${v}'`);
const upsert = (code: string, price: number, free: boolean) => E.call('ADMIN', `select public.admin_upsert_edition_package('${code}','${code} package','test',${price},365,'[]'::jsonb,null,true,10,${free})`);
const anonPublic = (ed = ED) => E.one('anon', `select public.edition_is_public('${ed}')`) === 't';
const approvedEdition = (slug: string) => { const ed = draftEdition(E, 'BIZ_OWNER', BIZ_ORG, slug, `ZZ ${slug}`); E.do('BIZ_OWNER', `select public.edition_submit_for_review('${ed}')`); E.do('ADMIN', `select public.admin_review_edition('${ed}','approve','looks fine')`); return ed; };
let n = 100;
/** a paid order, fulfilled as the webhook would, for a fresh approved Edition */
const paidOrder = (price = 5000) => {
  const ed = approvedEdition(`zz-refund-${++n}`);
  const o = E.call('BIZ_OWNER', `select public.edition_create_order('${BIZ_ORG}','${ed}','${PAID}','attempt-${n}0001')`);
  assert.equal(E.q(`select public.edition_fulfil_order('${o}','pi_test_${n}',${price})`), 'fulfilled');
  return { ed, o, pi: `pi_test_${n}` };
};
const refund = (o: string, amount: string, reason = 'customer asked for a refund') => E.try('ADMIN', `select public.admin_request_edition_order_refund('${o}', ${amount}, '${reason}')`);
const reqOf = (o: string) => E.q(`select id from public.edition_refund_requests where order_id='${o}' order by created_at desc limit 1`);

before(() => {
  E = new Env('editionspackagerefunds');
  S = seed(E);
  BIZ_ORG = enter(E, 'BIZ_OWNER', 'business', S.BIZ);
  PAID = upsert('zz_paid', 5000, false); FREE = upsert('zz_free', 0, true);
  flag('editions.commerce.enabled', 'true');
});
after(() => E?.drop());

describe('who may ask and what is checked', () => {
  test('administrators only: owners, helpers, strangers and signed-out visitors are refused, and nothing is created', () => {
    const { o } = paidOrder();
    for (const who of ['BIZ_OWNER', 'HELPER', 'STRANGER', 'anon'] as const) assert.match(E.try(who, `select public.admin_request_edition_order_refund('${o}', null, 'a good reason')`), /admins only|permission denied/, who);
    assert.equal(E.q(`select count(*) from public.edition_refund_requests where order_id='${o}'`), '0');
  });
  test('a reason of at least 5 characters, a real order, an amount above nothing and no more than what is left', () => {
    const { o } = paidOrder();
    assert.match(refund(o, 'null', '  hi '), /reason of at least 5/);
    assert.match(E.try('ADMIN', `select public.admin_request_edition_order_refund(gen_random_uuid(), null, 'a good reason')`), /order not found/);
    assert.match(refund(o, '0'), /more than nothing/); assert.match(refund(o, '-5'), /more than nothing/); assert.match(refund(o, '5001'), /no more than what is left/);
  });
  test('a free order, an unpaid order and a fully refunded order cannot be refunded', () => {
    const ed = approvedEdition('zz-refund-free');
    const f = E.call('BIZ_OWNER', `select public.edition_claim_free_package('${BIZ_ORG}','${ed}','${FREE}','attempt-free-0001')`);
    assert.match(refund(f, 'null'), /free package has nothing to refund/);
    const ed2 = approvedEdition('zz-refund-pending');
    const p = E.call('BIZ_OWNER', `select public.edition_create_order('${BIZ_ORG}','${ed2}','${PAID}','attempt-pend-0001')`);
    assert.match(refund(p, 'null'), /only a paid order/);
    const { o } = paidOrder(); E.sup(`select public.edition_refund_order('${o}', 5000)`);
    assert.match(refund(o, 'null'), /only a paid order/);
  });
});

describe('request, worker, provider confirmation', () => {
  test('a partial refund: queued, idempotent, visible to the worker, confirmed by the provider; the entitlement stays live and the Edition stays public', () => {
    const { ed, o, pi } = paidOrder();
    E.do('BIZ_OWNER', `select public.edition_set_status('${ed}','published')`);
    assert.ok(anonPublic(ed), 'public while entitled');
    const out = E.call('ADMIN', `select public.admin_request_edition_order_refund('${o}', 1000, 'goodwill refund')`);
    const j = JSON.parse(out);
    assert.equal(j.amount_pence, 1000); assert.equal(j.full, false); assert.equal(j.remaining_after_pence, 4000); assert.equal(j.status, 'pending'); assert.equal(j.already_requested, false);
    const again = JSON.parse(E.call('ADMIN', `select public.admin_request_edition_order_refund('${o}', 1000, 'goodwill refund')`));
    assert.equal(again.request_id, j.request_id); assert.equal(again.already_requested, true);
    assert.match(refund(o, '500'), /already in progress/);
    assert.equal(E.q(`select count(*) from public.edition_refund_requests where order_id='${o}'`), '1');
    assert.equal(E.q(`select count(*) from public.edition_audit_log where action='order_refund_requested' and detail->>'order'='${o}'`), '1');
    // the worker sees it with the order's payment intent, no application fee, no payment ledger row
    assert.equal(E.q(`select stripe_payment_intent_id || '|' || amount_pence || '|' || refund_application_fee || '|' || (payment_id is null) || '|' || (order_id = '${o}') from public.edition_refunds_next() where request_id='${j.request_id}'`), `${pi}|1000|false|true|true`);
    E.sup(`select public.edition_refund_request_mark('${j.request_id}','submitted',null)`);
    assert.equal(E.q(`select count(*) from public.edition_refunds_next() where request_id='${j.request_id}'`), '0', 'submitted is not sent twice');
    // the provider confirms (cumulative total)
    assert.equal(E.q(`select public.edition_refund_order('${o}', 1000)`), 'recorded');
    assert.equal(E.q(`select status || '|' || refunded_pence from public.edition_orders where id='${o}'`), 'partially_refunded|1000');
    assert.equal(E.q(`select status from public.edition_refund_requests where id='${j.request_id}'`), 'done');
    assert.equal(E.q(`select count(*) from public.edition_entitlements where order_id='${o}' and voided_at is null`), '1');
    assert.ok(anonPublic(ed), 'still public after a partial refund');
    // what is left is the ceiling now
    assert.match(refund(o, '4001'), /no more than what is left/);
  });
  test('the rest as a full refund (amount left empty): voids the entitlement and the Edition stops being public without anyone editing it', () => {
    const { ed, o } = paidOrder();
    E.do('BIZ_OWNER', `select public.edition_set_status('${ed}','published')`);
    E.sup(`select public.edition_refund_order('${o}', 1000)`);
    const j = JSON.parse(E.call('ADMIN', `select public.admin_request_edition_order_refund('${o}', null, 'refund the balance')`));
    assert.equal(j.amount_pence, 4000); assert.equal(j.full, true); assert.equal(j.remaining_after_pence, 0);
    assert.equal(E.q(`select public.edition_refund_order('${o}', 5000)`), 'voided');
    assert.equal(E.q(`select status from public.edition_orders where id='${o}'`), 'refunded');
    assert.equal(E.q(`select count(*) from public.edition_entitlements where order_id='${o}' and voided_at is null`), '0');
    assert.equal(anonPublic(ed), false); assert.equal(E.q(`select status from public.editions where id='${ed}'`), 'published', 'the Edition itself is untouched');
    assert.equal(E.q(`select status from public.edition_refund_requests where id='${j.request_id}'`), 'done');
    assert.equal(E.q(`select 'x' from public.edition_refund_order('${o}', 5000) as r where r = 'no_change'`), 'x', 'a repeat changes nothing');
  });
  test('temporary failures back off and retry; the sixth fails for good, raises an exception and an audit row, and the order is unchanged', () => {
    const { o } = paidOrder();
    const id = JSON.parse(E.call('ADMIN', `select public.admin_request_edition_order_refund('${o}', null, 'refund please')`)).request_id;
    E.sup(`select public.edition_refund_request_mark('${id}','retry','HTTP 503')`);
    assert.equal(E.q(`select attempts || '|' || (next_attempt_at > now() + interval '1 minute')::text from public.edition_refund_requests where id='${id}'`), '1|true');
    assert.equal(E.q(`select count(*) from public.edition_refunds_next() where request_id='${id}'`), '0', 'not due yet');
    for (let i = 0; i < 5; i++) E.sup(`select public.edition_refund_request_mark('${id}','retry','HTTP 503')`);
    assert.equal(E.q(`select status from public.edition_refund_requests where id='${id}'`), 'failed');
    assert.equal(E.q(`select count(*) from public.edition_reconciliation_exceptions where kind='refund_failed' and detail->>'order'='${o}'`), '1');
    assert.equal(E.q(`select count(*) from public.edition_audit_log where action='order_refund_failed' and detail->>'order'='${o}'`), '1');
    assert.equal(E.q(`select status from public.edition_orders where id='${o}'`), 'paid');
    // a new request is possible after a failed one
    assert.equal(JSON.parse(E.call('ADMIN', `select public.admin_request_edition_order_refund('${o}', null, 'try again')`)).already_requested, false);
  });
  test('the administrator can list the refunds of an order; nobody else can', () => {
    const { o } = paidOrder(); E.call('ADMIN', `select public.admin_request_edition_order_refund('${o}', 200, 'a small refund')`);
    assert.equal(E.one('ADMIN', `select count(*) from public.admin_edition_order_refunds('${o}')`), '1');
    assert.match(E.try('BIZ_OWNER', `select * from public.admin_edition_order_refunds('${o}')`), /admins only/);
  });
});

describe('safety', () => {
  test('refunding never changes review state, event moderation or Hub flags', () => {
    const snap = () => E.q(`select md5(coalesce((select string_agg(review_state || status, ',' order by id) from public.editions), '') || coalesce((select string_agg(is_verified::text || is_active::text, ',' order by id) from public.hubs), '') || (select count(*) from public.events)::text)`);
    const { o } = paidOrder(); const before = snap();
    E.call('ADMIN', `select public.admin_request_edition_order_refund('${o}', null, 'full refund now')`); E.sup(`select public.edition_refund_order('${o}', 5000)`);
    assert.equal(snap(), before);
  });
  test('the worker functions are not callable by people; the request functions are not callable signed out', () => {
    for (const who of ['BIZ_OWNER', 'ADMIN', 'anon'] as const) {
      assert.match(E.try(who, `select * from public.edition_refunds_next()`), /permission denied/, who);
      assert.match(E.try(who, `select public.edition_refund_request_mark(gen_random_uuid(),'done',null)`), /permission denied/, who);
      assert.match(E.try(who, `select public.edition_refund_order(gen_random_uuid(), 1)`), /permission denied/, who);
    }
    assert.match(E.try('anon', `select public.admin_request_edition_order_refund(gen_random_uuid(), null, 'a good reason')`), /permission denied/);
  });
  test('a request targets exactly one of a payment or an order', () => {
    assert.match(E.sup(`insert into public.edition_refund_requests (organiser_id, amount_pence, reason) values ('${BIZ_ORG}', 100, 'no target')`), /edition_refund_requests_one_target/);
  });
});
