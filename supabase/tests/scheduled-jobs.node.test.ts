/**
 * scheduled-jobs.node.test.ts — the scheduler is version-controlled, and it is
 * possible to tell when it stops.
 *
 * WHY THIS TEST EXISTS
 *
 * Six jobs ran in production and exactly one of them existed in git. The other
 * five had been created by hand in the Dashboard, so a project restored from
 * this repository would have come up with a sixth of its scheduler and nothing
 * would have complained: reminders would simply never send.
 *
 * Two things were also true and invisible:
 *
 *   · The four pg_net jobs carried the shared `x-cron-secret` as a LITERAL
 *     inside cron.job.command. That is why the fix could not simply be five
 *     cron.schedule calls in a migration — writing them out would have put the
 *     secret in git. It lives in Vault now, moved there without leaving the
 *     database.
 *
 *   · 24% of every scheduled HTTP dispatch was timing out at pg_net's 5000 ms
 *     default, and pg_cron recorded every one of them as `succeeded` — because
 *     for a pg_net job "succeeded" means the request was QUEUED. The average
 *     cron run took 0.04s, which is the cost of queuing and all pg_cron ever
 *     sees. That is why cron_transport_health() exists alongside
 *     cron_job_health(): they answer different questions.
 *
 * WHAT IS ASSERTED
 *   · every canonical job exists exactly once, is active, and runs as postgres
 *   · its schedule matches the version-controlled expectation
 *   · its command targets the intended function or RPC
 *   · no job embeds a literal secret, and the migration file contains none
 *   · meter-bookings is NOT scheduled — reminder-runner invokes it, and a
 *     second concurrent path is how a billing job double-bills
 *   · cron internals are unreadable and unwritable by anon and authenticated
 *   · the health functions are not callable by client roles
 *   · nothing is stale: every job that has run is within its tolerance
 *   · config.toml matches what is actually deployed, so a redeploy cannot
 *     silently switch authentication on for a public function
 *
 * SAFETY
 * Read-only apart from probes inside a transaction that is never committed.
 * No secret value is ever printed. No job is triggered.
 *
 * Run: npm test
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT_REF = 'nkrtmakxygkvxuxriiil';

/**
 * The canonical scheduler, mirroring 20260821140000_canonical_scheduled_jobs.sql.
 * If a schedule is changed there and not here (or vice versa) this fails, which
 * is the point: the migration and the expectation must move together.
 */
const CANONICAL: Array<{ name: string; schedule: string; targets: string; kind: 'sql' | 'http' }> = [
  { name: 'activate-scheduled-alerts',   schedule: '* * * * *',    targets: 'partner_alerts',              kind: 'sql'  },
  { name: 'expire-stale-ticket-orders',  schedule: '*/5 * * * *',  targets: 'expire_stale_ticket_orders',  kind: 'sql'  },
  { name: 'purge-old-job-applications',  schedule: '20 3 * * *',   targets: 'purge_old_job_applications',  kind: 'sql'  },
  { name: 'purge-rate-limits',           schedule: '17 4 * * *',   targets: 'purge_rate_limits',           kind: 'sql'  },
  { name: 'reminder-runner',             schedule: '*/5 * * * *',  targets: 'functions/v1/reminder-runner',   kind: 'http' },
  { name: 'social-composer',             schedule: '40 5 * * *',   targets: 'functions/v1/social-composer',   kind: 'http' },
  { name: 'social-publisher',            schedule: '*/15 * * * *', targets: 'functions/v1/social-publisher',  kind: 'http' },
  { name: 'sync-council-jobs',           schedule: '17 */3 * * *', targets: 'functions/v1/sync-council-jobs', kind: 'http' },
];

