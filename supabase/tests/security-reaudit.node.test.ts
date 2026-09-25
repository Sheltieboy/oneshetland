/**
 * security-reaudit.node.test.ts — the 25 Sep 2026 re-audit of the 19 Aug findings.
 *
 * What it pins:
 *   F4  notify-hub: being signed in is not enough. Which notice a caller may raise
 *       is tied to the HUB (the same is_hub_admin / hub_members authority the
 *       database uses), and decided before anything is sent.
 *   F5  calculate-fee: nothing but a UK postcode reaches the URL.
 *   F3  ai-cover-letter: a per-account hourly and daily cap before any paid call.
 *   F7  the six functions with no fixed search_path are pinned.
 *   NEW three anon-callable functions failed OPEN (NULL auth.uid() made the guard
 *       vanish): accept_image_pin_suggestion, business_analytics, accept_alert_policy.
 *       The live tests prove anon can no longer reach them, and sweep the whole
 *       CLASS so the next one is caught by a test, not by an audit.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// deno-lint-ignore no-explicit-any
const Auth: Record<string, any> = loadModule('supabase/functions/_shared/hub-notify-auth.ts');
// deno-lint-ignore no-explicit-any
const Postcode: Record<string, any> = loadModule('supabase/functions/_shared/uk-postcode.ts');

/* ── F4: notify-hub authorisation ─────────────────────────────────────── */

const HUB_A = '11111111-1111-4111-8111-111111111111';
const HUB_B = '22222222-2222-4222-8222-222222222222';
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';   // an ordinary user
const BOB   = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';   // another ordinary user
const CAROL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';   // an ordinary user with a genuinely pending request

type Member = { hub_id: string; user_id: string; status: string };

/** A fake service client: hub_members rows + which (hub,user) pairs are hub admins. */
function fakeSvc(members: Member[], admins: [string, string][], adminRpcFails = false) {
  const rpcCalls: unknown[] = [];
  return {
    rpcCalls,
    rpc: async (name: string, args: { p_hub: string; p_user: string }) => {
      rpcCalls.push({ name, args });
      if (adminRpcFails) return { data: null, error: { message: 'boom' } };
      return { data: admins.some(([h, u]) => h === args.p_hub && u === args.p_user), error: null };
    },
    from: (_t: string) => {
      const f: Record<string, string> = {};
      const q = {
        select: () => q,
        eq: (k: string, v: string) => { f[k] = v; return q; },
        limit: async () => ({ data: members.filter((m) => Object.entries(f).every(([k, v]) => (m as Record<string, string>)[k] === v)) }),
      };
      return q;
    },
  };
}
const user = (id: string) => ({ userId: id, isServiceRole: false });
const service = { userId: '', isServiceRole: true };
const ok = async (svc: unknown, caller: unknown, event: unknown, hubId: unknown, userId: unknown) =>
  (await Auth.authoriseHubNotify(svc, caller, { event, hubId, userId })).ok === true;
const status = async (svc: unknown, caller: unknown, event: unknown, hubId: unknown, userId: unknown) =>
  (await Auth.authoriseHubNotify(svc, caller, { event, hubId, userId })).status;

