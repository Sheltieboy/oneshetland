/**
 * ai-route-security.node.test.ts — nobody spends the Anthropic key without
 * signing in, and nobody signed in spends it without limit.
 *
 * WHY THIS TEST EXISTS
 *
 * Eight billable AI routes live on the website under /api/ai. SIX of them had
 * no authentication of any kind — any stranger on the internet could POST to
 * them and spend the OneShetland Anthropic key. The two that were gated
 * (draft-product by owner, draft-social by admin) had no usage ceiling, so one
 * signed-in account could call them in a loop for ever. None of the eight
 * bounded how much text could be sent.
 *
 * The original audit called this "eight AI route handlers" and then listed nine
 * paths. The real answer is EIGHT billable routes, all under /api/ai:
 * plan-day reaches Anthropic through lib/plan-ai.server.ts rather than
 * importing the SDK itself, and /api/trades/match — the ninth path — is a
 * database directory query with no model call at all.
 *
 * WHAT IS ASSERTED
 *   · every route under /api/ai goes through the shared guard — so a ninth
 *     route cannot appear unprotected without this test failing
 *   · anonymous callers get 401 from every one of them, live
 *   · the quota RPC refuses a caller with no session
 *   · one route's ceiling, the aggregate ceiling, and the daily ceiling
 *   · switching routes cannot multiply the allowance
 *   · one user's usage does not touch another's
 *   · concurrent requests at the last slot cannot both take it
 *   · the RPC and its table are not reachable from a browser as anon
 *   · the mobile app sends a Bearer token, or it would 401 against its own site
 *
 * SAFETY
 * No billable Anthropic call is made anywhere in this file. The live checks are
 * anonymous and oversized requests, which are refused BEFORE the provider is
 * reached — that is the whole point of them. Quota behaviour is exercised
 * against the database directly, and rolled back.
 *
 * Run: npm test
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const AI_DIR = join(WEB_ROOT, 'app', 'api', 'ai');
const SITE = 'https://oneshetland.com';

/** The eight billable routes. The directory is the source of truth, not this list. */
const EXPECTED_ROUTES = [
  'draft-article', 'draft-product', 'draft-social',
  'parse-brief', 'parse-event', 'parse-job', 'parse-shift', 'plan-day',
].sort();

