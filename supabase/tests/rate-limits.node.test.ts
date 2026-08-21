/**
 * rate-limits.node.test.ts — the M3 abuse ceiling (Step 15).
 *
 * WHAT WAS WRONG
 *
 * Nothing counted how often anything was asked for. Step 14 made the sensitive
 * endpoints require a real account; that stops an anonymous stranger and does
 * nothing about one free account asking for a hub broadcast, a driver fan-out
 * or a paid transcription in a loop.
 *
 * Step 15 also found four endpoints with NO caller check at all —
 * transcribe-audio, notify-booking, notify-business-claim and notify-hub —
 * the same shape as the Step 14 fan-outs. transcribe-audio was the worst of
 * them: it took a media_id from the body, used the service role to fetch that
 * object out of the private memories-media bucket, and paid OpenAI to
 * transcribe it, for anybody holding the public anon key.
 *
 * WHAT IS ASSERTED
 *   · the boundary holds: the (n+1)th claim in a window is refused
 *   · one subject's exhaustion does not affect another's (user isolation)
 *   · one action's exhaustion does not affect another's (route isolation)
 *   · an aggregate stops route-rotation before any per-route ceiling does
 *   · every aggregate is set BELOW the sum of its members, or it can never bind
 *   · an unrecognised action is DENIED, not allowed
 *   · no client role may claim, inspect or reset a bucket
 *   · the four Step 15 auth holes refuse the public anon key
 *   · cost-pattern functions are either limited or listed here with a reason
 *
 * SAFETY
 * Every limiter assertion runs inside a transaction that is never committed,
 * so no bucket survives the test. The concurrency proof needs genuinely
 * separate connections and therefore has to commit — it lives in the opt-in
 * fixture suite, not here. No email, push, Stripe object or provider call is
 * produced by this file.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FN_DIR = join(REPO_ROOT, 'supabase', 'functions');

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
    } catch { /* handled by the null return */ }
  }
  return url && anonKey ? { url, anonKey } : null;
}
const cfg = publicConfig();

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));
const one = (sql: string) => runSql(sql)[0] ?? {};

/**
 * Claims run as SEPARATE statements inside one uncommitted transaction.
 *
 * They cannot be a single statement with a LATERAL join: every call in one
 * statement reads the same snapshot, so all of them see an empty bucket and
 * all of them are allowed. That looks exactly like a broken limiter and is not
 * one — it is how the first version of this test lied.
 */
function claimSeries(claims: { label: string; subject: string; actions: string[] }[]): Record<string, unknown>[] {
  const stmts = ['begin;', 'create temp table t(i serial, label text, allowed boolean, blocked text, used int, maxa int, retry int);'];
  for (const c of claims) {
    const arr = `array[${c.actions.map((a) => `'${a}'`).join(',')}]`;
    stmts.push(`insert into t(label, allowed, blocked, used, maxa, retry) select '${c.label}', r.allowed, coalesce(r.blocked_action,'-'), r.used, r.max_allowed, r.retry_after_secs from public.claim_rate_limits('${c.subject}', ${arr}) r;`);
  }
  stmts.push("select label, allowed, blocked, used, maxa, retry from t order by i;");
  return runSql(stmts.join('\n'));
}

// ── 1. The boundary ─────────────────────────────────────────────────────────

describe('the limiter counts and refuses', () => {
  test('the claim after the ceiling is refused, with a retry hint', () => {
    // notify_broadcast is 6/hour.
    const rows = claimSeries(
      Array.from({ length: 8 }, (_, i) => ({ label: `c${i + 1}`, subject: 'user:rl-test-boundary', actions: ['notify_broadcast'] })),
    );
    const allowed = rows.filter((r) => r.allowed === true || r.allowed === 't').length;
    assert.equal(allowed, 6, 'exactly the ceiling should pass');
    const last = rows[rows.length - 1];
    assert.equal(last.blocked, 'notify_broadcast');
    assert.ok(Number(last.retry) > 0, 'a refusal must say when to come back');
  });

  test('an unrecognised action is denied, not allowed', () => {
    const [row] = claimSeries([{ label: 'unknown', subject: 'user:rl-test-unknown', actions: ['definitely_not_a_policy'] }]);
    assert.ok(row.allowed === false || row.allowed === 'f',
      'an endpoint nobody classified must fail closed, not get an unlimited allowance');
  });
});

// ── 2. Isolation ────────────────────────────────────────────────────────────

