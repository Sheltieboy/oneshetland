/**
 * test-registration.node.test.ts — every suite is either registered or
 * excluded on purpose, and the retired snapshot cannot come back to life.
 *
 * WHAT WAS WRONG
 *
 * Suites existed on disk that no npm command ran. Two had rotted without
 * anyone noticing: wallet-attempts asserted a payment call site that had
 * moved, and wallet-launch-reconciliation asserted launch-day figures that
 * ordinary use had long since passed. A suite nobody runs is not a safety
 * net; it is a note claiming there is one.
 *
 * The first version of this file then made the same mistake one level up: it
 * read scripts.test and nothing else, so it could not see the committed-
 * fixture lane and cheerfully reported a suite as unregistered while
 * test:fixtures was running it. Read every lane, or do not claim coverage.
 *
 * WHAT IS ASSERTED
 *   · every executable suite on disk is registered in SOME npm test lane
 *   · no suite is registered in two lanes, so test:all cannot run it twice
 *   · the routine lane stays free of suites that commit real rows — that is
 *     the promise npm test makes in this directory's README
 *   · the retired reconciliation snapshot is outside the executable pattern,
 *     absent from every lane, and refuses to run if invoked directly
 *
 * FETCH V2 STEP 13
 * Lane membership moved out of package.json into supabase/tests/lanes.json, read by scripts/test-lanes.mjs (offline and production-
 * read-only lanes) and scripts/isolated-pg.mjs. `npm test` no longer talks to production at all; the committed-fixture lane is gone
 * and its suites are quarantined (never run); the only production lane is the opt-in, read-only one. Every suite on disk must sit in
 * exactly one place: a lane, the quarantine, the exclusions, or the list of suites already unregistered at Build 148 (which may not grow).
 *
 * SAFETY
 * Reads package.json, lanes.json and the filesystem. No database, no network, no writes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUPABASE = join(REPO_ROOT, 'supabase');

/**
 * Suites deliberately kept out of EVERY lane. A name may only appear here
 * with a reason someone can check. Removing a file from the run is a
 * decision, not an oversight, so it has to be written down.
 *
 * rate-limit-concurrency is NOT here: it is not excluded, it lives in the
 * committed-fixture lane, which is where a suite needing genuinely separate OS
 * processes belongs.
 */
const EXCLUDED: Record<string, string> = {
  'booking-capacity-concurrency.node.test.ts':
    'ISOLATED DATABASE ONLY — never the linked project, and not merely until ' +
    'the migration ships. To reach the capacity guard as a real customer it ' +
    'must briefly make a synthetic business active, and a fixture business has ' +
    'no business appearing in a live Directory even for a second. It also ' +
    'races real inserts on purpose. Run it against a throwaway Postgres with ' +
    'BOOKING_PROOF_DSN set; that is where its concurrency, mutation, UPDATE ' +
    'and RLS proofs were taken and where they are re-taken.',
};

/** Suites that must never join the routine lane, and why. */
const FIXTURE_ONLY: Record<string, string> = {
  'rate-limit-concurrency.node.test.ts':
    'Needs genuinely separate OS processes to prove two callers contend; the ' +
    'file documents this itself.',
  'wallet-attempts.node.test.ts': 'Two connections must contend over one wallet.',
  'booking-terminal-state.node.test.ts':
    'Builds an INACTIVE fixture business with its own bookings and removes it; ' +
    'the transitions it proves have to be committed to be seen.',
  'wallet-integrity.node.test.ts': 'Concurrent debits against one balance.',
  'booking-metering.node.test.ts': 'Two workers must race for one booking.',
  'stripe-idempotency.node.test.ts': 'Webhook replay needs committed event rows.',
  'ticket-redemption.node.test.ts': 'Concurrent scans of one ticket.',
  'ai-route-security.node.test.ts': 'The quota counts committed ai_usage rows.',
};

/** The retired snapshot, kept as history. See its own header. */
const RETIRED = 'supabase/tests/retired/wallet-launch-reconciliation.snapshot.ts';

type Lanes = Record<string, string>;
type Manifest = { offline: string[]; productionReadonly: string[]; quarantined: Record<string, { class: string; via: string }>;
  excluded: Record<string, string>; unregisteredAtBase: string[]; isolated: string[] };
const manifest = (): Manifest => JSON.parse(readFileSync(join(REPO_ROOT, 'supabase/tests/lanes.json'), 'utf8'));

/**
 * Every runnable test lane, by its npm script name, as one body of text listing its suites. The lists live in lanes.json (offline and
 * production read-only) and in scripts/isolated-pg.mjs (the isolated lane builds a throwaway PostgreSQL first, so it keeps its own list).
 * The quarantine is NOT a lane: nothing runs it.
 */