function lastRow(out: string): Record<string, unknown> {
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) {
    throw new Error(`supabase db query returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  }
  const rows = parsed.rows ?? [];
  return rows[rows.length - 1] ?? {};
}

function runSql(sql: string): string {
  try {
    return execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`supabase db query failed: ${err.stdout || err.stderr || err.message}`);
  }
}

const query = (sql: string) => lastRow(runSql(sql));

async function queryAsync(sql: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000 });
  return lastRow(stdout);
}

function publicConfig(): { url: string; anonKey: string } | null {
  let url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  let anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anonKey) {
    try {
      for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
        const m = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.+)\s*$/);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1].endsWith('URL')) url ||= v; else anonKey ||= v;
      }
    } catch { /* handled below */ }
  }
  return url && anonKey ? { url, anonKey } : null;
}
const cfg = publicConfig();

// ── 1. The inventory guards itself ──────────────────────────────────────────

describe('every billable AI route goes through the guard', () => {
  before(() => {
    assert.ok(existsSync(AI_DIR), `expected the website checkout beside this repo at ${WEB_ROOT}`);
  });

  test('the route directory matches the protected inventory', () => {
    const found = readdirSync(AI_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(AI_DIR, d.name, 'route.ts')))
      .map((d) => d.name).sort();
    // If this fails because a NEW route appeared, that is the test working:
    // add it to the inventory AND give it the guard.
    assert.deepEqual(found, EXPECTED_ROUTES,
      'the set of AI routes changed — a new billable route must be added to the guard and to this list');
  });

  test('each route calls guardAi before anything else', () => {
    for (const r of EXPECTED_ROUTES) {
      const src = readFileSync(join(AI_DIR, r, 'route.ts'), 'utf8');
      assert.match(src, /guardAi\(/, `${r}: does not use the shared AI guard`);
      assert.match(src, /if \(!gate\.ok\) return gate\.response;/, `${r}: does not act on the guard's refusal`);

      // The gate must come before the provider is reached, or the expensive part
      // has already happened by the time we check. Import lines are stripped
      // first: `import { askPeerieBot }` sits at line 1 of every file and is not
      // a call.
      const body = src.split('\n').filter((l) => !l.trimStart().startsWith('import ')).join('\n');
      const gateAt = body.indexOf('guardAi(');
      assert.ok(gateAt !== -1, `${r}: no guardAi call outside the imports`);
      for (const marker of ['new Anthropic(', 'askPeerieBot(', 'suggestDayOrder(']) {
        const useAt = body.indexOf(marker);
        if (useAt !== -1) {
          assert.ok(gateAt < useAt, `${r}: reaches "${marker}" before the guard`);
        }
      }
    }
  });

  test('each route declares an input ceiling', () => {
    for (const r of EXPECTED_ROUTES) {
      const src = readFileSync(join(AI_DIR, r, 'route.ts'), 'utf8');
      assert.match(src, /maxBodyBytes: *[\d_]+/, `${r}: no body size ceiling`);
      assert.match(src, /maxFieldChars: *[\d_]+/, `${r}: no field size ceiling`);
    }
  });

  test('each Anthropic call has an explicit output ceiling', () => {
    const files = EXPECTED_ROUTES.map((r) => join(AI_DIR, r, 'route.ts'))
      .concat([join(WEB_ROOT, 'lib', 'plan-ai.server.ts')]);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const calls = (src.match(/messages\.create\(/g) ?? []).length;
      const caps = (src.match(/max_tokens: *\d+/g) ?? []).length;
      assert.ok(caps >= calls, `${f}: ${calls} model call(s) but only ${caps} max_tokens ceiling(s)`);
    }
  });

  test('the website still holds no service-role key', () => {
    // The boundary that has held through every step: the site authenticates as
    // the end user, never as the database owner.
    // grep exits 1 when it finds nothing, which is exactly the passing case —
    // so a bare execFileSync would throw on success.
    let hits = '';
    try {
      hits = execFileSync('grep',
        ['-rl', '--include=*.ts', '--include=*.tsx', 'SUPABASE_SERVICE_ROLE', WEB_ROOT],
        { encoding: 'utf8' }).trim();
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      if (err.status !== 1) throw e;   // 1 = no matches; anything else is a real failure
      hits = '';
    }
    assert.equal(hits, '', `the website now references a service-role key:\n${hits}`);
  });

  test('the mobile app sends a Bearer token to the website AI routes', () => {
    // Without this the app would 401 against its own site: it is cross-origin
    // and has no cookies.
    for (const f of ['components/ai/PeerieFill.tsx', 'lib/planner-api.ts']) {
      const src = readFileSync(join(REPO_ROOT, f), 'utf8');
      assert.match(src, /peerieHeaders\(\)/, `${f}: does not attach the session to its AI request`);
    }
    const helper = readFileSync(join(REPO_ROOT, 'lib/peerie-auth.ts'), 'utf8');
    assert.match(helper, /Bearer \$\{session\.access_token\}/, 'peerie-auth does not send a Bearer token');
  });
});

// ── 2. The quota, against the live database ─────────────────────────────────

type Case = { case_name: string; expected: string; actual: string; verdict: string };

