/**
 * geography-foundation.node.test.ts — Geography Stage 2A: the canonical geography layer, proven in an ISOLATED Postgres.
 *
 * WHAT THIS PROVES
 *  · the seven official localities exist with stable IDs and the right parent; shetland_wide is a scope (Level 0), not a place;
 *  · the resolver is exact, not fuzzy: "Westside" -> shetland_west, "Central Mainland" -> shetland_central, "Skerries" -> out_skerries, Nesting sits beneath shetland_north;
 *  · uncertain values are never silently resolved (Hamnavoe, Isles, bare "Central", Medium places, Foula, Papa Stour, "Main Street");
 *  · "Shetland" (an address that says only that) is UNRESOLVED — not shetland_wide;
 *  · Remote / Hybrid / Offshore / Marine are non_geographic, never a locality; test fixtures and category labels are invalid;
 *  · ordinary users cannot write the reference data, admins can, anon reads only ACTIVE rows, the review queue is admin-only;
 *  · the migration adds ONLY new objects: every pre-existing stub content row, column, policy and function is byte-identical afterwards;
 *  · the TypeScript normaliser equals the SQL one.
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a Supabase DSN. No network, no production row.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseGeoText, GEO_LOCALITIES, SHETLAND_WIDE } from '../../lib/geography.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = readFileSync(join(ROOT, 'supabase/tests/_support/geography-prefix-schema.sql'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20261127000000_canonical_geography_foundation.sql'), 'utf8');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
if (!DSN) throw new Error('PASS_PROOF_DSN is required (isolated database only) — run via `npm run test:isolated`');
if (/supabase/i.test(DSN)) throw new Error('refusing to run against a Supabase DSN');

const run = (args: string[], input?: string) => { const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], { input, encoding: 'utf8', timeout: 180_000 }); return `${r.stdout ?? ''}${r.stderr ?? ''}`; };
const raw = (sql: string) => run(['-c', sql]);
const file = (sql: string) => run([], sql);
const scalar = (sql: string) => raw(sql).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
const ok = (out: string) => !/ERROR|violates|denied|permission/i.test(out);
const ADM = 'e0000000-0000-4000-8000-0000000000e1', USER = 'a0000000-0000-4000-8000-0000000000a1';
type Who = 'admin' | 'user' | 'anon' | 'service';
const as = (who: Who, sql: string) => {
  const role = who === 'service' ? 'service_role' : who === 'anon' ? 'anon' : 'authenticated';
  const sub = who === 'admin' ? ADM : who === 'user' ? USER : '';
  return raw(`set role ${role}; select set_config('request.jwt.claim.sub','${sub}',false); ${sql}; reset role;`);
};
const R = (input: string) => JSON.parse(scalar(`select public.resolve_geography($v$${input}$v$)::text`));

const TABLES = ['jobs', 'events', 'local_businesses', 'notices', 'hubs', 'profiles', 'regions', 'runs', 'delivery_requests'];
const fingerprint = () => TABLES.map((t) => `${t}:${scalar(`select md5(coalesce(string_agg(md5(to_jsonb(x)::text), ',' order by md5(to_jsonb(x)::text)), '')) from ${t} x`)}`).join('|');
const catalogue = () => scalar(`select md5(string_agg(x, ',' order by x)) from (
  select 'col:'||table_name||'.'||column_name||':'||data_type from information_schema.columns where table_schema='public' and table_name in (${TABLES.map((t) => `'${t}'`).join(',')})
  union all select 'pol:'||tablename||'.'||policyname from pg_policies where schemaname='public' and tablename in (${TABLES.map((t) => `'${t}'`).join(',')})
  union all select 'fn:'||proname||md5(prosrc) from pg_proc where pronamespace='public'::regnamespace and proname in ('is_admin')) y`);
const relations = () => raw(`select string_agg(relname, ',' order by relname) from pg_class where relnamespace='public'::regnamespace and relkind in ('r','v','S')`).trim();
const functions = () => raw(`select string_agg(proname, ',' order by proname) from pg_proc where pronamespace='public'::regnamespace`).trim();

let BEFORE = { fp: '', cat: '', rel: '', fn: '' };
before(() => {
  const o = file(PREFIX); assert.doesNotMatch(o, /ERROR/i, `prefix failed:\n${o.slice(0, 800)}`);
  file(`insert into profiles (id, role, location_area) values ('${ADM}','admin',null), ('${USER}','customer','Burra');
        insert into regions (slug, name, display_order) values ('central-mainland','Central Mainland',3), ('lerwick','Lerwick',1);
        insert into jobs (title, locality, location) values ('A job','Westside','Shetland'), ('B job','Shetland-wide','Shetland (see advert)');
        insert into events (title, locality, venue) values ('An event','Lerwick','Mareel'), ('Another','Nesting','Hall');
        insert into local_businesses (name, address, lat, lng) values ('Biz','Shetland',60.15,-1.14), ('Fixture','London',null,null), ('Site','Archaeological site, Shetland',59.5,-1.6);
        insert into notices (title, locality) values ('N','Skerries');
        insert into hubs (name, area) values ('H','Remote / hybrid');
        insert into runs (origin_region_id) select id from regions limit 1;
        insert into delivery_requests (destination_region_id, destination_address) select id, 'Roadside, Hamnavoe ZE2 9LA' from regions limit 1;`);
  BEFORE = { fp: fingerprint(), cat: catalogue(), rel: relations(), fn: functions() };
  const m = file(MIGRATION); assert.doesNotMatch(m, /ERROR/i, `migration failed:\n${m.slice(0, 1500)}`);
});

describe('existing content is untouched; only new objects appear', () => {
  test('every stub content row is byte-identical after the migration', () => assert.equal(fingerprint(), BEFORE.fp));
  test('columns, policies and is_admin() on the content tables are identical', () => assert.equal(catalogue(), BEFORE.cat));
  test('the only new relations are the three geography tables (and their sequences)', () => {
    const now = new Set(relations().split(',')), was = new Set(BEFORE.rel.split(','));
    const added = [...now].filter((r) => !was.has(r)).sort();
    assert.deepEqual(added, ['areas', 'geography_review', 'geography_review_id_seq', 'place_aliases', 'place_aliases_id_seq']);
    assert.ok([...was].every((r) => now.has(r)), 'nothing was removed');
  });
  test('the only new functions are the geography helpers; no existing function changed', () => {
    const now = new Set(functions().split(',')), was = new Set(BEFORE.fn.split(','));
    assert.deepEqual([...now].filter((f) => !was.has(f)).sort(), ['geo_normalise', 'resolve_geography', 'tg_areas_validate', 'tg_geo_touch', 'tg_place_aliases_validate']);
  });
  test('no existing content table gained a policy or trigger', () => {
    assert.equal(scalar(`select count(*) from pg_policies where tablename in (${TABLES.map((t) => `'${t}'`).join(',')})`), '0');
    assert.equal(scalar(`select count(*) from pg_trigger t where not tgisinternal and tgrelid in (${TABLES.map((t) => `'public.${t}'::regclass`).join(',')})`), '0');
  });
});

describe('Level 0 and Level 1', () => {
  test('shetland_wide exists as the one Level 0 scope: type shetland, no parent, NOT physical', () => {
    assert.equal(scalar(`select type||'|'||coalesce(parent_id,'-')||'|'||is_physical from areas where id='shetland_wide'`), 'shetland|-|false');
    assert.equal(scalar(`select count(*) from areas where type='shetland'`), '1');
  });
  test('exactly the seven official localities exist, with stable IDs, official names, display names and shetland_wide as parent', () => {
    const rows = scalar(`select string_agg(id||'='||name_official||'='||name_display, ';' order by sort_order) from areas where type='locality'`).split(';');
    assert.deepEqual(rows, [
      'lerwick_bressay=Lerwick & Bressay=Lerwick & Bressay',
      'shetland_central=Shetland Central=Central Mainland',
      'shetland_north=Shetland North=North Mainland',
      'shetland_south=Shetland South=South Mainland',
      'shetland_west=Shetland West=West Mainland / Westside',
      'whalsay_skerries=Whalsay & Skerries=Whalsay & Skerries',
      'yell_unst_fetlar=Yell, Unst & Fetlar=Yell, Unst & Fetlar / North Isles',
    ]);
    assert.deepEqual(GEO_LOCALITIES.length, 7);
    assert.equal(scalar(`select count(*) from areas where type='locality' and parent_id='shetland_wide' and is_active`), '7');
  });
  test('population, data-zone count, PHS and SIC names are recorded from the audit', () => {
    assert.equal(scalar(`select (metadata->>'population_2024_25')||'/'||(metadata->>'data_zones_phs_2024_05')||'/'||(metadata->>'phs_lookup_name') from areas where id='yell_unst_fetlar'`), '1542/2/North Isles');
    // The seven figures sum to 22,940; the report rounds the Shetland total to 22,900.
    assert.equal(scalar(`select sum((metadata->>'population_2024_25')::int) from areas where type='locality'`), '22940');
  });
  test('boundary_ref exists and is empty everywhere (no polygons in this stage)', () => assert.equal(scalar(`select count(boundary_ref) from areas`), '0'));
});

describe('places', () => {
  test('High-confidence places are active and sit beneath the verified locality', () => {
    assert.equal(scalar(`select count(*) from areas where confidence='high' and type in ('settlement','island','area','site') and is_active`), '37');
    for (const [id, parent] of [['lerwick', 'lerwick_bressay'], ['bressay', 'lerwick_bressay'], ['scalloway', 'shetland_central'], ['burra', 'shetland_central'], ['trondra', 'shetland_central'], ['tingwall', 'shetland_central'],
      ['brae', 'shetland_north'], ['voe', 'shetland_north'], ['northmavine', 'shetland_north'], ['delting', 'shetland_north'], ['sandwick', 'shetland_south'], ['gulberwick', 'shetland_south'], ['fair_isle', 'shetland_south'],
      ['walls', 'shetland_west'], ['aith', 'shetland_west'], ['whalsay', 'whalsay_skerries'], ['out_skerries', 'whalsay_skerries'], ['yell', 'yell_unst_fetlar'], ['unst', 'yell_unst_fetlar'], ['fetlar', 'yell_unst_fetlar']]) {
      assert.equal(scalar(`select parent_id from areas where id='${id}'`), parent, id);
    }
  });
  test('Nesting is beneath shetland_north (the transit data wrongly puts it in Central) and resolves there', () => {
    assert.equal(scalar(`select parent_id from areas where id='nesting'`), 'shetland_north');
    const r = R('Nesting'); assert.equal(r.status, 'resolved'); assert.equal(r.area_id, 'nesting'); assert.equal(r.locality_id, 'shetland_north');
  });
  test('Medium-confidence places are registered with their evidence but are NOT auto-resolved', () => {
    assert.equal(scalar(`select count(*) from areas where confidence='medium' and type in ('settlement','island','area','site')`), '8');
    for (const v of ['Sumburgh', 'Noss', 'Toft', 'Mousa', 'Sullom Voe']) {
      const r = R(v); assert.equal(r.status, 'unresolved', v); assert.equal(r.reason, 'confidence_below_high'); assert.equal(r.area_id, null); assert.equal(r.candidate_ids.length, 1);
    }
    assert.ok(scalar(`select evidence from areas where id='sumburgh'`).length > 5);
  });
  test('Foula and Papa Stour are pending: no parent, inactive, never resolved, never silently assigned', () => {
    for (const id of ['foula', 'papa_stour']) {
      assert.equal(scalar(`select coalesce(parent_id,'NULL')||'|'||is_active||'|'||confidence from areas where id='${id}'`), 'NULL|false|low');
    }
    for (const v of ['Foula', 'Papa Stour']) { const r = R(v); assert.equal(r.status, 'unresolved'); assert.equal(r.area_id, null); assert.equal(r.locality_id, null); assert.equal(r.reason, 'area_inactive_or_pending'); }
    assert.ok(!ok(raw(`insert into areas (id,slug,name_official,name_display,type,parent_id,confidence) values ('zz_pending','zz-pending','Z','Z','island',null,'low')`)), 'a parentless place must be inactive');
  });
});

describe('the resolver is exact, not fuzzy', () => {
  test('Westside -> shetland_west; Central Mainland -> shetland_central; Skerries -> out_skerries', () => {
    assert.equal(R('Westside').area_id, 'shetland_west'); assert.equal(R('Westside').status, 'resolved');
    assert.equal(R('  WESTSIDE ').area_id, 'shetland_west');
    assert.equal(R('Central Mainland').area_id, 'shetland_central');
    assert.equal(R('Skerries').area_id, 'out_skerries'); assert.equal(R('Skerries').locality_id, 'whalsay_skerries');
    assert.equal(R('Out Skerries').area_id, 'out_skerries');
  });
  test('official, PHS and display names all reach the same locality; the original input is preserved', () => {
    for (const [v, id] of [['Shetland North', 'shetland_north'], ['North Mainland', 'shetland_north'], ['Shetland South', 'shetland_south'], ['South Mainland', 'shetland_south'], ['West Mainland', 'shetland_west'], ['Shetland West', 'shetland_west'],
      ['North Isles', 'yell_unst_fetlar'], ['Yell, Unst & Fetlar', 'yell_unst_fetlar'], ['Lerwick & Bressay', 'lerwick_bressay'], ['Whalsay and Skerries', 'whalsay_skerries'], ['Shetland Central', 'shetland_central']]) {
      const r = R(v); assert.equal(r.area_id, id, v); assert.equal(r.locality_id, id); assert.equal(r.input, v);
    }
  });
  test('"X, Shetland" resolves like X; place names resolve to their place and locality', () => {
    assert.equal(R('Lerwick, Shetland').area_id, 'lerwick'); assert.equal(R('Lerwick, Shetland Islands, Scotland').area_id, 'lerwick');
    const r = R('Unst'); assert.deepEqual([r.area_id, r.locality_id, r.area_type], ['unst', 'yell_unst_fetlar', 'island']);
    assert.equal(R('Brae / Sullom Voe').area_id, 'shetland_north');
  });
  test('no fuzzy matching: near-misses, extra words and venue/street names are unresolved', () => {
    for (const v of ['Lerwik', 'Lerwick Road', 'Mareel', 'Commercial Street', 'Main Street, Shetland', 'North of Lerwick', 'unst hall']) { const r = R(v); assert.equal(r.status, 'unresolved', v); assert.equal(r.reason, 'no_match', v); assert.equal(r.area_id, null); }
  });
  test('ambiguous values return ambiguous with candidates, never a guess (Hamnavoe, Isles)', () => {
    const h = R('Hamnavoe'); assert.equal(h.status, 'ambiguous'); assert.equal(h.area_id, null); assert.deepEqual(h.candidate_ids, ['burra']);
    const i = R('Isles'); assert.equal(i.status, 'ambiguous'); assert.deepEqual([...i.candidate_ids].sort(), ['whalsay_skerries', 'yell_unst_fetlar']);
  });
  test('bare compass words are registered but never auto-resolved ("Central, Shetland" is a business address in production)', () => {
    for (const v of ['Central', 'North', 'South', 'West', 'Central, Shetland']) { const r = R(v); assert.equal(r.status, 'unresolved', v); assert.equal(r.area_id, null); assert.equal(r.reason, 'confidence_below_high'); }
    assert.equal(R('Central').candidate_ids[0], 'shetland_central');
  });
  test('empty and null-ish input is unresolved', () => {
    for (const v of ['', '   ', '--', ',']) assert.equal(R(v).reason, 'empty');
    assert.equal(JSON.parse(scalar(`select public.resolve_geography(null)::text`)).status, 'unresolved');
  });
  test('the resolver is read-only: resolving writes nothing', () => {
    const before = scalar(`select (select count(*) from place_aliases)||'/'||(select count(*) from geography_review)||'/'||(select count(*) from areas)`);
    R('Atlantis'); R('Westside');
    assert.equal(scalar(`select (select count(*) from place_aliases)||'/'||(select count(*) from geography_review)||'/'||(select count(*) from areas)`), before);
  });
});

describe('Shetland-wide is a scope, distinct from unknown', () => {
  test('"Shetland-wide" (and variants) resolve to the shetland_wide scope', () => {
    for (const v of ['Shetland-wide', 'shetland wide', 'All Shetland', 'all-shetland']) { const r = R(v); assert.equal(r.status, 'resolved', v); assert.equal(r.area_id, SHETLAND_WIDE); assert.equal(r.is_shetland_wide, true); assert.equal(r.locality_id, null); assert.equal(r.area_type, 'shetland'); }
  });
  test('an address that says only "Shetland" is UNRESOLVED (unspecified), never shetland_wide', () => {
    for (const v of ['Shetland', 'Shetland Islands', 'Shetland Islands, Scotland', 'shetland']) { const r = R(v); assert.equal(r.status, 'unresolved', v); assert.equal(r.reason, 'unspecified_within_shetland'); assert.equal(r.area_id, null); assert.equal(r.is_shetland_wide, false); }
  });
  test('"Shetland (see advert)" is only a candidate for the scope; a value nobody has classified is unknown, not Shetland-wide', () => {
    const a = R('Shetland (see advert), Shetland Islands'); assert.equal(a.status, 'unresolved'); assert.equal(a.is_shetland_wide, false); assert.deepEqual(a.candidate_ids, ['shetland_wide']);
    const u = R('Somewhere unclassified'); assert.deepEqual([u.status, u.reason, u.is_shetland_wide, u.area_id], ['unresolved', 'no_match', false, null]);
  });
  test('shetland_wide is not a settlement: it cannot be a place alias target or have a parent', () => {
    assert.ok(!ok(raw(`insert into place_aliases (alias, kind, area_id, confidence) values ('whole place','place','shetland_wide','high')`)));
    assert.ok(!ok(raw(`insert into areas (id,slug,name_official,name_display,type,parent_id,confidence) values ('zz_x','zz-x','X','X','settlement','shetland_wide','high')`)), 'a settlement must sit beneath a locality');
    assert.ok(!ok(raw(`update areas set parent_id='lerwick_bressay' where id='shetland_wide'`)));
  });
});

describe('Remote / Hybrid / Offshore / Marine are work context, not geography', () => {
  test('they resolve as non_geographic with no area', () => {
    for (const v of ['Remote', 'Hybrid', 'Remote / hybrid', 'Offshore', 'Marine', 'Offshore / marine']) { const r = R(v); assert.equal(r.status, 'non_geographic', v); assert.equal(r.area_id, null); assert.equal(r.locality_id, null); }
  });
  test('no area, slug or name in the registry is remote, hybrid, offshore or marine', () => {
    assert.equal(scalar(`select count(*) from areas where lower(id||' '||slug||' '||name_official||' '||name_display) ~ '(remote|hybrid|offshore|marine)'`), '0');
    assert.equal(scalar(`select count(*) from place_aliases where area_id is not null and alias_normalised ~ '(remote|hybrid|offshore|marine)'`), '0');
  });
});

describe('invalid / test values and category labels', () => {
  test('London, "Not a real address", the operator fixture and category labels are invalid, not geography', () => {
    for (const v of ['London', 'Not a real address', 'Operator test fixture — not a real location', 'Archaeological site, Shetland', 'Castle or ruin, Shetland', 'Lighthouse, Shetland', 'Viewpoint, Shetland', 'Community hall, Shetland']) {
      const r = R(v); assert.equal(r.status, 'invalid', v); assert.equal(r.area_id, null);
    }
  });
});

describe('seed integrity', () => {
  test('aliases: exactly one active meaning per normalised spelling; every place/area/scope alias has a live target', () => {
    assert.equal(scalar(`select count(*) from (select alias_normalised from place_aliases where is_active group by 1 having count(*)>1) d`), '0');
    assert.equal(scalar(`select count(*) from place_aliases p where kind in ('place','area','scope') and not exists (select 1 from areas a where a.id=p.area_id)`), '0');
    assert.ok(Number(scalar(`select count(*) from place_aliases`)) >= 100);
  });
  test('every HIGH place has its own name as a high alias; venue/street strings were NOT turned into aliases', () => {
    assert.equal(scalar(`select count(*) from areas a where a.confidence='high' and a.type in ('settlement','island','area','site') and a.is_active and not exists (select 1 from place_aliases p where p.area_id=a.id and p.confidence='high')`), '0');
    for (const v of ['Mareel', 'Speldiburn', 'Commercial Street', 'Gilbert Bain Hospital']) assert.equal(scalar(`select count(*) from place_aliases where alias_normalised=public.geo_normalise($v$${v}$v$)`), '0', v);
  });
  test('the review queue is seeded from the audit, admin-only, and marks fixtures invalid', () => {
    assert.ok(Number(scalar(`select count(*) from geography_review`)) >= 50);
    assert.equal(scalar(`select count(*) from geography_review where status='open'`) > '0', true);
    assert.ok(Number(scalar(`select count(*) from geography_review where status='invalid'`)) > 0);
  });
  test('the model distinguishes the five outcomes (resolved, unresolved, ambiguous, invalid, non_geographic)', () => {
    const seen = new Set(['Westside', 'Atlantis', 'Hamnavoe', 'London', 'Remote'].map((v) => R(v).status));
    assert.deepEqual([...seen].sort(), ['ambiguous', 'invalid', 'non_geographic', 'resolved', 'unresolved']);
  });
});

describe('security', () => {
  test('anonymous visitors read ACTIVE areas and aliases only; pending Foula is hidden from them, visible to an admin', () => {
    assert.equal(scalar(`set role anon; select count(*) from areas where id in ('foula','papa_stour')`), '0');
    assert.equal(scalar(`set role anon; select count(*) from areas where id='lerwick'`), '1');
    assert.equal(as('admin', `select count(*) from areas where id in ('foula','papa_stour')`).trim().split('\n').pop(), '2');
  });
  test('the resolver is callable by anon and authenticated', () => {
    assert.equal(JSON.parse(scalar(`set role anon; select public.resolve_geography('Westside')::text`)).area_id, 'shetland_west');
    assert.equal(JSON.parse(scalar(`set role authenticated; select public.resolve_geography('Westside')::text`)).area_id, 'shetland_west');
  });
  test('ordinary users and anon cannot write areas or aliases', () => {
    for (const who of ['user', 'anon'] as Who[]) {
      assert.ok(!ok(as(who, `insert into areas (id,slug,name_official,name_display,type,parent_id,confidence) values ('hack_${who}','hack-${who}','H','H','settlement','lerwick_bressay','high')`)), `${who} insert area`);
      assert.ok(!ok(as(who, `insert into place_aliases (alias,kind,area_id,confidence) values ('hack${who}','place','lerwick','high')`)), `${who} insert alias`);
    }
    as('user', `update areas set name_display='HACKED' where id='lerwick'`); as('user', `delete from areas where id='lerwick'`);
    as('user', `update place_aliases set area_id='unst' where alias_normalised='westside'`); as('user', `delete from place_aliases where alias_normalised='westside'`);
    assert.equal(scalar(`select name_display from areas where id='lerwick'`), 'Lerwick');
    assert.equal(R('Westside').area_id, 'shetland_west');
  });
  test('an admin (is_admin) and the service role can write; a bad hierarchy is still refused', () => {
    assert.ok(ok(as('admin', `insert into areas (id,slug,name_official,name_display,type,parent_id,confidence,sort_order) values ('zz_admin_test','zz-admin-test','ZZ','ZZ','settlement','lerwick_bressay','low',9999)`)));
    assert.ok(ok(as('service', `update areas set is_active=false where id='zz_admin_test'`)));
    assert.ok(!ok(as('admin', `insert into areas (id,slug,name_official,name_display,type,parent_id,confidence) values ('zz_nested','zz-nested','ZZ','ZZ','settlement','zz_admin_test','low')`)), 'a settlement beneath a settlement');
    raw(`delete from areas where id='zz_admin_test'`);
  });
  test('the review queue is admin-only', () => {
    const n = (out: string) => out.trim().split('\n').pop();
    assert.equal(n(as('user', `select count(*) from geography_review`)), '0', 'an ordinary user sees no rows');
    assert.ok(!ok(as('anon', `select count(*) from geography_review`)), 'anon has no access at all');
    assert.ok(Number(n(as('admin', `select count(*) from geography_review`))) > 0);
    as('user', `update geography_review set status='dismissed'`); as('user', `delete from geography_review`);
    assert.equal(scalar(`select count(*) from geography_review where status='dismissed'`), '0');
    assert.ok(!ok(as('user', `insert into geography_review (source_system, source_field, original_value) values ('x','y','z')`)));
  });
});

describe('the TypeScript normaliser equals the SQL one (so web, app and edge agree)', () => {
  const SAMPLES = ['Lerwick', '  LERWICK  ', 'Lerwick, Shetland', 'Lerwick, Shetland Islands, Scotland', 'Shetland, Lerwick', 'Shetland', 'Yell, Unst & Fetlar', "St Ninian's Isle", 'St Ninian’s Isle', 'Remote / hybrid',
    'Offshore/Marine', 'Brae / Sullom Voe', 'Shetland-wide', 'Whalsay  &   Skerries', 'Café Lerwick', 'Hamnavoe ZE2 9LA', 'North Isles, Shetland, UK', '', '!!!', 'Aith.', 'AITH,SHETLAND'];
  test('identical output for a spread of real and awkward strings', () => {
    for (const s of SAMPLES) assert.equal(normaliseGeoText(s), scalar(`select public.geo_normalise($v$${s}$v$)`), JSON.stringify(s));
  });
});