describe('exhaustion is contained', () => {
  test('one subject exhausting a route does not affect another subject', () => {
    const claims = Array.from({ length: 6 }, (_, i) => ({ label: `fill${i}`, subject: 'user:rl-iso-a', actions: ['notify_broadcast'] }));
    claims.push({ label: 'a-again', subject: 'user:rl-iso-a', actions: ['notify_broadcast'] });
    claims.push({ label: 'b-first', subject: 'user:rl-iso-b', actions: ['notify_broadcast'] });
    const rows = claimSeries(claims);
    const a = rows.find((r) => r.label === 'a-again')!;
    const b = rows.find((r) => r.label === 'b-first')!;
    assert.ok(a.allowed === false || a.allowed === 'f', 'the exhausted subject must be refused');
    assert.ok(b.allowed === true || b.allowed === 't', 'a different subject must be unaffected');
  });

  test('one route exhausting does not affect another route', () => {
    const claims = Array.from({ length: 6 }, (_, i) => ({ label: `fill${i}`, subject: 'user:rl-route', actions: ['notify_broadcast'] }));
    claims.push({ label: 'other-route', subject: 'user:rl-route', actions: ['redeem_start'] });
    const rows = claimSeries(claims);
    const o = rows.find((r) => r.label === 'other-route')!;
    assert.ok(o.allowed === true || o.allowed === 't', 'a different action has its own allowance');
  });
});

// ── 3. Aggregates ───────────────────────────────────────────────────────────

describe('aggregates stop route rotation', () => {
  test('every aggregate is below the sum of its members, or it can never bind', () => {
    // This is not theory: notify_any was first set to 90 while its members
    // summed to 86, so no amount of rotation could ever reach it.
    const r = one(`
      with m as (
        select
          (select max_count from public.rate_limit_policies where action = 'notify_any')   as notify_any,
          (select sum(max_count) from public.rate_limit_policies
            where action in ('notify_broadcast','notify_fanout','notify_direct'))          as notify_sum,
          (select max_count from public.rate_limit_policies where action = 'stripe_any')   as stripe_any,
          (select sum(max_count) from public.rate_limit_policies
            where action in ('stripe_intent','stripe_account'))                            as stripe_sum
      )
      select (notify_any < notify_sum) as notify_ok, (stripe_any < stripe_sum) as stripe_ok,
             notify_any::text, notify_sum::text, stripe_any::text, stripe_sum::text from m;`);
    assert.ok(r.notify_ok === true || r.notify_ok === 't',
      `notify_any (${r.notify_any}) must be below the sum of its members (${r.notify_sum})`);
    assert.ok(r.stripe_ok === true || r.stripe_ok === 't',
      `stripe_any (${r.stripe_any}) must be below the sum of its members (${r.stripe_sum})`);
  });

  test('rotating between notification routes is stopped by the aggregate', () => {
    // 20 fan-out (its own ceiling) then 40 direct (ceiling 60) = 60 aggregate.
    const claims = [
      ...Array.from({ length: 20 }, (_, i) => ({ label: `f${i}`, subject: 'user:rl-agg', actions: ['notify_fanout', 'notify_any'] })),
      ...Array.from({ length: 40 }, (_, i) => ({ label: `d${i}`, subject: 'user:rl-agg', actions: ['notify_direct', 'notify_any'] })),
      { label: 'over', subject: 'user:rl-agg', actions: ['notify_direct', 'notify_any'] },
    ];
    const rows = claimSeries(claims);
    const over = rows.find((r) => r.label === 'over')!;
    assert.ok(over.allowed === false || over.allowed === 'f', 'rotation must not buy an unlimited allowance');
    assert.equal(over.blocked, 'notify_any',
      'the aggregate should be what stops it — notify_direct still had allowance left');
  });
});

// ── 4. Nobody but our own backend may claim ─────────────────────────────────