describe('the AI quota', () => {
  let rows: Case[] = [];

  before(() => {
    const out = runSql(`begin;
create temp table pp as select (select id from public.profiles order by id limit 1) a,
                               (select id from public.profiles order by id offset 1 limit 1) b;
create temp table res (n int generated always as identity, case_name text, expected text, actual text);

create temp table anon1 as select * from public.claim_ai_request('parse-job');
insert into res(case_name,expected,actual) select 'no session is refused','false',(select allowed::text from anon1);
insert into res(case_name,expected,actual) select 'and says why','not_authenticated',(select reason from anon1);

create or replace function pg_temp.as_user(p_user uuid, p_route text)
returns table(allowed boolean, reason text, retry integer, tot integer, rt integer, day integer)
language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role','authenticated')::text, true);
  return query select c.allowed, c.reason, c.retry_after_secs, c.used_this_hour, c.used_this_route, c.used_today
    from public.claim_ai_request(p_route) c;
end $f$;

create temp table u1 as select * from pg_temp.as_user((select a from pp),'parse-job');
insert into res(case_name,expected,actual) select 'a signed-in user is allowed','true',(select allowed::text from u1);

do $d$ begin for i in 1..14 loop perform pg_temp.as_user((select a from pp),'parse-job'); end loop; end $d$;
create temp table u16 as select * from pg_temp.as_user((select a from pp),'parse-job');
insert into res(case_name,expected,actual) select 'the 16th call on one route is refused','false',(select allowed::text from u16);
insert into res(case_name,expected,actual) select 'the per-route ceiling is the reason','hourly_route',(select reason from u16);
insert into res(case_name,expected,actual) select 'a retry hint is given','true',(select (retry > 0)::text from u16);

create temp table sw as select * from pg_temp.as_user((select a from pp),'parse-event');
insert into res(case_name,expected,actual) select 'another route still works below the aggregate','true',(select allowed::text from sw);
do $d$ begin for i in 1..14 loop perform pg_temp.as_user((select a from pp),'parse-event'); end loop; end $d$;
create temp table agg as select * from pg_temp.as_user((select a from pp),'plan-day');
insert into res(case_name,expected,actual) select 'route-switching cannot beat the aggregate','false',(select allowed::text from agg);
insert into res(case_name,expected,actual) select 'the aggregate is the reason','hourly_total',(select reason from agg);
insert into res(case_name,expected,actual) select 'the hour stopped at thirty','30',(select tot::text from agg);

create temp table other as select * from pg_temp.as_user((select b from pp),'parse-job');
insert into res(case_name,expected,actual) select 'a second user has their own allowance','true',(select allowed::text from other);
insert into res(case_name,expected,actual) select 'starting from one','1',(select tot::text from other);

-- The daily ceiling, reached by spreading across earlier hours.
insert into public.ai_usage (user_id, bucket, total, per_route)
select (select b from pp), date_trunc('hour', now()) - (g || ' hours')::interval, 30, '{}'::jsonb
from generate_series(1,5) g;
create temp table day1 as select * from pg_temp.as_user((select b from pp),'draft-social');
insert into res(case_name,expected,actual) select 'the daily ceiling holds across hours','false',(select allowed::text from day1);
insert into res(case_name,expected,actual) select 'the day is the reason','daily_total',(select reason from day1);

create or replace function pg_temp.try(p text) returns text language plpgsql as $f$
begin perform public.claim_ai_request(p); return 'ACCEPTED';
exception when others then return 'refused'; end $f$;
insert into res(case_name,expected,actual) select 'a blank route name is refused','refused',pg_temp.try('');
insert into res(case_name,expected,actual) select 'an over-long route name is refused','refused',pg_temp.try(repeat('x',100));

insert into res(case_name,expected,actual) select 'no prompt content is stored','0',
  (select count(*)::text from information_schema.columns where table_schema='public' and table_name='ai_usage'
    and column_name in ('prompt','input','text','content','response','body'));

select n, case_name, expected, actual,
  case when expected is not distinct from actual then 'PASS' else 'FAIL' end verdict from res order by n;
rollback;`);
    const parsed = JSON.parse(out) as { rows?: Case[]; _tag?: string; error?: unknown };
    if (parsed._tag === 'Error' || parsed.error) {
      throw new Error(`quota matrix returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
    }
    rows = (parsed.rows ?? []).filter((r) => r.verdict);
    assert.ok(rows.length >= 15, `expected the full quota matrix, got ${rows.length} cases`);
  });

  test('all quota rules hold', () => {
    const failed = rows.filter((r) => r.verdict !== 'PASS');
    if (failed.length) {
      assert.fail('AI QUOTA REGRESSION:\n' +
        failed.map((f) => `  • ${f.case_name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`).join('\n'));
    }
  });
});

// ── 3. Concurrency cannot beat the ceiling ──────────────────────────────────

describe('two AI requests at the last slot', () => {
  let user = '';

  before(() => {
    const r = query(`select (select id::text from public.profiles order by id offset 2 limit 1) as u;`);
    user = String(r.u);
    assert.match(user, /^[0-9a-f-]{36}$/, 'no spare profile available');
  });

  after(() => {
    query(`delete from public.ai_usage where user_id='${user}'; select 1;`);
    const left = query(`select count(*)::int as n from public.ai_usage where user_id='${user}';`);
    assert.equal(left.n, 0, 'the test left usage rows behind');
  });

  test('only one of them gets it', async () => {
    // Park the user one slot below the hourly aggregate, then have two requests
    // arrive together. If the claim were a read-then-write, both would see 29.
    query(`delete from public.ai_usage where user_id='${user}';
      insert into public.ai_usage (user_id, bucket, total, per_route)
      values ('${user}', date_trunc('hour', now()), 29, '{"parse-job": 1}'::jsonb); select 1;`);

    // A helper that adopts the user's identity the way PostgREST does, so both
    // connections claim as the same person.
    const claimAs = (hold: boolean) => `
create or replace function pg_temp.claim_as() returns text language plpgsql as $f$
declare v boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','${user}','role','authenticated')::text, true);
  select allowed into v from public.claim_ai_request('parse-job');
  return case when v then 'allowed' else 'refused' end;
end $f$;
${hold ? `begin;
create temp table x as select pg_temp.claim_as() r;
select pg_sleep(6);
select r from x;
commit;` : `select pg_sleep(3);
select pg_temp.claim_as() as r;`}`;

    const [ra, rb] = await Promise.all([queryAsync(claimAs(true)), queryAsync(claimAs(false))]);
    const results = [String(ra.r), String(rb.r)];
    assert.equal(results.filter((x) => x === 'allowed').length, 1,
      `both concurrent requests took the last slot. Got ${JSON.stringify(results)}`);

    const st = query(`select total::int as t from public.ai_usage where user_id='${user}' and bucket=date_trunc('hour', now());`);
    assert.equal(st.t, 30, `the ceiling was exceeded — total is ${st.t}, not 30`);
  });
});

// ── 4. The live boundary ────────────────────────────────────────────────────

describe('the live AI endpoints refuse strangers', () => {
  before(() => {
    if (!cfg) throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (or provide a .env).');
  });

  for (const r of EXPECTED_ROUTES) {
    test(`anonymous POST to /api/ai/${r} is refused`, async () => {
      const res = await fetch(`${SITE}/api/ai/${r}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'a plausible looking job advert for testing', recipe: 'spik_word', date: '2026-09-01' }),
      });
      assert.equal(res.status, 401,
        `/api/ai/${r} answered an anonymous caller with HTTP ${res.status} — it must be 401 before any Anthropic call`);
    });
  }

  test('an oversized body is refused before anything else', async () => {
    // Rejected on size, so this never reaches authentication, let alone Anthropic.
    const res = await fetch(`${SITE}/api/ai/parse-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(200_000) }),
    });
    assert.equal(res.status, 413, `an oversized body returned HTTP ${res.status} instead of 413`);
  });

  test('the quota RPC is not callable with the public anon key', async () => {
    const res = await fetch(`${cfg!.url}/rest/v1/rpc/claim_ai_request`, {
      method: 'POST',
      headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_route: 'parse-job' }),
    });
    assert.notEqual(res.status, 404, 'signature drifted — this probe stopped testing anything');
    assert.equal(res.status, 401, `claim_ai_request answered the anon key with HTTP ${res.status}`);
  });

  for (const verb of ['GET', 'POST', 'PATCH', 'DELETE']) {
    test(`anon cannot ${verb} ai_usage`, async () => {
      const qs = verb === 'GET' ? '?select=*' : (verb === 'POST' ? '' : '?bucket=gt.2000-01-01');
      const res = await fetch(`${cfg!.url}/rest/v1/ai_usage${qs}`, {
        method: verb,
        headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
        ...(verb === 'POST' ? { body: JSON.stringify({ user_id: '00000000-0000-0000-0000-000000000000', bucket: '2026-01-01' }) } : {}),
        ...(verb === 'PATCH' ? { body: JSON.stringify({ total: 0 }) } : {}),
      });
      assert.equal(res.status, 401,
        `anon ${verb} on ai_usage returned HTTP ${res.status} — the quota table must not be client-writable`);
    });
  }
});
