/**
 * editions-promotions.node.test.ts — ISOLATED Postgres only. The Launch / Showcase rate card, promotion rights, booking rules (window, capacity, fairness, grouping, races), cancel and
 * reschedule rules, refund effects, featuring and the public rule, tracking and the report, admin tools, and the attack surface. Real Stripe stays off; fulfilment is called as the webhook would.
 * Run: ISOLATED_ONLY=editions-promotions npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Env, USERS, seed, enter, draftEdition, last } from './_support/editions-env.ts';
import { approveEdition } from './_support/editions-env-2.ts';

let E: Env;
let S: ReturnType<typeof seed>;
let O = { BIZ: '', BIZ2: '', HUB: '', HUB2: '' };
let ED = { BIZ: '', BIZ_B: '', BIZ2: '', HUB: '', HUB2: '' };

let TODAY = '';
const T = (n: number) => `('${TODAY}'::date + ${n})`;
const UUID = /^[0-9a-f-]{36}$/;
const bad = (o: string) => /ERROR/.test(o);
const hint = (o: string) => o.match(/HINT:\s+(\S+)/)?.[1] ?? '';
const cfg = (k: string, v: string | null) => E.sup(v === null ? `delete from admin_config where key='${k}'` : `insert into admin_config (key, value, category) values ('${k}','${v}','editions') on conflict (key) do update set value='${v}'`);
const reset = () => {
  E.sup(`truncate public.edition_promo_bookings, public.edition_promo_rights, public.edition_promo_daily, public.edition_promo_track_rate`);
  E.sup(`delete from admin_config where key like 'editions.promo.%'`);
  E.sup(`update public.editions set status='published', review_state='approved' where id in ('${Object.values(ED).join("','")}')`);
};
let slugN = 0;
/** an approved, entitled, published Edition for an organiser (a real owner path); `days` is the publishing period */
function live(who: 'BIZ_OWNER' | 'BIZ2_OWNER' | 'HUB_OWNER' | 'HUB2_OWNER', org: string, days = 365) {
  const ed = draftEdition(E, who, org, `zz-promo-${++slugN}`, `ZZ Promo ${slugN}`);
  E.do(who, `select public.edition_submit_for_review('${ed}')`);
  E.do('ADMIN', `select public.admin_review_edition('${ed}','approve','ZZ TEST approved')`);
  E.do('ADMIN', `select public.admin_grant_edition_entitlement('${ed}','publish', now(), now() + interval '${days} days', 'ZZ TEST grant for the suite')`);
  E.do(who, `select public.edition_set_status('${ed}','published')`);
  assert.equal(E.q(`select status from public.editions where id='${ed}'`), 'published');
  return ed;
}
const grant = (ed: string, kind: 'discovery' | 'homepage', days: number) => last(E.do('ADMIN', `select public.admin_grant_promo_right('${ed}','${kind}',${days},'ZZ TEST goodwill grant')`));
const bookOut = (who: keyof typeof USERS | 'anon', right: string, n: number) => E.do(who, `select public.edition_promo_book('${right}', ${T(n)})`);
const book = (who: keyof typeof USERS, right: string, n: number) => { const id = last(bookOut(who, right, n)); assert.match(id, UUID, `booking failed: ${bookOut(who, right, n).slice(0, 300)}`); return id; };
const adminMove = (booking: string, n: number) => E.do('ADMIN', `select public.admin_promo_reschedule('${booking}', ${T(n)}, 'ZZ TEST move for the suite')`);
/** a booking that covers today: the owner books ahead, then an administrator moves it to today (owners cannot start inside the lead time) */
function liveToday(who: keyof typeof USERS, ed: string, kind: 'discovery' | 'homepage', days: number) {
  const b = book(who, grant(ed, kind, days), 3);
  const out = adminMove(b, 0); assert.ok(!bad(out), out.slice(0, 300));
  return b;
}
const active = (code: string, on = true) => E.sup(`update public.edition_packages set active=${on} where code='${code}'`);
const pkgId = (code: string) => E.q(`select id from public.edition_packages where code='${code}'`);
let attempt = 0;
const order = (who: keyof typeof USERS, org: string, ed: string, code: string) => last(E.do(who, `select public.edition_create_order('${org}','${ed}','${pkgId(code)}','attempt-promo-${++attempt}-xyz')`));
const fulfil = (o: string, amount: number) => E.sup(`select public.edition_fulfil_order('${o}','pi_promo_${o.slice(0, 8)}',${amount})`);
const count = (sql: string) => Number(E.q(`select count(*) from ${sql}`));
const rightsOf = (ed: string) => E.q(`select coalesce(string_agg(kind || ':' || days || ':' || (group_id is not null)::text, ',' order by kind), '') from public.edition_promo_rights where edition_id='${ed}'`);
const featured = (kind: string, who: 'anon' | keyof typeof USERS = 'anon') => last(E.do(who, `select coalesce(string_agg(slug, ',' order by ord), '') from public.edition_featured('${kind}') with ordinality as f(edition_id, slug, title, kind, starts_on, ends_on, summary, cover_url, organiser_name, parent_kind, parent_slug, ord)`));
const slugOf = (ed: string) => E.q(`select slug from public.editions where id='${ed}'`);

before(() => {
  E = new Env('editionspromotions');
  S = seed(E);
  TODAY = E.q(`select public.edition_promo_today()`);
  O.BIZ = enter(E, 'BIZ_OWNER', 'business', S.BIZ);
  O.BIZ2 = enter(E, 'BIZ2_OWNER', 'business', S.BIZ2);
  O.HUB = enter(E, 'HUB_OWNER', 'hub', S.HUB);
  O.HUB2 = enter(E, 'HUB2_OWNER', 'hub', S.HUB2);
  E.sup(`insert into admin_config (key, value, category) values ('editions.commerce.enabled','true','editions') on conflict (key) do update set value='true'`);
  ED.BIZ = live('BIZ_OWNER', O.BIZ); ED.BIZ_B = live('BIZ_OWNER', O.BIZ); ED.BIZ2 = live('BIZ2_OWNER', O.BIZ2);
  ED.HUB = live('HUB_OWNER', O.HUB); ED.HUB2 = live('HUB2_OWNER', O.HUB2);
  E.sup(`insert into public.edition_organiser_members (organiser_id, user_id, role) values ('${O.BIZ}','${USERS.HELPER}','editor') on conflict do nothing`);
});
after(() => E?.drop());