describe('limiter privileges', () => {
  test('no client role can claim, and both tables carry RLS', () => {
    const r = one(`
      select
        (select case when has_function_privilege('anon', p.oid,'EXECUTE') then 'yes' else 'no' end
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='claim_rate_limits')          as anon_exec,
        (select case when has_function_privilege('authenticated', p.oid,'EXECUTE') then 'yes' else 'no' end
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='claim_rate_limits')          as authd_exec,
        (select case when has_function_privilege('service_role', p.oid,'EXECUTE') then 'yes' else 'no' end
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='claim_rate_limits')          as svc_exec,
        (select coalesce(array_to_string(p.proconfig,','),'')
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='claim_rate_limits')          as cfg,
        (select case when relrowsecurity then 'on' else 'off' end from pg_class where relname='rate_limits')         as rls_buckets,
        (select case when relrowsecurity then 'on' else 'off' end from pg_class where relname='rate_limit_policies') as rls_policies;`);
    assert.equal(r.anon_exec, 'no', 'anon must not be able to claim or burn a bucket');
    assert.equal(r.authd_exec, 'no', 'a signed-in user must not be able to claim directly');
    assert.equal(r.svc_exec, 'yes', 'our own backend must be able to claim');
    assert.match(String(r.cfg), /search_path=/, 'a SECURITY DEFINER limiter needs a pinned search_path');
    assert.equal(r.rls_buckets, 'on');
    assert.equal(r.rls_policies, 'on');
  });
});

// ── 5. The endpoints ────────────────────────────────────────────────────────

/**
 * Functions that match a cost pattern but are deliberately NOT limited.
 * Anything not listed here must import the limiter, so a new expensive
 * endpoint cannot be added without a decision being recorded in one of these
 * two places.
 */
const EXEMPT: Record<string, string> = {
  'stripe-webhook':              'authenticated by Stripe signature; throttling it would drop real events',
  'meter-bookings':              'service-role only — 403 to the anon key; driven by cron, not the internet',
  'reminder-runner':             'cron secret (Step 10B)',
  'social-composer':             'cron secret (Step 10B)',
  'social-publisher':            'cron secret (Step 10B)',
  'sync-council-jobs':           'cron secret (Step 10B)',
  'notify-hub':                  'limited, but exempt from the source scan because its guard is inside the try block',
  // Post-payment fulfilment. Money has already moved; refusing these strands a
  // paid order, which is a worse outcome than the abuse a ceiling would stop.
  // Each verifies the caller owns the intent, so spamming re-reads only your own.
  'authorise-payment':           'post-payment fulfilment — refusing it strands money already taken',
  'capture-payment':             'post-payment fulfilment — refusing it strands money already taken',
  'cancel-payment':              'post-payment fulfilment — refusing it strands money already taken',
  'refund-payment':              'post-payment fulfilment — refusing it strands a refund owed',
  'confirm-boost':               'post-payment fulfilment — refusing it strands money already taken',
  'confirm-card-setup':          'post-payment fulfilment — refusing it strands money already taken',
  'confirm-event-tickets':       'post-payment fulfilment — refusing it strands money already taken',
  'confirm-gift':                'post-payment fulfilment — refusing it strands money already taken',
  'confirm-hub-donation':        'post-payment fulfilment — refusing it strands money already taken',
  'confirm-hub-membership':      'post-payment fulfilment — refusing it strands money already taken',
  'confirm-unit-purchase':       'post-payment fulfilment — refusing it strands money already taken',
  'local-wallet-confirm-topup':  'post-payment fulfilment — refusing it strands money already taken',
  'wallet-checkout':             'post-payment fulfilment — refusing it strands money already taken',
  'local-subscription-invoices': 'reads the caller’s own invoices from Stripe; no object is created',
  'remove-card':                 'removes the caller’s own saved card; no object is created',
};

function costPatternFunctions(): { name: string; tags: string[]; limited: boolean }[] {
  const out: { name: string; tags: string[]; limited: boolean }[] = [];
  for (const name of readdirSync(FN_DIR)) {
    const p = join(FN_DIR, name, 'index.ts');
    if (name === '_shared' || !existsSync(p)) continue;
    const b = readFileSync(p, 'utf8');
    const tags: string[] = [];
    if (/send-email\.ts|sendEmail/.test(b)) tags.push('EMAIL');
    if (/send-push\.ts|sendPush/.test(b)) tags.push('PUSH');
    if (/api\.stripe\.com/.test(b)) tags.push('STRIPE');
    if (/api\.openai|googleapis|admiralty/i.test(b)) tags.push('PROVIDER');
    if (tags.length) out.push({ name, tags, limited: b.includes('rate-limit.ts') });
  }
  return out;
}

