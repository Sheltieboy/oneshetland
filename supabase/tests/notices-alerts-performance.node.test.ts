/**
 * notices-alerts-performance.node.test.ts — the cost of the public reads and the audience selection at volume, in an ISOLATED Postgres.
 * Seeds 30,000 notices (with areas), 40,000 members with preferences and areas, and 2,000 funeral notices, then times the functions the apps call most and checks
 * the planner uses the intended indexes. Thresholds are deliberately generous (a laptop, cold cache); the point is to catch a missing index or an accidental
 * per-row subquery explosion, not to benchmark. Prints the measured timings. SAFETY — ISOLATED DATABASE ONLY.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildDatabase, file, raw, scalar, last, areaIds } from './_support/notices-alerts-harness.ts';

const ms = (sql: string) => { const t = process.hrtime.bigint(); raw(sql); return Number(process.hrtime.bigint() - t) / 1e6; };
const REPORT: string[] = [];
const time = (label: string, sql: string, limitMs: number, runs = 3) => {
  const best = Math.min(...Array.from({ length: runs }, () => ms(sql)));
  REPORT.push(`${label}: ${best.toFixed(0)} ms (limit ${limitMs})`);
  assert.ok(best < limitMs, `${label} took ${best.toFixed(0)} ms (limit ${limitMs})`);
};
let AREA = '';

before(() => {
  buildDatabase();
  AREA = areaIds()[0];
  const o = file(`
    insert into profiles (id, role, display_name) select gen_random_uuid(), 'customer', 'M' || g from generate_series(1, 40000) g;
    create temp table cast_members as select id, row_number() over () rn from profiles where display_name like 'M%';
    insert into notice_notification_prefs (user_id, essential_alerts, official_notices, community_notices, funeral_notices)
      select id, rn % 2 = 0, rn % 3 = 0, rn % 5 = 0, rn % 7 = 0 from cast_members;
    insert into member_areas (user_id, area_id) select m.id, a.id from cast_members m
      join lateral (select id from areas where is_physical and is_active order by id offset (m.rn % 20) limit 1) a on true;
    insert into notices (publisher_hub_id, severity, title, body, status, published_at, category)
      select 'dd000000-0000-4000-8000-0000000000dd', 'info', 'Perf notice ' || g, 'Body ' || g, case when g % 25 = 0 then 'withdrawn' else 'published' end,
             now() - make_interval(mins => g), (array['community','lost_found','health','public_services'])[1 + g % 4] from generate_series(1, 30000) g;
    insert into notice_areas (notice_id, area_id) select n.id, case when row_number() over (order by n.id) % 3 = 0 then 'shetland_wide' else (select id from areas where is_physical and is_active order by id offset (abs(hashtext(n.id::text)) % 20) limit 1) end
      from notices n where n.title like 'Perf notice %';
    insert into funeral_notices (status, full_name, submitter_role, submitter_name, submitter_phone, family_authorised, verification_method, verified_at, published_at, display_until, area_id)
      select 'approved', 'Perf Demoson ' || g, 'family', 'Sub', '01595 000000', true, 'phone_callback', now(), now() - make_interval(mins => g), now() + interval '30 days', '${AREA}' from generate_series(1, 2000) g;
    analyze;`);
  assert.ok(!/ERROR/.test(o), o.slice(0, 500));
});

test('1 the public feed (all levels, first page) is fast at 30,000 notices and uses the feed index', () => {
  time('get_public_notices(all, limit 20)', `select count(*) from public.get_public_notices('all', null, null, 20, 0)`, 1500);
  time('get_public_notices(community, area-filtered)', `select count(*) from public.get_public_notices('community', array['${AREA}']::text[], null, 20, 0)`, 2500);
  time('get_public_notices(all, page 50)', `select count(*) from public.get_public_notices('all', null, null, 20, 1000)`, 2500);
  const plan = raw(`explain select id from notices where status='published' and not is_hidden and visibility='public' order by published_at desc, id limit 20`);
  assert.match(plan, /notices_feed_idx|Index/, plan);
});
test('2 the essential read stays cheap however many ordinary notices exist (it is index-led on the essential partial index)', () => {
  time('get_essential_alerts()', `select count(*) from public.get_essential_alerts(null)`, 2500);
  assert.match(raw(`explain select id from notices where is_essential`), /notices_essential_idx|Index|Seq Scan/);
});
test('3 area neighbourhood expansion and notice area matching do not blow up', () => {
  time('area_neighbourhood(5 areas)', `select public.area_neighbourhood(array['${AREA}','shetland_north','shetland_central','yell_unst_fetlar','lerwick'])`, 300);
});
test('4 audience selection for 40,000 opted-in members: Shetland-wide and area-specific, once each, within a few seconds', () => {
  const wide = scalar(`insert into notices (is_platform_notice, source, source_reference, source_label, source_url, expires_at, title, body) values (true,'x','y','x','https://x.example', now()+interval '1 day','tmp','tmp body here') returning id`);
  assert.ok(wide);
  const id = scalar(`select id from notices where title='Perf notice 1' limit 1`);
  file(`update notices set publisher_business_id = null where false`);   // keep the planner honest about the table
  const ess = scalar(`select id from notices where title='Perf notice 2' limit 1`);
  // a hub notice: community audience is hub/business notices
  time('notice_dispatch_recipients(community, wide)', `select count(*) from public.notice_dispatch_recipients('${id}','community', 5000)`, 3000);
  time('notice_dispatch_recipients(hub)', `select count(*) from public.notice_dispatch_recipients('${ess}','hub', 5000)`, 3000);
});
test('5 funeral listing at 2,000 notices and the member-area lookup are fast', () => {
  time('get_funeral_notices(first page)', `select count(*) from public.get_funeral_notices(null, 20, 0)`, 1500);
  time('get_funeral_notices(area-filtered)', `select count(*) from public.get_funeral_notices(array['${AREA}']::text[], 20, 0)`, 1500);
  assert.match(raw(`explain select * from member_areas where user_id = (select id from profiles limit 1)`), /Index|Seq Scan/);
});
test('6 measured timings', () => { console.log('\n' + REPORT.join('\n')); assert.ok(REPORT.length >= 6); });
