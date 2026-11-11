/**
 * editions-hub-commerce.node.test.ts — ISOLATED Postgres only. Parity: a Hub-run and a Business-run organiser see and buy exactly the same packages at exactly the same prices (the Community
 * audience is retired and cannot be set); everything else (server pricing, one attempt = one order, fulfilment, entitlements, refunds, the payments switch) is the existing machinery.
 * Being a Hub, or linked to one, never grants anything free. Real Stripe stays off.
 * Run: ISOLATED_ONLY=editions-hub-commerce npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Env, USERS, seed, enter, draftEdition, last, failed as baseFailed, type Who as BaseWho } from './_support/editions-env.ts';
import { approveEdition } from './_support/editions-env-2.ts';

// PLAIN_OWNER is the Business owner: a Business-run organiser is the "not Hub-run" case
const U = { ADMIN: USERS.ADMIN, HUB_OWNER: USERS.HUB_OWNER, HUB_COMMITTEE: USERS.HUB_COMMITTEE, PLAIN_OWNER: USERS.BIZ_OWNER, STRANGER: USERS.STRANGER, HUB_MEMBER: USERS.HUB_MEMBER } as const;
type Who = keyof typeof U | 'anon' | 'service';
const failed = (o: string) => baseFailed(o) || /not available|for Hub-run|cost the same/i.test(o);
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
  PK_HUB = last(E.do('ADMIN', `select public.admin_upsert_edition_package('zz_second','ZZ Second package','d',2000,365,'[]',null,true,2)`));
  PK_HUB2 = last(E.do('ADMIN', `select public.admin_upsert_edition_package('zz_second_collect','ZZ Second + collect','d',3500,365,'["memberships","participation_fees","collect_payments"]',100,true,3)`));
});
after(() => Base?.drop());

describe('the catalogue: Community pricing is retired; Businesses and Hubs see the same rows at the same prices', () => {
  test('the five old rows (including both Community rows) are retired and inactive; the audience column is dormant (every new row is "any")', () => {
    assert.equal(E.q(`select string_agg(code || ':' || active::text || ':' || (retired_at is not null)::text, ',' order by code) from edition_packages where code like 'community_%'`), 'community_collect:false:true,community_publish:false:true');
    assert.equal(E.q(`select count(*) from edition_packages where code in ('publish_single','publish_collect','publish_full') and not active and retired_at is not null`), '3');
    assert.equal(E.q(`select count(*) from edition_packages where audience <> 'any'`), '2', 'only the two retired Community rows keep the old dormant value');
  });
  test('only administrators touch an audience, and no audience can make a package Hub-only any more', () => {
    for (const w of ['HUB_OWNER', 'HUB_COMMITTEE', 'PLAIN_OWNER', 'STRANGER', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.admin_set_edition_package_audience('zz_any','any')`)), w);
    assert.match(E.try('ADMIN', `select public.admin_set_edition_package_audience('zz_any','nobody')`), /audience must be/);
    assert.match(E.try('ADMIN', `select public.admin_set_edition_package_audience('zz_any','hub')`), /cost the same/);
    assert.match(E.try('ADMIN', `select public.admin_set_edition_package_audience('nope','any')`), /no such package/);
  });
  test('organisers read the identical catalogue through edition_available_packages, Hub-run or Business-run, with identical prices', () => {
    const cat = (w: Who, org: string) => E.one(w, `select string_agg(code || '@' || price_pence, ',' order by code) from public.edition_available_packages('${org}')`);
    assert.equal(cat('PLAIN_OWNER', ORG_PLAIN), 'zz_any@5000,zz_second@2000,zz_second_collect@3500');
    assert.equal(cat('HUB_OWNER', ORG_HUB), cat('PLAIN_OWNER', ORG_PLAIN));
    assert.equal(cat('HUB_COMMITTEE', ORG_HUB), cat('PLAIN_OWNER', ORG_PLAIN), 'the committee sees what the Hub may buy');
    for (const w of ['STRANGER', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select * from public.edition_available_packages('${ORG_HUB}')`)), w);
    assert.ok(failed(E.try('PLAIN_OWNER', `select * from public.edition_available_packages('${ORG_HUB}')`)), 'an unrelated organiser cannot browse another organiser\'s offers');
  });
  test('inactive and retired packages are never offered; a Hub going inactive changes no price (there is no Hub rate to lose)', () => {
    E.sup(`update edition_packages set active=false where code='zz_second_collect'`);
    assert.equal(E.one('HUB_OWNER', `select count(*) from public.edition_available_packages('${ORG_HUB}')`), '2'); E.sup(`update edition_packages set active=true where code='zz_second_collect'`);
    assert.equal(E.one('PLAIN_OWNER', `select count(*) from public.edition_available_packages('${ORG_PLAIN}') where code like 'community_%' or code like 'publish_%'`), '0');
  });
});

describe('ordering: one order path, the same for a Hub and a Business', () => {
  test('payments stay switched off: nobody can order anything while commerce is off, Hub or not', () => {
    assert.match(E.try('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB}','attempt-hub-0001')`), /not switched on/);
    assert.match(E.try('PLAIN_OWNER', `select public.edition_create_order('${ORG_PLAIN}','${ED_PLAIN}','${PK_ANY}','attempt-plain-001')`), /not switched on/);
    assert.equal(E.q(`select count(*) from edition_orders`), '0'); assert.equal(E.q(`select count(*) from edition_payments`), '0');
  });
  test('with commerce on (local only): a Hub owner AND committee (admins) and a Business owner order at the same server price; a stranger and a plain Hub member cannot', () => {
    E.sup(`update admin_config set value='true' where key='editions.commerce.enabled'`);
    const o = last(E.do('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB}','attempt-hub-0001')`));
    assert.equal(E.q(`select amount_pence || status from edition_orders where id='${o}'`), '2000pending');
    assert.equal(last(E.do('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB}','attempt-hub-0001')`)), o, 'one attempt = one order');
    const bz = last(E.do('PLAIN_OWNER', `select public.edition_create_order('${ORG_PLAIN}','${ED_PLAIN}','${PK_HUB}','attempt-plain-002')`));
    assert.equal(E.q(`select amount_pence from edition_orders where id='${bz}'`), '2000', 'a Business pays the same as a Hub');
    assert.ok(failed(E.try('STRANGER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB}','attempt-str-0001')`)));
    const c = last(E.do('HUB_COMMITTEE', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB}','attempt-comm-001')`));
    assert.equal(E.q(`select amount_pence from edition_orders where id='${c}'`), '2000', 'an owner or admin may buy');
    assert.match(E.try('HUB_MEMBER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB}','attempt-mem-0001')`), /only an owner or admin/);
    E.sup(`delete from edition_orders where attempt_id in ('attempt-comm-001','attempt-plain-002')`);
  });
  test('the first package sells to everyone, Hub-run or not, at its normal price', () => {
    assert.equal(E.q(`select amount_pence from edition_orders where id='${last(E.do('PLAIN_OWNER', `select public.edition_create_order('${ORG_PLAIN}','${ED_PLAIN}','${PK_ANY}','attempt-plain-003')`))}'`), '5000');
    assert.ok(last(E.do('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_ANY}','attempt-hub-0002')`)));
  });
  test('an unapproved Edition cannot have a package chosen, and a Hub that stops being active cannot order (the existing order keeps its snapshot)', () => {
    const o = E.q(`select id from edition_orders where attempt_id='attempt-hub-0001'`);
    const ED_NEW = draftEdition(Base, 'HUB_OWNER', ORG_HUB, 'zz-slippit-2028', 'ZZ Slippit 2028');
    assert.match(E.try('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_NEW}','${PK_HUB}','attempt-new-0001')`), /once OneShetland has approved/);
    E.sup(`update hubs set is_active=false where id='${HUB}'`);
    assert.ok(failed(E.try('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB}','attempt-gone-001')`)), 'an inactive Hub holds no authority');
    E.sup(`update hubs set is_active=true where id='${HUB}'`);
    assert.equal(E.q(`select (package_snapshot->>'price_pence') from edition_orders where id='${o}'`), '2000');
  });
  test('a free package is claimed, not paid for, and is the same for a Business-run and a Hub-run organiser', () => {
    const f = last(E.do('ADMIN', `select public.admin_upsert_edition_package('zz_free_pkg','ZZ free','d',0,365,'[]',null,true,4,true)`));
    assert.match(E.try('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${f}','attempt-free-hub1')`), /free: claim it/);
    assert.match(E.try('PLAIN_OWNER', `select public.edition_create_order('${ORG_PLAIN}','${ED_PLAIN}','${f}','attempt-free-biz1')`), /free: claim it/);
    E.sup(`update edition_packages set active=false where code='zz_free_pkg'`);
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
    assert.equal(E.q(`select public.edition_org_entitled('${ORG_HUB}', 'collect_payments')`), 'f', 'the publish-only package grants no payment features');
  });
  test('a package with payment features grants exactly what it lists, with its member cap', () => {
    E.sup(`insert into admin_config (key, value, category) values ('editions.commerce.renewal_window_days','800','editions') on conflict (key) do update set value='800'`); // a renewal, so a second package may queue
    const o = last(E.do('HUB_OWNER', `select public.edition_create_order('${ORG_HUB}','${ED_HUB}','${PK_HUB2}','attempt-hub-0003')`));
    assert.equal(E.q(`select amount_pence from edition_orders where id='${o}'`), '3500');
    E.do('service', `select public.edition_fulfil_order('${o}','pi_hub_2',3500)`);
    assert.equal(E.q(`select public.edition_org_entitled('${ORG_HUB}', 'collect_payments')`), 't'); assert.equal(E.q(`select public.edition_org_limit('${ORG_HUB}', 'memberships')`), '100');
    assert.equal(E.q(`select public.edition_org_entitled('${ORG_HUB}', 'csv_export')`), 'f');
    E.sup(`delete from admin_config where key='editions.commerce.renewal_window_days'`);
  });
  test('the ledger and entitlements stay append-only and money-in functions stay closed to people', () => {
    assert.match(E.sup(`delete from edition_organiser_entitlements where organiser_id='${ORG_HUB}'`), /cannot be deleted/);
    assert.equal(E.q(`select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('edition_fulfil_order','edition_refund_order') and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))`), '0');
  });
  test('no payment function, table or Stripe path was added: the catalogue functions are the only ones involved', () => {
    assert.equal(E.q(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('edition_org_is_hub_run','edition_available_packages','admin_set_edition_package_audience')`), '3');
    assert.equal(E.q(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'edition%' and proname ilike '%stripe%' and proname in ('edition_hub_stripe')`), '0');
  });
});