describe('the protected endpoint inventory', () => {
  test('every cost-pattern function is limited or has a recorded reason', () => {
    const unexplained = costPatternFunctions()
      .filter((f) => !f.limited && !(f.name in EXEMPT))
      .map((f) => `${f.name} (${f.tags.join(',')})`);
    assert.deepEqual(unexplained, [],
      `these can cost money or reach people, with no ceiling and no recorded reason: ${unexplained.join(', ')}`);
  });

  test('every policy in the table is actually claimed by something', () => {
    // rate_limit_policies is the answer to "what is limited here". A row that
    // no call site claims makes that answer overstate the protection. One was
    // seeded in this very step (password_reset_email, superseded by the
    // email_log throttle already inside request-password-reset) and removed.
    const declared = runSql('select action from public.rate_limit_policies order by action;')
      .map((r) => String(r.action));
    const claimed = new Set<string>();
    for (const name of readdirSync(FN_DIR)) {
      const p = join(FN_DIR, name, 'index.ts');
      if (name === '_shared' || !existsSync(p)) continue;
      for (const m of readFileSync(p, 'utf8').matchAll(/'([a-z_]+)'/g)) claimed.add(m[1]);
    }
    const orphans = declared.filter((a) => !claimed.has(a));
    assert.deepEqual(orphans, [], `policies nothing claims: ${orphans.join(', ')}`);
  });

  test('the exemption list has not gone stale', () => {
    const present = new Set(costPatternFunctions().map((f) => f.name));
    const gone = Object.keys(EXEMPT).filter((n) => !present.has(n));
    assert.deepEqual(gone, [], `exemptions for functions that no longer match a cost pattern: ${gone.join(', ')}`);
  });

  test('every notification route claims the aggregate, or it means nothing', () => {
    const missing = readdirSync(FN_DIR)
      .filter((n) => n.startsWith('notify-'))
      .filter((n) => existsSync(join(FN_DIR, n, 'index.ts')))
      .filter((n) => {
        const b = readFileSync(join(FN_DIR, n, 'index.ts'), 'utf8');
        return b.includes('rate-limit.ts') && !b.includes('notify_any');
      });
    assert.deepEqual(missing, [], `limited but not counted against notify_any: ${missing.join(', ')}`);
  });
});

// ── 6. The Step 15 authorisation holes ──────────────────────────────────────

describe('the endpoints that had no caller check at all', () => {
  test('each refuses the public anon key', { skip: !cfg }, async () => {
    for (const fn of ['transcribe-audio', 'notify-booking', 'notify-business-claim', 'notify-hub']) {
      const res = await fetch(`${cfg!.url}/functions/v1/${fn}`, {
        method: 'POST',
        headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.ok([401, 403].includes(res.status), `${fn} answered ${res.status} to the anon key`);
    }
  });

  test('transcribe-audio proves ownership before spending on the provider', () => {
    const b = readFileSync(join(FN_DIR, 'transcribe-audio', 'index.ts'), 'utf8');
    assert.match(b, /requireCaller/, 'the caller must be established');
    assert.match(b, /author_id !== caller\.userId/, 'the audio must belong to the caller');
    // The ownership check has to come before the money is spent.
    assert.ok(b.indexOf('author_id !== caller.userId') < b.indexOf('form.append'),
      'ownership must be proven before the Whisper call, not after');
  });
});

// ── 7. Failing closed ───────────────────────────────────────────────────────

describe('a broken limiter refuses', () => {
  test('the helper answers 503, never "carry on"', () => {
    const b = readFileSync(join(FN_DIR, '_shared', 'rate-limit.ts'), 'utf8');
    // Every failure path must produce a denial; none may return { ok: true }.
    const failureBlocks = b.split('return { denied:').length - 1;
    assert.ok(failureBlocks >= 4, 'each failure mode needs its own denial');
    assert.match(b, /503/, 'infrastructure failure is a 503');
    assert.match(b, /429/, 'quota exhaustion is a 429');
    assert.match(b, /Too many requests/, 'the 429 body is the agreed one');
    assert.ok(!/catch[\s\S]{0,200}return \{ ok: true \}/.test(b),
      'a thrown limiter must never be treated as permission');
  });

  test('the 429 tells the caller nothing about the limiter', () => {
    const b = readFileSync(join(FN_DIR, '_shared', 'rate-limit.ts'), 'utf8');
    const denial = b.slice(b.indexOf('if (!verdict.allowed)'));
    assert.ok(!/blocked_action[^\n]*json\(/.test(denial), 'the tripped action is operator detail, not caller detail');
    assert.match(denial, /console\.warn/, 'it should be logged for the operator');
  });
});