const lanes = (): Lanes => {
  const scripts = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  const m = manifest();
  const out: Lanes = {};
  for (const [name, body] of Object.entries(scripts)) {
    if (!name.startsWith('test') || ['test:all', 'test:quarantined', 'test:replay'].includes(name)) continue; // test:replay checks the catalogue, not suites
    if (body === 'node scripts/test-lanes.mjs offline') out[name] = m.offline.join('\n');
    else if (body === 'node scripts/test-lanes.mjs production-readonly') out[name] = m.productionReadonly.join('\n');
    else if (body.includes('node --test')) out[name] = body;
    else { const runner = body.match(/node\s+(scripts\/\S+\.mjs)/); if (runner) out[name] = readFileSync(join(REPO_ROOT, runner[1]), 'utf8'); }
  }
  return out;
};

const filesIn = (body: string): string[] =>
  body.match(/supabase\/\S+\.node\.test\.ts/g) ?? [];

const allRegistered = (): string[] => Object.values(lanes()).flatMap(filesIn);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.node.test.ts')) out.push(relative(REPO_ROOT, p));
  }
  return out;
}

describe('every suite on disk is accounted for', () => {
  test('the lanes are the ones this file knows about', () => {
    assert.deepEqual(Object.keys(lanes()).sort(), ['test', 'test:integration:production-readonly', 'test:isolated'],
      'a test lane was added or renamed — teach this file about it before trusting it');
  });

  test('no executable suite is missing from every lane', () => {
    const m = manifest();
    const registered = new Set([...allRegistered(), ...Object.keys(m.quarantined), ...m.unregisteredAtBase]);
    const orphans = walk(SUPABASE)
      .filter((f) => !registered.has(f))
      .filter((f) => !(f.split('/').pop()! in EXCLUDED));

    assert.deepEqual(orphans, [],
      `these suites exist but no npm test lane runs them:\n  ${orphans.join('\n  ')}`);
  });

  test('no suite is registered in two lanes', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [lane, body] of Object.entries(lanes())) {
      for (const f of filesIn(body)) {
        const prev = seen.get(f);
        if (prev) dupes.push(`${f} is in both ${prev} and ${lane}`);
        else seen.set(f, lane);
      }
    }
    assert.deepEqual(dupes, [], `test:all would run these twice:\n  ${dupes.join('\n  ')}`);
  });

  test('the routine lane commits nothing, so it holds no fixture suite', () => {
    // README: npm test "does not create, alter or remove a single real
    // application row". Every suite below breaks that promise by design.
    const routine = new Set(filesIn(lanes()['test']).map((f) => f.split('/').pop()!));
    const strays = Object.keys(FIXTURE_ONLY).filter((f) => routine.has(f));
    assert.deepEqual(strays, [],
      `these commit real rows and must stay in test:fixtures:\n  ${strays.join('\n  ')}`);
  });

  test('every fixture-only suite is quarantined (it committed rows in production), with a reason', () => {
    const q = new Set(Object.keys(manifest().quarantined).map((f) => f.split('/').pop()!));
    for (const [name, reason] of Object.entries(FIXTURE_ONLY)) {
      assert.ok(q.has(name), `${name} commits real rows and must stay quarantined — it may not run in any lane`);
      assert.ok(reason.length > 20, `${name} is quarantined without a usable reason`);
    }
    for (const body of Object.values(lanes())) for (const name of Object.keys(FIXTURE_ONLY)) assert.ok(!body.includes(name), `${name} is in a runnable lane`);
  });

  test('the quarantine is never a lane, and every entry says why', () => {
    const m = manifest();
    const runnable = new Set(allRegistered());
    for (const [f, v] of Object.entries(m.quarantined)) {
      assert.ok(!runnable.has(f), `${f} is quarantined AND registered in a lane`);
      assert.match(v.class, /^[DE]: .{20,}/, `${f} is quarantined without a class and reason`);
    }
  });

  test('the suites unregistered since Build 148 are recorded, not added to — a new suite must join a lane', () => {
    const m = manifest();
    assert.equal(m.unregisteredAtBase.length, 18, 'the pre-existing unregistered list grew or shrank — register the suite in a lane instead');
    for (const f of m.unregisteredAtBase) assert.ok(!allRegistered().includes(f), `${f} is now in a lane — remove it from unregisteredAtBase`);
  });

  test('the isolated-database suite stays excluded, and stays explained', () => {
    // It cannot quietly drift into a lane: nothing here is a default, so its
    // absence from EXCLUDED would fail the orphan test instead.
    const name = 'booking-capacity-concurrency.node.test.ts';
    assert.ok(name in EXCLUDED, `${name} must stay excluded — it must never run against production`);
    assert.match(EXCLUDED[name], /ISOLATED DATABASE ONLY/, 'the reason no longer says what it is');
    assert.match(EXCLUDED[name], /BOOKING_PROOF_DSN/, 'the reason no longer says how to run it');
    for (const body of Object.values(lanes())) {
      assert.ok(!body.includes(name), `${name} was registered in a lane — it races real inserts`);
    }
  });

  test('every exclusion is deliberate, and still exists', () => {
    const onDisk = new Set(walk(SUPABASE).map((f) => f.split('/').pop()!));
    const registered = new Set(allRegistered().map((f) => f.split('/').pop()!));
    for (const [name, reason] of Object.entries(EXCLUDED)) {
      assert.ok(onDisk.has(name), `${name} is excluded but no longer exists — drop the exclusion`);
      assert.ok(reason.length > 40, `${name} is excluded without a usable reason`);
      assert.ok(!registered.has(name), `${name} is both excluded and registered`);
    }
  });
});

