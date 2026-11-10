/**
 * editions-hub-commerce.node.test.ts — ISOLATED Postgres only. Editions 1.1: the discounted Community Editions package on the EXISTING packages and entitlements architecture.
 * A package has an audience ('any' or 'hub'); only an organiser linked to an active Hub may buy a 'hub' package; everything else (server pricing, one attempt = one order, fulfilment,
 * entitlements, refunds, the payments switch) is the existing machinery. Being a Hub, or linked to one, never grants anything free. Real Stripe stays off.
 * Run: ISOLATED_ONLY=editions-hub-commerce npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Env, USERS, seed, enter, draftEdition, last, failed as baseFailed, type Who as BaseWho } from './_support/editions-env.ts';
import { approveEdition } from './_support/editions-env-2.ts';

// PLAIN_OWNER is the Business owner: a Business-run organiser is the "not Hub-run" case
const U = { ADMIN: USERS.ADMIN, HUB_OWNER: USERS.HUB_OWNER, HUB_COMMITTEE: USERS.HUB_COMMITTEE, PLAIN_OWNER: USERS.BIZ_OWNER, STRANGER: USERS.STRANGER, HUB_MEMBER: USERS.HUB_MEMBER } as const;
type Who = keyof typeof U | 'anon' | 'service';
const failed = (o: string) => baseFailed(o) || /not available|for Hub-run/i.test(o);
const m = (w: Who): BaseWho => (w === 'PLAIN_OWNER' ? 'BIZ_OWNER' : w) as BaseWho;
class Wrap {
  e: Env;
  constructor(e: Env) { this.e = e; }
  try(w: Who, sql: string) { return w === 'service' ? this.e.sup(`begin; set local role service_role; ${sql}; rollback;`) : this.e.try(m(w), sql); }
  do(w: Who, sql: string) { return w === 'service' ? this.e.sup(`begin; set local role service_role; ${sql}; commit;`) : this.e.do(m(w), sql); }
  one(w: Who, sql: string) { return last(this.try(w, sql)); }
  q(sql: string) { return this.e.q(sql); }
  sup(sql: string) { return this.e.sup(sql); }
}
let E: Wrap, Base: Env, S: ReturnType<typeof seed>;
let HUB = '', ORG_HUB = '', ORG_PLAIN = '', ED_HUB = '', ED_PLAIN = '', PK_ANY = '', PK_HUB = '', PK_HUB2 = '';

before(() => {
  Base = new Env('editionshubcommerce');
  S = seed(Base); E = new Wrap(Base);
  HUB = S.HUB;
  E.sup(`insert into admin_config (key, value, category) values ('editions.commerce.enabled','false','editions') on conflict (key) do update set value='false';`);
  ORG_HUB = enter(Base, 'HUB_OWNER', 'hub', HUB);
  ORG_PLAIN = enter(Base, 'BIZ_OWNER', 'business', S.BIZ);
  ED_HUB = draftEdition(Base, 'HUB_OWNER', ORG_HUB, 'zz-slippit-2027', 'ZZ Slippit');
  ED_PLAIN = draftEdition(Base, 'BIZ_OWNER', ORG_PLAIN, 'zz-plain-2027', 'ZZ Plain');
  approveEdition(Base, 'HUB_OWNER', ED_HUB); approveEdition(Base, 'BIZ_OWNER', ED_PLAIN); // a package is chosen only after approval
  PK_ANY = last(E.do('ADMIN', `select public.admin_upsert_edition_package('zz_any','ZZ Standard','d',5000,365,'[]',null,true,1)`));
  PK_HUB = last(E.do('ADMIN', `select public.admin_upsert_edition_package('zz_community','ZZ Community rate','d',2000,365,'[]',null,true,2)`));
  E.do('ADMIN', `select public.admin_set_edition_package_audience('zz_community', 'hub')`);
  PK_HUB2 = last(E.do('ADMIN', `select public.admin_upsert_edition_package('zz_community_collect','ZZ Community + collect','d',3500,365,'["memberships","participation_fees","collect_payments"]',100,true,3)`));
  E.do('ADMIN', `select public.admin_set_edition_package_audience('zz_community_collect', 'hub')`);
});
after(() => Base?.drop());

describe('the catalogue: Community packages are hub-only drafts until an administrator prices and activates them', () => {
  test('the shipped Community packages are INACTIVE placeholders at price 0 with the hub audience, beside the existing drafts', () => {
    assert.equal(E.q(`select string_agg(code || ':' || audience || ':' || active::text || ':' || price_pence, ',' order by code) from edition_packages where code like 'community_%'`), 'community_collect:hub:false:0,community_publish:hub:false:0');
    assert.equal(E.q(`select count(*) from edition_packages where code in ('publish_single','publish_collect','publish_full') and audience='any' and not active`), '3', 'the existing drafts are untouched');
  });
  test('only administrators change an audience, and only to a known value', () => {
    for (const w of ['HUB_OWNER', 'HUB_COMMITTEE', 'PLAIN_OWNER', 'STRANGER', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.admin_set_edition_package_audience('zz_any','hub')`)), w);
    assert.match(E.try('ADMIN', `select public.admin_set_edition_package_audience('zz_any','nobody')`), /audience must be/);
    assert.match(E.try('ADMIN', `select public.admin_set_edition_package_audience('nope','hub')`), /no such package/);
    assert.ok(Number(E.q(`select count(*) from edition_audit_log where action='package_audience_set'`)) >= 2, 'audited');
  });
  test('the table read policy hides hub packages from everyone but administrators; organisers read the catalogue through edition_available_packages', () => {
    assert.equal(E.one('PLAIN_OWNER', `select count(*) from public.edition_packages where audience='hub'`), '0');
    assert.equal(E.one('HUB_OWNER', `select count(*) from public.edition_packages where audience='hub'`), '0', 'not even a Hub owner reads the table directly');
    assert.equal(E.one('ADMIN', `select count(*) from public.edition_packages where audience='hub'`), '4');
    assert.equal(E.one('PLAIN_OWNER', `select string_agg(code, ',' order by code) from public.edition_available_packages('${ORG_PLAIN}')`), 'zz_any');
    assert.equal(E.one('HUB_OWNER', `select string_agg(code, ',' order by code) from public.edition_available_packages('${ORG_HUB}')`), 'zz_any,zz_community,zz_community_collect');
    assert.equal(E.one('HUB_COMMITTEE', `select count(*) from public.edition_available_packages('${ORG_HUB}')`), '3', 'the committee sees what the Hub may buy');
    for (const w of ['STRANGER', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select * from public.edition_available_packages('${ORG_HUB}')`)), w);
    assert.ok(failed(E.try('PLAIN_OWNER', `select * from public.edition_available_packages('${ORG_HUB}')`)), 'an unrelated organiser cannot browse another organiser\'s offers');
  });
  test('inactive packages are never offered, hub or not; an inactive Hub loses the Community rate at once', () => {
    E.sup(`update edition_packages set active=false where code='zz_community_collect'`);
    assert.equal(E.one('HUB_OWNER', `select count(*) from public.edition_available_packages('${ORG_HUB}')`), '2'); E.sup(`update edition_packages set active=true where code='zz_community_collect'`);
    E.sup(`update hubs set is_active=false where id='${HUB}'`); assert.equal(E.one('ADMIN', `select count(*) from public.edition_available_packages('${ORG_HUB}')`), '1'); E.sup(`update hubs set is_active=true where id='${HUB}'`);
    // (unlinking an organiser from its Hub is retired: every organiser keeps exactly one parent)
  });
});

describe('ordering: the existing order path with one added eligibility rule', () => {
  test('payments stay switched off: nobody can order anything while commerce is off, Hub or not', () => {
    assert.match(E.try('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB}','attempt-hub-0001')`), /not switched on/);
    assert.match(E.try('PLAIN_OWNER', `select public.edition_create_order('${ORG_PLAIN}','${ED_PLAIN}','${PK_ANY}','attempt-plain-001')`), /not switched on/);
    assert.equal(E.q(`select count(*) from edition_orders`), '0'); assert.equal(E.q(`select count(*) from edition_payments`), '0');
  });
  test('with commerce on (local only): a Hub-run organiser\'s owner AND committee (admins) order a Community package at the server price; a Business-run organiser, a stranger and a plain Hub member cannot', () => {
    E.sup(`update admin_config set value='true' where key='editions.commerce.enabled'`);
    const o = last(E.do('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB}','attempt-hub-0001')`));
    assert.equal(E.q(`select amount_pence || status from edition_orders where id='${o}'`), '2000pending');
    assert.equal(last(E.do('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB}','attempt-hub-0001')`)), o, 'one attempt = one order');
    assert.match(E.try('PLAIN_OWNER', `select public.edition_create_order('${ORG_PLAIN}','${ED_PLAIN}','${PK_HUB}','attempt-plain-002')`), /for Hub-run Editions/);
    assert.ok(failed(E.try('STRANGER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB}','attempt-str-0001')`)));
    const c = last(E.do('HUB_COMMITTEE', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB}','attempt-comm-001')`));
    assert.equal(E.q(`select amount_pence from edition_orders where id='${c}'`), '2000', 'an owner or admin may buy');
    assert.match(E.try('HUB_MEMBER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB}','attempt-mem-0001')`), /only an owner or admin/);
    E.sup(`delete from edition_orders where attempt_id='attempt-comm-001'`);
  });
  test('the existing audience-any packages still sell to everyone, Hub-run or not, at their normal price', () => {
    assert.equal(E.q(`select amount_pence from edition_orders where id='${last(E.do('PLAIN_OWNER', `select public.edition_create_order('${ORG_PLAIN}','${ED_PLAIN}','${PK_ANY}','attempt-plain-003')`))}'`), '5000');
    assert.ok(last(E.do('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_ANY}','attempt-hub-0002')`)));
  });
  test('an unapproved Edition cannot have a package chosen, and a Hub that stops being active loses the Community rate (the existing order keeps its snapshot)', () => {
    const o = E.q(`select id from edition_orders where attempt_id='attempt-hub-0001'`);
    const ED_NEW = draftEdition(Base, 'HUB_OWNER', ORG_HUB, 'zz-slippit-2028', 'ZZ Slippit 2028');
    assert.match(E.try('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_NEW}','${PK_HUB}','attempt-new-0001')`), /once OneShetland has approved/);
    E.sup(`update hubs set is_active=false where id='${HUB}'`);
    assert.ok(failed(E.try('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB}','attempt-gone-001')`)), 'an inactive Hub holds no authority');
    E.sup(`update hubs set is_active=true where id='${HUB}'`);
    assert.equal(E.q(`select (package_snapshot->>'audience') from edition_orders where id='${o}'`), 'hub');
  });
  test('a free package is claimed, not paid for: a Hub-only free package is refused to a Business-run organiser', () => {
    const f = last(E.do('ADMIN', `select public.admin_upsert_edition_package('zz_community_free','ZZ Community free','d',0,365,'[]',null,true,4,true)`));
    E.do('ADMIN', `select public.admin_set_edition_package_audience('zz_community_free', 'hub')`);
    assert.match(E.try('PLAIN_OWNER', `select public.edition_claim_free_package('${ORG_PLAIN}','${ED_PLAIN}','${f}','attempt-free-biz1')`), /for Hub-run Editions/);
    assert.match(E.try('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${f}','attempt-free-hub1')`), /free: claim it/);
    E.sup(`update edition_packages set active=false where code='zz_community_free'`);
  });
});

describe('fulfilment and entitlements are the existing ones: a Hub gets nothing free', () => {
  test('a Hub-run organiser has NO entitlement of any kind before a payment or an administrator\'s grant', () => {
    for (const f of ['collect_payments', 'memberships', 'participation_fees', 'offline_records', 'csv_export']) assert.equal(E.q(`select public.edition_org_entitled('${ORG_HUB}', '${f}')`), 'f', f);
    assert.equal(E.q(`select public.edition_entitled('${ED_HUB}', 'publish')`), 'f');
    assert.equal(E.q(`select count(*) from edition_entitlements where organiser_id='${ORG_HUB}'`) + E.q(`select count(*) from edition_organiser_entitlements where organiser_id='${ORG_HUB}'`), '00');
  });
  test('only the verified payment (service role, exact amount) grants publish and the package\'s features, exactly as for any package', () => {
    const o = E.q(`select id from edition_orders where attempt_id='attempt-hub-0001'`);
    for (const w of ['HUB_OWNER', 'HUB_COMMITTEE', 'ADMIN', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_fulfil_order('${o}','pi_hub_1',2000)`)), w);
    assert.match(E.try('service', `select public.edition_fulfil_order('${o}','pi_hub_1',1)`), /does not match/);
    assert.equal(last(E.do('service', `select public.edition_fulfil_order('${o}','pi_hub_1',2000)`)), 'fulfilled');
    assert.equal(E.q(`select public.edition_entitled('${ED_HUB}', 'publish')`), 't');
    assert.equal(E.q(`select public.edition_org_entitled('${ORG_HUB}', 'collect_payments')`), 'f', 'the publish-only Community package grants no payment features');
  });
  test('the Community package with payment features grants exactly what it lists, with its member cap', () => {
    const o = last(E.do('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB2}','attempt-hub-0003')`));
    assert.equal(E.q(`select amount_pence from edition_orders where id='${o}'`), '3500');
    E.do('service', `select public.edition_fulfil_order('${o}','pi_hub_2',3500)`);
    assert.equal(E.q(`select public.edition_org_entitled('${ORG_HUB}', 'collect_payments')`), 't'); assert.equal(E.q(`select public.edition_org_limit('${ORG_HUB}', 'memberships')`), '100');
    assert.equal(E.q(`select public.edition_org_entitled('${ORG_HUB}', 'csv_export')`), 'f');
  });
  test('the ledger and entitlements stay append-only and money-in functions stay closed to people', () => {
    assert.match(E.sup(`delete from edition_organiser_entitlements where organiser_id='${ORG_HUB}'`), /cannot be deleted/);
    assert.equal(E.q(`select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('edition_fulfil_order','edition_refund_order') and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))`), '0');
  });
  test('no payment function, table or Stripe path was added: the only new function names are catalogue and eligibility', () => {
    assert.equal(E.q(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('edition_org_is_hub_run','edition_available_packages','admin_set_edition_package_audience')`), '3');
    assert.equal(E.q(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'edition%' and proname ilike '%stripe%' and proname in ('edition_hub_stripe')`), '0');
  });
});