function runSql(sql: string): string {
  try {
    return execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`supabase db query failed: ${err.stdout || err.stderr || err.message}`);
  }
}
function rowsOf(out: string): Record<string, unknown>[] {
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) {
    throw new Error(`supabase db query returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  }
  return parsed.rows ?? [];
}
const queryAll = (sql: string) => rowsOf(runSql(sql));
const query = (sql: string) => queryAll(sql)[0] ?? {};

// ── 1. The jobs exist, once, correctly ──────────────────────────────────────

describe('the canonical scheduler', () => {
  let jobs: Record<string, unknown>[] = [];
  before(() => {
    // Commands are classified in SQL rather than returned raw, so a literal
    // secret can be detected without ever being pulled out of the database.
    jobs = queryAll(`
      select j.jobname, j.schedule, j.active::text as active, j.username,
             (j.command like '%decrypted_secrets%')::text                       as uses_vault,
             (j.command ~ $re$'x-cron-secret'\\s*,\\s*'[^']$re$)::text            as literal_secret,
             (j.command like '%timeout_milliseconds%')::text                    as has_timeout
        from cron.job j order by j.jobname;`);
  });

  for (const job of CANONICAL) {
    test(`${job.name} is scheduled exactly once, active, at ${job.schedule}`, () => {
      const found = jobs.filter((j) => j.jobname === job.name);
      assert.equal(found.length, 1,
        found.length === 0
          ? `${job.name} is NOT scheduled — this job silently does not run`
          : `${job.name} is scheduled ${found.length} times — duplicates race each other`);
      assert.equal(found[0].active, 'true', `${job.name} exists but is INACTIVE`);
      assert.equal(found[0].schedule, job.schedule,
        `${job.name} runs on "${found[0].schedule}", version control expects "${job.schedule}"`);
      assert.equal(found[0].username, 'postgres',
        `${job.name} runs as ${found[0].username}, not postgres — its privileges differ from what was designed`);
    });
  }

  test('every job targets what it is supposed to target', () => {
    // Checked in SQL so the command text (which held the secret) is never
    // returned to the test process.
    const checks = CANONICAL.map((j) =>
      `select '${j.name}' as name, coalesce((select (command like '%${j.targets}%') from cron.job where jobname='${j.name}'), false)::text as hits`
    ).join(' union all ');
    const wrong = queryAll(`${checks};`).filter((r) => r.hits !== 'true');
    assert.deepEqual(wrong, [],
      `these jobs do not invoke their intended target: ${wrong.map((w) => w.name).join(', ')}`);
  });

  test('no scheduled job embeds a literal secret', () => {
    const leaky = jobs.filter((j) => j.literal_secret === 'true').map((j) => j.jobname);
    assert.deepEqual(leaky, [],
      `these jobs carry the cron secret as a literal in cron.job.command: ${leaky.join(', ')}`);
  });

  test('the HTTP jobs resolve their secret from Vault and set a timeout', () => {
    for (const job of CANONICAL.filter((j) => j.kind === 'http')) {
      const live = jobs.find((j) => j.jobname === job.name)!;
      assert.equal(live.uses_vault, 'true', `${job.name} does not read its secret from Vault`);
      assert.equal(live.has_timeout, 'true',
        `${job.name} uses pg_net's 5000ms default, which was timing out on 24% of dispatches`);
    }
  });

  test('the Vault secret the jobs depend on exists', () => {
    // Name only. The value is never selected.
    const r = query(`select count(*)::text as n from vault.secrets where name = 'cron_secret';`);
    assert.equal(r.n, '1',
      'cron_secret is missing from Vault — every scheduled Edge Function call would send a null header and get 403');
  });

  test('no unexpected extra jobs are running', () => {
    const known = new Set(CANONICAL.map((j) => j.name));
    const extra = jobs.filter((j) => !known.has(j.jobname as string)).map((j) => j.jobname);
    assert.deepEqual(extra, [],
      `jobs are running that version control does not describe: ${extra.join(', ')}`);
  });
});

// ── 2. meter-bookings must not gain a second path ───────────────────────────

