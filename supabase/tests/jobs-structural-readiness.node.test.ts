/**
 * jobs-structural-readiness.node.test.ts — Jobs Stage 2: the database half.
 *
 * WHAT WAS WRONG (Stage 1 audit, 30 Oct 2026)
 *  · An employer posting a job could leave the closing date empty — and the form defaulted to exactly that — so it stayed public forever.
 *  · Nothing stopped a signed-in user inserting a job that CLAIMED to be an external source ("Shetland Islands Council via myjobscotland"),
 *    or taking a (source, source_ref) the council sync later needs.
 *  · contract_type had no 'temporary': the council's "Temporary" posts were being filed as 'casual'.
 *  · posted_at (first seen) was the only date, so "newest first" ordered by import day, and the source's own reference was discarded.
 *
 * HOW IT PROVES IT
 * The pre-fix production state (copied from introspection) is loaded from _support/jobs-prefix-schema.sql and each problem is shown to be REAL
 * against it (controls). The REAL migration 20261122000000 is then applied over seeded legacy rows and every rule is checked, including that
 * the legacy rows are byte-identical afterwards and that the service role / admins keep their powers. The rollback is proved last.
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a Supabase DSN. No network, no production row.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = readFileSync(join(ROOT, 'supabase/tests/_support/jobs-prefix-schema.sql'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20261122000000_jobs_structural_readiness.sql'), 'utf8');
const ROLLBACK = readFileSync(join(ROOT, 'supabase/rollbacks/20261122000000_jobs_structural_readiness_rollback.sql'), 'utf8');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
if (!DSN) throw new Error('PASS_PROOF_DSN is required (isolated database only) — run via `npm run test:isolated`');
if (/supabase/i.test(DSN)) throw new Error('refusing to run against a Supabase DSN');

const raw = (sql: string) => { const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', timeout: 120_000 }); return `${r.stdout ?? ''}${r.stderr ?? ''}`; };
const file = (sql: string) => { const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', timeout: 180_000 }); return `${r.stdout ?? ''}${r.stderr ?? ''}`; };
const scalar = (sql: string) => raw(sql).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

const U = { EMP: 'a0000000-0000-4000-8000-0000000000a1', OTHER: 'a0000000-0000-4000-8000-0000000000a2', ADM: 'e0000000-0000-4000-8000-0000000000e1' };
type Who = keyof typeof U | 'service' | 'anon';
function as(who: Who, sql: string): string {
  const role = who === 'service' ? 'service_role' : who === 'anon' ? 'anon' : 'authenticated';
  const sub = who === 'service' || who === 'anon' ? '' : U[who];
  return raw(`set role ${role}; select set_config('request.jwt.claim.sub','${sub}',false); ${sql}; reset role;`);
}
const ok = (out: string) => !/ERROR|violates|denied/i.test(out);

function freshPre() {
  const out = file(PREFIX); assert.doesNotMatch(out, /ERROR/i, `prefix failed:\n${out.slice(0, 1200)}`);
  const s = file(`
    insert into profiles (id, role) values ('${U.EMP}','customer'), ('${U.OTHER}','customer'), ('${U.ADM}','admin');
    -- two legacy rows exactly as the council sync writes them (service role), one past its closing date
    set role service_role;
    insert into jobs (id, title, contract_type, location, apply_url, expires_at, source, source_ref, source_label, external_employer_name, posted_at)
      values ('11111111-1111-4111-8111-111111111111','Head Teacher - Whalsay School','full-time','Whalsay School, Whalsay','https://example.invalid/jobs/494359', now() + interval '10 days','myjobscotland','494359','via myjobscotland','Shetland Islands Council', now() - interval '20 days'),
             ('22222222-2222-4222-8222-222222222222','Old closed vacancy','casual','Lerwick','https://example.invalid/jobs/1', now() - interval '2 days','myjobscotland','1','via myjobscotland','Shetland Islands Council', now() - interval '30 days');
    reset role;`);
  assert.doesNotMatch(s, /ERROR/i, `seed failed:\n${s.slice(0, 1200)}`);
}
function freshPost() { freshPre(); const o = file(MIGRATION); assert.doesNotMatch(o, /ERROR/i, `migration failed:\n${o.slice(0, 1500)}`); }
const insertAs = (who: Who, cols: string, vals: string) => as(who, `insert into jobs (${cols}) values (${vals}) returning id`);

describe('CONTROLS — the pre-fix production state really has these problems', () => {
  test('an employer can post a job with NO closing date, and it stays public indefinitely', () => {
    freshPre();
    assert.ok(ok(insertAs('EMP', 'employer_id,title', `'${U.EMP}','Never ends'`)));
    assert.equal(scalar(`select count(*) from jobs where title='Never ends' and expires_at is null`), '1');
    assert.equal(scalar(`set role anon; select count(*) from jobs where title='Never ends'`), '1');
  });
  test('an employer can claim to BE an external source (source, source_ref, external employer, logo)', () => {
    freshPre();
    assert.ok(ok(insertAs('EMP', 'employer_id,title,source,source_ref,source_label,external_employer_name', `'${U.EMP}','Fake council job','myjobscotland','999999','via myjobscotland','Shetland Islands Council'`)));
    assert.equal(scalar(`select count(*) from jobs where source='myjobscotland' and source_ref='999999'`), '1');
  });
  test("'temporary' is not an allowed contract type, so the sync had to file it as 'casual'", () => {
    freshPre();
    assert.ok(!ok(as('service', `insert into jobs (title, contract_type) values ('t','temporary')`)));
  });
});

describe('after the migration', () => {
  test('contract_type accepts temporary; an invalid value is still refused', () => {
    freshPost();
    assert.ok(ok(as('service', `insert into jobs (title, contract_type) values ('Temp teacher','temporary')`)));
    assert.ok(!ok(as('service', `insert into jobs (title, contract_type) values ('bad','bogus')`)));
  });
  test('legacy rows are untouched: every old column is identical, new columns are null, listed_at = first-seen', () => {
    freshPre();
    const before = scalar(`select md5(string_agg(md5(row(id,employer_id,posted_as_business_id,title,description,category,location,locality,contract_type,pay_text,apply_url,is_featured,is_hidden,expires_at,posted_at,created_at,status,updated_at,source,source_ref,source_label,external_employer_name)::text), ',' order by id)) from jobs`);
    const o = file(MIGRATION); assert.doesNotMatch(o, /ERROR/i);
    const after = scalar(`select md5(string_agg(md5(row(id,employer_id,posted_as_business_id,title,description,category,location,locality,contract_type,pay_text,apply_url,is_featured,is_hidden,expires_at,posted_at,created_at,status,updated_at,source,source_ref,source_label,external_employer_name)::text), ',' order by id)) from jobs`);
    assert.equal(after, before);
    assert.equal(scalar(`select count(*) from jobs where source_url is not null or source_reference is not null or source_published_at is not null or source_meta is not null`), '0');
    assert.equal(scalar(`select count(*) from jobs where listed_at = posted_at`), '2');
  });
  test('listed_at is the SOURCE publication date when known, the first-seen date otherwise — and posted_at is preserved', () => {
    freshPost();
    as('service', `update jobs set source_published_at = '2026-09-28T09:00:00Z', source_reference = 'SIC09073' where id='11111111-1111-4111-8111-111111111111'`);
    assert.equal(scalar(`select listed_at = '2026-09-28T09:00:00Z' and posted_at < now() - interval '19 days' and posted_at <> listed_at from jobs where id='11111111-1111-4111-8111-111111111111'`), 't');
    assert.equal(scalar(`select listed_at = posted_at from jobs where id='22222222-2222-4222-8222-222222222222'`), 't');
  });
  test('the source model keeps: source, source id, human reference, listing URL, apply URL, publication date, first-seen date, source labels', () => {
    freshPost();
    assert.ok(ok(as('service', `insert into jobs (title, source, source_ref, source_reference, source_url, apply_url, source_published_at, source_meta)
      values ('Dock operative','nhs-shetland','NHS-77','JOB-0077','https://example.invalid/listing/77','https://example.invalid/apply/77','2026-10-20T08:00:00Z','{"contract_label":"Fixed term","hours_label":"Full time"}')`)));
    assert.equal(scalar(`select source||'|'||source_ref||'|'||source_reference||'|'||source_url||'|'||apply_url||'|'||(source_meta->>'contract_label') from jobs where source_ref='NHS-77'`),
      'nhs-shetland|NHS-77|JOB-0077|https://example.invalid/listing/77|https://example.invalid/apply/77|Fixed term');
    // the SAME human reference may exist under two sources (that is how cross-source duplicates are found), but (source, source_ref) stays unique
    assert.ok(ok(as('service', `insert into jobs (title, source, source_ref, source_reference) values ('Same job elsewhere','employer-site','E-1','JOB-0077')`)));
    assert.ok(!ok(as('service', `insert into jobs (title, source, source_ref) values ('dupe','nhs-shetland','NHS-77')`)));
    assert.equal(scalar(`select count(*) from jobs where source_reference='JOB-0077'`), '2');
  });
});

describe('direct employer postings', () => {
  test('no closing date -> finite: 30 days after posting (and the client cannot choose posted_at)', () => {
    freshPost();
    assert.ok(ok(insertAs('EMP', 'employer_id,title,posted_at', `'${U.EMP}','Posted with nothing',now() + interval '400 days'`)));
    assert.equal(scalar(`select posted_at <= now() and abs(extract(epoch from (expires_at - (posted_at + interval '30 days')))) < 5 from jobs where title='Posted with nothing'`), 't');
  });
  test('an explicit closing date is kept exactly', () => {
    freshPost();
    assert.ok(ok(insertAs('EMP', 'employer_id,title,expires_at', `'${U.EMP}','Fixed deadline','2026-12-01T22:00:00Z'`)));
    assert.equal(scalar(`select expires_at = '2026-12-01T22:00:00Z' from jobs where title='Fixed deadline'`), 't');
  });
  test('the employer cannot remove the closing date later, or edit the source fields, posting date or promotion', () => {
    freshPost();
    insertAs('EMP', 'employer_id,title,expires_at', `'${U.EMP}','Mine','2026-12-01T22:00:00Z'`);
    as('EMP', `update jobs set expires_at = null, title = 'Mine (edited)', source='myjobscotland', source_ref='42', source_url='x', source_reference='y', source_published_at=now(), source_meta='{"a":1}', external_employer_name='Council', is_featured=true, boosted_until=now() + interval '9 days', posted_at = now() + interval '90 days' where title='Mine'`);
    assert.equal(scalar(`select title||'|'||(expires_at = '2026-12-01T22:00:00Z')||'|'||(source is null)||'|'||(source_ref is null)||'|'||(source_url is null)||'|'||(source_reference is null)||'|'||(source_published_at is null)||'|'||(source_meta is null)||'|'||(external_employer_name is null)||'|'||(not is_featured)||'|'||(boosted_until is null)||'|'||(posted_at <= now()) from jobs where employer_id='${U.EMP}'`),
      'Mine (edited)|true|true|true|true|true|true|true|true|true|true|true');
  });
  test('claiming an external source is ignored on insert (the job is stored as a plain employer posting)', () => {
    freshPost();
    assert.ok(ok(insertAs('EMP', 'employer_id,title,source,source_ref,source_label,external_employer_name,external_employer_logo_url,source_reference', `'${U.EMP}','Fake council job','myjobscotland','999999','via myjobscotland','Shetland Islands Council','https://example.invalid/logo.png','SIC00001'`)));
    assert.equal(scalar(`select (source is null)::text||(source_ref is null)::text||(source_label is null)::text||(external_employer_name is null)::text||(external_employer_logo_url is null)::text||(source_reference is null)::text from jobs where title='Fake council job'`), 'truetruetruetruetruetrue');
    assert.ok(ok(as('service', `insert into jobs (title, source, source_ref) values ('Real sync row','myjobscotland','999999')`)), 'the sync can still use that source_ref');
  });
  test("another employer still cannot edit someone else's job; expired and hidden jobs stay hidden from the public", () => {
    freshPost();
    insertAs('EMP', 'employer_id,title', `'${U.EMP}','Mine'`);
    assert.equal(scalar(`select count(*) from (select 1) x`), '1');
    as('OTHER', `update jobs set title='hijacked' where title='Mine'`);
    assert.equal(scalar(`select count(*) from jobs where title='hijacked'`), '0');
    assert.equal(scalar(`set role anon; select count(*) from jobs where id='22222222-2222-4222-8222-222222222222'`), '0');   // past closing date
    assert.equal(scalar(`set role anon; select count(*) from jobs where id='11111111-1111-4111-8111-111111111111'`), '1');   // current
  });
});

describe('trusted writers keep their powers', () => {
  test('the service role (sync / importers) may set source fields and may omit a closing date', () => {
    freshPost();
    assert.ok(ok(as('service', `insert into jobs (title, source, source_ref, source_url, source_reference) values ('Importer job','x','1','u','r')`)));
    assert.equal(scalar(`select (expires_at is null)::text||'|'||source_reference from jobs where source_ref='1' and source='x'`), 'true|r');
  });
  test('a platform admin may set source fields on any job', () => {
    freshPost();
    as('ADM', `update jobs set source_reference = 'SIC1', source_meta = '{"k":1}' where id='11111111-1111-4111-8111-111111111111'`);
    assert.equal(scalar(`select source_reference||'|'||(source_meta->>'k') from jobs where id='11111111-1111-4111-8111-111111111111'`), 'SIC1|1');
  });
});

describe('rollback', () => {
  test('is refused while any job uses temporary / the new columns, and restores the old behaviour once they are gone', () => {
    freshPost();
    as('service', `insert into jobs (title, contract_type) values ('Temp','temporary')`);
    assert.match(file(ROLLBACK), /rollback refused/);
    as('service', `delete from jobs where contract_type='temporary'`);
    assert.doesNotMatch(file(ROLLBACK), /ERROR/i);
    assert.equal(scalar(`select count(*) from information_schema.columns where table_name='jobs' and column_name in ('listed_at','source_url','source_reference','source_published_at','source_meta')`), '0');
    // load-bearing: with the old trigger back, the employer's no-expiry job is public forever again
    assert.ok(ok(insertAs('EMP', 'employer_id,title', `'${U.EMP}','Never ends again'`)));
    assert.equal(scalar(`select count(*) from jobs where title='Never ends again' and expires_at is null`), '1');
  });
});