describe('notify-hub: an ordinary signed-in user cannot notify for a hub they do not administer', () => {
  const svc = () => fakeSvc(
    [{ hub_id: HUB_A, user_id: BOB, status: 'active' }, { hub_id: HUB_A, user_id: ALICE, status: 'pending' }, { hub_id: HUB_A, user_id: CAROL, status: 'pending' }],
    [[HUB_A, ADMIN]],
  );

  test('approved → "you are now a member" cannot be pushed to someone by a non-admin', async () => {
    assert.equal(await ok(svc(), user(ALICE), 'approved', HUB_A, BOB), false, 'ALICE is not an admin of HUB_A');
    assert.equal(await status(svc(), user(ALICE), 'approved', HUB_A, BOB), 403);
  });

  test('approved → cannot self-approve, even for a hub they belong to', async () => {
    assert.equal(await ok(svc(), user(ALICE), 'approved', HUB_A, ALICE), false);
    assert.equal(await ok(svc(), user(BOB), 'approved', HUB_A, BOB), false, 'an ordinary active member is not an admin');
  });

  test('approved → an admin of hub A cannot raise a notice for hub B', async () => {
    const s = fakeSvc([{ hub_id: HUB_B, user_id: BOB, status: 'active' }], [[HUB_A, ADMIN]]);
    assert.equal(await ok(s, user(ADMIN), 'approved', HUB_B, BOB), false);
  });

  test('approved → the hub admin telling a genuinely active member IS allowed', async () => {
    assert.equal(await ok(svc(), user(ADMIN), 'approved', HUB_A, BOB), true);
  });

  test('approved → even a real admin cannot "approve" someone who is not an active member', async () => {
    assert.equal(await ok(svc(), user(ADMIN), 'approved', HUB_A, ALICE), false, 'ALICE is only pending');
    assert.equal(await ok(svc(), user(ADMIN), 'approved', HUB_A, '99999999-9999-4999-8999-999999999999'), false);
  });

  test('the admin test asks about the CALLER, never the user_id in the body', async () => {
    const s = svc();
    await Auth.authoriseHubNotify(s, user(ALICE), { event: 'approved', hubId: HUB_A, userId: ADMIN });
    assert.deepEqual(s.rpcCalls, [{ name: 'is_hub_admin', args: { p_hub: HUB_A, p_user: ALICE } }],
      'passing an admin as user_id must not make the caller an admin');
    assert.equal(await ok(svc(), user(ALICE), 'approved', HUB_A, ADMIN), false);
  });

  test('a failing admin lookup denies (fail closed)', async () => {
    const s = fakeSvc([{ hub_id: HUB_A, user_id: BOB, status: 'active' }], [[HUB_A, ADMIN]], true);
    assert.equal(await ok(s, user(ADMIN), 'approved', HUB_A, BOB), false);
  });

  test('join_request → you can only announce YOUR OWN pending request', async () => {
    assert.equal(await ok(svc(), user(ALICE), 'join_request', HUB_A, ALICE), true);
    assert.equal(await ok(svc(), user(ALICE), 'join_request', HUB_A, BOB), false, 'naming another user as the requester is spoofing');
    assert.equal(await ok(svc(), user(ALICE), 'join_request', HUB_A, CAROL), false,
      'even when CAROL really has a pending request, ALICE cannot announce it in her name — only identity stops this');
  });

  test('join_request → no request, an active membership, or a different hub is refused', async () => {
    assert.equal(await ok(svc(), user(ALICE), 'join_request', HUB_B, ALICE), false, 'no row for that hub');
    assert.equal(await ok(svc(), user(BOB), 'join_request', HUB_A, BOB), false, 'BOB is active, not pending');
    assert.equal(await ok(fakeSvc([], []), user(ALICE), 'join_request', HUB_A, ALICE), false);
  });

  test('membership_paid → clients can never raise it; only our backend can', async () => {
    assert.equal(await ok(svc(), user(ALICE), 'membership_paid', HUB_A, ALICE), false);
    assert.equal(await ok(svc(), user(ADMIN), 'membership_paid', HUB_A, BOB), false);
    assert.equal(await ok(svc(), service, 'membership_paid', HUB_A, BOB), true);
  });

  test('the service role (fulfilment) stays trusted for every event', async () => {
    for (const e of ['join_request', 'approved', 'membership_paid']) assert.equal(await ok(svc(), service, e, HUB_A, BOB), true, e);
  });

  test('malformed input is a 400 before any lookup', async () => {
    const s = svc();
    assert.equal(await status(s, user(ALICE), 'nope', HUB_A, ALICE), 400);
    assert.equal(await status(s, user(ALICE), 'approved', 'not-a-uuid', ALICE), 400);
    assert.equal(await status(s, user(ALICE), 'approved', undefined, ALICE), 400);
    assert.equal(await status(s, user(ALICE), 'approved', HUB_A, 'nope'), 400);
    assert.equal(await status(s, user(ALICE), 'approved', HUB_A, { a: 1 }), 400);
    assert.equal(s.rpcCalls.length, 0);
  });
});

