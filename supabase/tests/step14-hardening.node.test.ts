/**
 * step14-hardening.node.test.ts — the Step 14 medium/low sweep, held in place.
 *
 * WHAT THIS GUARDS
 *
 * Four fixes from the consolidated sweep, each of which is easy to undo by
 * accident later:
 *
 * M5 — six notification fan-outs were reachable with nothing but the public
 * anon key. verify_jwt was true on all of them, which proves only that the
 * caller presented a well-formed JWT; the anon key IS a well-formed JWT. The
 * fix is _shared/require-caller.ts, which rejects the anon key by identity
 * rather than by shape.
 *
 * L2 — every function's catch-all returned `err.message` to the caller, and on
 * the money paths several of them deliberately re-threw Stripe's own text, so
 * provider internals reached whoever made the request. The fix is
 * _shared/safe-error.ts: the caller gets one fixed sentence, the operator still
 * gets the real error in the function log.
 *
 * §17 — fetch_memory_pins and search_memories still selected memory_media.url,
 * the legacy PUBLIC object URL. Step 13C made that bucket private, so every one
 * of those URLs was a dead 400 and the mobile map pins had been rendering them
 * directly. They now return storage_path and the reader signs it.
 *
 * M1 — the website's security headers.
 *
 * WHAT IS ASSERTED
 *   · no tracked Edge Function returns a raw error message to a caller
 *   · the six fan-outs reject the public anon key
 *   · neither memory feed reads memory_media.url; both return a path; both keep
 *     their visibility predicate and their anon EXECUTE grant
 *   · a real anon call to the feed serves no legacy public URL
 *   · oneshetland.com serves the headers, live
 *
 * SAFETY
 * Read-only. No row is written, no production data changes, and no key, path,
 * URL or author appears in the output. Belongs in the routine suite.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
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
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }));
const one = (sql: string) => runSql(sql)[0] ?? {};

/** Every tracked Edge Function entry point. */
function functionSources(): { name: string; body: string }[] {
  const files = execFileSync('git', ['ls-files', 'supabase/functions/*/index.ts'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean);
  return files.map((rel) => ({ name: rel.split('/')[2], body: readFileSync(join(REPO_ROOT, rel), 'utf8') }));
}

// ── 1. L2 — no function hands a raw error to a caller ───────────────────────

describe('provider error messages stay server-side', () => {
  test('the shared helper exists and returns a constant, not the error', () => {
    const p = join(FN_DIR, '_shared', 'safe-error.ts');
    assert.ok(existsSync(p), '_shared/safe-error.ts is missing');
    const body = readFileSync(p, 'utf8');
    assert.match(body, /export const SAFE_ERROR_MESSAGE\s*=\s*'/, 'the safe message must be a fixed constant');
    assert.match(body, /console\.error\(/, 'the real error must still reach the function log');
    // The helper must not interpolate the error into what it returns.
    const returned = body.slice(body.indexOf('export function safeError'));
    assert.ok(!/return\s+[`'"].*\$\{/.test(returned), 'safeError must not return anything derived from err');
  });

  test('no tracked function echoes err.message to the caller', () => {
    // A line that feeds the message to an RPC parameter (p_error) is recording
    // the failure IN the database for an operator to read later — that one
    // should keep the real text. Only what travels back to the caller counts.
    const offenders = functionSources()
      .filter(({ body }) => body.split('\n').some((line) =>
        /err instanceof Error \? err\.message/.test(line) && !/\bp_[a-z_]*\s*:/.test(line)))
      .map(({ name }) => name);
    assert.deepEqual(offenders, [], `these return the raw error to the caller: ${offenders.join(', ')}`);
  });

  test('the money paths import the helper', () => {
    const money = ['wallet-checkout', 'capture-payment', 'refund-payment', 'authorise-payment',
                   'local-wallet-pay', 'create-event-ticket-intent', 'confirm-event-tickets'];
    const src = new Map(functionSources().map((f) => [f.name, f.body]));
    for (const m of money) {
      const body = src.get(m);
      if (!body) continue; // covered by the drift test, not this one
      assert.match(body, /_shared\/safe-error\.ts/, `${m} does not use the safe error helper`);
    }
  });
});

// ── 2. M5 — the fan-outs reject the public anon key ─────────────────────────

const FAN_OUTS = ['notify-event-update', 'notify-engagement', 'notify-hub-content',
                  'notify-job', 'notify-shift-status', 'notify-claim'];

describe('notification fan-outs are not reachable with the anon key', () => {
  test('each fan-out guards its caller in source', () => {
    const src = new Map(functionSources().map((f) => [f.name, f.body]));
    for (const f of FAN_OUTS) {
      const body = src.get(f);
      assert.ok(body, `${f} has no tracked source`);
      assert.match(body!, /require-caller\.ts/, `${f} does not call requireCaller`);
    }
  });

  /**
   * Statuses that are the platform failing to produce an answer at all — a
   * cold container that did not boot in time, or the gateway shedding while it
   * starts one. They are not the function's reply, so they are not evidence
   * about authorisation either way, and they are the ONLY HTTP statuses this
   * test will ask again about.
   *
   * Nothing else is retried. In particular a 2xx is failed immediately and can
   * never be retried away: "first response 200, second response 401" is a
   * security failure, not a flake, so the 2xx check comes before any retry.
   */
  const NO_ANSWER_YET = new Set([502, 503, 504, 546]);
  const ATTEMPTS = 3;

  test('each fan-out rejects a request bearing only the anon key', { skip: !cfg }, async () => {
    for (const f of FAN_OUTS) {
      let settled = false;
      for (let attempt = 1; attempt <= ATTEMPTS && !settled; attempt++) {
        let res: Response;
        try {
          res = await fetch(`${cfg!.url}/functions/v1/${f}`, {
            method: 'POST',
            headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
            body: '{}',
          });
        } catch (e) {
          // No HTTP response was received, so there is nothing to assert on.
          // Only this case — and the no-answer statuses below — may be retried.
          const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          assert.ok(attempt < ATTEMPTS, `${f} never answered over ${ATTEMPTS} attempts (${why})`);
          console.error(`  [fan-out probe] ${f} transport failure on attempt ${attempt}: ${why}`);
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          continue;
        }

        // Checked FIRST, before any retry decision, so an accepted
        // unauthenticated request can never be papered over by a later 401.
        assert.ok(res.status < 200 || res.status >= 300,
          `${f} ACCEPTED the anon key with ${res.status} — the anon key ships in the website bundle`);

        if (NO_ANSWER_YET.has(res.status) && attempt < ATTEMPTS) {
          console.error(`  [fan-out probe] ${f} answered ${res.status} on attempt ${attempt} (no answer yet, asking again)`);
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          continue;
        }

        // The contract is exactly 401. A 400 or 404 would mean the body was
        // processed, which is exactly how this was found: notify-event-update
        // answered "update not found", proving it had already reached the
        // database. A 429 would mean a limiter answered instead of the
        // authorisation check, which is not the guarantee being made here.
        const body = await res.text().catch(() => '<unreadable>');
        assert.equal(res.status, 401,
          `${f} answered ${res.status} to the anon key (expected 401): ${body.slice(0, 200)}`);
        settled = true;
      }
    }
  });
});

// ── 3. §17 — the memory feeds serve a path, not a dead public URL ───────────

describe('memory feeds resolve media by path', () => {
  for (const fn of ['fetch_memory_pins', 'search_memories']) {
    test(`${fn} no longer reads memory_media.url`, () => {
      const r = one(`
        select case when p.prosrc ilike '%mm.url%' then 'yes' else 'no' end as legacy,
               case when p.prosrc ilike '%storage_path%' then 'yes' else 'no' end as path,
               case when p.prosrc ilike '%visibility%' then 'yes' else 'no' end as visibility,
               coalesce(array_to_string(p.proconfig, ','), '') as cfg,
               case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'yes' else 'no' end as anon_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = '${fn}';`);
      assert.equal(r.legacy, 'no', `${fn} still selects the legacy public URL`);
      assert.equal(r.path, 'yes', `${fn} must return the durable storage path`);
      assert.equal(r.visibility, 'yes', `${fn} lost its visibility predicate`);
      assert.match(String(r.cfg), /search_path=/, `${fn} is SECURITY DEFINER with an unpinned search_path`);
      assert.equal(r.anon_exec, 'yes', `${fn} lost its anon EXECUTE grant — the public map would break`);
    });
  }

  test('a real anon call serves no legacy public URL', { skip: !cfg }, async () => {
    const res = await fetch(`${cfg!.url}/rest/v1/rpc/fetch_memory_pins`, {
      method: 'POST',
      headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ min_lat: 59.4, max_lat: 61.0, min_lng: -2.4, max_lng: -0.4, result_limit: 50 }),
    });
    assert.equal(res.status, 200, 'anon must still be able to read the public map');
    const pins = await res.json() as { hero_url: string | null; hero_path: string | null }[];
    assert.ok(Array.isArray(pins));
    assert.equal(pins.filter((p) => p.hero_url).length, 0, 'a legacy public URL is still being served');
    assert.ok('hero_path' in (pins[0] ?? { hero_path: null }), 'hero_path is missing from the feed');
  });

  test('every client signs the hero rather than rendering it raw', () => {
    const api = readFileSync(join(REPO_ROOT, 'lib', 'memories-api.ts'), 'utf8');
    assert.match(api, /async function signHeroes/, 'the mobile client does not sign hero_path');
    assert.match(api, /createSignedUrls/, 'the mobile client must sign, not build public URLs');
  });
});

// ── 4. M1 — the website's headers, live ─────────────────────────────────────

describe('oneshetland.com security headers', () => {
  test('the live site serves them', async () => {
    const res = await fetch(`https://oneshetland.com/?cb=${Date.now()}`, { redirect: 'follow' });
    const want = ['content-security-policy-report-only', 'x-frame-options',
                  'x-content-type-options', 'referrer-policy', 'permissions-policy'];
    const missing = want.filter((h) => !res.headers.get(h));
    assert.deepEqual(missing, [], `live site is missing: ${missing.join(', ')}`);
  });
});