describe('the retired reconciliation snapshot stays retired', () => {
  test('it is outside the executable pattern', () => {
    assert.ok(!RETIRED.endsWith('.node.test.ts'),
      'the retired snapshot matches the test glob and would be collected');
    assert.ok(!walk(SUPABASE).includes(RETIRED),
      'the retired snapshot was discovered as an executable suite');
  });

  test('it is absent from every lane', () => {
    for (const [lane, body] of Object.entries(lanes())) {
      assert.ok(!body.includes('wallet-launch-reconciliation'),
        `the retired snapshot is registered in ${lane}`);
    }
  });

  test('it refuses to run, so its production deletes cannot fire', async () => {
    await assert.rejects(
      () => import(join(REPO_ROOT, RETIRED)),
      /RETIRED point-in-time snapshot/,
      'the retired snapshot executed instead of refusing',
    );
  });

  test('its production delete is still the reason, and still recorded', () => {
    const src = readFileSync(join(REPO_ROOT, RETIRED), 'utf8');
    assert.match(src, /delete from public\.local_wallet_balances/,
      'the history this file was kept for has been edited away');
    assert.match(src, /ALLOWLIST NEGATION/,
      'the header no longer explains why the file must not run');
  });
});

/**
 * Fetch v2 Step 13: the routine lane cannot reach production, by construction.
 *
 * The runtime guard (scripts/test-safety/guard.mjs) would refuse it anyway; this makes the mistake visible before anything runs. Each
 * signature is how a suite actually reaches a hosted service in this repository: the linked Supabase CLI, the service-role key file,
 * fetch() to a configured project or the live site.
 */
const REACHES: [RegExp, string][] = [
  [/['"]--linked['"]/, 'the Supabase CLI against the linked project'],
  [/readFileSync\([^)]*service_key|['"]service_key\.txt['"]|process\.env\.SUPABASE_SERVICE_ROLE_KEY/, 'the production service-role key'],
  [/fetch\(\s*`\$\{[^}]*(url|URL|Url|SUPABASE|base|BASE)/, 'fetch() to a configured hosted project'],
  [/fetch\([^)]*(LAUNCH_READINESS_BASE_URL|https:\/\/(www\.)?oneshetland\.com)/, 'fetch() to the live website'],
];
describe('the offline lane (npm test) cannot reach production', () => {
  test('no suite in it has a way to reach a hosted service', () => {
    const offenders: string[] = [];
    for (const f of manifest().offline) {
      if (f.endsWith('test-registration.node.test.ts') || f.endsWith('test-safety.node.test.ts')) continue; // they name these strings to look for them
      const src = readFileSync(join(REPO_ROOT, f), 'utf8');
      for (const [re, what] of REACHES) if (re.test(src)) offenders.push(`${f}: ${what}`);
    }
    assert.deepEqual(offenders, [], `move these to the production read-only lane or the quarantine:\n  ${offenders.join('\n  ')}`);
  });
  test('the read-only production lane holds no write', () => {
    const WRITE = /\b(insert\s+into|update\s+[\w."]+\s+set|delete\s+from|truncate|alter\s+table|drop\s|create\s+(or\s+replace\s+)?(function|table|policy|trigger)|grant\s|revoke\s)/i;
    for (const f of manifest().productionReadonly) {
      const src = readFileSync(join(REPO_ROOT, f), 'utf8');
      assert.ok(!WRITE.test([...src.matchAll(/`([\s\S]*?)`/g)].map((m) => m[1]).join('\n')), `${f} contains write SQL`);
      assert.ok(!/method:\s*['"](POST|PATCH|PUT|DELETE)['"]/.test(src), `${f} makes a write request`);
      assert.ok(!REACHES[1][0].test(src), `${f} uses the service-role key`);
    }
  });
  test('the guard and its own tests are in the routine lane', () => {
    assert.ok(manifest().offline.includes('supabase/tests/test-safety.node.test.ts'));
    assert.ok(manifest().offline.includes('supabase/tests/fetch-v2-client-contract.node.test.ts'));
    assert.ok(manifest().offline.includes('supabase/tests/fetch-v2-mobile-guards.node.test.ts'));
    assert.ok(manifest().offline.includes('supabase/tests/fetch-v2-mobile-logic.node.test.ts'));
  });
});