describe('notify-hub: the function applies the gate before it does anything', () => {
  const src = strip(read('supabase/functions/notify-hub/index.ts'));
  const gate = src.indexOf('authoriseHubNotify(');
  test('authorisation runs before any lookup or send', () => {
    assert.ok(gate > 0, 'the gate is called');
    for (const marker of ["from('hubs')", "from('profiles')", "from('hub_members')", 'sendUserPushBulk(svc']) {
      assert.ok(src.indexOf(marker) > gate, `${marker} must come AFTER the gate`);
    }
  });
  test('a denial returns before recipients are resolved', () => {
    assert.match(src, /if \(!decision\.ok\) return json\(\{ error: decision\.error \}, decision\.status\)/);
  });
  test('still requires a real caller and is still rate limited', () => {
    assert.match(src, /requireCaller\(req, corsHeaders\)/);
    assert.match(src, /enforceRateLimit\('notify-hub'/);
  });
});

/* ── F5: calculate-fee ────────────────────────────────────────────────── */

describe('calculate-fee: only a UK postcode reaches the URL', () => {
  test('real Shetland and UK postcodes, in any spacing or case, are accepted and normalised', () => {
    for (const [input, out] of [['ZE1 0AA', 'ZE10AA'], ['ze10aa', 'ZE10AA'], [' ZE2  9XX ', 'ZE29XX'], ['AB10 1AA', 'AB101AA'],
      ['EC1A 1BB', 'EC1A1BB'], ['ZE1 0AA\n', 'ZE10AA'] /* stray whitespace is dropped, leaving a clean canonical value */, ['W1A 0AX', 'W1A0AX'], ['M1 1AE', 'M11AE'], ['GY1 1AA', 'GY11AA']]) {
      assert.equal(Postcode.normaliseUkPostcode(input), out, input);
    }
  });
  test('path traversal, query, fragment, encoding, schemes and control characters are refused', () => {
    for (const bad of ['../../etc', 'ZE1 0AA/../..', 'ZE1 0AA?x=1', 'ZE1 0AA#frag', 'ZE1%200AA', 'http://evil.example',
      'ZE1\t0AA/', '@evil', 'ZE1 0AA;', '', ' ', 'ZE1', 'ZE1 0A', 'AAAAAAAA', '12345', "ZE1 0AA' OR 1=1"]) {
      assert.equal(Postcode.normaliseUkPostcode(bad), null, JSON.stringify(bad));
    }
  });
  test('oversized and non-string input is refused without throwing', () => {
    for (const bad of ['Z'.repeat(5000), 12345, null, undefined, {}, [], true, ['ZE1 0AA']]) {
      assert.equal(Postcode.normaliseUkPostcode(bad), null);
    }
  });
  test('the function sends only the validated, encoded value, follows no redirects, and is bounded', () => {
    const src = strip(read('supabase/functions/calculate-fee/index.ts'));
    assert.match(src, /normaliseUkPostcode\(body\?\.pickup_postcode\)/);
    assert.match(src, /normaliseUkPostcode\(body\?\.destination_postcode\)/);
    assert.ok(!/pickup_postcode\.replace|destination_postcode\.replace/.test(src), 'no raw string handling of the body values');
    assert.match(src, /encodeURIComponent\(pc\)/);
    assert.match(src, /redirect: 'error'/);
    assert.match(src, /AbortSignal\.timeout\(/);
    const fetches = src.match(/fetch\(/g) ?? [];
    assert.equal(fetches.length, 1, 'one outbound call site, and it is the validated one');
  });
  test('the whole-endpoint ceiling is checked before any outbound request', () => {
    const src = strip(read('supabase/functions/calculate-fee/index.ts'));
    assert.ok(src.indexOf("['calculate_fee_global']") > 0);
    assert.ok(src.indexOf("['calculate_fee_global']") < src.indexOf('fetch('));
  });
});

/* ── F3: ai-cover-letter ──────────────────────────────────────────────── */

describe('ai-cover-letter: a paid model call is capped per account', () => {
  const src = strip(read('supabase/functions/ai-cover-letter/index.ts'));
  test('still refuses the anon key (needs a real user)', () => {
    assert.match(src, /if \(!user\) return json\(\{ error: 'Not signed in' \}, 401\)/);
  });
  test('an hourly AND daily cap, keyed on the account, before anything is spent', () => {
    assert.match(src, /enforceRateLimit\('ai-cover-letter', userSubject\(user\.id\), \['ai_cover_letter', 'ai_cover_letter_day'\]/);
    const limit = src.indexOf("enforceRateLimit('ai-cover-letter'");
    for (const later of ["from('jobs')", "from('worker_profiles')", 'api.anthropic.com']) {
      assert.ok(src.indexOf(later) > limit, `${later} must come after the limit`);
    }
  });
  test('job_id must be a uuid, and errors no longer echo internals', () => {
    assert.match(src, /typeof job_id !== 'string'/);
    assert.ok(!/\(e as Error\)\.message/.test(src));
    assert.match(src, /safeError\('ai-cover-letter'/);
  });
});

/* ── the migration ────────────────────────────────────────────────────── */

describe('the migration', () => {
  const sql = strip(read('supabase/migrations/20261025000000_close_anon_fail_open_rpcs.sql').replace(/^--.*$/gm, ''));
  test('revokes the three fail-open functions from PUBLIC and anon and keeps authenticated', () => {
    for (const sig of ['accept_image_pin_suggestion\\(uuid\\)', 'business_analytics\\(uuid, integer\\)', 'accept_alert_policy\\(uuid\\)']) {
      assert.match(sql, new RegExp(`revoke execute on function public\\.${sig}\\s+from public, anon;`), sig);
      assert.match(sql, new RegExp(`grant execute on function public\\.${sig}\\s+to authenticated, service_role;`), sig);
    }
  });
  test('pins search_path on all six functions', () => {
    for (const fn of ['accept_image_pin_suggestion\\(uuid\\)', 'count_lk_vessels\\(\\)', 'get_spik_stats\\(\\)', 'mark_notifications_read\\(uuid\\[\\]\\)',
      'should_notify\\(uuid, text, boolean\\)', 'unread_notification_count\\(\\)']) {
      assert.match(sql, new RegExp(`alter function public\\.${fn}\\s+set search_path = public, pg_temp;`), fn);
    }
  });
  test('creates the rate-limit policies the new limits depend on (an unknown action is DENIED)', () => {
    for (const a of ['ai_cover_letter', 'ai_cover_letter_day', 'calculate_fee_global']) assert.match(sql, new RegExp(`'${a}'`), a);
  });
});

/* ── live production ──────────────────────────────────────────────────── */

const runSql = (sql: string): Record<string, unknown>[] => {
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
};

describe('live (read-only, rolled-back): production honours the fixes', () => {
  let sqlOk = false;
  before(() => { try { runSql('select 1 as ok'); sqlOk = true; } catch { sqlOk = false; } });
  const skip = 'Supabase CLI or linked project unavailable — run `supabase link` to exercise this layer.';

  test('anon has no EXECUTE on the three fail-open functions; authenticated still does', (t) => {
    if (!sqlOk) return t.skip(skip);
    const rows = runSql(`select p.proname,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
      from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('accept_image_pin_suggestion','business_analytics','accept_alert_policy')`);
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.equal(r.anon_exec, false, `${r.proname} must not be anon-executable`);
      assert.equal(r.auth_exec, true, `${r.proname} must stay callable by signed-in users`);
    }
  });

  test('an unauthenticated call is REFUSED for each (rolled back), and a non-author is still refused', (t) => {
    if (!sqlOk) return t.skip(skip);
    const rows = runSql(`
      begin;
      create temp table ids as select
        (select id from public.memory_image_pin_suggestions limit 1) as sug,
        (select id from public.local_businesses limit 1) as biz;
      create temp table res(what text, outcome text);
      grant all on ids, res to anon, authenticated;
      set local role anon;
      select set_config('request.jwt.claims', '{"role":"anon"}', true);
      do $$ declare i record; begin
        select * into i from ids;
        begin perform public.accept_image_pin_suggestion(i.sug); insert into res values ('anon accept_image_pin_suggestion','SUCCEEDED');
          exception when others then insert into res values ('anon accept_image_pin_suggestion', case when sqlstate='42501' then 'denied' else 'other:'||sqlerrm end); end;
        begin perform public.business_analytics(i.biz, 30); insert into res values ('anon business_analytics','SUCCEEDED');
          exception when others then insert into res values ('anon business_analytics', case when sqlstate='42501' then 'denied' else 'other:'||sqlerrm end); end;
        begin perform public.accept_alert_policy(i.biz); insert into res values ('anon accept_alert_policy','SUCCEEDED');
          exception when others then insert into res values ('anon accept_alert_policy', case when sqlstate='42501' then 'denied' else 'other:'||sqlerrm end); end;
      end $$;
      reset role;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000001"}', true);
      do $$ declare i record; begin
        select * into i from ids;
        begin perform public.accept_image_pin_suggestion(i.sug); insert into res values ('stranger accept_image_pin_suggestion','SUCCEEDED');
          exception when others then insert into res values ('stranger accept_image_pin_suggestion','refused'); end;
        begin perform public.business_analytics(i.biz, 30); insert into res values ('stranger business_analytics','SUCCEEDED');
          exception when others then insert into res values ('stranger business_analytics','refused'); end;
      end $$;
      reset role;
      select what, outcome from res order by what;
      rollback;`);
    const got = Object.fromEntries(rows.map((r) => [r.what as string, r.outcome as string]));
    for (const k of ['anon accept_image_pin_suggestion', 'anon business_analytics', 'anon accept_alert_policy']) assert.equal(got[k], 'denied', k);
    assert.equal(got['stranger accept_image_pin_suggestion'], 'refused');
    assert.equal(got['stranger business_analytics'], 'refused');
  });

  test('THE CLASS: no anon-callable, non-trigger SECURITY DEFINER function guards with `<> auth.uid()` (NULL makes that guard vanish)', (t) => {
    if (!sqlOk) return t.skip(skip);
    const rows = runSql(`select p.proname from pg_proc p
      where p.prosecdef and p.pronamespace = 'public'::regnamespace and p.prorettype <> 'trigger'::regtype
        and has_function_privilege('anon', p.oid, 'EXECUTE')
        and pg_get_functiondef(p.oid) ~* '(<>|!=)\\s*auth\\.uid\\(\\)|auth\\.uid\\(\\)\\s*(<>|!=)'
      order by 1`);
    assert.deepEqual(rows.map((r) => r.proname), [], 'these are callable without signing in and skip their ownership check when auth.uid() is NULL');
  });

  test('every SECURITY DEFINER function in public has a fixed search_path', (t) => {
    if (!sqlOk) return t.skip(skip);
    const rows = runSql(`select p.proname from pg_proc p where p.prosecdef and p.pronamespace = 'public'::regnamespace
      and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) order by 1`);
    assert.deepEqual(rows.map((r) => r.proname), []);
  });

  test('the rate-limit policies exist (an unknown action is denied, so the limits would lock the functions)', (t) => {
    if (!sqlOk) return t.skip(skip);
    const rows = runSql(`select action, max_count, window_seconds from public.rate_limit_policies
      where action in ('ai_cover_letter','ai_cover_letter_day','calculate_fee_global') order by action`);
    assert.equal(rows.length, 3);
  });
});