/* ── catalogue ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('catalogue: the rate card, retirement, parity', () => {
  test('the six rate-card rows have the contract codes, kinds, names and pence, and are INACTIVE', () => {
    assert.equal(E.q(`select string_agg(code || '|' || kind || '|' || name || '|' || price_pence || '|' || active::text, ';' order by sort) from public.edition_packages where retired_at is null and code in ('launch','showcase','promo_discovery_2w','promo_discovery_6w','promo_homepage_7d','promo_campaign_full')`),
      'launch|package|Launch|24900|false;showcase|package|Showcase|49900|false;promo_discovery_2w|promotion|Two weeks of enhanced discovery|7900|false;promo_discovery_6w|promotion|Six weeks of enhanced discovery|17900|false;promo_homepage_7d|promotion|Seven more days on the homepage|14900|false;promo_campaign_full|promotion|Complete additional campaign|24900|false');
    assert.equal(count(`public.edition_packages where active`), 0, 'nothing is on sale');
    assert.equal(E.q(`select string_agg(code || ':' || grants::text, ';' order by sort) from public.edition_packages where code in ('launch','showcase','promo_discovery_2w','promo_discovery_6w','promo_homepage_7d','promo_campaign_full')`),
      'launch:{};showcase:{"grouped": true, "homepage_days": 7, "discovery_days": 42};promo_discovery_2w:{"discovery_days": 14};promo_discovery_6w:{"discovery_days": 42};promo_homepage_7d:{"homepage_days": 7};promo_campaign_full:{"grouped": true, "homepage_days": 7, "discovery_days": 42}');
    assert.equal(E.q(`select count(*) from public.edition_packages where code in ('launch','showcase','promo_discovery_2w','promo_discovery_6w','promo_homepage_7d','promo_campaign_full') and audience='any'`), '6');
  });
  test('Launch and Showcase carry all five features, no member cap and 365 days; they differ ONLY in the campaign grant', () => {
    const row = (c: string) => E.q(`select features::text || '|' || coalesce(max_members::text,'null') || '|' || duration_days from public.edition_packages where code='${c}'`);
    assert.equal(row('launch'), row('showcase'));
    assert.equal(row('launch'), '["collect_payments", "memberships", "participation_fees", "offline_records", "csv_export"]|null|365');
    assert.equal(E.q(`select count(*) from public.edition_packages where kind='promotion' and (features <> '[]'::jsonb or max_members is not null or duration_days is not null)`), '0');
  });
  test('the five old rows are retired (inactive, stamped, still present) and the admin form cannot reactivate or edit them; a direct update cannot either', () => {
    for (const c of ['publish_single', 'publish_collect', 'publish_full', 'community_publish', 'community_collect']) {
      assert.equal(E.q(`select (not active and retired_at is not null)::text from public.edition_packages where code='${c}'`), 'true', c);
      const out = E.try('ADMIN', `select public.admin_upsert_edition_package('${c}','x','x',100,365,'[]'::jsonb,null,true,1)`);
      assert.equal(hint(out), 'retired_package', c);
    }
    assert.match(E.sup(`update public.edition_packages set active=true, price_pence=100 where code='publish_single'`), /edition_packages_retired_inactive/);
    assert.equal(count(`public.edition_packages where code in ('publish_single','publish_collect','publish_full','community_publish','community_collect')`), 5, 'never deleted');
  });
  test('catalogue admin: validation of kind, grants and days; kind cannot change; Launch and Showcase cannot lose a feature or gain a cap', () => {
    const up = (args: string) => E.try('ADMIN', `select public.admin_upsert_edition_package(${args})`);
    assert.equal(hint(up(`'zz_p1','P','d',500,30,'[]'::jsonb,null,false,1,false,'promotion','{"discovery_days":14}'::jsonb`)), 'promotion_days');
    assert.equal(hint(up(`'zz_p2','P','d',500,null,'[]'::jsonb,null,false,1,false,'promotion','{}'::jsonb`)), 'promotion_empty');
    assert.equal(hint(up(`'zz_p3','P','d',500,null,'["csv_export"]'::jsonb,null,false,1,false,'promotion','{"discovery_days":14}'::jsonb`)), 'promotion_features');
    assert.equal(hint(up(`'zz_p4','P','d',500,null,'[]'::jsonb,null,false,1,false,'promotion','{"discovery_days":"x"}'::jsonb`)), 'bad_grants');
    assert.equal(hint(up(`'zz_p5','P','d',500,null,'[]'::jsonb,null,false,1,false,'promotion','{"discovery_days":14,"grouped":true}'::jsonb`)), 'bad_grants', 'grouped needs both kinds');
    assert.equal(hint(up(`'zz_p6','P','d',500,null,'[]'::jsonb,null,false,1,false,'promotion','{"discovery_days":14,"evil":1}'::jsonb`)), 'bad_grants');
    assert.equal(hint(up(`'zz_p7','P','d',500,null,'[]'::jsonb,null,false,1,false,'thing','{"discovery_days":14}'::jsonb`)), 'bad_kind');
    assert.equal(hint(up(`'zz_k1','K','d',500,null,'[]'::jsonb,null,false,1`)), 'package_days');
    assert.equal(hint(up(`'launch','Launch','d',24900,365,'[]'::jsonb,null,false,10`)), 'no_restrictions');
    assert.equal(hint(up(`'showcase','Showcase','d',49900,365,'["collect_payments","memberships","participation_fees","offline_records","csv_export"]'::jsonb,50,false,20,false,'package','{}'::jsonb`)), 'no_restrictions');
    assert.equal(hint(up(`'launch','Launch','d',24900,365,'["collect_payments","memberships","participation_fees","offline_records","csv_export"]'::jsonb,null,false,10,false,'promotion','{"discovery_days":3}'::jsonb`)), 'promotion_days');
    const ok = last(E.do('ADMIN', `select public.admin_upsert_edition_package('zz_promo_ok','ZZ promo','d',500,null,'[]'::jsonb,null,false,90,false,'promotion','{"homepage_days":3}'::jsonb)`));
    assert.match(ok, UUID);
    assert.equal(hint(up(`'zz_promo_ok','ZZ promo','d',500,365,'[]'::jsonb,null,false,90,false,'package','{}'::jsonb`)), 'kind_change');
    assert.equal(E.q(`select count(*) from public.edition_audit_log where action='package_upserted' and detail->>'code'='zz_promo_ok'`), '1', 'audited');
    for (const who of ['BIZ_OWNER', 'HUB_OWNER', 'STRANGER', 'anon'] as const) assert.match(E.try(who, `select public.admin_upsert_edition_package('zz_x','x','x',100,365,'[]'::jsonb,null,false,1)`), /admins only|permission denied/, who);
  });
  test('parity: a Business-run and a Hub-run organiser see the identical rows and prices; nobody can make a package Hub-only', () => {
    for (const c of ['launch', 'showcase', 'promo_discovery_2w', 'promo_discovery_6w', 'promo_homepage_7d', 'promo_campaign_full']) active(c);
    const cat = (who: keyof typeof USERS, org: string) => E.one(who, `select string_agg(code || '@' || price_pence || '@' || kind || '@' || grants::text || '@' || features::text, ';' order by sort, code) from public.edition_available_packages('${org}')`);
    const biz = cat('BIZ_OWNER', O.BIZ); assert.match(biz, /launch@24900@package/); assert.match(biz, /promo_campaign_full@24900@promotion/);
    assert.equal(cat('HUB_OWNER', O.HUB), biz); assert.equal(cat('BIZ2_OWNER', O.BIZ2), biz); assert.equal(cat('HUB2_OWNER', O.HUB2), biz);
    assert.equal(E.one('BIZ_OWNER', `select count(*) from public.edition_packages where active`), E.one('HUB_OWNER', `select count(*) from public.edition_packages where active`));
    assert.match(E.try('ADMIN', `select public.admin_set_edition_package_audience('launch','hub')`), /cost the same/);
    assert.match(E.try('STRANGER', `select * from public.edition_available_packages('${O.BIZ}')`), /not permitted/);
    for (const c of ['launch', 'showcase', 'promo_discovery_2w', 'promo_discovery_6w', 'promo_homepage_7d', 'promo_campaign_full']) active(c, false);
  });
  test('configuration keys: the validator accepts the new keys within bounds, refuses everything else, and is administrator-only', () => {
    const set = (k: string, v: string, who: keyof typeof USERS = 'ADMIN') => E.do(who, `select public.admin_set_edition_commerce_config('${k}','${v}')`);
    for (const [k, v] of [['editions.promo.homepage_capacity', '3'], ['editions.promo.discovery_capacity', '6'], ['editions.promo.homepage_visible', '3'], ['editions.promo.discovery_visible', '4'], ['editions.promo.lead_days', '2'],
      ['editions.promo.horizon_days', '180'], ['editions.promo.homepage_days_per_90', '14'], ['editions.promo.reschedule_notice_days', '3'], ['editions.commerce.vat_note', ''], ['editions.commerce.vat_note', 'Prices are shown as charged.'],
      ['editions.app.handoff_ios', 'off'], ['editions.app.handoff_android', 'on']]) assert.ok(!bad(set(k, v)), `${k}=${v}`);
    for (const [k, v] of [['editions.promo.homepage_capacity', '0'], ['editions.promo.homepage_capacity', '51'], ['editions.promo.homepage_capacity', 'x'], ['editions.promo.discovery_visible', '13'], ['editions.promo.lead_days', '31'],
      ['editions.promo.horizon_days', '0'], ['editions.promo.horizon_days', '731'], ['editions.promo.homepage_days_per_90', '91'], ['editions.promo.reschedule_notice_days', '61'], ['editions.commerce.vat_note', '<b>VAT</b>'],
      ['editions.commerce.vat_note', 'x'.repeat(301)], ['editions.app.handoff_ios', 'maybe'], ['editions.promo.nope', '1'], ['editions.enabled', 'true']]) assert.match(set(k, v), /not allowed/, `${k}=${v}`);
    for (const who of ['BIZ_OWNER', 'STRANGER', 'anon'] as const) assert.match(set('editions.promo.lead_days', '2', who), /admins only|permission denied/, who);
    assert.equal(E.one('BIZ_OWNER', `select (public.edition_promo_settings() ->> 'homepage_capacity')`), '3', 'defaults apply');
    assert.equal(E.q(`select (select value from admin_config where key='editions.commerce.vat_note')`), 'Prices are shown as charged.');
    assert.match(E.try('anon', `select public.edition_promo_settings()`), /permission denied/);
    reset();
  });
});

/* ── orders and fulfilment ─────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('orders and fulfilment create the right rights', () => {
  before(() => { for (const c of ['launch', 'showcase', 'promo_discovery_2w', 'promo_discovery_6w', 'promo_homepage_7d', 'promo_campaign_full']) active(c); });
  const approved = (slug: string) => { const ed = draftEdition(E, 'BIZ_OWNER', O.BIZ, slug, `ZZ ${slug}`); approveEdition(E, 'BIZ_OWNER', ed); return ed; };
  test('Launch: publish entitlement of 365 days, all five features with no cap, and NO promotion rights', () => {
    const ed = approved('zz-ord-launch'); const o = order('BIZ_OWNER', O.BIZ, ed, 'launch');
    assert.equal(E.q(`select amount_pence from public.edition_orders where id='${o}'`), '24900');
    assert.equal(fulfil(o, 24900).trim(), 'fulfilled');
    assert.equal(E.q(`select round(extract(epoch from (ends_at - starts_at)) / 86400) from public.edition_entitlements where order_id='${o}' and feature='publish'`), '365');
    assert.equal(E.q(`select string_agg(feature || ':' || coalesce(max_value::text,'null'), ',' order by feature) from public.edition_organiser_entitlements where order_id='${o}'`), 'collect_payments:null,csv_export:null,memberships:null,offline_records:null,participation_fees:null');
    assert.equal(rightsOf(ed), '');
    assert.equal(fulfil(o, 24900).trim(), 'already_fulfilled'); assert.equal(rightsOf(ed), '');
  });
  test('Showcase: the same publish and features as Launch plus one GROUPED campaign (42 discovery + 7 homepage days)', () => {
    const ed = approved('zz-ord-showcase'); const o = order('BIZ_OWNER', O.BIZ, ed, 'showcase');
    assert.equal(E.q(`select amount_pence from public.edition_orders where id='${o}'`), '49900');
    assert.match(fulfil(o, 49900), /fulfilled/);
    assert.equal(E.q(`select count(*) from public.edition_entitlements where order_id='${o}' and feature='publish'`), '1');
    assert.equal(E.q(`select string_agg(feature || ':' || coalesce(max_value::text,'null'), ',' order by feature) from public.edition_organiser_entitlements where order_id='${o}'`), 'collect_payments:null,csv_export:null,memberships:null,offline_records:null,participation_fees:null');
    assert.equal(rightsOf(ed), 'discovery:42:true,homepage:7:true');
    assert.equal(E.q(`select count(distinct group_id) from public.edition_promo_rights where edition_id='${ed}'`), '1', 'one shared group');
    assert.match(fulfil(o, 49900), /already_fulfilled/); assert.equal(rightsOf(ed), 'discovery:42:true,homepage:7:true', 'no duplicate rights on a repeat');
    assert.match(E.sup(`select public.edition_fulfil_order('${o}','pi_x',1)`), /already_fulfilled/);
  });
  test('a wrong amount never fulfils; a pending promotion order creates nothing', () => {
    const ed = approved('zz-ord-amount'); const o = order('BIZ_OWNER', O.BIZ, ed, 'showcase');
    assert.match(fulfil(o, 100), /does not match/); assert.equal(rightsOf(ed), ''); assert.equal(E.q(`select status from public.edition_orders where id='${o}'`), 'pending');
  });
  test('promotions: refused for an unapproved Edition or one without a live publishing period; helpers and strangers cannot buy', () => {
    const unapproved = draftEdition(E, 'BIZ_OWNER', O.BIZ, 'zz-ord-unapp', 'ZZ unapproved');
    assert.match(E.try('BIZ_OWNER', `select public.edition_create_order('${O.BIZ}','${unapproved}','${pkgId('promo_discovery_2w')}','attempt-un-0001')`), /once OneShetland has approved/);
    const noEnt = approved('zz-ord-noent');
    assert.equal(hint(E.try('BIZ_OWNER', `select public.edition_create_order('${O.BIZ}','${noEnt}','${pkgId('promo_discovery_2w')}','attempt-ne-0001')`)), 'not_live');
    for (const who of ['HELPER', 'STRANGER', 'HUB_OWNER'] as const) assert.match(E.try(who, `select public.edition_create_order('${O.BIZ}','${ED.BIZ}','${pkgId('promo_discovery_2w')}','attempt-who-0001')`), /owner or admin/, who);
    assert.match(E.try('anon', `select public.edition_create_order('${O.BIZ}','${ED.BIZ}','${pkgId('promo_discovery_2w')}','attempt-an-00001')`), /permission denied/);
  });
  test('each promotion product creates exactly its rights from the snapshot and NEVER touches the publishing period or the organiser features', () => {
    const cases: [string, number, string][] = [['promo_discovery_2w', 7900, 'discovery:14:false'], ['promo_discovery_6w', 17900, 'discovery:42:false'], ['promo_homepage_7d', 14900, 'homepage:7:false'], ['promo_campaign_full', 24900, 'discovery:42:true,homepage:7:true']];
    for (const [code, pence, rights] of cases) {
      const ed = live('BIZ_OWNER', O.BIZ, 365);
      const before = E.q(`select count(*) || '|' || max(ends_at) from public.edition_entitlements where edition_id='${ed}'`);
      const orgEnt = count(`public.edition_organiser_entitlements`);
      const o = order('BIZ_OWNER', O.BIZ, ed, code);
      assert.equal(E.q(`select amount_pence from public.edition_orders where id='${o}'`), String(pence), code);
      assert.match(fulfil(o, pence), /fulfilled/, code);
      assert.equal(rightsOf(ed), rights, code);
      assert.equal(E.q(`select count(*) || '|' || max(ends_at) from public.edition_entitlements where edition_id='${ed}'`), before, `${code} must not extend publishing`);
      assert.equal(count(`public.edition_organiser_entitlements`), orgEnt, `${code} grants no organiser features`);
      assert.equal(E.q(`select count(*) from public.edition_promo_rights where edition_id='${ed}' and source='order' and order_id='${o}'`), String(rights.split(',').length));
    }
  });
  test('the snapshot rules: a later catalogue change never changes what an earlier order grants', () => {
    const ed = live('BIZ_OWNER', O.BIZ); const o = order('BIZ_OWNER', O.BIZ, ed, 'promo_discovery_2w');
    E.sup(`update public.edition_packages set grants='{"discovery_days":99}' where code='promo_discovery_2w'`);
    fulfil(o, 7900); assert.equal(rightsOf(ed), 'discovery:14:false');
    E.sup(`update public.edition_packages set grants='{"discovery_days":14}' where code='promo_discovery_2w'`);
  });
  test('a free claim cannot be used for a promotion; a retired or inactive row cannot be ordered', () => {
    E.sup(`update public.edition_packages set is_free=true, price_pence=0 where code='promo_homepage_7d'`);
    const ed = live('BIZ_OWNER', O.BIZ);
    assert.match(E.try('BIZ_OWNER', `select public.edition_claim_free_package('${O.BIZ}','${ed}','${pkgId('promo_homepage_7d')}','attempt-fr-00001')`), /not available/);
    E.sup(`update public.edition_packages set is_free=false, price_pence=14900 where code='promo_homepage_7d'`);
    assert.match(E.try('BIZ_OWNER', `select public.edition_create_order('${O.BIZ}','${ed}','${pkgId('publish_single')}','attempt-rt-00001')`), /not available/);
    active('promo_homepage_7d', false);
    assert.match(E.try('BIZ_OWNER', `select public.edition_create_order('${O.BIZ}','${ed}','${pkgId('promo_homepage_7d')}','attempt-in-00001')`), /not available/);
    active('promo_homepage_7d');
  });
  test('Business and Hub pay the same: identical orders at identical amounts', () => {
    const a = approved('zz-parity-biz'); const b = draftEdition(E, 'HUB_OWNER', O.HUB, 'zz-parity-hub', 'ZZ parity hub'); approveEdition(E, 'HUB_OWNER', b);
    const oa = order('BIZ_OWNER', O.BIZ, a, 'showcase'), ob = order('HUB_OWNER', O.HUB, b, 'showcase'); assert.match(oa, UUID); assert.match(ob, UUID);
    assert.equal(E.q(`select amount_pence from public.edition_orders where id='${oa}'`), '49900'); assert.equal(E.q(`select amount_pence from public.edition_orders where id='${ob}'`), '49900');
  });
  test('promotion rights granted by an order are visible to editors and above on that Edition only', () => {
    reset(); const ed = live('BIZ_OWNER', O.BIZ); fulfil(order('BIZ_OWNER', O.BIZ, ed, 'promo_campaign_full'), 24900);
    for (const who of ['BIZ_OWNER', 'HELPER', 'ADMIN'] as const) assert.equal(E.one(who, `select count(*) from public.edition_my_promo_rights('${ed}')`), '2', who);
    for (const who of ['STRANGER', 'BIZ2_OWNER', 'HUB_OWNER'] as const) assert.match(E.try(who, `select * from public.edition_my_promo_rights('${ed}')`), /not permitted/, who);
    assert.match(E.try('anon', `select * from public.edition_my_promo_rights('${ed}')`), /permission denied/);
    assert.equal(E.one('BIZ_OWNER', `select string_agg(status, ',') from public.edition_my_promo_rights('${ed}')`), 'unused,unused');
    for (const c of ['launch', 'showcase', 'promo_discovery_2w', 'promo_discovery_6w', 'promo_homepage_7d', 'promo_campaign_full']) active(c, false);
  });
});

/* ── no stacking, no extension product ─────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('a package cannot be stacked: renewal only in the last 30 days', () => {
  before(() => { reset(); for (const c of ['launch', 'showcase', 'promo_discovery_2w']) active(c); E.sup(`delete from admin_config where key='editions.commerce.renewal_window_days'`); });
  after(() => { for (const c of ['launch', 'showcase', 'promo_discovery_2w']) active(c, false); E.sup(`delete from admin_config where key='editions.commerce.renewal_window_days'`); });
  const attemptOf = () => `attempt-stack-${++attempt}-abc`;
  const tryOrder = (who: keyof typeof USERS, org: string, ed: string, code: string) => E.try(who, `select public.edition_create_order('${org}','${ed}','${pkgId(code)}','${attemptOf()}')`);
  test('mid-term a second package is refused with already_live and a plain-English message naming the date; Business and Hub are identical', () => {
    const b = live('BIZ_OWNER', O.BIZ), h = live('HUB_OWNER', O.HUB);
    const ob = tryOrder('BIZ_OWNER', O.BIZ, b, 'launch'), oh = tryOrder('HUB_OWNER', O.HUB, h, 'showcase');
    for (const o of [ob, oh]) { assert.equal(hint(o), 'already_live'); assert.match(o, /This Edition is already live until \d{1,2} \w+ \d{4}\. You can renew it in the last 30 days\./); }
    assert.equal(hint(tryOrder('BIZ_OWNER', O.BIZ, b, 'showcase')), 'already_live', 'Showcase too: there is no upgrade product');
    assert.equal(count(`public.edition_orders where edition_id in ('${b}','${h}')`), 0);
  });
  test('promotions are unaffected by a live term', () => {
    const b = live('BIZ_OWNER', O.BIZ);
    assert.ok(!bad(tryOrder('BIZ_OWNER', O.BIZ, b, 'promo_discovery_2w')));
  });
  test('in the last 30 days a renewal is allowed and starts AFTER the current period ends (never overlapping, never extended automatically)', () => {
    const ed = live('BIZ_OWNER', O.BIZ, 25);
    const o = order('BIZ_OWNER', O.BIZ, ed, 'launch'); assert.match(o, UUID);
    const curEnd = E.q(`select max(ends_at) from public.edition_entitlements where edition_id='${ed}' and feature='publish'`);
    assert.match(fulfil(o, 24900), /fulfilled/);
    assert.equal(E.q(`select (starts_at = '${curEnd}'::timestamptz)::text from public.edition_entitlements where order_id='${o}'`), 'true');
    assert.equal(E.q(`select round(extract(epoch from (ends_at - starts_at)) / 86400) from public.edition_entitlements where order_id='${o}'`), '365');
    assert.equal(hint(tryOrder('BIZ_OWNER', O.BIZ, ed, 'launch')), 'already_live', 'now the term runs for over a year: refused again');
    const h = live('HUB_OWNER', O.HUB, 25); assert.match(order('HUB_OWNER', O.HUB, h, 'launch'), UUID, 'identical for a Hub');
  });
  test('the window is a validated config key (default 30) and is listed in edition_promo_settings', () => {
    assert.equal(E.one('BIZ_OWNER', `select public.edition_promo_settings() ->> 'renewal_window_days'`), '30');
    for (const v of ['0', '10', '365']) assert.ok(!bad(E.do('ADMIN', `select public.admin_set_edition_commerce_config('editions.commerce.renewal_window_days','${v}')`)), v);
    for (const v of ['366', 'x', '-1', '']) assert.match(E.do('ADMIN', `select public.admin_set_edition_commerce_config('editions.commerce.renewal_window_days','${v}')`), /not allowed/, v);
    assert.match(E.do('BIZ_OWNER', `select public.admin_set_edition_commerce_config('editions.commerce.renewal_window_days','5')`), /admins only/);
    E.do('ADMIN', `select public.admin_set_edition_commerce_config('editions.commerce.renewal_window_days','10')`);
    const ed = live('BIZ_OWNER', O.BIZ, 20);
    assert.equal(hint(tryOrder('BIZ_OWNER', O.BIZ, ed, 'launch')), 'already_live', '20 days left is outside a 10-day window');
    E.do('ADMIN', `select public.admin_set_edition_commerce_config('editions.commerce.renewal_window_days','30')`);
    assert.ok(!bad(tryOrder('BIZ_OWNER', O.BIZ, ed, 'launch')));
  });
  test('a free package follows the same rule (claim refused mid-term, allowed in the last 30 days), identically for Business and Hub', () => {
    const f = last(E.do('ADMIN', `select public.admin_upsert_edition_package('zz_free_renew','ZZ free','d',0,365,'[]'::jsonb,null,true,95,true)`));
    const claim = (who: keyof typeof USERS, org: string, ed: string) => E.try(who, `select public.edition_claim_free_package('${org}','${ed}','${f}','${attemptOf()}')`);
    for (const [who, org] of [['BIZ_OWNER', O.BIZ], ['HUB_OWNER', O.HUB]] as const) {
      const long = live(who, org, 365), short = live(who, org, 20);
      assert.equal(hint(claim(who, org, long)), 'already_live', who); assert.match(claim(who, org, long), /renew it in the last 30 days/);
      assert.ok(!bad(claim(who, org, short)), who);
    }
    E.sup(`update public.edition_packages set active=false where code='zz_free_renew'`);
  });
});

/* ── booking window ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('booking window rules', () => {
  before(reset);
  test('the Edition must be approved AND published with a live publishing period', () => {
    const draft = draftEdition(E, 'BIZ_OWNER', O.BIZ, 'zz-win-draft', 'ZZ draft'); const r = grant(draft, 'discovery', 14);
    assert.equal(hint(bookOut('BIZ_OWNER', r, 5)), 'not_live');
    approveEdition(E, 'BIZ_OWNER', draft); assert.equal(hint(bookOut('BIZ_OWNER', r, 5)), 'not_live', 'approved but not published');
    E.do('ADMIN', `select public.admin_grant_edition_entitlement('${draft}','publish', now(), now() + interval '90 days', 'ZZ TEST grant for the suite')`);
    assert.equal(hint(bookOut('BIZ_OWNER', r, 5)), 'not_live', 'entitled but not published');
    E.do('BIZ_OWNER', `select public.edition_set_status('${draft}','published')`);
    { const o = bookOut('BIZ_OWNER', r, 5); assert.match(last(o), UUID, `now it can be booked: ${o.slice(0, 400)}`); }
    reset();
  });
  test('a voided or expired publishing period blocks booking', () => {
    const r = grant(ED.BIZ, 'discovery', 14);
    E.sup(`update public.edition_entitlements set voided_at=now(), void_reason='ZZ test' where edition_id='${ED.BIZ}' and feature='publish'`);
    assert.equal(hint(bookOut('BIZ_OWNER', r, 5)), 'no_entitlement');
    E.sup(`update public.edition_entitlements set voided_at=null, void_reason=null where edition_id='${ED.BIZ}' and feature='publish'`);
    assert.match(last(bookOut('BIZ_OWNER', r, 5)), UUID);
    reset();
  });
  test('lead time: today+1 is refused, today+2 is allowed (default 2 days); the lead time is configurable', () => {
    const r = grant(ED.BIZ, 'discovery', 14);
    assert.equal(hint(bookOut('BIZ_OWNER', r, 0)), 'too_early'); assert.equal(hint(bookOut('BIZ_OWNER', r, 1)), 'too_early'); assert.equal(hint(bookOut('BIZ_OWNER', r, -3)), 'too_early');
    cfg('editions.promo.lead_days', '5'); assert.equal(hint(bookOut('BIZ_OWNER', r, 4)), 'too_early');
    cfg('editions.promo.lead_days', null);
    assert.match(last(bookOut('BIZ_OWNER', r, 2)), UUID);
    reset();
  });
  test('never before the Edition was published, even when the lead time would allow it', () => {
    E.sup(`update public.editions set published_at = now() + interval '9 days' where id='${ED.BIZ}'`);
    const r = grant(ED.BIZ, 'discovery', 14);
    assert.equal(hint(bookOut('BIZ_OWNER', r, 5)), 'too_early'); assert.equal(hint(bookOut('BIZ_OWNER', r, 8)), 'too_early');
    assert.match(last(bookOut('BIZ_OWNER', r, 9)), UUID);
    E.sup(`update public.editions set published_at = now() where id='${ED.BIZ}'`); reset();
  });
  test('the window must end inside the publishing period: a promotion can never extend publishing', () => {
    const short = live('BIZ_OWNER', O.BIZ, 20);
    const r = grant(short, 'discovery', 14);
    assert.equal(hint(bookOut('BIZ_OWNER', r, 10)), 'outside_publish_window', 'would end after the publishing period');
    const ends = E.q(`select (max(ends_at) at time zone 'Europe/London')::date - public.edition_promo_today() from public.edition_entitlements where edition_id='${short}' and feature='publish'`);
    const lastFull = Number(ends) - 1; // the last whole day inside the period (ends part-way through the following day)
    assert.match(last(bookOut('BIZ_OWNER', r, lastFull - 13)), UUID, 'ending on the last whole day fits');
    reset(); const r2 = grant(short, 'discovery', 14);
    assert.equal(hint(bookOut('BIZ_OWNER', r2, lastFull - 12)), 'outside_publish_window', 'one day later does not');
    const ed = E.q(`select count(*) from public.edition_entitlements where edition_id='${short}' and feature='publish'`); assert.equal(ed, '1', 'booking never creates or changes a publish entitlement');
    reset();
  });
  test('horizon: up to 180 days ahead, not beyond; the horizon is configurable', () => {
    const r = grant(ED.BIZ, 'discovery', 14);
    assert.equal(hint(bookOut('BIZ_OWNER', r, 181)), 'too_far'); assert.match(last(bookOut('BIZ_OWNER', r, 180)), UUID);
    reset(); const r2 = grant(ED.BIZ, 'discovery', 14); cfg('editions.promo.horizon_days', '30');
    assert.equal(hint(bookOut('BIZ_OWNER', r2, 31)), 'too_far'); assert.match(last(bookOut('BIZ_OWNER', r2, 30)), UUID);
    reset();
  });
  test('ends_on = starts_on + days - 1 (whole days); a booking cannot be made twice for the same right; a null start is refused', () => {
    const r = grant(ED.BIZ, 'homepage', 7); const b = book('BIZ_OWNER', r, 10);
    assert.equal(E.q(`select (ends_on - starts_on + 1) || '|' || (starts_on = ${T(10)})::text from public.edition_promo_bookings where id='${b}'`), '7|true');
    assert.equal(hint(bookOut('BIZ_OWNER', r, 30)), 'right_booked');
    assert.equal(hint(E.do('BIZ_OWNER', `select public.edition_promo_book('${grant(ED.BIZ, 'discovery', 14)}', null)`)), 'bad_dates');
    reset();
  });
  test('the Edition becoming non-public: a returned-to-review Edition keeps its booking but cannot get a new one, and is not shown', () => {
    reset(); const ed = live('BIZ_OWNER', O.BIZ); const b = liveToday('BIZ_OWNER', ed, 'discovery', 14);
    assert.ok((featured('discovery')).includes(slugOf(ed)));
    E.do('BIZ_OWNER', `update public.editions set title='ZZ renamed after approval' where id='${ed}'`);
    assert.equal(E.q(`select review_state from public.editions where id='${ed}'`), 'submitted', 'a material change returns it to review');
    assert.ok(!featured('discovery').includes(slugOf(ed)), 'not shown while back in review');
    assert.equal(E.q(`select status from public.edition_promo_bookings where id='${b}'`), 'booked', 'the booking itself is untouched');
    assert.equal(hint(bookOut('BIZ_OWNER', grant(ed, 'homepage', 7), 20)), 'not_live');
    reset();
  });
});

/* ── capacity and fairness ─────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('capacity and fairness', () => {
  before(reset);
  test('capacity per day per kind: the fourth organiser is refused a homepage day that three already hold; other kinds and other days are unaffected', () => {
    reset();
    const eds: [keyof typeof USERS, string][] = [['BIZ_OWNER', ED.BIZ], ['BIZ2_OWNER', ED.BIZ2], ['HUB_OWNER', ED.HUB]];
    for (const [who, ed] of eds) book(who, grant(ed, 'homepage', 7), 10);
    const r4 = grant(ED.HUB2, 'homepage', 7);
    assert.equal(hint(bookOut('HUB2_OWNER', r4, 10)), 'full'); assert.equal(hint(bookOut('HUB2_OWNER', r4, 14)), 'full', 'overlapping the last booked day');
    assert.match(last(bookOut('HUB2_OWNER', r4, 17)), UUID, 'the first free day works');
    assert.match(last(bookOut('HUB2_OWNER', grant(ED.HUB2, 'discovery', 14), 10)), UUID, 'discovery has its own capacity');
    assert.equal(E.one('BIZ_OWNER', `select remaining || '/' || capacity || '/' || booked from public.edition_promo_availability('homepage', ${T(10)}, ${T(10)})`), '0/3/3');
    assert.equal(E.one('BIZ_OWNER', `select remaining from public.edition_promo_availability('homepage', ${T(17)}, ${T(17)})`), '2', 'HUB2 holds one place from day 17');
    cfg('editions.promo.homepage_capacity', '4'); assert.match(last(bookOut('HUB2_OWNER', grant(ED.HUB2, 'homepage', 7), 10)), UUID, 'the capacity is configurable');
    reset();
  });
  test('capacity is configurable and a booking returns the place when cancelled; availability exposes counts but no names', () => {
    reset(); cfg('editions.promo.discovery_capacity', '1');
    const b = book('BIZ_OWNER', grant(ED.BIZ, 'discovery', 14), 10);
    assert.equal(hint(bookOut('BIZ2_OWNER', grant(ED.BIZ2, 'discovery', 14), 12)), 'full');
    E.do('BIZ_OWNER', `select public.edition_promo_cancel('${b}')`);
    assert.match(last(bookOut('BIZ2_OWNER', grant(ED.BIZ2, 'discovery', 14), 12)), UUID);
    assert.equal(E.one('STRANGER', `select count(*) from public.edition_promo_availability('discovery', ${T(10)}, ${T(30)})`), '21', 'any signed-in user may look');
    assert.match(E.try('anon', `select * from public.edition_promo_availability('discovery', ${T(10)}, ${T(30)})`), /permission denied/);
    assert.equal(hint(E.try('STRANGER', `select * from public.edition_promo_availability('discovery', ${T(10)}, ${T(900)})`)), 'bad_range');
    reset();
  });
  test('one booking per organiser per kind per day, across all of its Editions; different days are fine', () => {
    reset(); book('BIZ_OWNER', grant(ED.BIZ, 'discovery', 14), 10);
    assert.equal(hint(bookOut('BIZ_OWNER', grant(ED.BIZ_B, 'discovery', 14), 15)), 'already_booked', 'a second Edition of the same organiser overlapping');
    assert.equal(hint(bookOut('BIZ_OWNER', grant(ED.BIZ, 'discovery', 14), 23)), 'already_booked', 'the same Edition, overlapping the last day');
    assert.match(last(bookOut('BIZ_OWNER', grant(ED.BIZ_B, 'discovery', 14), 24)), UUID, 'the day after');
    assert.match(last(bookOut('BIZ_OWNER', grant(ED.BIZ, 'homepage', 7), 10)), UUID, 'the other kind is separate');
    reset();
  });
  test('fairness: no organiser may exceed 14 homepage days in any rolling 90 days, counted across all its Editions', () => {
    reset();
    book('BIZ_OWNER', grant(ED.BIZ, 'homepage', 7), 10); book('BIZ_OWNER', grant(ED.BIZ_B, 'homepage', 7), 30);
    const third = grant(ED.BIZ, 'homepage', 7);
    assert.equal(hint(bookOut('BIZ_OWNER', third, 60)), 'fairness_limit', 'a third week inside 90 days of the first two');
    assert.equal(hint(bookOut('BIZ_OWNER', third, 18)), 'fairness_limit');
    assert.equal(hint(bookOut('BIZ_OWNER', third, 99)), 'fairness_limit', 'one day too soon: a 90-day window would hold 15');
    assert.match(last(bookOut('BIZ_OWNER', third, 100)), UUID, 'no 90-day window holds more than 14');
    reset(); cfg('editions.promo.homepage_days_per_90', '21');
    book('BIZ_OWNER', grant(ED.BIZ, 'homepage', 7), 10); book('BIZ_OWNER', grant(ED.BIZ_B, 'homepage', 7), 30);
    { const o = bookOut('BIZ_OWNER', grant(ED.BIZ, 'homepage', 7), 60); assert.match(last(o), UUID, `the limit is configurable: ${o.slice(0, 400)}`); }
    reset();
  });
  test('fairness is per organiser: another organiser is unaffected, and discovery days are not limited by it', () => {
    reset(); book('BIZ_OWNER', grant(ED.BIZ, 'homepage', 7), 10); book('BIZ_OWNER', grant(ED.BIZ_B, 'homepage', 7), 30);
    assert.match(last(bookOut('BIZ2_OWNER', grant(ED.BIZ2, 'homepage', 7), 60)), UUID);
    assert.match(last(bookOut('BIZ_OWNER', grant(ED.BIZ, 'discovery', 42), 40)), UUID);
    reset();
  });
});

/* ── grouped campaigns ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('grouped campaigns', () => {
  let ed = '', grp = '', rd = '', rh = '';
  const fresh = () => {
    reset(); ed = live('BIZ_OWNER', O.BIZ);
    E.sup(`update public.edition_packages set active=true where code='promo_campaign_full'`);
    fulfil(order('BIZ_OWNER', O.BIZ, ed, 'promo_campaign_full'), 24900);
    E.sup(`update public.edition_packages set active=false where code='promo_campaign_full'`);
    grp = E.q(`select group_id from public.edition_promo_rights where edition_id='${ed}' limit 1`);
    rd = E.q(`select id from public.edition_promo_rights where edition_id='${ed}' and kind='discovery'`); rh = E.q(`select id from public.edition_promo_rights where edition_id='${ed}' and kind='homepage'`);
  };
  const campaign = (d: number, h: number, who: keyof typeof USERS = 'BIZ_OWNER') => E.do(who, `select public.edition_promo_book_campaign('${ed}','${grp}',${T(d)},${T(h)})`);
  test('a homepage right cannot be booked before the group\'s discovery days; and must sit wholly inside them', () => {
    fresh();
    assert.equal(hint(bookOut('BIZ_OWNER', rh, 20)), 'book_discovery_first');
    const d = book('BIZ_OWNER', rd, 10); // 10..51
    assert.equal(hint(bookOut('BIZ_OWNER', rh, 9)), 'outside_discovery'); assert.equal(hint(bookOut('BIZ_OWNER', rh, 46)), 'outside_discovery', 'would end on day 52');
    assert.match(last(bookOut('BIZ_OWNER', rh, 45)), UUID, 'ends exactly on the last discovery day');
    assert.ok(d);
  });
  test('book_campaign books both atomically and returns both ids; the homepage window must be inside the discovery window', () => {
    fresh();
    assert.equal(hint(campaign(10, 9)), 'outside_discovery'); assert.equal(hint(campaign(10, 46)), 'outside_discovery'); assert.equal(count(`public.edition_promo_bookings`), 0);
    const j = JSON.parse(last(campaign(10, 20)));
    assert.match(j.discovery_booking, UUID); assert.match(j.homepage_booking, UUID);
    assert.equal(E.q(`select string_agg(kind || ':' || (starts_on - ${T(0)}) || ':' || (ends_on - ${T(0)}), ',' order by kind) from public.edition_promo_bookings`), 'discovery:10:51,homepage:20:26');
    assert.equal(hint(campaign(10, 20)), 'right_booked');
  });
  test('all or nothing: when the homepage place is full the discovery booking is not left behind', () => {
    fresh();
    for (const [who, e2] of [['BIZ2_OWNER', ED.BIZ2], ['HUB_OWNER', ED.HUB], ['HUB2_OWNER', ED.HUB2]] as const) book(who, grant(e2, 'homepage', 7), 20);
    assert.equal(hint(campaign(10, 20)), 'full'); assert.equal(count(`public.edition_promo_bookings where edition_id='${ed}'`), 0, 'nothing booked');
    assert.equal(E.one('BIZ_OWNER', `select string_agg(status, ',') from public.edition_my_promo_rights('${ed}')`), 'unused,unused');
    assert.ok(!bad(campaign(10, 27)) && count(`public.edition_promo_bookings where edition_id='${ed}'`) === 2, 'the free week works');
  });
  test('a group of another Edition, an unknown group, a voided right and a stranger are all refused', () => {
    fresh();
    assert.match(E.do('BIZ_OWNER', `select public.edition_promo_book_campaign('${ED.BIZ_B}','${grp}',${T(10)},${T(20)})`), /not available/);
    assert.match(E.do('BIZ_OWNER', `select public.edition_promo_book_campaign('${ed}',gen_random_uuid(),${T(10)},${T(20)})`), /not available/);
    for (const who of ['STRANGER', 'BIZ2_OWNER', 'HELPER'] as const) assert.match(campaign(10, 20, who), /only an owner or admin/, who);
    assert.match(E.do('anon', `select public.edition_promo_book_campaign('${ed}','${grp}',${T(10)},${T(20)})`), /permission denied/);
    E.sup(`update public.edition_promo_rights set voided_at=now(), void_reason='ZZ' where id='${rh}'`); assert.equal(hint(campaign(10, 20)), 'right_void');
  });
  test('cancelling the discovery days takes the group\'s homepage booking with it; moving them cannot strand the homepage days', () => {
    fresh(); const j = JSON.parse(last(campaign(10, 20)));
    assert.equal(hint(E.do('BIZ_OWNER', `select public.edition_promo_reschedule('${j.discovery_booking}', ${T(30)})`)), 'homepage_would_fall_outside');
    assert.ok(!bad(E.do('BIZ_OWNER', `select public.edition_promo_reschedule('${j.discovery_booking}', ${T(15)})`)), 'still contains the homepage days (15..56 holds 20..26)');
    assert.equal(hint(E.do('BIZ_OWNER', `select public.edition_promo_reschedule('${j.homepage_booking}', ${T(52)})`)), 'outside_discovery');
    E.do('BIZ_OWNER', `select public.edition_promo_cancel('${j.discovery_booking}')`);
    assert.equal(E.q(`select string_agg(status, ',' order by kind) from public.edition_promo_bookings`), 'cancelled,cancelled');
    assert.equal(E.one('BIZ_OWNER', `select string_agg(status, ',') from public.edition_my_promo_rights('${ed}')`), 'unused,unused');
    assert.ok(!bad(campaign(12, 14)), 'and the campaign can be booked again');
  });
});

/* ── concurrency ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('concurrency: real parallel connections', () => {
  const asBg = (who: keyof typeof USERS, sql: string, hold = 0.4) => E.db.bg(`begin; ${E.as(who)} ${sql}; select pg_sleep(${hold}); commit;`);
  const okOf = (r: { stdout: string; stderr: string }) => r.stdout.split('\n').some((l) => UUID.test(l.trim())) && !/ERROR/.test(r.stderr);
  test('two organisers racing for the LAST homepage place: exactly one wins, the other is told it is full', async () => {
    for (let round = 0; round < 3; round++) {
      reset(); cfg('editions.promo.homepage_capacity', '1');
      const a = grant(ED.BIZ, 'homepage', 7), b = grant(ED.BIZ2, 'homepage', 7);
      const [ra, rb] = await Promise.all([asBg('BIZ_OWNER', `select public.edition_promo_book('${a}', ${T(10)})`), asBg('BIZ2_OWNER', `select public.edition_promo_book('${b}', ${T(10)})`)]);
      assert.equal([ra, rb].filter(okOf).length, 1, `round ${round}: ${ra.stderr}${rb.stderr}`);
      assert.match([ra, rb].find((r) => !okOf(r))!.stderr, /no place is free/);
      assert.equal(count(`public.edition_promo_bookings where status='booked'`), 1);
    }
  });
  test('the same organiser double-booking the same days from two connections: one succeeds', async () => {
    reset(); const a = grant(ED.BIZ, 'discovery', 14), b = grant(ED.BIZ_B, 'discovery', 14);
    const rs = await Promise.all([asBg('BIZ_OWNER', `select public.edition_promo_book('${a}', ${T(10)})`), asBg('BIZ_OWNER', `select public.edition_promo_book('${b}', ${T(12)})`)]);
    assert.equal(rs.filter(okOf).length, 1); assert.match(rs.find((r) => !okOf(r))!.stderr, /already have this kind of promotion booked/);
    assert.equal(count(`public.edition_promo_bookings where status='booked'`), 1);
  });
  test('the same right booked twice at once: one booking only', async () => {
    reset(); const r = grant(ED.BIZ, 'homepage', 7);
    const rs = await Promise.all([asBg('BIZ_OWNER', `select public.edition_promo_book('${r}', ${T(10)})`), asBg('BIZ_OWNER', `select public.edition_promo_book('${r}', ${T(40)})`)]);
    assert.equal(rs.filter(okOf).length, 1); assert.equal(count(`public.edition_promo_bookings where status='booked'`), 1);
  });
  test('cancelling while another organiser books the same place: capacity is never exceeded and nobody sees a half state', async () => {
    for (let round = 0; round < 3; round++) {
      reset(); cfg('editions.promo.homepage_capacity', '1');
      const held = book('BIZ_OWNER', grant(ED.BIZ, 'homepage', 7), 10); const other = grant(ED.BIZ2, 'homepage', 7);
      const [rc, rb] = await Promise.all([asBg('BIZ_OWNER', `select public.edition_promo_cancel('${held}')`, 0.2), asBg('BIZ2_OWNER', `select public.edition_promo_book('${other}', ${T(10)})`, 0.2)]);
      assert.ok(!/ERROR/.test(rc.stderr), rc.stderr);
      assert.ok(okOf(rb) || /no place is free/.test(rb.stderr), rb.stderr);
      assert.ok(count(`public.edition_promo_bookings where status='booked'`) <= 1, 'capacity 1 never exceeded');
      assert.equal(E.q(`select status from public.edition_promo_bookings where id='${held}'`), 'cancelled');
    }
  });
  test('a full refund racing a booking: the right is either booked-then-cancelled or never booked; no live booking survives on a voided right', async () => {
    reset(); const ed = live('BIZ_OWNER', O.BIZ); active('promo_homepage_7d'); const o = order('BIZ_OWNER', O.BIZ, ed, 'promo_homepage_7d'); fulfil(o, 14900); active('promo_homepage_7d', false);
    const right = E.q(`select id from public.edition_promo_rights where order_id='${o}'`);
    await Promise.all([asBg('BIZ_OWNER', `select public.edition_promo_book('${right}', ${T(10)})`, 0.3), E.db.bg(`begin; select public.edition_refund_order('${o}', 14900); select pg_sleep(0.1); commit;`)]);
    assert.equal(E.q(`select count(*) from public.edition_promo_bookings b join public.edition_promo_rights r on r.id=b.right_id where r.voided_at is not null and b.status='booked'`), '0');
    assert.equal(E.q(`select (voided_at is not null)::text from public.edition_promo_rights where id='${right}'`), 'true');
  });
});

/* ── cancel and reschedule ─────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('cancel and reschedule by the owner, and by an administrator', () => {
  test('the owner may cancel while the booking starts at least 3 days away; the right returns to unused and can be booked again', () => {
    reset(); const r = grant(ED.BIZ, 'discovery', 14); const b = book('BIZ_OWNER', r, 10);
    assert.equal(E.one('BIZ_OWNER', `select status from public.edition_my_promo_rights('${ED.BIZ}') where right_id='${r}'`), 'booked');
    E.do('BIZ_OWNER', `select public.edition_promo_cancel('${b}')`);
    assert.equal(E.q(`select status || '|' || (cancelled_at is not null)::text from public.edition_promo_bookings where id='${b}'`), 'cancelled|true');
    assert.equal(E.one('BIZ_OWNER', `select status from public.edition_my_promo_rights('${ED.BIZ}') where right_id='${r}'`), 'unused');
    assert.match(last(bookOut('BIZ_OWNER', r, 20)), UUID, 'the same right books again; the cancelled row stays as history');
    assert.equal(count(`public.edition_promo_bookings where right_id='${r}'`), 2);
    assert.equal(hint(E.do('BIZ_OWNER', `select public.edition_promo_cancel('${b}')`)), 'not_booked', 'cancelling twice is refused');
  });
  test('inside the notice period (and once started) the owner cannot cancel or move: contact OneShetland', () => {
    reset(); const r = grant(ED.BIZ, 'discovery', 14); const b = book('BIZ_OWNER', r, 3);
    assert.equal(hint(E.do('BIZ_OWNER', `select public.edition_promo_cancel('${b}')`)), '', 'starting exactly 3 days away is still allowed');
    const b2 = book('BIZ_OWNER', r, 2);
    assert.equal(hint(E.do('BIZ_OWNER', `select public.edition_promo_cancel('${b2}')`)), 'too_late'); assert.equal(hint(E.do('BIZ_OWNER', `select public.edition_promo_reschedule('${b2}', ${T(20)})`)), 'too_late');
    adminMove(b2, 0); assert.equal(hint(E.do('BIZ_OWNER', `select public.edition_promo_cancel('${b2}')`)), 'too_late', 'started');
    cfg('editions.promo.reschedule_notice_days', '0'); assert.equal(hint(E.do('BIZ_OWNER', `select public.edition_promo_cancel('${b2}')`)), '', 'configurable');
    reset();
  });
  test('the owner can reschedule under the same window, capacity, fairness and one-per-day rules', () => {
    reset(); cfg('editions.promo.homepage_capacity', '1');
    book('BIZ2_OWNER', grant(ED.BIZ2, 'homepage', 7), 20);
    const b = book('BIZ_OWNER', grant(ED.BIZ, 'homepage', 7), 10);
    assert.equal(hint(E.do('BIZ_OWNER', `select public.edition_promo_reschedule('${b}', ${T(22)})`)), 'full');
    assert.equal(hint(E.do('BIZ_OWNER', `select public.edition_promo_reschedule('${b}', ${T(1)})`)), 'too_early');
    assert.equal(hint(E.do('BIZ_OWNER', `select public.edition_promo_reschedule('${b}', ${T(185)})`)), 'too_far');
    assert.ok(!bad(E.do('BIZ_OWNER', `select public.edition_promo_reschedule('${b}', ${T(12)})`)), 'overlapping its own old days is fine');
    assert.equal(E.q(`select (starts_on - ${T(0)}) || '|' || (ends_on - ${T(0)}) from public.edition_promo_bookings where id='${b}'`), '12|18');
    assert.equal(E.q(`select count(*) from public.edition_audit_log where action='promo_rescheduled'`) !== '0', true, 'audited');
    reset();
  });
  test('only an owner or admin of THAT organiser: editors, strangers and another organiser\'s owner cannot book, cancel or move', () => {
    reset(); const r = grant(ED.BIZ, 'discovery', 14); const b = book('BIZ_OWNER', grant(ED.BIZ, 'homepage', 7), 10);
    for (const who of ['HELPER', 'STRANGER', 'BIZ2_OWNER', 'HUB_OWNER'] as const) {
      assert.match(bookOut(who, r, 20), /only an owner or admin/, who);
      assert.match(E.do(who, `select public.edition_promo_cancel('${b}')`), /only an owner or admin/, who);
      assert.match(E.do(who, `select public.edition_promo_reschedule('${b}', ${T(30)})`), /only an owner or admin/, who);
    }
    for (const fn of [`select public.edition_promo_book(gen_random_uuid(), ${T(20)})`, `select public.edition_promo_cancel(gen_random_uuid())`]) assert.match(E.do('STRANGER', fn), /only an owner or admin/, 'a stranger cannot tell a real id from an unknown one');
    assert.equal(count(`public.edition_promo_bookings where status='booked'`), 1);
    E.sup(`insert into public.edition_organiser_members (organiser_id, user_id, role) values ('${O.BIZ}','${USERS.EDITOR}','admin') on conflict (organiser_id, user_id) do update set role='admin'`);
    assert.match(last(bookOut('EDITOR', r, 20)), UUID, 'an organiser admin may');
    E.sup(`delete from public.edition_organiser_members where organiser_id='${O.BIZ}' and user_id='${USERS.EDITOR}'`);
    reset();
  });
  test('administrators may always cancel, move or grant (no notice or lead time), still under capacity and window rules; a reason of 5+ characters is needed and the action is audited', () => {
    reset(); cfg('editions.promo.homepage_capacity', '1');
    const b = book('BIZ_OWNER', grant(ED.BIZ, 'homepage', 7), 10); book('BIZ2_OWNER', grant(ED.BIZ2, 'homepage', 7), 30);
    assert.equal(hint(E.do('ADMIN', `select public.admin_promo_reschedule('${b}', ${T(30)}, 'ZZ move for the suite')`)), 'full', 'capacity still applies');
    assert.equal(hint(E.do('ADMIN', `select public.admin_promo_reschedule('${b}', ${T(12)}, 'x')`)), 'reason_required');
    assert.equal(hint(E.do('ADMIN', `select public.admin_promo_reschedule('${b}', ${T(-5)}, 'ZZ move into the past')`)), 'too_early', 'never into the past');
    assert.ok(!bad(adminMove(b, 0)), 'start today (inside the lead time) is allowed for administrators');
    assert.equal(hint(E.do('BIZ_OWNER', `select public.edition_promo_cancel('${b}')`)), 'too_late');
    assert.equal(hint(E.do('ADMIN', `select public.admin_promo_cancel('${b}', 'no')`)), 'reason_required');
    assert.ok(!bad(E.do('ADMIN', `select public.admin_promo_cancel('${b}', 'ZZ cancelled for the suite')`)));
    assert.equal(E.q(`select cancel_reason from public.edition_promo_bookings where id='${b}'`), 'cancelled by OneShetland: ZZ cancelled for the suite');
    assert.equal(E.q(`select count(*) from public.edition_audit_log where action in ('promo_cancelled','promo_rescheduled','promo_right_granted') and detail::text like '%ZZ%'`) !== '0', true);
    assert.match(E.do('ADMIN', `select public.admin_promo_cancel(gen_random_uuid(), 'ZZ no such booking')`), /booking not found/);
    for (const who of ['BIZ_OWNER', 'HELPER', 'STRANGER', 'anon'] as const) {
      assert.match(E.do(who, `select public.admin_promo_cancel('${b}', 'ZZ attempt')`), /admins only|permission denied/, who);
      assert.match(E.do(who, `select public.admin_promo_reschedule('${b}', ${T(12)}, 'ZZ attempt')`), /admins only|permission denied/, who);
      assert.match(E.do(who, `select public.admin_grant_promo_right('${ED.BIZ}','homepage',7,'ZZ attempt')`), /admins only|permission denied/, who);
    }
    reset();
  });
  test('admin_grant_promo_right: validated, audited, creates a non-grouped right with source admin_grant', () => {
    reset();
    for (const [args, h] of [[`'${ED.BIZ}','weekly',7,'ZZ reason here'`, ''], [`'${ED.BIZ}','homepage',0,'ZZ reason here'`, 'bad_days'], [`'${ED.BIZ}','homepage',121,'ZZ reason here'`, 'bad_days'], [`'${ED.BIZ}','homepage',7,'no'`, 'reason_required']] as const) {
      const out = E.do('ADMIN', `select public.admin_grant_promo_right(${args})`); assert.ok(bad(out), args); assert.equal(hint(out), h, args);
    }
    assert.match(E.do('ADMIN', `select public.admin_grant_promo_right(gen_random_uuid(),'homepage',7,'ZZ reason here')`), /edition not found/);
    const r = grant(ED.BIZ, 'homepage', 7);
    assert.equal(E.q(`select source || '|' || (group_id is null)::text || '|' || (order_id is null)::text || '|' || (granted_by is not null)::text from public.edition_promo_rights where id='${r}'`), 'admin_grant|true|true|true');
    assert.equal(count(`public.edition_audit_log where action='promo_right_granted'`) >= 1, true);
    assert.match(E.sup(`insert into public.edition_promo_rights (edition_id, organiser_id, source, kind, days) values ('${ED.BIZ}','${O.BIZ}','admin_grant','homepage',7)`), /edition_promo_rights_source/, 'a grant without reason or actor is refused by the table');
    assert.match(E.sup(`insert into public.edition_promo_rights (edition_id, organiser_id, source, kind, days) values ('${ED.BIZ}','${O.BIZ}','order','homepage',7)`), /edition_promo_rights_source/, 'an order right needs an order');
  });
});

/* ── refunds ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('refund effects', () => {
  const showcase = () => {
    reset(); active('showcase'); const ed = draftEdition(E, 'BIZ_OWNER', O.BIZ, `zz-refund-sc-${++slugN}`, 'ZZ refund showcase'); approveEdition(E, 'BIZ_OWNER', ed);
    const o = order('BIZ_OWNER', O.BIZ, ed, 'showcase'); fulfil(o, 49900); active('showcase', false); E.do('BIZ_OWNER', `select public.edition_set_status('${ed}','published')`);
    return { ed, o, grp: E.q(`select group_id from public.edition_promo_rights where order_id='${o}' limit 1`) };
  };
  test('a PARTIAL refund changes nothing: rights, bookings and the publishing period stay', () => {
    const { ed, o, grp } = showcase(); E.do('BIZ_OWNER', `select public.edition_promo_book_campaign('${ed}','${grp}',${T(10)},${T(20)})`);
    assert.equal(E.sup(`select public.edition_refund_order('${o}', 5000)`).trim(), 'recorded');
    assert.equal(count(`public.edition_promo_bookings where status='booked'`), 2); assert.equal(count(`public.edition_promo_rights where order_id='${o}' and voided_at is null`), 2);
    assert.equal(E.q(`select public.edition_entitled('${ed}','publish')`), 't');
  });
  test('a FULL refund voids unused rights and cancels FUTURE bookings; the Edition stops being public with its publishing period', () => {
    const { ed, o, grp } = showcase(); E.do('BIZ_OWNER', `select public.edition_promo_book_campaign('${ed}','${grp}',${T(10)},${T(20)})`);
    assert.equal(E.sup(`select public.edition_refund_order('${o}', 49900)`).trim(), 'voided');
    assert.equal(E.q(`select string_agg(status, ',') from public.edition_promo_bookings`), 'cancelled,cancelled');
    assert.equal(E.q(`select count(*) from public.edition_promo_rights where order_id='${o}' and voided_at is not null and void_reason='order refunded'`), '2');
    assert.equal(E.q(`select public.edition_entitled('${ed}','publish')`), 'f');
    assert.equal(hint(E.do('BIZ_OWNER', `select public.edition_promo_book('${E.q(`select id from public.edition_promo_rights where order_id='${o}' limit 1`)}', ${T(40)})`)), 'right_void');
    assert.match(E.sup(`select public.edition_refund_order('${o}', 49900)`), /no_change/);
  });
  test('a full refund of UNUSED rights voids them with no bookings to cancel', () => {
    const { o } = showcase(); E.sup(`select public.edition_refund_order('${o}', 49900)`);
    assert.equal(E.q(`select count(*) from public.edition_promo_rights where order_id='${o}' and voided_at is not null`), '2'); assert.equal(count(`public.edition_promo_bookings`), 0);
  });
  test('bookings that have STARTED stay (and so do their rights); only the future ones go', () => {
    const { ed, o, grp } = showcase(); const j = JSON.parse(last(E.do('BIZ_OWNER', `select public.edition_promo_book_campaign('${ed}','${grp}',${T(10)},${T(20)})`)));
    adminMove(j.discovery_booking, 0);
    E.sup(`select public.edition_refund_order('${o}', 49900)`);
    assert.equal(E.q(`select status from public.edition_promo_bookings where id='${j.discovery_booking}'`), 'booked', 'started: stays');
    assert.equal(E.q(`select status from public.edition_promo_bookings where id='${j.homepage_booking}'`), 'cancelled', 'future: cancelled');
    assert.equal(E.q(`select string_agg(kind || ':' || (voided_at is not null)::text, ',' order by kind) from public.edition_promo_rights where order_id='${o}'`), 'discovery:false,homepage:true');
  });
  test('a refund of one order never touches another order\'s rights or an administrator\'s grant', () => {
    const { o } = showcase(); const g = grant(ED.BIZ2, 'homepage', 7);
    active('promo_homepage_7d'); const ed2 = live('BIZ_OWNER', O.BIZ); const o2 = order('BIZ_OWNER', O.BIZ, ed2, 'promo_homepage_7d'); fulfil(o2, 14900); active('promo_homepage_7d', false);
    E.sup(`select public.edition_refund_order('${o}', 49900)`);
    assert.equal(E.q(`select (voided_at is null)::text from public.edition_promo_rights where id='${g}'`), 'true'); assert.equal(count(`public.edition_promo_rights where order_id='${o2}' and voided_at is null`), 1);
  });
  test('the existing refund path is unchanged for package orders: Launch refund voids publish and features and there are no rights to touch', () => {
    reset(); active('launch'); const ed = draftEdition(E, 'BIZ_OWNER', O.BIZ, 'zz-refund-launch', 'ZZ refund'); approveEdition(E, 'BIZ_OWNER', ed);
    const o = order('BIZ_OWNER', O.BIZ, ed, 'launch'); fulfil(o, 24900); active('launch', false);
    assert.equal(E.sup(`select public.edition_refund_order('${o}', 24900)`).trim(), 'voided');
    assert.equal(E.q(`select count(*) from public.edition_entitlements where order_id='${o}' and voided_at is null`), '0');
    assert.equal(E.q(`select count(*) from public.edition_organiser_entitlements where order_id='${o}' and voided_at is null`), '0');
  });
});

/* ── featuring and the public rule ─────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('edition_featured: rotation, limits and the public rule', () => {
  test('only Editions with a booking covering TODAY appear, for the right kind; anon and signed-in callers see the same', () => {
    reset(); const a = liveToday('BIZ_OWNER', ED.BIZ, 'homepage', 7);
    book('BIZ2_OWNER', grant(ED.BIZ2, 'homepage', 7), 10); // future: not today
    book('HUB_OWNER', grant(ED.HUB, 'discovery', 14), 10);
    assert.equal(featured('homepage'), slugOf(ED.BIZ)); assert.equal(featured('homepage', 'STRANGER'), slugOf(ED.BIZ));
    assert.equal(featured('discovery'), '', 'a homepage booking does not feature in discovery, and a future one does not appear yet');
    adminMove(E.q(`select id from public.edition_promo_bookings where edition_id='${ED.HUB}'`), 0);
    assert.equal(featured('discovery'), slugOf(ED.HUB));
    E.sup(`update public.edition_promo_bookings set status='cancelled', cancelled_at=now() where id='${a}'`);
    assert.equal(featured('homepage'), '', 'a cancelled booking never appears');
    assert.match(E.do('anon', `select * from public.edition_featured('nope')`), /kind must be/);
  });
  test('output columns and values: slug, title, kind, dates, summary, organiser name, parent kind and slug', () => {
    reset(); liveToday('HUB_OWNER', ED.HUB, 'homepage', 7); liveToday('BIZ_OWNER', ED.BIZ, 'homepage', 7);
    const row = (ed: string) => last(E.do('anon', `select edition_id::text, slug, title, kind, starts_on::text, ends_on::text, summary, organiser_name, parent_kind, parent_slug from public.edition_featured('homepage') where edition_id='${ed}'`));
    assert.match(row(ED.HUB), new RegExp(`^${ED.HUB}\\|${slugOf(ED.HUB)}\\|ZZ Promo \\d+\\|multi_day\\|[0-9-]+\\|[0-9-]+\\|A festival\\|ZZ Test Hub\\|hub\\|zz-test-hub`));
    assert.match(row(ED.BIZ), /\|business\|/);
    assert.equal(E.q(`select count(*) from information_schema.columns where table_name='edition_featured'`), '0');
  });
  test('a strip shows at most 3 (homepage) and 4 (discovery) and the limits are configurable; it is a share, never a takeover', () => {
    reset(); cfg('editions.promo.homepage_capacity', '6'); cfg('editions.promo.discovery_capacity', '8');
    const extra = [live('BIZ_OWNER', O.BIZ), live('BIZ2_OWNER', O.BIZ2), live('HUB_OWNER', O.HUB), live('HUB2_OWNER', O.HUB2)];
    const who: (keyof typeof USERS)[] = ['BIZ_OWNER', 'BIZ2_OWNER', 'HUB_OWNER', 'HUB2_OWNER'];
    // four organisers, each holding one homepage and one discovery booking today (an organiser holds only one booking per kind per day)
    extra.forEach((ed, i) => { liveToday(who[i], ed, 'homepage', 7); liveToday(who[i], ed, 'discovery', 14); });
    assert.equal(featured('homepage').split(',').length, 3); assert.equal(featured('discovery').split(',').length, 4);
    cfg('editions.promo.homepage_visible', '2'); cfg('editions.promo.discovery_visible', '3');
    assert.equal(featured('homepage').split(',').length, 2); assert.equal(featured('discovery').split(',').length, 3);
  });
  test('stable daily rotation by hashtext(edition || day): the same order all day, and over days nobody is permanently first', () => {
    reset(); cfg('editions.promo.homepage_capacity', '6'); cfg('editions.promo.homepage_visible', '12');
    const eds = [live('BIZ_OWNER', O.BIZ), live('BIZ2_OWNER', O.BIZ2), live('HUB_OWNER', O.HUB), live('HUB2_OWNER', O.HUB2)]; const who: (keyof typeof USERS)[] = ['BIZ_OWNER', 'BIZ2_OWNER', 'HUB_OWNER', 'HUB2_OWNER'];
    eds.forEach((ed, i) => liveToday(who[i], ed, 'homepage', 7));
    const first = featured('homepage'); assert.equal(featured('homepage'), first, 'stable within a day');
    assert.equal(first, E.q(`select string_agg(slug, ',' order by hashtext(id::text || public.edition_promo_today()::text), id) from public.editions where id in ('${eds.join("','")}')`));
    const firsts = E.q(`select count(distinct f) from (select (select e.id from public.editions e where e.id in ('${eds.join("','")}') order by hashtext(e.id::text || (public.edition_promo_today() + g)::text), e.id limit 1) as f from generate_series(0, 29) g) x`);
    assert.ok(Number(firsts) >= 2, `the first place rotates (${firsts} different Editions led over 30 days)`);
  });
  test('the public rule: an unapproved, hidden, suspended, test, parent-paused or Editions-off Edition never appears, however it is booked', () => {
    reset(); liveToday('BIZ_OWNER', ED.BIZ, 'discovery', 14); const slug = slugOf(ED.BIZ);
    const shown = () => featured('discovery').split(',').includes(slug);
    assert.ok(shown());
    const cases: [string, string, string][] = [
      ['unapproved', `update public.editions set review_state='changes_requested' where id='${ED.BIZ}'`, `update public.editions set review_state='approved' where id='${ED.BIZ}'`],
      ['hidden (draft)', `update public.editions set status='draft' where id='${ED.BIZ}'`, `update public.editions set status='published' where id='${ED.BIZ}'`],
      ['suspended', `update public.editions set status='suspended' where id='${ED.BIZ}'`, `update public.editions set status='published' where id='${ED.BIZ}'`],
      ['test record', `set app.edition_test_mark='on'; update public.editions set is_test=true where id='${ED.BIZ}'; reset app.edition_test_mark`, `set app.edition_test_mark='on'; update public.editions set is_test=false where id='${ED.BIZ}'; reset app.edition_test_mark`],
      ['organiser suspended', `update public.edition_organisers set status='suspended' where id='${O.BIZ}'`, `update public.edition_organisers set status='verified' where id='${O.BIZ}'`],
      ['Business not active', `update public.local_businesses set is_active=false where id='${S.BIZ}'`, `update public.local_businesses set is_active=true where id='${S.BIZ}'`],
      ['publishing voided', `update public.edition_entitlements set voided_at=now(), void_reason='ZZ' where edition_id='${ED.BIZ}' and feature='publish'`, `update public.edition_entitlements set voided_at=null, void_reason=null where edition_id='${ED.BIZ}' and feature='publish'`],
      ['Editions switched off', `update admin_config set value='false' where key='editions.enabled'`, `update admin_config set value='true' where key='editions.enabled'`]];
    for (const [name, off, on] of cases) { const offOut = E.sup(off); assert.ok(!bad(offOut), `${name}: ${offOut.slice(0, 300)}`); assert.ok(!shown(), `${name}: must not appear`); E.sup(on); assert.ok(shown(), `${name}: back when restored`); }
  });
  test('the Hub parent being paused hides its Edition; an Edition that has already finished is not featured', () => {
    reset(); liveToday('HUB_OWNER', ED.HUB, 'discovery', 14); const slug = slugOf(ED.HUB);
    E.sup(`update public.hubs set is_active=false where id='${S.HUB}'`); assert.ok(!featured('discovery').includes(slug)); E.sup(`update public.hubs set is_active=true where id='${S.HUB}'`);
    assert.ok(featured('discovery').includes(slug));
    E.sup(`set session_replication_role = replica; update public.editions set starts_on = ${T(-5)}, ends_on = ${T(-4)} where id='${ED.HUB}'; set session_replication_role = origin`);
    assert.ok(!featured('discovery').includes(slug), 'finished');
    E.sup(`set session_replication_role = replica; update public.editions set starts_on = ${T(20)}, ends_on = ${T(22)} where id='${ED.HUB}'; set session_replication_role = origin`);
  });
  test('every call records one "shown" per row returned, on the right surface; a hidden Edition is not counted', () => {
    reset(); liveToday('BIZ_OWNER', ED.BIZ, 'homepage', 7); liveToday('BIZ2_OWNER', ED.BIZ2, 'discovery', 14);
    featured('homepage'); featured('homepage'); featured('discovery');
    const n = (ed: string, surface: string) => E.q(`select coalesce(sum(n), 0) from public.edition_promo_daily where edition_id='${ed}' and surface='${surface}' and metric='shown' and day = public.edition_promo_today()`);
    assert.equal(n(ED.BIZ, 'home'), '2'); assert.equal(n(ED.BIZ2, 'discovery'), '1'); assert.equal(n(ED.BIZ, 'discovery'), '0'); assert.equal(n(ED.BIZ2, 'home'), '0');
    E.sup(`update public.editions set status='draft' where id='${ED.BIZ}'`); featured('homepage'); E.sup(`update public.editions set status='published' where id='${ED.BIZ}'`);
    assert.equal(n(ED.BIZ, 'home'), '2');
  });
});

/* ── tracking and the report ───────────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('tracking and the campaign report', () => {
  const track = (ed: string, surface: string, metric: string, who: 'anon' | keyof typeof USERS = 'anon') => E.do(who, `select public.edition_promo_track('${ed}','${surface}','${metric}')`);
  const n = (ed: string, surface: string, metric: string) => Number(E.q(`select coalesce(sum(n), 0) from public.edition_promo_daily where edition_id='${ed}' and surface='${surface}' and metric='${metric}'`));
  test('counts only for a public Edition with a booking covering today; invalid input and everything else is silently ignored', () => {
    reset(); liveToday('BIZ_OWNER', ED.BIZ, 'homepage', 7);
    track(ED.BIZ, 'home', 'tap'); track(ED.BIZ, 'home', 'shown'); track(ED.BIZ, 'edition_page', 'view'); track(ED.BIZ, 'edition_page', 'view', 'STRANGER');
    assert.equal(n(ED.BIZ, 'home', 'tap'), 1); assert.equal(n(ED.BIZ, 'home', 'shown'), 1); assert.equal(n(ED.BIZ, 'edition_page', 'view'), 2);
    track(ED.BIZ, 'discovery', 'tap'); assert.equal(n(ED.BIZ, 'discovery', 'tap'), 0, 'no discovery booking today');
    track(ED.BIZ2, 'home', 'tap'); track(ED.BIZ2, 'edition_page', 'view'); assert.equal(n(ED.BIZ2, 'home', 'tap') + n(ED.BIZ2, 'edition_page', 'view'), 0, 'no booking');
    for (const [s, m] of [['nowhere', 'tap'], ['home', 'bought'], ['', ''], ['HOME', 'tap']]) assert.ok(!bad(track(ED.BIZ, s, m)), 'no error leaks');
    track(ED.BIZ, 'nowhere', 'tap'); assert.equal(count(`public.edition_promo_daily where surface not in ('home','discovery','edition_page')`), 0);
    assert.ok(!bad(E.do('anon', `select public.edition_promo_track(null,'home','tap')`)));
    assert.ok(!bad(E.do('anon', `select public.edition_promo_track(gen_random_uuid(),'home','tap')`)), 'an unknown Edition is ignored, not an error');
    E.sup(`update public.editions set status='draft' where id='${ED.BIZ}'`); track(ED.BIZ, 'home', 'tap'); E.sup(`update public.editions set status='published' where id='${ED.BIZ}'`);
    assert.equal(n(ED.BIZ, 'home', 'tap'), 1, 'a non-public Edition is not counted');
  });
  test('the per-key brake bounds what an anonymous caller can write (counts are indicative)', () => {
    reset(); liveToday('BIZ_OWNER', ED.BIZ, 'homepage', 7);
    E.do('anon', `select public.edition_promo_track('${ED.BIZ}','home','tap') from generate_series(1, 400)`);
    const got = n(ED.BIZ, 'home', 'tap'); assert.ok(got >= 120 && got <= 240, `capped near 120 per minute, got ${got}`);
    assert.equal(E.q(`select count(*) from public.edition_promo_track_rate where edition_id='${ED.BIZ}'`) >= '1', true);
  });
  test('the report follows the bookings: dates, kind, shown, taps, views, plus saves and plan-adds inside the window; editor and above only', () => {
    reset(); const b = liveToday('BIZ_OWNER', ED.BIZ, 'homepage', 7);
    featured('homepage'); featured('homepage'); track(ED.BIZ, 'home', 'tap'); track(ED.BIZ, 'edition_page', 'view'); track(ED.BIZ, 'edition_page', 'view'); track(ED.BIZ, 'edition_page', 'view');
    E.do('STRANGER', `select public.edition_save('${ED.BIZ}', true)`); E.do('BIZ2_OWNER', `select public.edition_save('${ED.BIZ}', true)`);
    E.sup(`insert into public.edition_saves (user_id, edition_id, created_at) values ('${USERS.HELPER}','${ED.BIZ}', now() - interval '40 days') on conflict do nothing`);
    const rep = E.one('BIZ_OWNER', `select kind || '|' || status || '|' || shown || '|' || taps || '|' || views || '|' || saves || '|' || plan_adds from public.edition_promo_report('${ED.BIZ}')`);
    assert.equal(rep, 'homepage|booked|2|1|3|2|0', 'the save from 40 days ago is outside the window');
    assert.equal(E.one('HELPER', `select count(*) from public.edition_promo_report('${ED.BIZ}')`), '1', 'an editor may read it');
    assert.equal(E.one('ADMIN', `select count(*) from public.edition_promo_report('${ED.BIZ}')`), '1');
    for (const who of ['STRANGER', 'BIZ2_OWNER', 'HUB_OWNER'] as const) assert.match(E.try(who, `select * from public.edition_promo_report('${ED.BIZ}')`), /not permitted/, who);
    assert.match(E.try('anon', `select * from public.edition_promo_report('${ED.BIZ}')`), /permission denied/);
    assert.equal(E.one('BIZ_OWNER', `select count(*) from public.edition_promo_report('${ED.BIZ_B}')`), '0', 'an Edition with no booking has an empty report');
    E.sup(`update public.edition_promo_bookings set status='cancelled', cancelled_at=now() where id='${b}'`);
    assert.equal(E.one('BIZ_OWNER', `select status from public.edition_promo_report('${ED.BIZ}')`), 'cancelled', 'reporting follows the booking, even once cancelled');
  });
});

/* ── admin calendar ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('admin calendar', () => {
  test('who is booked each day and the capacity use; names are for administrators only', () => {
    reset(); book('BIZ_OWNER', grant(ED.BIZ, 'homepage', 7), 10); book('BIZ2_OWNER', grant(ED.BIZ2, 'homepage', 7), 12); book('HUB_OWNER', grant(ED.HUB, 'discovery', 14), 10);
    assert.equal(E.one('ADMIN', `select string_agg(kind || ':' || capacity || ':' || booked, ',' order by kind) from public.admin_edition_promo_calendar(${T(12)}, ${T(12)})`), 'discovery:6:1,homepage:3:2');
    assert.equal(E.one('ADMIN', `select string_agg(kind || ':' || capacity || ':' || booked, ',' order by kind) from public.admin_edition_promo_calendar(${T(13)}, ${T(13)})`), 'discovery:6:1,homepage:3:2');
    assert.equal(E.one('ADMIN', `select count(*) from public.admin_edition_promo_calendar(${T(0)}, ${T(29)})`), '60');
    assert.match(E.one('ADMIN', `select bookings::text from public.admin_edition_promo_calendar(${T(13)}, ${T(13)}) where kind='homepage'`), /ZZ Test Cafe|ZZ Other Shop/);
    assert.equal(hint(E.try('ADMIN', `select * from public.admin_edition_promo_calendar(${T(0)}, ${T(500)})`)), 'bad_range');
    for (const who of ['BIZ_OWNER', 'HELPER', 'STRANGER', 'anon'] as const) assert.match(E.try(who, `select * from public.admin_edition_promo_calendar(${T(0)}, ${T(5)})`), /admins only|permission denied/, who);
    reset();
  });
});

/* ── exposure and attacks ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('security: exposure, attacks and the catalogue of grants', () => {
  const PROMO_FNS = ['edition_my_promo_rights(uuid)', 'edition_promo_availability(text,date,date)', 'edition_promo_book(uuid,date)', 'edition_promo_book_campaign(uuid,uuid,date,date)', 'edition_promo_cancel(uuid)', 'edition_promo_reschedule(uuid,date)',
    'edition_promo_report(uuid)', 'edition_promo_settings()', 'admin_edition_promo_calendar(date,date)', 'admin_promo_cancel(uuid,text)', 'admin_promo_reschedule(uuid,date,text)', 'admin_grant_promo_right(uuid,text,integer,text)'];
  const INTERNAL = ['edition_promo_lock()', 'edition_promo_validate(uuid,text,date,integer,uuid,boolean)', 'edition_promo_cancel_core(uuid,text)', 'edition_promo_reschedule_core(uuid,date,boolean,text)', 'edition_promo_void_order_rights(uuid)', 'edition_promo_cfg_int(text,integer)',
    'edition_package_grants_ok(jsonb)', 'edition_promo_rights_guard()', 'edition_promo_bookings_guard()'];
  const priv = (who: 'anon' | 'authenticated' | 'service_role', f: string) => E.q(`select has_function_privilege('${who}', 'public.${f}', 'execute')`) === 't';
  test('anonymous visitors can execute edition_featured and edition_promo_track and NOTHING else of the promotion surface', () => {
    for (const f of ['edition_featured(text)', 'edition_promo_track(uuid,text,text)']) assert.ok(priv('anon', f), f);
    for (const f of [...PROMO_FNS, ...INTERNAL, 'edition_create_order(uuid,uuid,uuid,text)', 'edition_claim_free_package(uuid,uuid,uuid,text)', 'edition_fulfil_order(uuid,text,integer)', 'edition_refund_order(uuid,integer)',
      'admin_upsert_edition_package(text,text,text,integer,integer,jsonb,integer,boolean,integer,boolean,text,jsonb)', 'edition_available_packages(uuid)']) assert.ok(!priv('anon', f), f);
    assert.equal(E.q(`select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like '%promo%' or p.proname='edition_featured') and has_function_privilege('anon', p.oid, 'execute')`), '2');
    assert.equal(E.q(`select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like '%promo%' or p.proname='edition_featured') and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')`), '0', 'no PUBLIC grant');
  });
  test('signed-in users run only the people functions; the internals and the money-in functions are closed to every client role; the service role keeps fulfil and refund', () => {
    for (const f of PROMO_FNS) assert.ok(priv('authenticated', f), f);
    for (const f of INTERNAL) { assert.ok(!priv('authenticated', f), f); assert.ok(!priv('anon', f), f); }
    for (const f of ['edition_fulfil_order(uuid,text,integer)', 'edition_refund_order(uuid,integer)']) { assert.ok(!priv('authenticated', f), f); assert.ok(priv('service_role', f), f); }
    for (const who of ['BIZ_OWNER', 'ADMIN', 'HUB_OWNER'] as const) {
      assert.match(E.try(who, `select public.edition_promo_validate('${ED.BIZ}','homepage',${T(10)},7,null,true)`), /permission denied/, who);
      assert.match(E.try(who, `select public.edition_promo_cancel_core(gen_random_uuid(),'x')`), /permission denied/, who);
      assert.match(E.try(who, `select public.edition_promo_void_order_rights(gen_random_uuid())`), /permission denied/, who);
      assert.match(E.try(who, `select public.edition_fulfil_order(gen_random_uuid(),'pi_x',1)`), /permission denied/, who);
    }
  });
  test('every promotion function is SECURITY DEFINER with a pinned search_path (the pure date helper is invoker)', () => {
    assert.equal(E.q(`select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like 'edition_promo_%' or p.proname in ('edition_featured','admin_edition_promo_calendar','admin_promo_cancel','admin_promo_reschedule','admin_grant_promo_right','edition_my_promo_rights')) and p.proname not in ('edition_promo_today','edition_promo_rights_guard','edition_promo_bookings_guard') and (not p.prosecdef or p.proconfig::text not ilike '%search_path%')`), '0');
    assert.equal(E.q(`select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like 'edition_promo_%' or p.proname like 'admin_%promo%' or p.proname in ('edition_featured','edition_my_promo_rights','edition_package_grants_ok')) and p.proconfig::text not ilike '%search_path%'`), '0', 'all pinned');
  });
  test('no client write path: signed-in users and anon cannot insert, update or delete any promotion table; reads are by membership only', () => {
    reset(); const r = grant(ED.BIZ, 'homepage', 7); const b = book('BIZ_OWNER', r, 10);
    for (const who of ['BIZ_OWNER', 'ADMIN', 'STRANGER', 'anon'] as const) for (const t of ['edition_promo_rights', 'edition_promo_bookings', 'edition_promo_daily', 'edition_promo_track_rate']) {
      assert.match(E.try(who, `insert into public.${t} select * from public.${t} limit 1; delete from public.${t}`), /permission denied/, `${who} ${t}`);
      assert.match(E.try(who, `update public.${t} set edition_id = edition_id`), /permission denied/, `${who} ${t}`);
    }
    assert.match(E.try('BIZ_OWNER', `update public.edition_promo_bookings set starts_on = starts_on + 1 where id='${b}'`), /permission denied/);
    assert.match(E.try('BIZ_OWNER', `insert into public.edition_promo_bookings (edition_id, organiser_id, right_id, kind, starts_on, ends_on) values ('${ED.BIZ}','${O.BIZ}','${r}','homepage', ${T(30)}, ${T(36)})`), /permission denied/);
    assert.match(E.try('anon', `select * from public.edition_promo_rights`), /permission denied/);
    assert.match(E.try('anon', `select * from public.edition_promo_bookings`), /permission denied/);
    assert.match(E.try('BIZ_OWNER', `select * from public.edition_promo_track_rate`), /permission denied/);
    assert.equal(E.one('BIZ_OWNER', `select count(*) from public.edition_promo_rights`), '1'); assert.equal(E.one('HELPER', `select count(*) from public.edition_promo_bookings`), '1');
    for (const who of ['STRANGER', 'BIZ2_OWNER', 'HUB_OWNER'] as const) { assert.equal(E.one(who, `select count(*) from public.edition_promo_rights`), '0', who); assert.equal(E.one(who, `select count(*) from public.edition_promo_bookings`), '0', who); assert.equal(E.one(who, `select count(*) from public.edition_promo_daily`), '0', who); }
    assert.equal(E.one('ADMIN', `select count(*) from public.edition_promo_rights`), '1');
    assert.equal(E.q(`select count(*) from pg_policies where tablename like 'edition_promo_%' and cmd <> 'SELECT'`), '0'); assert.equal(E.q(`select count(*) from pg_class where relname like 'edition_promo_%' and relkind='r' and not relrowsecurity`), '0');
    reset();
  });
  test('table guards hold even for a database owner: rights are append-only, a booking must match its right, a live right is booked once, nothing is deletable', () => {
    reset(); const r = grant(ED.BIZ, 'homepage', 7); const b = book('BIZ_OWNER', r, 10);
    assert.match(E.sup(`update public.edition_promo_rights set days = 14 where id='${r}'`), /append-only/);
    assert.match(E.sup(`delete from public.edition_promo_rights where id='${r}'`), /cannot be deleted/);
    assert.match(E.sup(`delete from public.edition_promo_bookings where id='${b}'`), /cannot be deleted/);
    assert.match(E.sup(`update public.edition_promo_bookings set ends_on = ends_on + 3 where id='${b}'`), /must match its right/);
    assert.match(E.sup(`update public.edition_promo_bookings set edition_id = '${ED.BIZ2}' where id='${b}'`), /must match its right|only the dates/);
    assert.match(E.sup(`insert into public.edition_promo_bookings (edition_id, organiser_id, right_id, kind, starts_on, ends_on) values ('${ED.BIZ}','${O.BIZ}','${r}','homepage', ${T(40)}, ${T(46)})`), /edition_promo_bookings_right_live_uq/);
    assert.match(E.sup(`insert into public.edition_promo_bookings (edition_id, organiser_id, right_id, kind, starts_on, ends_on) values ('${ED.BIZ}','${O.BIZ}','${r}','discovery', ${T(40)}, ${T(46)})`), /must match its right/);
    E.sup(`update public.edition_promo_bookings set status='cancelled', cancelled_at=now() where id='${b}'`);
    assert.match(E.sup(`update public.edition_promo_bookings set status='booked', cancelled_at=null where id='${b}'`), /cannot be revived/);
    assert.match(E.sup(`update public.edition_promo_bookings set status='cancelled', cancelled_at=null where id='${b}'`), /edition_promo_bookings_cancel_stamp/);
    reset();
  });
  test('a promotion can never create publishing: no code path inserts a publish entitlement except the package branch of fulfilment', () => {
    reset(); const ed = live('BIZ_OWNER', O.BIZ); const before = count(`public.edition_entitlements where edition_id='${ed}'`);
    grant(ed, 'discovery', 14); grant(ed, 'homepage', 7); book('BIZ_OWNER', E.q(`select id from public.edition_promo_rights where edition_id='${ed}' and kind='discovery'`), 10);
    assert.equal(count(`public.edition_entitlements where edition_id='${ed}'`), before);
    assert.equal(E.q(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like '%promo%' and prosrc ilike '%edition_entitlements%' and prosrc ilike '%insert into public.edition_entitlements%'`), '0');
    assert.equal(E.q(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like '%promo%' and prosrc ilike '%update public.edition_entitlements%'`), '0');
    reset();
  });
  test('the catalogue stays administrator-written: signed-in users cannot write packages; anon reads nothing; money functions stay closed', () => {
    for (const who of ['BIZ_OWNER', 'HUB_OWNER', 'anon'] as const) { assert.match(E.try(who, `update public.edition_packages set price_pence = 1`), /permission denied/, who); assert.match(E.try(who, `insert into public.edition_orders (organiser_id, edition_id, package_id, buyer_id, amount_pence, package_snapshot, attempt_id) select organiser_id, edition_id, package_id, buyer_id, 0, '{}', 'x' from public.edition_orders`), /permission denied/, who); }
    assert.match(E.try('anon', `select * from public.edition_packages`), /permission denied/);
  });
  test('the new surface leaves the Editions anonymous allow-list at exactly the two reviewed additions', () => {
    assert.equal(E.q(`select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text collate "C") from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname ilike '%edition%') and has_function_privilege('anon', p.oid, 'execute')`),
      'edition_business_role(uuid),edition_controls_business(uuid),edition_entitled(uuid,text,timestamp with time zone),edition_featured(text),edition_is_public(uuid),edition_parent_live(uuid),edition_participation_ok(uuid),edition_promo_track(uuid,text,text),edition_public_tiers(text),edition_role_rank(text),editions_enabled()');
  });
});