describe('booking metering has exactly one caller', () => {
  test('meter-bookings is not scheduled', () => {
    // reminder-runner invokes it (index.ts:392). A cron job as well would mean
    // two concurrent metering runs over the same bookings, and the legacy
    // Stripe usage path increments without an idempotency key.
    const r = query(`select count(*)::text as n from cron.job where command like '%meter-bookings%';`);
    assert.equal(r.n, '0',
      'meter-bookings has its own cron job AND is invoked by reminder-runner — two concurrent billing paths');
  });

  test('reminder-runner is still the caller', () => {
    const src = readFileSync(join(REPO_ROOT, 'supabase/functions/reminder-runner/index.ts'), 'utf8');
    assert.ok(/functions\.invoke\(\s*['"]meter-bookings['"]/.test(src),
      'reminder-runner no longer invokes meter-bookings — bookings would stop being billed entirely');
  });
});

// ── 3. Cron internals stay server-side ──────────────────────────────────────

describe('clients cannot see or change the scheduler', () => {
  test('anon and authenticated are refused cron and the health functions', () => {
    const rows = queryAll(`
      begin;
      create temp table pr (n int generated always as identity, who text, what text, outcome text);
      do $$
      declare v_role text; v_out text; v_n int;
      begin
        foreach v_role in array array['anon','authenticated'] loop
          begin
            execute format('set local role %I', v_role);
            execute 'select count(*) from cron.job' into v_n;
            reset role; v_out := 'ALLOWED';
          exception when others then reset role; v_out := 'DENIED'; end;
          insert into pr(who,what,outcome) values (v_role,'read cron.job',v_out);

          begin
            execute format('set local role %I', v_role);
            execute 'select count(*) from cron.job_run_details' into v_n;
            reset role; v_out := 'ALLOWED';
          exception when others then reset role; v_out := 'DENIED'; end;
          insert into pr(who,what,outcome) values (v_role,'read cron.job_run_details',v_out);

          begin
            execute format('set local role %I', v_role);
            execute $q$select cron.schedule('sj_probe','* * * * *','select 1')$q$ into v_n;
            reset role; v_out := 'ALLOWED';
          exception when others then reset role; v_out := 'DENIED'; end;
          insert into pr(who,what,outcome) values (v_role,'cron.schedule',v_out);

          begin
            execute format('set local role %I', v_role);
            execute 'select count(*) from public.cron_job_health()' into v_n;
            reset role; v_out := 'ALLOWED';
          exception when others then reset role; v_out := 'DENIED'; end;
          insert into pr(who,what,outcome) values (v_role,'cron_job_health()',v_out);

          begin
            execute format('set local role %I', v_role);
            execute 'select count(*) from public.cron_transport_health()' into v_n;
            reset role; v_out := 'ALLOWED';
          exception when others then reset role; v_out := 'DENIED'; end;
          insert into pr(who,what,outcome) values (v_role,'cron_transport_health()',v_out);
        end loop;
      end $$;
      select who, what, outcome from pr order by n;`);

    assert.equal(rows.length, 10, 'the privilege probe did not run all its cases');
    const allowed = rows.filter((r) => r.outcome === 'ALLOWED');
    assert.deepEqual(allowed, [],
      `client roles reached the scheduler: ${allowed.map((a) => `${a.who} → ${a.what}`).join(', ')}`);
  });

  test('the maintenance RPCs stay server-only', () => {
    // Step 1B locked these; scheduling them must not have widened them.
    const rows = queryAll(`
      select p.proname as fn,
             has_function_privilege('anon', p.oid, 'EXECUTE')::text          as anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE')::text as auth_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public'
         and p.proname in ('purge_old_job_applications','expire_stale_ticket_orders',
                           'cron_job_health','cron_transport_health')
       order by 1;`);
    assert.ok(rows.length >= 4, `expected four functions, found ${rows.length}`);
    for (const r of rows) {
      assert.equal(r.anon_exec, 'false', `anon can execute ${r.fn}`);
      assert.equal(r.auth_exec, 'false', `authenticated can execute ${r.fn}`);
    }
  });
});

// ── 4. Staleness ────────────────────────────────────────────────────────────

describe('nothing has quietly stopped', () => {
  test('no canonical job is stale, inactive or repeatedly failing', () => {
    const rows = queryAll(`select job_name, healthy::text as healthy, problem, has_ever_run::text as ever
                             from public.cron_job_health() order by job_name;`);
    assert.equal(rows.length, CANONICAL.length,
      `cron_job_health() reports ${rows.length} jobs, the canonical set has ${CANONICAL.length}`);
    const sick = rows.filter((r) => r.healthy !== 'true');
    assert.deepEqual(sick, [],
      `unhealthy jobs: ${sick.map((s) => `${s.job_name} (${s.problem})`).join('; ')}`);
  });

  test('the frequent jobs have actually run, not merely been scheduled', () => {
    // A job can be active, correctly configured and never fire. The two
    // fastest-cadence jobs must show real execution; the daily ones are exempt
    // because a fresh reschedule legitimately has no history yet.
    const rows = queryAll(`select job_name, has_ever_run::text as ever from public.cron_job_health()
                            where job_name in ('activate-scheduled-alerts','expire-stale-ticket-orders');`);
    for (const r of rows) {
      assert.equal(r.ever, 'true', `${r.job_name} is scheduled but has never executed`);
    }
  });
});

// ── 4b. Metering is observable even though it is not a cron job ─────────────

describe('booking metering cannot stop silently', () => {
  test('the backlog check reports metering as running', () => {
    // reminder-runner swallows a meter-bookings failure in a catch and still
    // returns 200, so no amount of cron history can reveal a stopped meter.
    // This asks the data instead: bookings that should have been metered and
    // were not. Verified to go red when a stale unmetered booking is injected.
    const r = query(`select unmetered_billable::text as backlog,
                            unbillable_pro_bookings::text as unbillable,
                            healthy::text as healthy, problem
                       from public.metering_backlog_health();`);
    assert.equal(r.healthy, 'true',
      `booking metering appears to have stopped: ${r.problem}`);
  });

  test('the backlog check is not callable by client roles', () => {
    const r = query(`select
      has_function_privilege('anon', 'public.metering_backlog_health()', 'EXECUTE')::text          as anon_exec,
      has_function_privilege('authenticated', 'public.metering_backlog_health()', 'EXECUTE')::text as auth_exec,
      has_function_privilege('service_role', 'public.metering_backlog_health()', 'EXECUTE')::text  as svc_exec;`);
    assert.equal(r.anon_exec, 'false', 'anon can read the metering backlog');
    assert.equal(r.auth_exec, 'false', 'authenticated can read the metering backlog');
    assert.equal(r.svc_exec, 'true', 'service_role lost access to the metering health check');
  });
});

// ── 5. Nothing leaked into the repository ───────────────────────────────────

describe('no credential reached version control', () => {
  test('the cron migration contains no secret literal', () => {
    const sql = readFileSync(join(REPO_ROOT, 'supabase/migrations/20260821140000_canonical_scheduled_jobs.sql'), 'utf8');
    // The literal that was in production had this shape; the JWT and Supabase
    // key shapes are checked too, since a future edit might paste one in.
    for (const [label, re] of [
      ['a cron secret literal', /os-cron-[A-Za-z0-9]{8,}/],
      ['a JWT',                 /eyJ[A-Za-z0-9_.-]{20,}/],
      ['a Supabase secret key', /sb_secret_[A-Za-z0-9_-]{8,}/],
    ] as const) {
      assert.ok(!re.test(sql), `the cron migration contains ${label}`);
    }
    assert.ok(sql.includes('decrypted_secrets'),
      'the migration no longer reads the secret from Vault');
  });
});

// ── 6. Deployed auth matches version control ────────────────────────────────

describe('Edge Function authentication is restorable', () => {
  let deployed: Record<string, boolean> = {};
  let configured: Record<string, boolean> = {};
  before(() => {
    const out = execFileSync('npx', ['supabase', 'functions', 'list', '--project-ref', PROJECT_REF],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
    for (const f of (JSON.parse(out) as { functions: { slug: string; verify_jwt: boolean }[] }).functions) {
      deployed[f.slug] = f.verify_jwt;
    }
    const toml = readFileSync(join(REPO_ROOT, 'supabase/config.toml'), 'utf8');
    for (const m of toml.matchAll(/\[functions\.([a-z0-9-]+)\]\s*\nverify_jwt = (true|false)/g)) {
      configured[m[1]] = m[2] === 'true';
    }
  });

  test('supabase/config.toml exists', () => {
    assert.ok(existsSync(join(REPO_ROOT, 'supabase/config.toml')),
      'config.toml is missing — Edge Function auth is unversioned again');
  });

  test('every publicly reachable function is pinned in config.toml', () => {
    // This is the one that matters: verify_jwt defaults to TRUE on deploy, so
    // a public function missing from config.toml gets authentication switched
    // on by the next routine redeploy and simply stops working.
    const publicFns = Object.entries(deployed).filter(([, v]) => v === false).map(([k]) => k);
    assert.ok(publicFns.length > 0, 'read no deployed functions — the check would pass vacuously');
    const unpinned = publicFns.filter((f) => !(f in configured));
    assert.deepEqual(unpinned, [],
      `deployed with verify_jwt=false but absent from config.toml: ${unpinned.join(', ')}`);
  });

  test('config.toml does not contradict what is deployed', () => {
    const wrong = Object.entries(configured)
      .filter(([slug, want]) => slug in deployed && deployed[slug] !== want)
      .map(([slug, want]) => `${slug}: config=${want}, deployed=${deployed[slug]}`);
    assert.deepEqual(wrong, [], `config.toml would change auth on next deploy — ${wrong.join('; ')}`);
  });

  test('the scheduled functions are reachable without a JWT, and meter-bookings is not', () => {
    for (const f of ['reminder-runner', 'social-composer', 'social-publisher', 'sync-council-jobs']) {
      assert.equal(deployed[f], false,
        `${f} requires a JWT, but pg_net sends none — the scheduler would get 401`);
    }
    assert.equal(deployed['meter-bookings'], true,
      'meter-bookings is publicly reachable — it bills money and must stay behind the gateway');
  });
});
