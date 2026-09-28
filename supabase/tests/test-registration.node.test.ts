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
 * SAFETY
 * Reads package.json and the filesystem. No database, no network, no writes.
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
  'wallet-attempts.node.test.ts':
    'Commits inside one rolled-back transaction against production shapes; the ' +
    'two-connection proof moved to the isolated lane.',
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

/**
 * Every npm script that runs tests, by name. test:all only chains the others.
 *
 * A lane usually lists its suites inline. `test:isolated` cannot: it has to
 * build a throwaway PostgreSQL before anything can run, so it delegates to a
 * runner and the list of suites lives there. Read that file, or the suites it
 * runs look like orphans.
 */
const lanes = (): Lanes => {
  const scripts = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as
    { scripts: Record<string, string> }).scripts;
  const out: Lanes = {};
  for (const [name, body] of Object.entries(scripts)) {
    if (!name.startsWith('test')) continue;
    if (body.includes('node --test')) { out[name] = body; continue; }
    const runner = body.match(/node\s+(scripts\/\S+\.mjs)/);
    if (runner) out[name] = readFileSync(join(REPO_ROOT, runner[1]), 'utf8');
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
    assert.deepEqual(Object.keys(lanes()).sort(), ['test', 'test:fixtures', 'test:isolated'],
      'a test lane was added or renamed — teach this file about it before trusting it');
  });

  test('no executable suite is missing from every lane', () => {
    const registered = new Set(allRegistered());
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

  test('every fixture-only suite is in the fixture lane, with a reason', () => {
    const fixture = new Set(filesIn(lanes()['test:fixtures']).map((f) => f.split('/').pop()!));
    for (const [name, reason] of Object.entries(FIXTURE_ONLY)) {
      assert.ok(fixture.has(name), `${name} is fixture-only but not in test:fixtures`);
      assert.ok(reason.length > 20, `${name} sits in the fixture lane without a usable reason`);
    }
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
 * The lane that talks to PRODUCTION may not move money.
 *
 * On 2026-09-08 the wallet-integrity concurrency proof left a real customer
 * account holding a fabricated £38.00 balance with no top-up behind it. It was
 * not a coding mistake: the proof needs two COMMITTED connections, so it cannot
 * roll itself back, and it relied on cleanup that never ran when the Supabase
 * CLI's login role failed mid-run. Worse, its account picker skips any profile
 * that already has wallet rows, so the polluted account would be passed over
 * next time and a fresh real account chosen — the damage accumulated.
 *
 * Those proofs now live in the isolated lane. This is the guard that stops them
 * coming back, and it bites statically, before a single row is written.
 *
 * WHAT IS CHECKED, AND WHY THESE TWO THINGS
 *
 * Not "any write": the production lanes legitimately INSERT wallet rows inside
 * `begin; … rollback;` fixtures, and their begin and rollback live in shared
 * FIXTURE/END constants far from the statement, so no textual span check can
 * tell those apart without lying. These two signatures can:
 *
 *   1  a DELETE against a wallet money table. A rolled-back fixture never needs
 *      one; the removed proofs opened with three of them, to clear a real
 *      account before overwriting it.
 *   2  a cleanup hook that mentions a wallet money table. That is the literal
 *      shape of "this suite depends on tidying production afterwards", which is
 *      the assumption that failed.
 */
const MONEY_TABLE = String.raw`(public\.)?local_wallet_(balances|transactions)\b`;
const MONEY_DELETE = new RegExp(String.raw`delete\s+from\s+` + MONEY_TABLE, 'gi');
const PRODUCTION_LANES = ['test', 'test:fixtures'];

/** The body of every after()/afterEach() hook in a file. */
function cleanupHooks(src: string): string {
  let out = '';
  for (const m of src.matchAll(/\bafter(?:Each)?\s*\(/g)) {
    let i = src.indexOf('(', m.index! + m[0].length - 1), depth = 0, start = i;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) break; }
    }
    out += src.slice(start, i + 1);
  }
  return out;
}

describe('the production lanes never move real money', () => {
  test('the lanes being checked actually exist', () => {
    const l = lanes();
    for (const n of PRODUCTION_LANES) assert.ok(l[n], `lane ${n} is gone, so this guard checks nothing`);
  });

  for (const lane of PRODUCTION_LANES) {
    test(`no suite in ${lane} deletes from a Wallet money table`, () => {
      const offenders: string[] = [];
      for (const f of filesIn(lanes()[lane])) {
        const hits = readFileSync(join(REPO_ROOT, f), 'utf8').match(MONEY_DELETE);
        if (hits) offenders.push(`${f}: ${hits.length} delete(s)`);
      }
      assert.deepEqual(offenders, [],
        'a production-targeted suite deletes real Wallet rows. A rolled-back ' +
        'fixture never needs to. Move the proof to the isolated lane ' +
        '(scripts/isolated-pg.mjs), where the users are disposable.');
    });

    test(`no suite in ${lane} tidies Wallet rows up afterwards`, () => {
      const offenders: string[] = [];
      for (const f of filesIn(lanes()[lane])) {
        const hooks = cleanupHooks(readFileSync(join(REPO_ROOT, f), 'utf8'));
        if (new RegExp(MONEY_TABLE, 'i').test(hooks)) offenders.push(f);
      }
      assert.deepEqual(offenders, [],
        'a production-targeted suite depends on a cleanup hook to restore real ' +
        'Wallet state. That is exactly the assumption that failed on ' +
        '2026-09-08 and left fabricated money on a real account.');
    });
  }

  /**
   * No concurrency proof may run against production at all.
   *
   * A proof that needs two connections cannot roll itself back — that is the
   * whole point of it — so it must seed real rows and tidy up afterwards. Every
   * one of them was doing exactly that: the AI quota rewrote a real person's
   * hourly counter, booking metering created a business and twenty bookings
   * under a real owner, ticket check-in created events and tickets. They also
   * happened to be the tests that could not survive the Supabase CLI's login
   * role failing, which is how the wallet one came to leave fabricated money
   * behind on 2026-09-08.
   *
   * The signature is deliberately structural rather than semantic: a suite that
   * builds an async database helper (execFileAsync) AND fans out with
   * Promise.all is running two connections at once. Nothing else in these lanes
   * does that, so it does not misfire.
   */
  for (const lane of PRODUCTION_LANES) {
    test(`no suite in ${lane} races two database connections`, () => {
      const offenders = filesIn(lanes()[lane]).filter((f) => {
        // This file names both strings in order to look for them, and touches no
        // database at all. Excluding it keeps the guard from flagging itself.
        if (f.endsWith('test-registration.node.test.ts')) return false;
        const src = readFileSync(join(REPO_ROOT, f), 'utf8');
        return src.includes('execFileAsync') && src.includes('Promise.all');
      });
      assert.deepEqual(offenders, [],
        'a production-targeted suite runs two database connections at once. A ' +
        'proof that needs two committed connections cannot roll itself back, so ' +
        'it must seed and then tidy real rows — and an interrupted run leaves ' +
        'them behind. Move it to supabase/tests/production-concurrency-proofs' +
        '.node.test.ts in the isolated lane (scripts/isolated-pg.mjs).');
    });
  }

  test('the concurrency proofs still exist, in the isolated lane', () => {
    const iso = readFileSync(join(REPO_ROOT, 'scripts/isolated-pg.mjs'), 'utf8');
    assert.match(iso, /wallet-concurrency\.node\.test\.ts/,
      'the wallet concurrency proofs were deleted rather than moved');
    assert.match(iso, /production-concurrency-proofs\.node\.test\.ts/,
      'the moved production concurrency proofs were deleted rather than moved');
    const moved = readFileSync(join(REPO_ROOT, 'supabase/tests/production-concurrency-proofs.node.test.ts'), 'utf8');
    for (const proof of [
      'only one of them gets it',                                   // AI quota
      'ten simultaneous connections cannot exceed a ceiling of six', // limiter
      'exactly one delivery may proceed',                            // Stripe
      'two concurrent workers never claim the same booking',         // metering
      'exactly one entrance admits the attendee',                    // ticket door
      'when the refund wins, the door is closed',                    // refund vs scan
    ]) assert.ok(moved.includes(proof), `the "${proof}" proof did not survive the move`);
    const src = readFileSync(join(REPO_ROOT, 'supabase/tests/wallet-concurrency.node.test.ts'), 'utf8');
    for (const proof of [
      'a wallet with 1000p cannot pay 800p twice',
      'even from two connections',
      'exactly one copy may claim the reference',
      'and only one of them debits',
    ]) assert.ok(src.includes(proof), `the "${proof}" proof did not survive the move`);
    assert.match(src, /refusing to run against anything that looks like Supabase/,
      'the moved proofs no longer refuse a production DSN');
  });
});
