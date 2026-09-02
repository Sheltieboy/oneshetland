/**
 * test-registration.node.test.ts — every suite is either registered or
 * excluded on purpose, and the retired snapshot cannot come back to life.
 *
 * WHAT WAS WRONG
 *
 * Eight suites existed on disk that `npm test` never ran. They were written,
 * they passed, and then they quietly stopped being part of the baseline. Two
 * had rotted without anyone noticing: wallet-attempts asserted a payment call
 * site that had moved, and wallet-launch-reconciliation asserted launch-day
 * figures that ordinary use had long since moved past. A suite nobody runs is
 * not a safety net; it is a note claiming there is one.
 *
 * WHAT IS ASSERTED
 *   · every executable suite on disk is named in the canonical npm test script
 *   · the only exclusions are the ones listed here, each with a stated reason
 *   · the retired reconciliation snapshot is outside the executable pattern,
 *     absent from the registration, and refuses to run if invoked directly
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
 * Suites deliberately kept out of `npm test`. A name may only appear here with
 * a reason someone can check. Removing a file from the run is a decision, not
 * an oversight, so it has to be written down.
 */
const EXCLUDED: Record<string, string> = {
  'rate-limit-concurrency.node.test.ts':
    'Needs genuinely separate OS processes to prove two callers contend; the ' +
    'file documents this itself. Run it by hand, not in the routine suite.',
};

/** The retired snapshot, kept as history. See its own header. */
const RETIRED = 'supabase/tests/retired/wallet-launch-reconciliation.snapshot.ts';

const testScript = (): string =>
  (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as
    { scripts: Record<string, string> }).scripts.test;

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
  test('no executable suite is missing from the canonical test script', () => {
    const script = testScript();
    const orphans = walk(SUPABASE)
      .filter((f) => !script.includes(f))
      .filter((f) => !(f.split('/').pop()! in EXCLUDED));

    assert.deepEqual(orphans, [],
      `these suites exist but npm test never runs them:\n  ${orphans.join('\n  ')}`);
  });

  test('the six Launch Gate 2 suites are registered', () => {
    const script = testScript();
    for (const f of ['ai-route-security', 'booking-metering', 'stripe-idempotency',
                     'ticket-redemption', 'wallet-integrity', 'wallet-attempts']) {
      assert.ok(script.includes(`supabase/tests/${f}.node.test.ts`),
        `${f} is not in the canonical test script`);
    }
  });

  test('every exclusion is deliberate, and still exists', () => {
    const onDisk = new Set(walk(SUPABASE).map((f) => f.split('/').pop()!));
    for (const [name, reason] of Object.entries(EXCLUDED)) {
      assert.ok(onDisk.has(name), `${name} is excluded but no longer exists — drop the exclusion`);
      assert.ok(reason.length > 40, `${name} is excluded without a usable reason`);
      assert.ok(!testScript().includes(name), `${name} is both excluded and registered`);
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

  test('it is absent from the canonical test script', () => {
    assert.ok(!testScript().includes('wallet-launch-reconciliation'),
      'the retired snapshot is registered in npm test');
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
